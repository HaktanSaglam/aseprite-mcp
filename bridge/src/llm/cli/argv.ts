/**
 * On Windows the CLIs are npm .cmd shims started through cmd.exe, which ends the command
 * line at the first newline. A prompt passed as an argument therefore has to be one line
 * there; elsewhere it stays untouched.
 */
export function singleLineOnWindows(text: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? text.replace(/\s*\r?\n\s*/g, " ") : text;
}
