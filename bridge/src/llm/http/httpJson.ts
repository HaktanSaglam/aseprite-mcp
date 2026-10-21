import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

/** A failed provider call, with what the retry loop needs to decide what to do. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    /** The provider's own error text, for callers that match on it. */
    readonly detail = "",
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface JsonResponse {
  status: number;
  json: any;
  text: string;
  headers: IncomingHttpHeaders;
}

interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Whole-request limit. Generous by default: one agent step at high effort can take minutes. */
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_NETWORK = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_SOCKET"]);

function abortError(): Error {
  const error = new Error("Stopped.");
  error.name = "AbortError";
  return error;
}

/**
 * JSON over node:http(s) instead of fetch: fetch gives up after 300 s without response
 * headers, which a long non-streamed agent step (high effort, big drawing) can exceed.
 */
export function requestJson(url: string, options: RequestOptions = {}): Promise<JsonResponse> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError());
    const req = send(target, { method: options.method ?? (payload ? "POST" : "GET"), headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error) => fail(error));
      res.on("end", () => {
        cleanup();
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
    });

    const onAbort = () => req.destroy(abortError());
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const timer = setTimeout(
      () => req.destroy(new ProviderHttpError(`No response from ${target.origin} within ${Math.round(timeoutMs / 1000)} s`, undefined, true)),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error & { code?: string }) => {
      cleanup();
      if (error.name === "AbortError" || error instanceof ProviderHttpError) return reject(error);
      if (error.code === "ECONNREFUSED") {
        return reject(new ProviderHttpError(`Cannot connect to ${target.origin} (connection refused). Is the server running?`, undefined, false));
      }
      if (error.code === "ENOTFOUND") {
        return reject(new ProviderHttpError(`Cannot resolve ${target.hostname}. Check the base URL and your internet connection.`, undefined, false));
      }
      reject(new ProviderHttpError(`Network error talking to ${target.origin}: ${error.message}`, undefined, RETRYABLE_NETWORK.has(error.code ?? "")));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", fail);
    req.end(payload);
  });
}

function retryAfterMs(headers: IncomingHttpHeaders): number | undefined {
  const ms = Number(headers["retry-after-ms"]);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headers["retry-after"];
  if (typeof raw !== "string") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** The human-readable part of an error body, whatever the provider's error shape. */
export function providerMessage(response: JsonResponse): string {
  const body = response.json;
  const message =
    (typeof body?.error === "string" ? body.error : undefined) ??
    body?.error?.message ??
    body?.message ??
    body?.detail ??
    (Array.isArray(body) ? body[0]?.error?.message : undefined);
  if (typeof message === "string" && message.trim()) return message.trim();
  return response.text.trim().slice(0, 300) || "no details";
}

/**
 * Throws a ProviderHttpError for non-2xx responses: "<label> error (HTTP 404): <provider message>",
 * plus a hint for auth failures so the user knows which setting to fix.
 */
export function ensureOk(label: string, response: JsonResponse, authHint?: string): JsonResponse {
  if (response.status >= 200 && response.status < 300) return response;
  const detail = providerMessage(response);
  let hint = (response.status === 401 || response.status === 403) && authHint ? ` ${authHint}` : "";
  // Drawing is all tool calls; a model without tool calling can't do anything useful here.
  if (/does not support tools|tool(s| use| calling)? (is |are )?not supported/i.test(detail)) {
    hint += " Pick a model with tool calling (e.g. qwen3, llama3.1, mistral-small, gpt-oss).";
  }
  throw new ProviderHttpError(
    `${label} error (HTTP ${response.status}): ${detail}${hint}`,
    response.status,
    RETRYABLE_STATUS.has(response.status),
    retryAfterMs(response.headers),
    detail,
  );
}
