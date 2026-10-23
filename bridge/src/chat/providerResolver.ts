import { EFFORTS, type Effort, type ILlmRunner, type IProviderRegistry, type ProviderInfo } from "../llm/LlmRunner.js";
import { UserFacingError } from "./chatUpdates.js";

/** Medium is the sweet spot for drawing: high/max mostly add thinking time, not better pixels. */
export const DEFAULT_EFFORT: Effort = "medium";

export interface ResolvedProvider {
  info: ProviderInfo;
  runner: ILlmRunner;
  model?: string;
  effort?: Effort;
}

/**
 * The closest effort the provider supports (ties go to the cheaper one), so switching
 * providers in the UI never turns a valid choice into an error.
 */
export function resolveEffort(requested: Effort | undefined, supported: readonly Effort[]): Effort | undefined {
  if (supported.length === 0) return undefined;
  const wanted = requested ?? DEFAULT_EFFORT;
  if (supported.includes(wanted)) return wanted;
  const rank = (e: Effort) => EFFORTS.indexOf(e);
  const distance = (e: Effort) => Math.abs(rank(e) - rank(wanted));
  return [...supported].sort((a, b) => distance(a) - distance(b) || rank(a) - rank(b))[0];
}

export async function resolveProvider(
  registry: IProviderRegistry,
  options: { provider?: string; model?: string; effort?: Effort },
): Promise<ResolvedProvider> {
  const id = options.provider || registry.defaultId;
  const providers = await registry.list();
  const info = providers.find((p) => p.id === id);
  if (!info) {
    const known = providers.map((p) => p.id).join(", ") || "none";
    throw new UserFacingError(`Unknown AI provider "${id}". Available: ${known}.`);
  }
  if (!info.available) {
    throw new UserFacingError(`${info.label} is not available${info.note ? `: ${info.note}` : "."}`);
  }
  return {
    info,
    runner: registry.runner(id),
    // Any id is passed through: providers accept models newer than their built-in list.
    model: options.model || info.defaultModel || info.models[0]?.id,
    effort: resolveEffort(options.effort, info.efforts),
  };
}
