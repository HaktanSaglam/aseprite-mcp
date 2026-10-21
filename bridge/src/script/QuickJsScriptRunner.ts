import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { Raster } from "../pixel/Raster.js";
import { createValueNoise, seededRandom } from "./noise.js";
import { createScriptApi, type ScriptScope } from "./scriptApi.js";
import {
  ScriptError,
  type DrawScriptRequest,
  type DrawScriptResult,
  type IScriptRunner,
  type ScriptFrame,
} from "./ScriptRunner.js";

export interface ScriptLimits {
  /** Per frame, so long animations are not starved by their first frames. */
  timeoutMs: number;
  memoryBytes: number;
  /** Host calls per frame. */
  maxCalls: number;
  maxLogLines: number;
}

const DEFAULT_LIMITS: ScriptLimits = {
  timeoutMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  maxCalls: 2_000_000,
  maxLogLines: 20,
};

const FILE_NAME = "draw.js";
const MAX_LOG_LINE = 300;

function toHandle(vm: QuickJSContext, value: unknown): QuickJSHandle | undefined {
  if (value === undefined) return undefined;
  if (value === null) return vm.null;
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "string") return vm.newString(value);
  if (typeof value === "boolean") return value ? vm.true : vm.false;
  if (Array.isArray(value)) {
    const array = vm.newArray();
    value.forEach((item, i) => {
      // setProp copies the value; static handles (null/true/...) ignore dispose.
      const handle = toHandle(vm, item) ?? vm.undefined;
      vm.setProp(array, i, handle);
      handle.dispose();
    });
    return array;
  }
  return undefined;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Runs scripts inside QuickJS compiled to WebAssembly: a separate JS engine with no
 * access to Node, the file system or the network. Node's own `vm` module would be
 * simpler but is not a security boundary, and this repo is meant to be shared.
 */
export class QuickJsScriptRunner implements IScriptRunner {
  private module?: Promise<QuickJSWASMModule>;
  private readonly limits: ScriptLimits;

