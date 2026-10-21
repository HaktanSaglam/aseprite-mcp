# AI providers

The chat inside Aseprite can run on several back-ends. All of them implement
`ILlmRunner` (`LlmRunner.ts`) and are created by `createProviderRegistry()`
(`ProviderRegistry.ts`). Every provider drives the same thing: the bridge's MCP tools.

| id | What it runs | Sign-in | Images | Effort | Status |
|---|---|---|---|---|---|
| `claude-code` (default) | Claude Code CLI (`claude -p`) | your Claude subscription (`claude auth login`) | yes | low…max | stable |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` | yes | low…max | stable |
| `openai` | any Chat Completions API: OpenAI, OpenRouter, LM Studio, Groq, DeepSeek, vLLM… | `OPENAI_API_KEY` (not needed for local servers) | yes¹ | low…high² | stable |
| `ollama` | local models through Ollama's OpenAI-compatible API | none | off¹ | – | stable |
| `codex` | OpenAI Codex CLI (`codex exec --json`) | your ChatGPT plan (`codex login`) | yes | low…xhigh | experimental |
| `gemini-cli` | Google Gemini CLI (`gemini --output-format stream-json`) | your Google account | no | – | experimental |

¹ Set `"vision": true/false` per provider. ² Only for models that accept `reasoning_effort`; see below.

The UI gets this list (with `available` and a `note` saying what to do when a provider
is not usable) through `bridge_info`, see `docs/PROTOCOL.md`.

## Configuration

Settings come from `~/.aseprite-mcp/config.json` (override the path with
`ASEPRITE_MCP_CONFIG`) and from environment variables. **The config file wins**;
environment variables only fill gaps. The file is re-read when it changes, so no bridge
restart is needed. Every key is optional.

```json
{
  "defaultProvider": "claude-code",
  "providers": {
    "claude-code": { "path": "/opt/homebrew/bin/claude" },
    "codex":       { "path": "codex", "models": ["gpt-6.1-sol", "gpt-6-luna"] },
    "gemini-cli":  { "path": "gemini", "models": ["auto", "pro", "flash"] },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-6.1-sol",
      "models": ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"],
      "reasoningEffort": true,
      "maxReasoningEffort": "high",
      "vision": true,
      "label": "OpenAI"
    },
    "anthropic": { "apiKey": "sk-ant-...", "model": "claude-opus-5-5", "models": ["claude-opus-5-5", "claude-sonnet-5-5"] },
    "ollama":    { "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3", "vision": false }
  }
}
```

| Key | Meaning |
|---|---|
| `defaultProvider` | Provider the chat uses when the UI does not pick one. |
| `*.path` | CLI executable (name on PATH or absolute path). |
| `*.models` | Model ids offered in the UI; the first is the default unless `model` is set. |
| `*.model` | Default model. |
| `openai.baseUrl` | Endpoint up to the version segment (`…/v1`). Anything other than api.openai.com counts as a custom server: no API key required and models are listed from `GET {baseUrl}/models` when `models` is not set. |
| `openai.reasoningEffort` | Send the UI's effort as `reasoning_effort`. Default: on for api.openai.com with a GPT-5/GPT-6/o-series model, off otherwise. If a model answers 400 to it, the bridge stops sending it for that model. |
| `openai.maxReasoningEffort` | Highest value the endpoint accepts (`high` by default; GPT-6 models accept `xhigh`/`max`). Higher UI efforts are clamped to it. |
| `*.vision` | Whether the model can look at images (canvas previews returned by tools). |
| `openai.label` | Name shown in the UI, e.g. "OpenRouter". |
| `anthropic.baseUrl` | For proxies/gateways; default `https://api.anthropic.com`. |

