import { describe, expect, it } from "vitest";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { QuickJsScriptRunner } from "../src/script/QuickJsScriptRunner.js";
import { ScriptError } from "../src/script/ScriptRunner.js";

const runner = new QuickJsScriptRunner();

function pixel(image: { width: number; data: Uint8Array }, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return [...image.data.subarray(o, o + 4)];
}

async function errorOf(promise: Promise<unknown>): Promise<ScriptError> {
  try {
    await promise;
  } catch (error) {
    return error as ScriptError;
  }
  throw new Error("expected the script to fail");
}

describe("QuickJsScriptRunner", () => {
  it("draws with the helpers and returns calls/elapsed", async () => {
    const result = await runner.run({ code: 'rect(0, 0, W, H, "#ff0000"); set(1, 1, "#00ff00");', width: 3, height: 2 });
    expect(pixel(result.image, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(result.image, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(result.images).toHaveLength(1);
    expect(result.calls).toBe(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns arrays from host helpers (ramp) and values (get, textWidth, noise)", async () => {
    const result = await runner.run({
      code: `
        const r = ramp("#3b7d4f", 4);
        console.log(Array.isArray(r), r.length, r[1]);
        set(0, 0, r[0]);
        console.log(get(0, 0) === r[0], get(1, 0), textWidth("AB"), typeof noise(1, 2));
      `,
      width: 2,
      height: 1,
    });
    expect(result.logs).toEqual(["true 4 #3b7d4f", "true null 7 number"]);
  });

  it("runs once per frame with F, i, n, t and starts each frame from its base", async () => {
    const base = createRgbaImage(4, 1);
    base.data.set([9, 9, 9, 255], 0);
    const result = await runner.run({
      code: 'console.log(F, i, n, t); set(i + 1, 0, "#ffffff");',
      width: 4,
      height: 1,
      frames: [{ frame: 5, base }, { frame: 6 }, { frame: 7, base }],
    });
    expect(result.logs).toEqual(["[F=5] 5 0 3 0", `[F=6] 6 1 3 ${1 / 3}`, `[F=7] 7 2 3 ${2 / 3}`]);
    expect(result.images).toHaveLength(3);
    expect(pixel(result.images[0], 0, 0)).toEqual([9, 9, 9, 255]);
    expect(pixel(result.images[1], 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(result.images[2], 3, 0)).toEqual([255, 255, 255, 255]);
    // Frames do not leak into each other.
    expect(pixel(result.images[2], 1, 0)).toEqual([0, 0, 0, 0]);
    // The caller's base image is never mutated.
    expect(pixel(base, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it("restarts rand() every frame so random scenery does not flicker", async () => {
    const result = await runner.run({
      code: "console.log(rand(1000), rand(1000));",
      width: 1,
      height: 1,
      seed: 42,
      frames: [{ frame: 1 }, { frame: 2 }],
    });
    expect(result.logs[0].replace("[F=1] ", "")).toBe(result.logs[1].replace("[F=2] ", ""));
  });

  it("allows a top-level return and top-level let i / const F", async () => {
    const result = await runner.run({
      code: 'let i = 0; const F = "mine"; set(0, 0, "#fff"); if (i === 0) return; set(1, 0, "#fff");',
      width: 2,
      height: 1,
    });
    expect(pixel(result.image, 0, 0)[3]).toBe(255);
    expect(pixel(result.image, 1, 0)[3]).toBe(0);
  });

  it("caps console output", async () => {
    const limited = new QuickJsScriptRunner({ maxLogLines: 3 });
    const result = await limited.run({ code: "for (let k = 0; k < 10; k++) console.log('line', k, {k});", width: 1, height: 1 });
    expect(result.logs).toEqual(['line 0 {"k":0}', 'line 1 {"k":1}', 'line 2 {"k":2}', "… 7 more console lines dropped"]);
  });

  it("reports syntax errors with the line and its source", async () => {
    const error = await errorOf(runner.run({ code: 'set(0, 0, "#fff");\nlet b = ;\n', width: 1, height: 1 }));
    expect(error).toBeInstanceOf(ScriptError);
    expect(error.line).toBe(2);
    expect(error.message).toMatch(/^SyntaxError: .* at line 2: let b = ;/);
  });

  it("names the helper and the bad argument for host errors", async () => {
    const error = await errorOf(runner.run({ code: 'rect(0, 0, 2, 2, "#fff");\nset(0, "a", "#fff");', width: 2, height: 2 }));
    expect(error.message).toContain('TypeError: set(): y must be a number, got "a"');
    expect(error.message).toContain('at line 2: set(0, "a", "#fff");');
    const color = await errorOf(runner.run({ code: 'rect(0, 0, 1, 1, "reddish");', width: 1, height: 1 }));
    expect(color.message).toMatch(/rect\(\): Invalid color "reddish"/);
    const options = await errorOf(runner.run({ code: 'gradient(0, 0, 1, 1, ["#000"], "diagonal");', width: 1, height: 1 }));
    expect(options.message).toMatch(/dir must be one of "v", "h", "radial"/);
  });

  it("reports runtime errors with the frame for animations", async () => {
    const error = await errorOf(
      runner.run({
        code: "if (F === 3) undefinedThing();",
        width: 1,
        height: 1,
        frames: [{ frame: 2 }, { frame: 3 }],
      }),
    );
    expect(error.message).toMatch(/ReferenceError: .*undefinedThing.* at line 1: .* \(frame F=3\)/);
    expect(error.frame).toBe(3);
  });

  it("stops infinite loops with an actionable timeout", async () => {
    const fast = new QuickJsScriptRunner({ timeoutMs: 100 });
    const error = await errorOf(fast.run({ code: "while (true) {}", width: 1, height: 1 }));
    expect(error.message).toMatch(/longer than 100 ms.*infinite loop/);
  });

  it("enforces the call limit even if the script swallows the error", async () => {
    const limited = new QuickJsScriptRunner({ maxCalls: 50 });
    const error = await errorOf(
      limited.run({ code: 'for (let k = 0; k < 100; k++) { try { set(0, 0, "#fff"); } catch (e) {} }', width: 1, height: 1 }),
    );
    expect(error.message).toMatch(/more than 50 drawing calls/);
  });

  it("isolates scripts from the host", async () => {
    const result = await runner.run({
      code: "console.log(typeof process, typeof require, typeof fetch, typeof globalThis.setTimeout);",
      width: 1,
      height: 1,
    });
    expect(result.logs).toEqual(["undefined undefined undefined undefined"]);
  });
});
