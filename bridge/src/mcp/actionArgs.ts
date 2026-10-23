/**
 * Multi-action tools (edit_sprite, manage_layers, set_selection, ...) take one flat
 * argument object. An argument the chosen action ignores usually means the model
 * picked the wrong action, so name it instead of silently dropping it.
 */
export function rejectUnusedArgs(action: string, args: object, used: readonly string[]): void {
  const unused = Object.entries(args)
    .filter(([key, value]) => key !== "action" && value !== undefined && !used.includes(key))
    .map(([key]) => key);
  if (unused.length === 0) return;
  const takes = used.length > 0 ? `It takes: ${used.join(", ")}.` : "It takes no other arguments.";
  throw new Error(`'${action}' does not use ${unused.join(", ")}. ${takes}`);
}