Environment variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OLLAMA_HOST`, `CLAUDE_PATH`, `CODEX_PATH`,
`GEMINI_PATH`. `ANTHROPIC_BASE_URL` is deliberately **not** read: a bridge started from a
Claude Code terminal inherits that session's internal proxy URL.

Default model lists (October 2026) live in `modelCatalog.ts`; `models` in the config
replaces them, so new model ids never need a code change.

### Recipes

- **OpenRouter**: `"openai": {"baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-...", "model": "openai/gpt-6.1-sol", "label": "OpenRouter"}`
- **LM Studio**: `"openai": {"baseUrl": "http://127.0.0.1:1234/v1", "label": "LM Studio"}` (models are listed from the server)
- **Groq / DeepSeek / Mistral**: their OpenAI-compatible base URL + `apiKey` + `model`.
- **Ollama**: install from ollama.com, `ollama pull qwen3`; the `ollama` provider finds it at `127.0.0.1:11434`. Pick a model with tool support; small models draw poorly.

## How the runners work

### Claude Code (`ClaudeCliRunner`)

`claude -p --input-format stream-json --output-format stream-json` with only the
Aseprite MCP server allowed (`--strict-mcp-config`, `--tools ""`,
`--allowedTools mcp__aseprite__*`, `--setting-sources ""`) in an empty working directory.
The prompt and attached images go in as one stream-json user message.

**Warm processes.** Starting the CLI costs about a second per message (Node boot, login
check, MCP handshake). With stream-json input the process accepts the next message on
stdin, so each conversation keeps its process alive: a follow-up starts streaming in
milliseconds. A process is reused only for the same session, model, effort, MCP URL and
system prompt; otherwise a new one starts with `--resume <session>`. Idle processes stop
after 10 minutes, at most 3 stay warm (least recently used are stopped first), and an
aborted run kills its process (the next message resumes the session). Runs with
`keepAlive: false` (one-shot jobs) close stdin so the CLI exits after its answer.
Keep the system prompt stable within a conversation; put per-message context in the
prompt, or every message pays the start-up again.

`done.stats` carries the turn's duration, model turns, tokens (cached prompt tokens
included) and cost. The CLI reports cumulative session cost, so the runner reports the
difference to the previous turn.

### API providers (`ToolCallingAgent` + `OpenAiChatModel` / `AnthropicChatModel`)

APIs have no agent of their own, so `agent/ToolCallingAgent.ts` is one: it connects to
the run's MCP URL with the MCP SDK client, lists the tools, converts their JSON schemas,
and loops *model → tool calls → MCP `callTool` → results* until the model answers
without a tool call (at most 40 steps per message). The MCP server's instructions and
the request's system prompt form the system prompt.

- Conversations are kept in memory per session id (the 20 most recent), so follow-ups work.
- Rate limits, overload (429/5xx/529) and network errors are retried with backoff
  (`retry` events); other HTTP errors show the status and the provider's message.
- Tool images reach the model: as `image` blocks inside `tool_result` (Anthropic) or as
  one user message with data URIs after the tool messages (Chat Completions, where tool
  messages must be text).
- History stays bounded: Chat Completions keeps only the 3 newest images. The Anthropic
  runner keeps its history append-only (its thinking blocks are bound to the exact
  history before them), uses server-side tool-result clearing, prompt caching and
  server-side refusal fallbacks, and only between messages replaces old images (dropping
  thinking blocks at the same time). Optional Anthropic features the API rejects are
  switched off automatically instead of failing the provider.
- HTTP goes through `node:http(s)` (`http/httpJson.ts`), not `fetch`, because `fetch`
  gives up after 300 s without response headers.

### Codex and Gemini CLIs (experimental)

- Codex: `codex -c mcp_servers.aseprite.url=… -c …approval_mode="approve" exec --json
  --skip-git-repo-check --sandbox read-only [-m model] [resume <thread>] [-i image] <prompt>`.
  Effort maps to `model_reasoning_effort` (`max` → `xhigh`).
- Gemini: `gemini --prompt=… --output-format stream-json --approval-mode yolo
  --allowed-mcp-server-names aseprite [--model m] [--resume id]`, with a per-run settings
  file (MCP server, built-in file/shell/web tools excluded) passed as
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `GEMINI_CLI_TRUST_WORKSPACE=true`.
- Neither CLI can append to its system prompt, so the bridge's instructions open the
  first message of a conversation. Their JSON event parsers ignore unknown events.

Session ids are only resumed by the runner that created them (during this bridge run);
a foreign id starts a new conversation instead of failing.

## Adding a provider

- HTTP API with tool calling: implement `IChatModel` (`agent/types.ts`): `userTurn`,
  `complete`, `toolResultTurn`, `compact`. The agent loop does the rest.
- CLI agent: spawn it with `cli/JsonLineProcess.ts`, map its JSON lines to `LlmEvent`s
  (pure parser + unit tests on recorded lines), and register it in `ProviderRegistry.ts`.
