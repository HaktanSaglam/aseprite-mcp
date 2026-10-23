import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/** The few file-system facts the policy needs, so tests can fake them. */
export interface PathProbe {
  homeDir(): string;
  /** "file", "dir", or null when nothing exists at `path`. */
  kind(path: string): "file" | "dir" | null;
  /** A small text file's content, or null when it can't be read (missing, too big...). */
  readText?(path: string): string | null;
  /** Where `path` really points after following symlinks, or null when it can't be resolved. */
  realPath?(path: string): string | null;
}

// Sprite-sheet JSON is a few hundred bytes per frame; a much bigger file is not one.
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export const nodePathProbe: PathProbe = {
  homeDir: () => homedir(),
  kind: (path) => {
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? "dir" : "file";
  },
  readText: (path) => {
    try {
      if (statSync(path).size > MAX_JSON_BYTES) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  realPath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

export interface OutputPathRules {
  /** Lower-case extensions including the dot, e.g. [".png", ".gif"]. */
  extensions: readonly string[];
  /** Replace an existing file instead of refusing. */
  overwrite?: boolean;
  /** The document's own file: writing over it is a normal save, not an accident. */
  currentFile?: string;
  /** What the path is for, used in error messages ("export path", "dataPath"). */
  label?: string;
}

/**
 * Validates where Aseprite may write a file on the model's behalf. The model only
 * sees text, so it must not be able to clobber the user's files by accident or write
 * somewhere unexpected (a relative path would land in Aseprite's working directory).
 * `overwrite` is a flag the model sets, so it never reaches settings: hidden folders
 * are refused and an existing .json is only replaced when it is sprite-sheet data.
 * Returns the normalized absolute path.
 */
export function resolveOutputPath(raw: string, rules: OutputPathRules, probe: PathProbe = nodePathProbe): string {
  const label = rules.label ?? "path";
  const path = absoluteUserPath(raw, rules.extensions, label, probe);
  const isCurrent = rules.currentFile !== undefined && isAbsolute(rules.currentFile) && resolve(rules.currentFile) === path;
  const ext = requireExtension(path, rules.extensions, label);

  const hidden = hiddenSegment(path);
  if (hidden !== undefined && !isCurrent) {
    throw new Error(
      `${label} "${path}" is inside "${hidden}", a hidden name where apps keep their settings; ` +
        "choose a normal folder such as ~/Desktop or ~/Pictures",
    );
  }

  const parent = dirname(path);
  if (probe.kind(parent) !== "dir") {
    throw new Error(`Folder "${parent}" does not exist; choose an existing folder for ${label}`);
  }

  const existing = probe.kind(path);
  if (existing === "dir") throw new Error(`"${path}" is a folder; ${label} must be a file name`);
  if (existing === "file" && ext === ".json" && !isSpriteSheetJson(probe.readText?.(path) ?? null)) {
    throw new Error(
      `"${path}" already exists and is not Aseprite sprite-sheet data, so it is never replaced; choose another name`,
    );
  }
  if (existing === "file" && !rules.overwrite && !isCurrent) {
    throw new Error(`"${path}" already exists; pass overwrite: true to replace it or choose another name`);
  }
  return path;
}

export interface InputPathRules {
  /** Lower-case extensions including the dot, e.g. [".png"]. */
  extensions: readonly string[];
  /** What the path is for, used in error messages. */
  label?: string;
}

/**
 * Validates a file the bridge reads on the model's behalf. Same rules as for writing
 * (absolute or ~/, local, an allowed extension) plus: the file must exist, and neither
 * the path nor where its symlinks lead may be inside a hidden folder, so a model can't
 * be talked into reading app settings or keys. Returns the normalized absolute path.
 */
export function resolveInputPath(raw: string, rules: InputPathRules, probe: PathProbe = nodePathProbe): string {
  const label = rules.label ?? "path";
  const path = absoluteUserPath(raw, rules.extensions, label, probe);
  requireExtension(path, rules.extensions, label);
  const hidden = hiddenSegment(path);
  if (hidden !== undefined) {
    throw new Error(
      `${label} "${path}" is inside "${hidden}", a hidden name where apps keep their settings; ` +
        "move the file to a normal folder such as ~/Desktop or ~/Pictures",
    );
  }

  const kind = probe.kind(path);
  if (kind === null) throw new Error(`"${path}" does not exist; check the name and folder (absolute, or ~/ for home)`);
  if (kind === "dir") throw new Error(`"${path}" is a folder; ${label} must name a ${rules.extensions.join("/")} file`);

  const real = probe.realPath?.(path);
  if (real && real !== path) {
    if (isNetworkPath(real)) throw new Error(`${label} "${path}" links to the network path "${real}"; it is not read`);
    const realHidden = hiddenSegment(real);
    if (realHidden !== undefined) {
      throw new Error(`${label} "${path}" links to "${real}" inside the hidden "${realHidden}"; it is not read`);
    }
    requireExtension(real, rules.extensions, label);
  }
  return path;
}

/**
 * Trims, refuses network paths, expands "~/" and requires an absolute path; returns it
 * normalized (".." resolved).
 */
function absoluteUserPath(raw: string, extensions: readonly string[], label: string, probe: PathProbe): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  // Checked before any file-system probe: on Windows merely looking at \\host\share
  // opens an SMB connection that sends the user's credentials to that host.
  if (isNetworkPath(trimmed)) {
    throw new Error(`${label} must be on this computer; network paths like "${trimmed}" are not allowed`);
  }
  const expanded = expandHome(trimmed, probe, label);
  if (!isAbsolute(expanded)) {
    throw new Error(`${label} must be absolute (e.g. ~/Desktop/hero${extensions[0] ?? ""}); got "${raw}"`);
  }
  return resolve(expanded);
}

/** The path's lower-case extension, which must be one of `extensions`. */
function requireExtension(path: string, extensions: readonly string[], label: string): string {
  const ext = extname(path).toLowerCase();
  if (!extensions.includes(ext)) {
    throw new Error(`${label} must end with ${extensions.join(", ")}; got "${ext || "no extension"}" in "${path}"`);
  }
  return ext;
}

/** UNC and device paths: \\host\share, //host/share, \\?\..., \\.\... */
function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** The first folder (or file) name that starts with "." (~/.config, ~/.claude, .git...). */
function hiddenSegment(path: string): string | undefined {
  return path.split(/[\\/]/).find((segment) => segment.startsWith("."));
}

/** Aseprite's sprite-sheet data: a JSON object whose "frames" is a list or a map. */
function isSpriteSheetJson(text: string | null): boolean {
  if (text === null) return false;
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
    const frames: unknown = (data as Record<string, unknown>).frames;
    return typeof frames === "object" && frames !== null;
  } catch {
    return false;
  }
}

function expandHome(path: string, probe: PathProbe, label: string): string {
  if (path === "~") return probe.homeDir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return probe.homeDir() + path.slice(1);
  if (path.startsWith("~")) throw new Error(`${label}: only "~/" is supported for the home folder, not "${path}"`);
  return path;
}