  constructor(limits: Partial<ScriptLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async run(request: DrawScriptRequest): Promise<DrawScriptResult> {
    const QuickJS = await (this.module ??= getQuickJS());
    const started = Date.now();
    const frames: ScriptFrame[] = request.frames ?? [{ frame: 1, base: request.base }];
    if (frames.length === 0) throw new Error("draw script: no frames to draw");
    const seed = request.seed ?? 1;
    const scope: ScriptScope = {
      raster: new Raster(request.width, request.height),
      random: seededRandom(seed),
      noise: createValueNoise(seed),
    };
    const logs: string[] = [];
    let droppedLogs = 0;
    let frameCalls = 0;
    let totalCalls = 0;
    let callLimitHit = false;
    let logPrefix = "";

    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    const vm = runtime.newContext();

    try {
      const define = (name: string, handle: QuickJSHandle) => {
        vm.setProp(vm.global, name, handle);
        handle.dispose();
      };
      const expose = (name: string, fn: (...args: unknown[]) => unknown) => {
        define(
          name,
          vm.newFunction(name, (...args) => {
            if (++frameCalls > this.limits.maxCalls) {
              callLimitHit = true;
              throw new Error(`more than ${this.limits.maxCalls} drawing calls in one frame`);
            }
            try {
              return toHandle(vm, fn(...args.map((a) => vm.dump(a))));
            } catch (error) {
              // Prefixing the helper's name turns "x must be a number" into a fixable hint.
              const message = `${name}(): ${error instanceof Error ? error.message : String(error)}`;
              throw error instanceof TypeError ? new TypeError(message) : new Error(message);
            }
          }),
        );
      };

      define("W", vm.newNumber(request.width));
      define("H", vm.newNumber(request.height));
      for (const [name, fn] of Object.entries(createScriptApi(scope))) expose(name, fn);
      define(
        "__log",
        vm.newFunction("log", (...args) => {
          if (logs.length >= this.limits.maxLogLines) {
            droppedLogs++;
            return;
          }
          const line = args.map((a) => formatLogValue(vm.dump(a))).join(" ");
          logs.push(logPrefix + (line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line));
        }),
      );
      this.evalOrThrow(
        vm,
        "globalThis.console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };",
        "",
      );

      // Wrapping the script in a function allows a top-level `return`; the prefix stays on
      // line 1 so reported line numbers match the model's code.
      this.evalOrThrow(vm, `globalThis.__draw = function () {${request.code}\n};`, request.code);
      const draw = vm.getProp(vm.global, "__draw");

      const images = [];
      try {
        for (let index = 0; index < frames.length; index++) {
          const frame = frames[index];
          scope.raster = new Raster(request.width, request.height, frame.base);
          // Restarting rand() keeps random scenery identical in every frame (no flicker).
          scope.random = seededRandom(seed);
          frameCalls = 0;
          logPrefix = frames.length > 1 ? `[F=${frame.frame}] ` : "";
          define("F", vm.newNumber(frame.frame));
          define("i", vm.newNumber(index));
          define("n", vm.newNumber(frames.length));
          define("t", vm.newNumber(index / frames.length));

          runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.timeoutMs));
          const result = vm.callFunction(draw, vm.undefined);
          if (result.error) {
            const error = vm.dump(result.error);
            result.error.dispose();
            throw this.toScriptError(error, request.code, frames.length > 1 ? frame.frame : undefined, callLimitHit);
          }
          result.value.dispose();
          if (callLimitHit) {
            throw this.toScriptError({ message: "call limit" }, request.code, frame.frame, true);
          }
          totalCalls += frameCalls;
          images.push(scope.raster.image);
        }
      } finally {
        draw.dispose();
      }

      if (droppedLogs > 0) logs.push(`… ${droppedLogs} more console lines dropped`);
      return { images, image: images[0], calls: totalCalls, elapsedMs: Date.now() - started, logs };
    } finally {
      vm.dispose();
      runtime.dispose();
    }
  }

  private evalOrThrow(vm: QuickJSContext, code: string, source: string): void {
    const result = vm.evalCode(code, FILE_NAME);
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw this.toScriptError(error, source, undefined, false);
    }
    result.value.dispose();
  }

  /** Name, message, line number and the offending source line: what the model needs to fix it. */
  private toScriptError(error: unknown, code: string, frame: number | undefined, callLimitHit: boolean): ScriptError {
    const e = (error && typeof error === "object" ? error : { message: String(error) }) as {
      name?: string;
      message?: string;
      stack?: string;
      lineNumber?: number;
    };
    const where = frame === undefined ? "" : ` (frame F=${frame})`;
    if (callLimitHit) {
      return new ScriptError(
        `Script made more than ${this.limits.maxCalls} drawing calls${where}. Draw areas with rect/gradient/fill ` +
          "instead of set() per pixel, or split the work into several draw_script calls.",
        undefined,
        frame,
      );
    }
    if (e.name === "InternalError" && e.message === "interrupted") {
      return new ScriptError(
        `Script ran longer than ${this.limits.timeoutMs} ms${where}: check for an infinite loop or a loop ` +
          "bound that never changes; per-pixel loops over large regions should use rect/gradient instead.",
        undefined,
        frame,
      );
    }
    if (/out of memory/i.test(e.message ?? "")) {
      return new ScriptError(`Script ran out of memory (${this.limits.memoryBytes >> 20} MB)${where}.`, undefined, frame);
    }

    const match = new RegExp(`${FILE_NAME.replace(".", "\\.")}:(\\d+)`).exec(e.stack ?? "");
    const line = match ? Number(match[1]) : e.lineNumber;
    const source = line !== undefined ? code.split("\n")[line - 1]?.trim() : undefined;
    const at = line !== undefined ? ` at line ${line}${source ? `: ${source.slice(0, 120)}` : ""}` : "";
    const message = `${e.name ?? "Error"}: ${e.message ?? String(error)}${at}${where}`;
    return new ScriptError(message, line, frame);
  }
}
