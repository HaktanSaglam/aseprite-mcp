import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/** The few file-system facts the policy needs, so tests can fake them. */
export interface PathProbe {
  homeDir(): string;
  /** "file", "dir", or null when nothing exists at `path`. */
  kind(path: string): "file" | "dir" | null;
}

export const nodePathProbe: PathProbe = {
  homeDir: () => homedir(),
  kind: (path) => {
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? "dir" : "file";
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
 * Returns the normalized absolute path.
 */
export function resolveOutputPath(raw: string, rules: OutputPathRules, probe: PathProbe = nodePathProbe): string {
  const label = rules.label ?? "path";
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);

  const expanded = expandHome(trimmed, probe, label);
  if (!isAbsolute(expanded)) {
    throw new Error(
      `${label} must be absolute (e.g. ~/Desktop/hero${rules.extensions[0] ?? ""}); got "${raw}"`,
    );
  }
  const path = resolve(expanded);

  const ext = extname(path).toLowerCase();
  if (!rules.extensions.includes(ext)) {
    throw new Error(
      `${label} must end with ${rules.extensions.join(", ")}; got "${ext || "no extension"}" in "${path}"`,
    );
  }

  const parent = dirname(path);
  if (probe.kind(parent) !== "dir") {
    throw new Error(`Folder "${parent}" does not exist; choose an existing folder for ${label}`);
  }

  const existing = probe.kind(path);
  if (existing === "dir") throw new Error(`"${path}" is a folder; ${label} must be a file name`);
  const isCurrent = rules.currentFile !== undefined && isAbsolute(rules.currentFile) && resolve(rules.currentFile) === path;
  if (existing === "file" && !rules.overwrite && !isCurrent) {
    throw new Error(`"${path}" already exists; pass overwrite: true to replace it or choose another name`);
  }
  return path;
}

function expandHome(path: string, probe: PathProbe, label: string): string {
  if (path === "~") return probe.homeDir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return probe.homeDir() + path.slice(1);
  if (path.startsWith("~")) throw new Error(`${label}: only "~/" is supported for the home folder, not "${path}"`);
  return path;
}
