import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodePathProbe, resolveOutputPath, type PathProbe } from "../src/canvas/pathPolicy.js";

/** POSIX-style test paths as the platform resolves them ("/art" → "D:\\art" on Windows). */
const abs = (path: string) => resolve(path);
const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** A tiny fake file system: a set of folders and a set of files. */
function probe(dirs: string[], files: string[] = [], home = "/home/me"): PathProbe {
  const d = dirs.map(abs);
  const f = files.map(abs);
  return {
    homeDir: () => abs(home),
    kind: (path) => (d.includes(path) ? "dir" : f.includes(path) ? "file" : null),
  };
}

const PNG = { extensions: [".png"] };
const fs = probe(["/art", "/home/me", "/home/me/Desktop"], ["/art/hero.png", "/art/hero.aseprite"]);

describe("resolveOutputPath", () => {
  it("accepts an absolute path in an existing folder", () => {
    expect(resolveOutputPath("/art/new.png", PNG, fs)).toBe(abs("/art/new.png"));
  });

  it("expands a leading ~ to the home folder", () => {
    expect(resolveOutputPath("~/Desktop/a.png", PNG, fs)).toBe(abs("/home/me/Desktop/a.png"));
  });

  it("rejects other ~user forms", () => {
    expect(() => resolveOutputPath("~bob/a.png", PNG, fs)).toThrow(/only "~\/"/);
  });

  it("trims whitespace and normalizes .. segments", () => {
    expect(resolveOutputPath("  /art/sub/../new.png ", PNG, fs)).toBe(abs("/art/new.png"));
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
    expect(resolveOutputPath("/art/A.PNG", PNG, fs)).toBe(abs("/art/A.PNG"));
  });

  it("requires the parent folder to exist", () => {
    expect(() => resolveOutputPath("/missing/a.png", PNG, fs)).toThrow(new RegExp(`Folder "${escapeRegex(abs("/missing"))}" does not exist`));
  });

  it("refuses to overwrite an existing file unless asked", () => {
    expect(() => resolveOutputPath("/art/hero.png", PNG, fs)).toThrow(/already exists.*overwrite: true/);
    expect(resolveOutputPath("/art/hero.png", { ...PNG, overwrite: true }, fs)).toBe(abs("/art/hero.png"));
  });

  it("allows writing over the document's own file", () => {
    const rules = { extensions: [".aseprite"], currentFile: abs("/art/hero.aseprite") };
    expect(resolveOutputPath("/art/hero.aseprite", rules, fs)).toBe(abs("/art/hero.aseprite"));
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

  it("refuses network (UNC) paths before touching the file system", () => {
    const untouchable: PathProbe = {
      homeDir: () => abs("/home/me"),
      kind: () => {
        throw new Error("probed a network path");
      },
    };
    for (const path of ["\\\\attacker.example\\share\\x.png", "//attacker.example/share/x.png", "\\\\?\\C:\\x.png", "/\\host\\x.png"]) {
      expect(() => resolveOutputPath(path, PNG, untouchable)).toThrow(/network paths .* are not allowed/);
    }
  });

  it("refuses hidden folders and dotfiles, where apps keep their settings", () => {
    const home = probe(["/home/me", "/home/me/.claude", "/home/me/.config/app"]);
    expect(() => resolveOutputPath("~/.claude/settings.json", { extensions: [".json"], overwrite: true }, home)).toThrow(
      /inside "\.claude", a hidden name/,
    );
    expect(() => resolveOutputPath("~/.config/app/x.png", PNG, home)).toThrow(/hidden name/);
    expect(() => resolveOutputPath("~/.hero.png", PNG, home)).toThrow(/hidden name/);
    // Saving the document over itself stays a normal save, wherever the user keeps it.
    const own = { extensions: [".aseprite"], currentFile: abs("/home/me/.config/app/own.aseprite") };
    expect(resolveOutputPath("~/.config/app/own.aseprite", own, home)).toBe(abs("/home/me/.config/app/own.aseprite"));
  });

  it("only replaces an existing .json when it is Aseprite sprite-sheet data", () => {
    const texts: Record<string, string> = {
      [abs("/art/sheet.json")]: '{"frames": {"hero 0.aseprite": {}}, "meta": {"app": "https://www.aseprite.org/"}}',
      [abs("/art/package.json")]: '{"name": "my-app", "scripts": {}}',
      [abs("/art/broken.json")]: "{ not json",
    };
    const files = probe(["/art"], Object.keys(texts));
    const withText: PathProbe = { ...files, readText: (path) => texts[path] ?? null };
    const json = { extensions: [".json"], overwrite: true, label: "dataPath" };
    expect(resolveOutputPath("/art/sheet.json", json, withText)).toBe(abs("/art/sheet.json"));
    for (const name of ["package.json", "broken.json"]) {
      expect(() => resolveOutputPath(`/art/${name}`, json, withText)).toThrow(/not Aseprite sprite-sheet data/);
      // The advice must not be "pass overwrite: true" when that would not help.
      expect(() => resolveOutputPath(`/art/${name}`, { ...json, overwrite: false }, withText)).toThrow(/choose another name/);
    }
    // A probe that can't read files never lets an existing .json be replaced.
    expect(() => resolveOutputPath("/art/sheet.json", json, files)).toThrow(/not Aseprite sprite-sheet data/);
    expect(resolveOutputPath("/art/new.json", json, withText)).toBe(abs("/art/new.json"));
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

  it("reads existing .json files to tell sprite-sheet data from anything else", () => {
    writeFileSync(join(root, "sheet.json"), JSON.stringify({ frames: [], meta: { app: "aseprite" } }));
    writeFileSync(join(root, "config.json"), JSON.stringify({ apiKey: "x" }));
    const json = { extensions: [".json"], overwrite: true };
    expect(resolveOutputPath(join(root, "sheet.json"), json)).toBe(join(root, "sheet.json"));
    expect(() => resolveOutputPath(join(root, "config.json"), json)).toThrow(/not Aseprite sprite-sheet data/);
    expect(nodePathProbe.readText!(join(root, "missing.json"))).toBeNull();
  });
});
