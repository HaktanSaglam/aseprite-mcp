import { describe, expect, it } from "vitest";
import { registerEffectTools } from "../src/mcp/tools/effects.js";
import { TOOL_REGISTRARS } from "../src/mcp/tools/index.js";
import { analyzeImage } from "../src/pixel/analyze.js";
import { cleanupPixels } from "../src/pixel/effects/cleanup.js";
import type { IssueKind } from "../src/pixel/quality/index.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness } from "./fakes/toolHarness.js";
import {
  bandedTile,
  doubledBall,
  fringedBall,
  galleryArt,
  gallerySprite,
  gappyBall,
  litBall,
  noisyBall,
  paleBall,
  pillowBall,
  softBall,
  withPixels,
} from "./fixtures/qualityArt.js";

const CLEAN: [string, () => RgbaImage][] = [
  ["the README knight scene", () => galleryArt("knight")],
  ["the README item icons", () => galleryArt("items")],
  ["the README cabin scene", () => galleryArt("cabin")],
  ["the README item icons on transparency", () => gallerySprite("items")],
  ["a lit, outlined ball", () => litBall()],
  ["a big lit ball", () => litBall(64, 26)],
];

const strays = () =>
  withPixels(litBall(), [
    [2, 2, "#ff0000"],
    [29, 3, "#ff0000"],
    [3, 28, "#00ff00"],
    [28, 28, "#0000ff"],
    [15, 1, "#ffffff"],
    [1, 15, "#ffffff"],
  ]);

const BROKEN: [string, () => RgbaImage, IssueKind][] = [
  ["stray pixels", strays, "stray_pixels"],
  ["holes in the outline", gappyBall, "outline_gaps"],
  ["an 8-connected (doubled) outline", doubledBall, "doubled_corners"],
  ["concentric pillow shading", pillowBall, "pillow_shading"],
  ["a semi-transparent rim", softBall, "aa_against_transparency"],
  ["a light fringe left by a white background", fringedBall, "aa_against_transparency"],
  ["hundreds of noisy colors", noisyBall, "too_many_colors"],
  ["four nearly equal pale tones", paleBall, "low_contrast"],
  ["lock-step diagonal stripes", bandedTile, "banding"],
];

describe("quality score: clean art", () => {
  it.each(CLEAN)("%s scores 85 or more", (_name, make) => {
    const { score } = analyzeImage(make());
    expect(score).toBeGreaterThanOrEqual(85);
  });

  it("an empty image is not penalised", () => {
    expect(analyzeImage(createRgbaImage(8, 8))).toMatchObject({ score: 100, issues: [] });
  });
});

describe("quality score: broken art", () => {
  const clean = analyzeImage(litBall()).score;

  it.each(BROKEN)("%s scores clearly lower and is named first", (_name, make, kind) => {
    const { score, issues } = analyzeImage(make());
    expect(score).toBeLessThanOrEqual(80);
    expect(score).toBeLessThan(clean - 10);
    expect(issues[0].kind).toBe(kind);
  });

  it("adds up several problems", () => {
    const art = withPixels(softBall(), [
      [2, 2, "#ff0000"],
      [29, 3, "#ff0000"],
      [3, 28, "#00ff00"],
      [28, 28, "#0000ff"],
    ]);
    const { score, issues } = analyzeImage(art);
    expect(score).toBeLessThan(70);
    expect(issues.map((i) => i.kind)).toEqual(["aa_against_transparency", "stray_pixels"]);
  });

  it("cleaning up raises the score again", () => {
    const fixed = cleanupPixels(strays()).image;
    expect(analyzeImage(fixed).score).toBeGreaterThan(analyzeImage(strays()).score);
    expect(analyzeImage(fixed).score).toBeGreaterThanOrEqual(85);
  });
});

describe("quality issues", () => {
  it("say where the problem is and name a tool that exists", async () => {
    const h = await toolHarness(TOOL_REGISTRARS, new FakeGateway());
    const tools = new Set((await h.listTools()).map((t) => t.name));
    await h.close();
    for (const [, make] of BROKEN) {
      for (const issue of analyzeImage(make()).issues) {
        expect(tools, issue.fixWith).toContain(issue.fixWith);
        expect(issue.message.length).toBeGreaterThan(30);
        expect(issue.region !== undefined || (issue.x !== undefined && issue.y !== undefined)).toBe(true);
      }
    }
  });

  it("point at the exact pixels for outline gaps and doubled corners", () => {
    const gaps = analyzeImage(gappyBall()).issues[0];
    expect(gaps).toMatchObject({ kind: "outline_gaps", region: { x: 4, y: 11, width: 2, height: 10 } });
    const doubled = analyzeImage(doubledBall()).issues[0];
    expect(doubled.region).toEqual({ x: 4, y: 4, width: 24, height: 24 });
  });

  it("tell a light fringe (erase it) from semi-transparent pixels (snap alpha)", () => {
    expect(analyzeImage(fringedBall()).issues[0]).toMatchObject({ fixWith: "write_pixels" });
    expect(analyzeImage(fringedBall()).issues[0].message).toMatch(/lighter pixels outside the dark outline/);
    expect(analyzeImage(softBall()).issues[0]).toMatchObject({ fixWith: "normalize_pixel_art" });
  });

  it("suggest merges for near-duplicate colors that don't chain", () => {
    const issue = analyzeImage(paleBall()).issues.find((i) => i.kind === "near_duplicate_colors")!;
    const swaps = [...issue.message.matchAll(/\{from: "(#\w+)", to: "(#\w+)"\}/g)].map((m) => ({ from: m[1], to: m[2] }));
    expect(swaps.length).toBeGreaterThan(1);
    const froms = new Set(swaps.map((s) => s.from));
    for (const swap of swaps) expect(froms.has(swap.to)).toBe(false);
  });

  it("list at most 5, worst first", () => {
    const art = withPixels(noisyBall(), [
      [2, 2, "#ff0000"],
      [29, 3, "#ff000080"],
      [3, 28, "#00ff00"],
    ]);
    const { issues } = analyzeImage(art);
    expect(issues.length).toBeLessThanOrEqual(5);
    expect(issues[0].kind).toBe("too_many_colors");
  });

  it("stay fast on a 128x128 sprite", () => {
    const art = litBall(128, 55);
    analyzeImage(art);
    const started = performance.now();
    for (let i = 0; i < 5; i++) analyzeImage(art);
    // Measured ~6 ms; the bound leaves room for slow CI machines.
    expect((performance.now() - started) / 5).toBeLessThan(50);
  });
});

describe("analyze_sprite", () => {
  it("returns the score and issues ahead of the stats", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 8, height: 8 });
    gw.fillRect({ x: 1, y: 1, width: 1, height: 1, color: "#ff0000" });
    gw.fillRect({ x: 4, y: 4, width: 3, height: 3, color: "#00ff00" });
    const h = await toolHarness([registerEffectTools], gw);
    const result = await h.json("analyze_sprite");
    await h.close();
    expect(Object.keys(result).slice(0, 4)).toEqual(["layer", "frame", "score", "issues"]);
    expect(result.score).toBeLessThan(100);
    expect(result.issues[0]).toMatchObject({ kind: "stray_pixels", x: 1, y: 1, fixWith: "cleanup_pixels" });
  });
});
