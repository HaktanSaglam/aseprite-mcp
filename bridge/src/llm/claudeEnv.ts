/**
 * Environment for the Claude Code CLI child process.
 *
 * Started from a Claude Code terminal, the bridge inherits that session's internal
 * variables (CLAUDECODE, CLAUDE_CODE_SESSION_ID, an ANTHROPIC_BASE_URL pointing at the
 * session's proxy, ...); passed on, they make the child use the parent's short-lived
 * credentials. User configuration (Bedrock/Vertex switches, a long-lived OAuth token,
 * client certificates) must survive, though.
 *
 * ANTHROPIC_API_KEY is dropped too: this provider promises the user's subscription, and
 * with a key in the environment the CLI would bill the API instead. The "anthropic"
 * provider is the one that uses keys.
 */
const KEEP = /^CLAUDE_CODE_(USE_|SKIP_[A-Z]+_AUTH$|MAX_|DISABLE_NONESSENTIAL|CLIENT_|API_KEY_HELPER|OAUTH_TOKEN$)/;
const SESSION_ONLY = /^(CLAUDECODE|CLAUDE_AGENT_SDK_.*|CLAUDE_EFFORT|CLAUDE_PID|CLAUDE_PREVIEW_.*)$/;

export function claudeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const insideClaudeCode = env.CLAUDECODE !== undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "ANTHROPIC_API_KEY") continue;
    if (SESSION_ONLY.test(key)) continue;
    if (key.startsWith("CLAUDE_CODE_") && !KEEP.test(key)) continue;
    // A gateway URL the user set is kept; the parent session's proxy is not.
    if (key === "ANTHROPIC_BASE_URL" && insideClaudeCode) continue;
    out[key] = value;
  }
  return out;
}
