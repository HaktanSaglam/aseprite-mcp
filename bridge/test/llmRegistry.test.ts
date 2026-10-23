import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { AnthropicApiRunner } from "../src/llm/AnthropicApiRunner.js";
import { ClaudeCliRunner } from "../src/llm/ClaudeCliRunner.js";
import type { ProviderInfo } from "../src/llm/LlmRunner.js";
import { modelOptions, RemoteModelLister } from "../src/llm/modelCatalog.js";
import { OpenAiCompatibleRunner } from "../src/llm/OpenAiCompatibleRunner.js";
import { createProviderRegistry } from "../src/llm/ProviderRegistry.js";
import { ConfigFileSource, readConfigFile, resolveSettings } from "../src/llm/providerSettings.js";
import { type MockHttpServer, startMockHttpServer } from "./fixtures/llm/testServers.js";

let dir: string;
let configFile: string;

const bridgeConfig = (): BridgeConfig => ({
  version: "0.0.0-test",
  host: "127.0.0.1",
  mcpPort: 7800,
  asepritePort: 7801,
  requestTimeoutMs: 30_000,
  claudePath: "claude",
  claudeWorkDir: join(dir, "aseprite-mcp-claude"),
  configFile,
  maxParallelRuns: 4,
});

const installed = (...commands: string[]) => (command: string) =>
  commands.includes(command) ? `/usr/local/bin/${command}` : undefined;

function byId(list: ProviderInfo[], id: string): ProviderInfo {
  const info = list.find((p) => p.id === id);
  if (!info) throw new Error(`no provider ${id}`);
  return info;
}

function writeConfig(value: unknown): void {
  writeFileSync(configFile, typeof value === "string" ? value : JSON.stringify(value));
}

// Nothing listens on port 1, so "is Ollama running?" is answered quickly and offline.
const OFFLINE_OLLAMA = { providers: { ollama: { baseUrl: "http://127.0.0.1:1/v1" } } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-registry-test-"));
  configFile = join(dir, "config.json");
});

describe("provider settings", () => {
  it("treats a missing config file as empty", () => {
    expect(readConfigFile(join(dir, "missing.json"))).toEqual({ file: {} });
  });

  it("reports invalid JSON and invalid values", () => {
    writeConfig("{ nope");
    expect(readConfigFile(configFile).error).toMatch(/not valid JSON/);
    writeConfig({ providers: { openai: { baseUrl: "not a url" } } });
    expect(readConfigFile(configFile).error).toMatch(/providers\.openai\.baseUrl/);
  });

  it("prefers the config file over environment variables", () => {
    const s = resolveSettings(
      { providers: { openai: { apiKey: "file-key", model: "file-model" }, codex: { path: "/opt/codex" } } },
      { OPENAI_API_KEY: "env-key", OPENAI_MODEL: "env-model", CODEX_PATH: "/env/codex", ANTHROPIC_API_KEY: "ant", GEMINI_PATH: "/env/gemini" },
      "claude",
    );
    expect(s.openai).toMatchObject({ apiKey: "file-key", model: "file-model", official: true, baseUrl: "https://api.openai.com/v1" });
    expect(s.codex.path).toBe("/opt/codex");
    expect(s.gemini.path).toBe("/env/gemini");
    expect(s.anthropic.apiKey).toBe("ant");
  });

  it("reads OpenAI-compatible endpoints and Ollama hosts from the environment", () => {
    const s = resolveSettings({}, { OPENAI_BASE_URL: "http://localhost:1234/v1/", OLLAMA_HOST: "10.0.0.5:11434" }, "claude");
    expect(s.openai).toMatchObject({ baseUrl: "http://localhost:1234/v1", official: false });
    expect(s.ollama.baseUrl).toBe("http://10.0.0.5:11434/v1");
  });

  it("does not inherit ANTHROPIC_BASE_URL from a parent Claude Code session", () => {
    expect(resolveSettings({}, { ANTHROPIC_BASE_URL: "http://proxy" }, "claude").anthropic.baseUrl).toBe("https://api.anthropic.com");
  });

  it("re-reads the config file only when it changes", () => {
    const source = new ConfigFileSource(configFile);
    expect(source.current().file).toEqual({});
    writeConfig({ defaultProvider: "openai" });
    expect(source.current().file.defaultProvider).toBe("openai");
    const first = source.current();
    expect(source.current()).toBe(first);
    writeConfig({ defaultProvider: "anthropic" });
    utimesSync(configFile, new Date(), new Date(Date.now() + 5000));
    expect(source.current().file.defaultProvider).toBe("anthropic");
  });

  it("keeps the configured model first in model lists", () => {
    expect(modelOptions(undefined, "custom", [{ id: "a", label: "A" }])).toEqual([
      { id: "custom", label: "custom" },
      { id: "a", label: "A" },
    ]);
    expect(modelOptions(["x"], undefined, [{ id: "x", label: "Model X" }])).toEqual([{ id: "x", label: "Model X" }]);
  });
});

