import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * launchd agents and apps started from the Dock get a minimal PATH, so a CLI installed
 * with Homebrew or npm can be missing from PATH while being right there on disk.
 */
function fallbackDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".claude", "local"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
  ];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a command the way a shell would (PATH, then common install dirs) and
 * returns its absolute path, or undefined when it is not installed.
 */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!command) return undefined;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : undefined;
  }
  // npm puts an extensionless sh script next to claude.cmd on Windows; only the .cmd/.exe
  // can be started, so PATHEXT extensions come first and the bare name only if it has one.
  const pathExt = (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  const hasExt = pathExt.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const extensions = process.platform === "win32" ? (hasExt ? [""] : pathExt) : [""];
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...fallbackDirs()];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}
