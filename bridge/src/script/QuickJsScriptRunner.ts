import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { Raster } from "../pixel/Raster.js";
import type { DrawScriptRequest, DrawScriptResult, IScriptRunner } from "./ScriptRunner.js";

interface Limits {
  timeoutMs: number;
  memoryBytes: number;
  maxCalls: number;
}

const DEFAULT_LIMITS: Limits = {
  timeoutMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  maxCalls: 2_000_000,
};

/** Small seeded PRNG (mulberry32): deterministic output for the same seed. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function num(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a number, got ${JSON.stringify(value)}`);
  return n;
}

function color(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`color must be a string like "#1a1c2c"`);
  return value;
}

function points(value: unknown): number[][] {
  if (!Array.isArray(value)) throw new TypeError("poly expects [[x, y], ...]");
  return value.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2) throw new TypeError(`poly point ${i} must be [x, y]`);
    return [num(p[0], "x"), num(p[1], "y")];
  });
}

function toHandle(vm: QuickJSContext, value: unknown): QuickJSHandle | undefined {
  if (value === undefined) return undefined;
  if (value === null) return vm.null;
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "string") return vm.newString(value);
  return undefined;
}

/**
 * Runs scripts inside QuickJS compiled to WebAssembly: a separate JS engine with no
 * access to Node, the file system or the network. Node's own `vm` module would be
 * simpler but is not a security boundary, and this repo is meant to be shared.
 */
export class QuickJsScriptRunner implements IScriptRunner {
  private module?: Promise<QuickJSWASMModule>;

  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {}

  async run(request: DrawScriptRequest): Promise<DrawScriptResult> {
    const QuickJS = await (this.module ??= getQuickJS());
    const started = Date.now();
    const raster = new Raster(request.width, request.height, request.base);
    const random = seededRandom(request.seed ?? 1);
    let calls = 0;

    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    // Stops infinite loops in the script itself; host calls are bounded by maxCalls.
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(started + this.limits.timeoutMs));
    const vm = runtime.newContext();

    try {
      const expose = (name: string, fn: (...args: unknown[]) => unknown) => {
        const handle = vm.newFunction(name, (...args) => {
          if (++calls > this.limits.maxCalls) {
            throw new Error(`More than ${this.limits.maxCalls} drawing calls`);
          }
          return toHandle(vm, fn(...args.map((a) => vm.dump(a))));
        });
        vm.setProp(vm.global, name, handle);
        handle.dispose();
      };
      const constant = (name: string, value: number) => {
        const handle = vm.newNumber(value);
        vm.setProp(vm.global, name, handle);
        handle.dispose();
      };

      constant("W", request.width);
      constant("H", request.height);
      expose("set", (x, y, c) => raster.set(num(x, "x"), num(y, "y"), color(c)));
      expose("get", (x, y) => raster.get(num(x, "x"), num(y, "y")));
      expose("rect", (x, y, w, h, c) =>
        raster.rect(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), color(c)),
      );
      expose("frame", (x, y, w, h, c) =>
        raster.frame(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), color(c)),
      );
      expose("line", (x0, y0, x1, y1, c) =>
        raster.line(num(x0, "x0"), num(y0, "y0"), num(x1, "x1"), num(y1, "y1"), color(c)),
      );
      expose("circle", (cx, cy, r, c, filled) =>
        raster.circle(num(cx, "cx"), num(cy, "cy"), num(r, "r"), color(c), filled !== false),
      );
      expose("ellipse", (cx, cy, rx, ry, c, filled) =>
        raster.ellipse(
          num(cx, "cx"),
          num(cy, "cy"),
          num(rx, "rx"),
          num(ry, "ry"),
          color(c),
          filled !== false,
        ),
      );
      expose("poly", (pts, c) => raster.poly(points(pts), color(c)));
      expose("fill", (x, y, c) => raster.fill(num(x, "x"), num(y, "y"), color(c)));
      expose("dither", (x, y, w, h, c, amount) =>
        raster.dither(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), color(c), num(amount, "amount")),
      );
      expose("rand", (n) => (n === undefined ? random() : Math.floor(random() * num(n, "n"))));

      const result = vm.evalCode(request.code, "draw.js");
      if (result.error) {
        const error = vm.dump(result.error) as { name?: string; message?: string; stack?: string };
        result.error.dispose();
        // Name, message and line number are what Claude needs to fix its script.
        throw new Error(
          `${error.name ?? "Error"}: ${error.message ?? String(error)}${error.stack ? `\n${error.stack}` : ""}`,
        );
      }
      result.value.dispose();
    } finally {
      vm.dispose();
      runtime.dispose();
    }

    return { image: raster.image, calls, elapsedMs: Date.now() - started };
  }
}
