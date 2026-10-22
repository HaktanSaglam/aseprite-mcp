import { describe, expect, it } from "vitest";
import { resolveProvider } from "../src/chat/providerResolver.js";
import type { IProviderRegistry, ProviderInfo } from "../src/llm/LlmRunner.js";

const info: ProviderInfo = {
  id: "claude-code",
  label: "Claude Code",
  models: [{ id: "fable", label: "Fable" }, { id: "opus", label: "Opus" }],
  efforts: ["low", "medium"],
  available: true,
  supportsImages: true,
  defaultModel: "opus",
};
const registry: IProviderRegistry = {
  defaultId: "claude-code",
  list: async () => [info],
  runner: () => ({ run: async function* () {} }),
};

describe("resolveProvider", () => {
  it("uses the provider's default model, not the first in the list", async () => {
    expect((await resolveProvider(registry, {})).model).toBe("opus");
    expect((await resolveProvider(registry, { model: "fable" })).model).toBe("fable");
  });
});
