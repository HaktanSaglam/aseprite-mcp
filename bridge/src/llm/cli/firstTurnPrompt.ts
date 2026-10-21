import { connectMcpToolHost } from "../agent/McpToolHost.js";

/** Where the MCP server's own usage instructions come from (stubbed in tests). */
export type InstructionsSource = (mcpUrl: string) => Promise<string | undefined>;

/** Best effort: a run without the server's drawing guidance still works, just less well. */
export const fetchMcpInstructions: InstructionsSource = async (mcpUrl) => {
  try {
    const host = await connectMcpToolHost(mcpUrl);
    try {
      return host.instructions;
    } finally {
      await host.close();
    }
  } catch {
    return undefined;
  }
};

/**
 * Codex and Gemini CLIs have no "append to system prompt" flag, so the bridge's
 * instructions open the first message of a conversation; resumed turns already have them.
 */
export function firstTurnPrompt(systemPrompt: string, serverInstructions: string | undefined, prompt: string): string {
  const instructions = [serverInstructions?.trim(), systemPrompt.trim()].filter(Boolean).join("\n\n");
  return instructions ? `<instructions>\n${instructions}\n</instructions>\n\n${prompt}` : prompt;
}