describe("createProviderRegistry", () => {
  let server: MockHttpServer;
  beforeAll(async () => {
    server = await startMockHttpServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it("lists every provider with availability and what to do about it", async () => {
    writeConfig(OFFLINE_OLLAMA);
    const registry = createProviderRegistry(bridgeConfig(), { env: {}, which: installed("claude") });
    const list = await registry.list();
    expect(list.map((p) => p.id)).toEqual(["claude-code", "codex", "gemini-cli", "openai", "anthropic", "ollama"]);

    expect(byId(list, "claude-code")).toMatchObject({
      available: true,
      supportsImages: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultModel: "opus",
    });
    expect(byId(list, "claude-code").models.map((m) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(byId(list, "codex")).toMatchObject({ available: false, note: expect.stringContaining("npm install -g @openai/codex") });
    expect(byId(list, "gemini-cli")).toMatchObject({ available: false, note: expect.stringContaining("@google/gemini-cli") });
    expect(byId(list, "openai")).toMatchObject({
      available: false,
      note: `Set OPENAI_API_KEY or add providers.openai.apiKey to ${configFile}, then reopen the chat.`,
    });
    expect(byId(list, "anthropic")).toMatchObject({ available: false, note: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(byId(list, "ollama")).toMatchObject({ available: false, note: expect.stringContaining("Ollama is not running") });
    expect(registry.defaultId).toBe("claude-code");
  });

  it("enables API providers from environment keys with sensible defaults", async () => {
    writeConfig(OFFLINE_OLLAMA);
    const registry = createProviderRegistry(bridgeConfig(), {
      env: { OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "sk-ant" },
      which: installed("claude", "codex", "gemini"),
    });
    const list = await registry.list();
    const openai = byId(list, "openai");
    expect(openai).toMatchObject({ available: true, label: "OpenAI", defaultModel: "gpt-6.1-sol", efforts: ["low", "medium", "high"] });
    expect(openai.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"]);
    expect(byId(list, "anthropic")).toMatchObject({ available: true, defaultModel: "claude-opus-5-5" });
    expect(byId(list, "codex")).toMatchObject({ available: true, efforts: ["low", "medium", "high", "xhigh"] });
    expect(byId(list, "gemini-cli")).toMatchObject({ available: true, supportsImages: false, defaultModel: "auto" });

    expect(registry.runner("openai")).toBeInstanceOf(OpenAiCompatibleRunner);
    expect(registry.runner("anthropic")).toBeInstanceOf(AnthropicApiRunner);
    // Same settings → same runner, so in-memory conversations survive.
    expect(registry.runner("openai")).toBe(registry.runner("openai"));
  });

  it("lists the models an OpenAI-compatible server reports", async () => {
    server.reply({ json: { object: "list", data: [{ id: "qwen3:8b" }, { id: "llama3.1:8b" }] } });
    writeConfig({ providers: { openai: { baseUrl: `${server.url}/v1`, label: "LM Studio" }, ollama: { baseUrl: `${server.url}/v1` } } });
    const registry = createProviderRegistry(bridgeConfig(), { env: {}, which: installed(), models: new RemoteModelLister() });
    const list = await registry.list();
    expect(byId(list, "openai")).toMatchObject({ available: true, label: "LM Studio", efforts: [], defaultModel: "llama3.1:8b" });
    expect(byId(list, "openai").models.map((m) => m.id)).toEqual(["llama3.1:8b", "qwen3:8b"]);
    expect(byId(list, "ollama")).toMatchObject({ available: true, supportsImages: false });
    expect(server.requests.every((r) => r.path === "/v1/models")).toBe(true);
  });

  it("honours defaultProvider and falls back for unknown ids", () => {
    writeConfig({ defaultProvider: "anthropic" });
    expect(createProviderRegistry(bridgeConfig(), { env: {}, which: installed() }).defaultId).toBe("anthropic");
    writeConfig({ defaultProvider: "skynet" });
    expect(createProviderRegistry(bridgeConfig(), { env: {}, which: installed() }).defaultId).toBe("claude-code");
  });

  it("throws readable errors for unknown or unavailable providers", () => {
    const registry = createProviderRegistry(bridgeConfig(), { env: {}, which: installed() });
    expect(() => registry.runner("skynet")).toThrow(/Unknown AI provider "skynet"/);
    expect(() => registry.runner("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => registry.runner("claude-code")).toThrow(/Claude Code CLI not found/);
  });

  it("uses the configured CLI paths", () => {
    writeConfig({ providers: { "claude-code": { path: "/custom/claude" } } });
    const registry = createProviderRegistry(bridgeConfig(), { env: {}, which: (c) => (c === "/custom/claude" ? c : undefined) });
    expect(registry.runner("claude-code")).toBeInstanceOf(ClaudeCliRunner);
    registry.dispose?.();
  });

  it("explains an ignored config file on providers that need it", async () => {
    writeConfig("{ broken");
    const registry = createProviderRegistry(bridgeConfig(), { env: {}, which: installed("claude") });
    const list = await registry.list();
    expect(byId(list, "anthropic").note).toMatch(/Config file ignored: .*not valid JSON/);
    expect(byId(list, "claude-code").note).toBeUndefined();
  });
});
