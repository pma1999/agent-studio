/**
 * Provider ids and the model-id scheme shared by server and client.
 *
 * Every model id carries its provider: OpenRouter ids stay native
 * (`author/slug`), every other provider uses a `<scheme>:` prefix. Zero
 * dependencies.
 */

export type ProviderId =
  | 'openrouter'
  | 'deepseek'
  | 'codex'
  | 'lmstudio'
  | 'llamacpp'
  | 'abliteration'
  | 'arnict'
  | 'opencode-go';

/** Scheme prefix per namespaced provider (OpenRouter has none). */
export const PROVIDER_PREFIXES: Readonly<Record<Exclude<ProviderId, 'openrouter'>, string>> = {
  deepseek: 'deepseek:',
  codex: 'codex:',
  lmstudio: 'lmstudio:',
  llamacpp: 'llamacpp:',
  abliteration: 'abliteration:',
  arnict: 'arnict:',
  'opencode-go': 'opencode-go:',
};

const PREFIX_ENTRIES = Object.entries(PROVIDER_PREFIXES) as Array<[Exclude<ProviderId, 'openrouter'>, string]>;

/** Provider that serves a model id (unprefixed ids are OpenRouter). */
export function providerOfModelId(modelId: string | null | undefined): ProviderId {
  if (typeof modelId !== 'string') return 'openrouter';
  for (const [provider, prefix] of PREFIX_ENTRIES) {
    if (modelId.startsWith(prefix)) return provider;
  }
  return 'openrouter';
}

/** The id the upstream API expects (scheme prefix removed). */
export function upstreamIdOf(modelId: string): string {
  const provider = providerOfModelId(modelId);
  return provider === 'openrouter' ? modelId : modelId.slice(PROVIDER_PREFIXES[provider].length);
}

/** Namespaced app id for an upstream id. */
export function namespacedModelId(provider: ProviderId, upstreamId: string): string {
  return provider === 'openrouter' ? upstreamId : `${PROVIDER_PREFIXES[provider]}${upstreamId}`;
}
