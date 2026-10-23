import type { ChildProcess } from "node:child_process";
// cross-spawn instead of child_process.spawn: on Windows the CLIs are npm .cmd shims,
// which Node only starts through cmd.exe, and arguments then need cmd.exe escaping.
import spawn from "cross-spawn";
import { createInterface } from "node:readline";

export type ProcessOutput =
  | { kind: "line"; value: unknown }
  | { kind: "exit"; code: number | null; spawnError?: NodeJS.ErrnoException }
  | { kind: "aborted" };

interface Options {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** "ignore" for CLIs that would otherwise wait for (or read extra context from) stdin. */
  stdin?: "pipe" | "ignore";
}

const STDERR_TAIL = 4000;
const KILL_GRACE_MS = 3000;

/**
 * A child process that speaks JSON Lines on stdout (Claude Code, Codex and Gemini CLIs
 * in their headless modes). Output is pulled one item at a time so one process can serve
 * several turns, and every wait can be cancelled with an AbortSignal.
 */
export class JsonLineProcess {
  private readonly child: ChildProcess;
  private readonly queue: ProcessOutput[] = [];
  private waiter?: (item: ProcessOutput) => void;
  private exitedFlag = false;
  private stderr = "";
  /** Non-JSON stdout lines; some CLIs print fatal errors as plain text. */
  private plainText = "";

  constructor(command: string, args: string[], options: Options) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ?? "pipe", "pipe", "pipe"],
      // Own process group on POSIX, so Stop also reaches processes the CLI starts itself
      // (Gemini relaunches itself in a child node process).
      detached: process.platform !== "win32",
    });
    // Writing to a process that already died must not crash the bridge.
    this.child.stdin?.on("error", () => {});
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    this.child.on("error", (error: NodeJS.ErrnoException) => this.finish({ kind: "exit", code: null, spawnError: error }));
    this.child.on("close", (code) => this.finish({ kind: "exit", code }));
  }

  get exited(): boolean {
    return this.exitedFlag;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Last stderr output plus plain-text stdout lines, for error messages. */
  get diagnostics(): string {
    return `${this.stderr}\n${this.plainText}`.trim();
  }

  send(value: unknown): void {
    if (!this.exitedFlag) this.child.stdin?.write(`${JSON.stringify(value)}\n`);
  }

  endInput(): void {
    if (!this.exitedFlag) this.child.stdin?.end();
  }

  kill(): void {
    if (this.exitedFlag || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.signal("SIGTERM");
    // A CLI that ignores SIGTERM (or is busy in a child process) is killed for good.
    const force = setTimeout(() => {
      if (!this.exitedFlag) this.signal("SIGKILL");
    }, KILL_GRACE_MS);
    force.unref();
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    try {
      if (pid === undefined) return;
      if (process.platform === "win32") {
        // cmd.exe runs the npm shim; only a tree kill reaches the node process behind it.
        spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => {});
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      this.child.kill(signal);
    }
  }

  /** Lets a CLI that already reported its result finish saving the session before a kill. */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitedFlag) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Keeps an idle process from holding the bridge (or a test run) open. */
  unref(): void {
    this.child.unref();
    for (const stream of this.pipes()) stream.unref?.();
  }

  ref(): void {
    this.child.ref();
    for (const stream of this.pipes()) stream.ref?.();
  }

  // Pipes are net.Sockets at runtime, but typed as plain streams.
  private pipes(): { ref?: () => void; unref?: () => void }[] {
    return [this.child.stdin, this.child.stdout, this.child.stderr].filter((s) => s !== null) as {
      ref?: () => void;
      unref?: () => void;
    }[];
  }

  /** Next stdout item; after the exit item it keeps returning that exit item. */
  next(signal?: AbortSignal): Promise<ProcessOutput> {
    const queued = this.queue.shift();
    if (queued) {
      if (queued.kind === "exit") this.queue.unshift(queued);
      return Promise.resolve(queued);
    }
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiter = undefined;
        resolve({ kind: "aborted" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = (item) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(item);
      };
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.plainText = (this.plainText + "\n" + trimmed).slice(-STDERR_TAIL);
      return;
    }
    this.push({ kind: "line", value });
  }

  private finish(item: ProcessOutput): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    this.push(item);
  }

  private push(item: ProcessOutput): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(item);
      if (item.kind === "exit") this.queue.push(item);
    } else {
      this.queue.push(item);
    }
  }
}
