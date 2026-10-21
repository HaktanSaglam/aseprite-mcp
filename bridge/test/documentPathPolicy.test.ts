import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodePathProbe, resolveOutputPath, type PathProbe } from "../src/canvas/pathPolicy.js";

/** A tiny fake file system: a set of folders and a set of files. */
function probe(dirs: string[], files: string[] = [], home = "/home/me"): PathProbe {
  return {
    homeDir: () => home,
    kind: (path) => (dirs.includes(path) ? "dir" : files.includes(path) ? "file" : null),
  };
}

const PNG = { extensions: [".png"] };
const fs = probe(["/art", "/home/me", "/home/me/Desktop"], ["/art/hero.png", "/art/hero.aseprite"]);

describe("resolveOutputPath", () => {
  it("accepts an absolute path in an existing folder", () => {
    expect(resolveOutputPath("/art/new.png", PNG, fs)).toBe("/art/new.png");
  });

  it("expands a leading ~ to the home folder", () => {
    expect(resolveOutputPath("~/Desktop/a.png", PNG, fs)).toBe("/home/me/Desktop/a.png");
  });

  it("rejects other ~user forms", () => {
    expect(() => resolveOutputPath("~bob/a.png", PNG, fs)).toThrow(/only "~\/"/);
  });

  it("trims whitespace and normalizes .. segments", () => {
    expect(resolveOutputPath("  /art/sub/../new.png ", PNG, fs)).toBe("/art/new.png");
  });

  it("rejects relative paths with an example of a valid one", () => {
    expect(() => resolveOutputPath("hero.png", PNG, fs)).toThrow(/must be absolute.*~\/Desktop\/hero\.png/);
  });

  it("rejects empty paths", () => {
    expect(() => resolveOutputPath("   ", PNG, fs)).toThrow(/must not be empty/);
  });

  it("rejects extensions outside the allowed list, case-insensitively accepting the rest", () => {
    expect(() => resolveOutputPath("/art/a.jpg", PNG, fs)).toThrow(/must end with \.png.*\.jpg/);
    expect(() => resolveOutputPath("/art/a", PNG, fs)).toThrow(/no extension/);
    expect(resolveOutputPath("/art/A.PNG", PNG, fs)).toBe("/art/A.PNG");
  });

  it("requires the parent folder to exist", () => {
    expect(() => resolveOutputPath("/missing/a.png", PNG, fs)).toThrow(/Folder "\/missing" does not exist/);
  });

  it("refuses to overwrite an existing file unless asked", () => {
    expect(() => resolveOutputPath("/art/hero.png", PNG, fs)).toThrow(/already exists.*overwrite: true/);
    expect(resolveOutputPath("/art/hero.png", { ...PNG, overwrite: true }, fs)).toBe("/art/hero.png");
  });

  it("allows writing over the document's own file", () => {
    const rules = { extensions: [".aseprite"], currentFile: "/art/hero.aseprite" };
    expect(resolveOutputPath("/art/hero.aseprite", rules, fs)).toBe("/art/hero.aseprite");
    expect(() => resolveOutputPath("/art/hero.aseprite", { extensions: [".aseprite"], currentFile: "Sprite-0001" }, fs)).toThrow(
      /already exists/,
    );
  });

  it("refuses a path that is a folder", () => {
    const withFolder = probe(["/art", "/art/x.png"]);
    expect(() => resolveOutputPath("/art/x.png", PNG, withFolder)).toThrow(/is a folder/);
  });

  it("uses the label in messages", () => {
    expect(() => resolveOutputPath("a.json", { extensions: [".json"], label: "dataPath" }, fs)).toThrow(/^dataPath must be absolute/);
  });
});

describe("nodePathProbe (real file system)", () => {
  const root = mkdtempSync(join(tmpdir(), "amcp-path-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "taken.png"), "x");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("sees files and folders", () => {
    expect(nodePathProbe.kind(root)).toBe("dir");
    expect(nodePathProbe.kind(join(root, "taken.png"))).toBe("file");
    expect(nodePathProbe.kind(join(root, "nope.png"))).toBeNull();
  });

  it("works end to end with the default probe", () => {
    expect(resolveOutputPath(join(root, "sub", "a.png"), PNG)).toBe(join(root, "sub", "a.png"));
    expect(() => resolveOutputPath(join(root, "taken.png"), PNG)).toThrow(/already exists/);
  });
});
