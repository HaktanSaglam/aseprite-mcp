import { describe, expect, it } from "vitest";
import { claudeChildEnv } from "../src/llm/claudeEnv.js";

describe("claudeChildEnv", () => {
  it("drops the parent session's variables and the API key, keeps user configuration", () => {
    const env = claudeChildEnv({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_ENTRYPOINT: "sdk",
      CLAUDE_AGENT_SDK_VERSION: "1",
      CLAUDE_EFFORT: "high",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    });
    expect(env).toEqual({
      PATH: "/bin",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    });
  });

  it("keeps a gateway base URL when not started from Claude Code", () => {
    expect(claudeChildEnv({ ANTHROPIC_BASE_URL: "https://gw.example" }).ANTHROPIC_BASE_URL).toBe("https://gw.example");
  });
});
