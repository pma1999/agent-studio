/**
 * Guardrail for the abliteration.ai provider (5th provider, GC §§1-11).
 *
 * Source-regex assertions in the `test-llamacpp-chat-gates.ts` idiom
 * (STABILITY + SEAM, `ok N - name` logging). Two phases live in this one
 * script:
 *
 *   STABILITY — the openrouter/deepseek/codex/llamacpp branches of
 *   providers/index.ts, chat.ts and councilExecutor.ts stay byte-stable
 *   across the abliteration edits (GC §8: existing branches byte-stable).
 *
 *   SEAM — each GC-frozen abliteration touchpoint exists exactly once where
 *   the T1-T4 reports say it landed: registry config/prefix, static catalog
 *   routes + validate code-match, chat guard/stream_options/effort
 *   arm/healing-max exclusions/cost arms, council guard/bodies/cost arms,
 *   frontend prefix/group/picker/routing-exclusion/settings-card/store arms,
 *   and the crypto allowlist.
 *
 * Usage:
 *   npx tsx scripts/test-abliteration-chat-gates.ts
 *
 * Reads source text only — offline-safe, db-free, no network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');
const indexSource = read('server/providers/index.ts');
const chatSource = read('server/routes/chat.ts');
const councilSource = read('server/services/councilExecutor.ts');
const modelsSource = read('server/routes/models.ts');
const cryptoSource = read('server/crypto.ts');
const envSource = read('.env.example');
const frontendProvidersSource = read('src/utils/providers.ts');
const modelUtilsSource = read('src/utils/modelUtils.ts');
const clientSource = read('src/api/client.ts');
const hookSource = read('src/hooks/useAbliterationModels.ts');
const selectorSource = read('src/components/ModelSelectorCore.tsx');
const routingSource = read('src/components/ProviderRoutingSelector.tsx');
const settingsSource = read('src/components/SettingsPanel.tsx');
const storeSource = read('src/stores/store.ts');

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ===========================================================================
// STABILITY — byte-stable anchors in the untouched provider branches (GC §8)
// ===========================================================================
function stabilityChecks(): void {
  ok('(S1) OPENROUTER_CONFIG url preserved', () => {
    assert.match(indexSource, /chatCompletionsUrl: 'https:\/\/openrouter\.ai\/api\/v1\/chat\/completions',/);
  });
  ok('(S2) OPENROUTER_CONFIG headers preserved', () => {
    assert.match(indexSource, /'HTTP-Referer': 'http:\/\/localhost:5173',/);
    assert.match(indexSource, /'X-Title': 'Agent Studio',/);
  });
  ok('(S3) resolveProviderId deepseek/codex/llamacpp arms preserved', () => {
    assert.match(indexSource, /modelId\.startsWith\(DEEPSEEK_PREFIX\)\) return 'deepseek';/);
    assert.match(indexSource, /modelId\.startsWith\(CODEX_PREFIX\)\) return 'codex';/);
    assert.match(indexSource, /modelId\.startsWith\(LLAMACPP_PREFIX\)\) return 'llamacpp';/);
  });
  ok('(S4) assistantReasoningField deepseek ternary preserved (no abliteration arm)', () => {
    assert.match(indexSource, /return id === 'deepseek' \? 'reasoning_content' : 'reasoning';/);
  });
  ok('(S5) CODEX_CONFIG keyless shape preserved', () => {
    assert.match(indexSource, /apiKeySetting: '',/);
  });
  ok('(S6) LLAMACPP_PREFIX + config label preserved', () => {
    assert.match(indexSource, /export const LLAMACPP_PREFIX = 'llamacpp:';/);
    assert.match(indexSource, /label: 'llama\.cpp \(Local\)'/);
  });
  ok('(S7) chat codex branch anchor preserved', () => {
    assert.match(chatSource, /if \(provider\.id === 'codex'\) \{/);
  });
  ok('(S8) chat deepseek thinking assignment preserved', () => {
    assert.match(chatSource, /Object\.assign\(requestBody, buildDeepSeekThinking\(reasoningEnabled, reasoningEffort\)\);/);
  });
  ok('(S9) chat OpenRouter file-parser plugin attach preserved', () => {
    assert.match(chatSource, /requestBody\.plugins = \[\{ id: 'file-parser', pdf: \{ engine: pdf_engine \} \}\];/);
  });
  ok('(S10) council codex member dispatch preserved', () => {
    assert.match(councilSource, /if \(resolveProviderId\(modelId\) === 'codex'\) \{/);
    assert.match(councilSource, /return this\.executeMemberStreamCodex\(modelId, options\);/);
  });
  ok('(S11) council deepseek cost fallback preserved', () => {
    assert.match(councilSource, /else if \(ep\.provider\.id === 'deepseek'\) cost = computeDeepSeekCost\(usage, ep\.upstreamModel\);/);
  });
  ok('(S12) council codex turn bridge import preserved', () => {
    assert.match(councilSource, /import \{ runCodexTurn \} from '\.\.\/codex\/chat\.js';/);
  });
}

// ===========================================================================
// SEAMS — the GC-frozen abliteration touchpoints (T1-T4 as landed)
// ===========================================================================
function seamChecks(): void {
  // ---- registry: prefix / config / resolvers (GC §1) -----------------------
  ok('(P1) ProviderId union carries abliteration', () => {
    assert.match(indexSource, /'openrouter' \| 'deepseek' \| 'codex' \| 'lmstudio' \| 'llamacpp' \| 'abliteration'/);
  });
  ok('(P2) ABLITERATION_PREFIX + BASE_URL frozen', () => {
    assert.match(indexSource, /export const ABLITERATION_PREFIX = 'abliteration:';/);
    assert.match(indexSource, /export const ABLITERATION_BASE_URL = 'https:\/\/api\.abliteration\.ai';/);
  });
  ok('(P3) ABLITERATION_CONFIG pinned shape (endpoint/key/Bearer/flags)', () => {
    assert.match(indexSource, /chatCompletionsUrl: `\$\{ABLITERATION_BASE_URL\}\/v1\/chat\/completions`,/);
    assert.match(indexSource, /apiKeySetting: 'abliteration_api_key',/);
    assert.match(indexSource, /'Authorization': `Bearer \$\{apiKey\}`,/);
    assert.match(indexSource, /supportsProviderRouting: false,\s*\n\s*supportsPlugins: false,\s*\n\s*supportsReasoningParam: false,\s*\n\s*supportsJsonSchema: true,/);
  });
  ok('(P4) resolveProviderId + toUpstreamModelId abliteration arms', () => {
    assert.match(indexSource, /modelId\.startsWith\(ABLITERATION_PREFIX\)\) return 'abliteration';/);
    assert.match(indexSource, /modelId\.startsWith\(ABLITERATION_PREFIX\)\) return modelId\.slice\(ABLITERATION_PREFIX\.length\);/);
  });
  ok('(P5) isAbliterationModel classifier exported', () => {
    assert.match(indexSource, /export function isAbliterationModel\(/);
  });
  ok('(P6) large-model guard helper + exact frozen message', () => {
    assert.match(indexSource, /export function isAbliterationLargeModel\(/);
    assert.match(indexSource, /upstreamModelId === 'abliterated-model-large' \|\| upstreamModelId === 'abliterated-model-large-v2'/);
    assert.match(
      indexSource,
      /'Abliteration large models are text-only; use abliteration:abliterated-model for image content\.'/,
    );
  });
  ok('(P7) persistedModelId keeps namespaced id for abliteration', () => {
    assert.match(
      indexSource,
      /providerId === 'deepseek' \|\| providerId === 'lmstudio' \|\| providerId === 'llamacpp' \|\| providerId === 'abliteration'/,
    );
  });
  ok('(P8) CONFIGS map wires abliteration', () => {
    assert.match(indexSource, /abliteration: ABLITERATION_CONFIG,/);
  });
  ok('(P9) static catalog carries the three frozen upstream ids + prices', () => {
    assert.match(indexSource, /export const ABLITERATION_CATALOG/);
    for (const id of ['abliterated-model', 'abliterated-model-large', 'abliterated-model-large-v2']) {
      assert.match(indexSource, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(indexSource, /context_length: 262144,/);
    assert.match(indexSource, /pricing: \{ prompt: '0\.000001', completion: '0\.000003' \}/);
    assert.match(indexSource, /pricing: \{ prompt: '0\.000003', completion: '0\.000005' \}/);
  });
  ok('(P10) reasoning arm builds top-level reasoning_effort allowlist only', () => {
    assert.match(indexSource, /export function buildAbliterationReasoning\(/);
    assert.match(indexSource, /reasoning_effort: effort/);
    assert.match(
      indexSource,
      /new Set\(\['minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]\)/,
    );
  });
  ok('(P11) cost helpers implement the §6 hit rule', () => {
    assert.match(indexSource, /export function computeAbliterationCost\(/);
    assert.match(indexSource, /export function abliterationCachedTokens\(/);
    assert.match(
      indexSource,
      /usage\.prompt_tokens_details\?\.cached_tokens \?\? usage\.prompt_cache_hit_tokens \?\? 0/,
    );
  });

  // ---- models.ts: static catalog + validate proxy (GC §3 + §9) -------------
  ok('(R1) models.ts imports the abliteration catalog + base URL', () => {
    assert.match(modelsSource, /ABLITERATION_BASE_URL, ABLITERATION_CATALOG/);
  });
  ok('(R2) GET /abliteration returns the static catalog with no key gate', () => {
    assert.match(modelsSource, /router\.get\('\/abliteration',/);
    assert.match(modelsSource, /res\.json\(\{ data: ABLITERATION_CATALOG \}\);/);
  });
  ok('(R3) GET /abliteration/validate proxies credits with the key gate', () => {
    assert.match(modelsSource, /router\.get\('\/abliteration\/validate',/);
    assert.match(modelsSource, /getSettingValue\(userId, 'abliteration_api_key'\)/);
    assert.match(modelsSource, /`\$\{ABLITERATION_BASE_URL\}\/v1\/credits`/);
    assert.match(modelsSource, /error: 'Abliteration API key not configured'/);
  });
  ok('(R4) validate matches on error.code with the frozen 401/402 envelopes', () => {
    assert.match(modelsSource, /errJson\.error\?\.code/);
    assert.match(modelsSource, /code === 'missing_api_key' \|\| code === 'invalid_api_key'/);
    assert.match(modelsSource, /error: 'Invalid Abliteration API key'/);
    assert.match(modelsSource, /response\.status === 402 \|\| code === 'billing_error'/);
    assert.match(modelsSource, /error: 'Insufficient Abliteration credits — top up at abliteration\.ai\/console'/);
  });
  ok('(R5) validate success passes total_credits/total_usage through', () => {
    assert.match(modelsSource, /total_credits: json\.data\?\.total_credits,/);
    assert.match(modelsSource, /total_usage: json\.data\?\.total_usage,/);
  });
  ok('(R6) no .env.example entry (settings-only like DeepSeek)', () => {
    assert.doesNotMatch(envSource, /ABLIT/i);
    assert.doesNotMatch(envSource, /abliteration/i);
  });

  // ---- chat.ts (GC §4/§5/§6/§7/§8) -----------------------------------------
  ok('(C1) chat imports the abliteration helpers', () => {
    assert.match(chatSource, /isAbliterationLargeModel,/);
    assert.match(chatSource, /buildAbliterationReasoning,/);
    assert.match(chatSource, /computeAbliterationCost,/);
    assert.match(chatSource, /abliterationCachedTokens,/);
    assert.match(chatSource, /ABLITERATION_LARGE_TEXT_ONLY_MESSAGE,/);
  });
  ok('(C2) chat large-model image guard fires after the PDF gate, before send', () => {
    assert.match(
      chatSource,
      /if \(provider\.id === 'abliteration' && isAbliterationLargeModel\(upstreamModel\)\) \{/,
    );
    assert.match(chatSource, /res\.status\(400\)\.json\(\{ error: ABLITERATION_LARGE_TEXT_ONLY_MESSAGE \}\);/);
    const pdfAt = chatSource.indexOf('attachments.length > 0 && !provider.supportsPlugins');
    const guardAt = chatSource.indexOf(
      "provider.id === 'abliteration' && isAbliterationLargeModel(upstreamModel)",
    );
    const effortAt = chatSource.indexOf('buildAbliterationReasoning(reasoningEnabled');
    assert.ok(pdfAt >= 0 && guardAt > pdfAt, 'image guard must come AFTER the PDF-attachments gate');
    assert.ok(effortAt > guardAt, 'image guard must fire BEFORE the request-body build');
  });
  ok('(C3) chat abliteration turns set stream_options usage frame', () => {
    assert.match(
      chatSource,
      /if \(provider\.id === 'abliteration'\) \{[\s\S]{0,600}?requestBody\.stream_options = \{ include_usage: true \};/,
    );
  });
  ok('(C4) chat abliteration reasoning arm sends reasoning_effort verbatim', () => {
    assert.match(chatSource, /else if \(provider\.id === 'abliteration'\) \{/);
    assert.match(chatSource, /Object\.assign\(requestBody, buildAbliterationReasoning\(reasoningEnabled, reasoningEffort\)\);/);
  });
  ok('(C5) chat healing exclusion names abliteration', () => {
    assert.match(
      chatSource,
      /provider\.id !== 'codex' && provider\.id !== 'llamacpp' && provider\.id !== 'abliteration';/,
    );
  });
  ok('(C6) chat effort-max retry exclusion names abliteration', () => {
    assert.match(
      chatSource,
      /requestedMaxEffort = reasoningEnabled && reasoningEffort === 'max' && provider\.id !== 'codex' && provider\.id !== 'llamacpp' && provider\.id !== 'abliteration';/,
    );
  });
  ok('(C7) chat stream + non-stream usage blocks compute static cost without overwriting', () => {
    const costs = chatSource.match(/computeAbliterationCost\(/g) ?? [];
    assert.ok(costs.length >= 2, `expected >=2 static-cost arms (stream + non-stream), found ${costs.length}`);
    const cached = chatSource.match(/abliterationCachedTokens\(/g) ?? [];
    assert.ok(cached.length >= 2, `expected >=2 cached-tokens arms, found ${cached.length}`);
    assert.match(chatSource, /if \(u\.cost === undefined\) cost = computeAbliterationCost\(au, upstreamModel\);/);
    assert.match(chatSource, /if \(usage\.cost === undefined\) cost = computeAbliterationCost\(usage, upstreamModel\);/);
  });

  // ---- councilExecutor.ts mirrors (GC §4/§5/§6/§7) --------------------------
  ok('(M1) council imports the abliteration helpers', () => {
    assert.match(councilSource, /buildAbliterationReasoning,/);
    assert.match(councilSource, /computeAbliterationCost,/);
    assert.match(councilSource, /isAbliterationLargeModel,/);
    assert.match(councilSource, /ABLITERATION_LARGE_TEXT_ONLY_MESSAGE,/);
  });
  ok('(M2) council member path throws the same text-only guard', () => {
    assert.match(
      councilSource,
      /if \(ep\.provider\.id === 'abliteration' && isAbliterationLargeModel\(ep\.upstreamModel\)/,
    );
    assert.match(councilSource, /throw new Error\(ABLITERATION_LARGE_TEXT_ONLY_MESSAGE\);/);
  });
  ok('(M3) council member + synthesis bodies set usage frame + reasoning arm', () => {
    const frames = councilSource.match(/requestBody\.stream_options = \{ include_usage: true \};/g) ?? [];
    assert.ok(frames.length >= 2, `expected >=2 usage-frame arms (member + synthesis), found ${frames.length}`);
    const arms = councilSource.match(/Object\.assign\(requestBody, buildAbliterationReasoning\(reasoning\.enabled, reasoning\.effort\)\);/g) ?? [];
    assert.ok(arms.length >= 2, `expected >=2 reasoning arms (member + synthesis), found ${arms.length}`);
  });
  ok('(M4) council member + synthesis usage blocks compute static cost', () => {
    const costs = councilSource.match(
      /else if \(ep\.provider\.id === 'abliteration'\) cost = computeAbliterationCost\(usage, ep\.upstreamModel\);/g,
    ) ?? [];
    assert.ok(costs.length >= 2, `expected >=2 council cost arms, found ${costs.length}`);
  });

  // ---- frontend (GC §10) ----------------------------------------------------
  ok('(F1) frontend prefix/group/accent literals frozen', () => {
    assert.match(frontendProvidersSource, /export const ABLITERATION_PREFIX = 'abliteration:';/);
    assert.match(frontendProvidersSource, /export const ABLITERATION_GROUP = 'abliteration-direct';/);
    assert.match(frontendProvidersSource, /export const ABLITERATION_ACCENT = '#e5489e';/);
  });
  ok('(F2) frontend classifier + display strip', () => {
    assert.match(frontendProvidersSource, /export function isAbliterationModel\(/);
    assert.match(frontendProvidersSource, /export function stripAbliterationPrefix\(/);
  });
  ok('(F3) picker groups/displays Abliteration Direct (premium/brain) after codex', () => {
    assert.match(modelUtilsSource, /\[ABLITERATION_GROUP\]: 'Abliteration · Direct',/);
    assert.match(modelUtilsSource, /\[ABLITERATION_GROUP\]: ABLITERATION_ACCENT,/);
    assert.match(modelUtilsSource, /name: 'Abliteration · Direct', color: ABLITERATION_ACCENT, iconName: 'brain', tier: 'premium'/);
    const codexAt = modelUtilsSource.indexOf('CODEX_DIRECT_GROUP,');
    const ablAt = modelUtilsSource.indexOf('ABLITERATION_GROUP,');
    const llamaAt = modelUtilsSource.indexOf('LLAMACPP_GROUP,');
    assert.ok(codexAt >= 0 && ablAt > codexAt && llamaAt > ablAt, 'priority slot must sit after codex, before llamacpp');
  });
  ok('(F4) API client hits both abliteration routes', () => {
    assert.match(clientSource, /abliteration: \(\) => request<\{ data: OpenRouterModel\[\] \}>\('\/models\/abliteration'\),/);
    assert.match(clientSource, /validate: \(\) => request<AbliterationValidateResult>\('\/models\/abliteration\/validate'\),/);
    assert.match(clientSource, /export interface AbliterationValidateResult \{/);
  });
  ok('(F5) catalog hook is module-cached and fail-soft', () => {
    assert.match(hookSource, /export function useAbliterationModels\(/);
    assert.match(hookSource, /modelsApi\s*\n?\s*\.abliteration\(\)/);
    assert.match(hookSource, /return \{ models, loading, error \};/);
  });
  ok('(F6) picker spreads abliteration models between codex and llamacpp', () => {
    assert.match(selectorSource, /import \{ useAbliterationModels \} from '\.\.\/hooks\/useAbliterationModels';/);
    assert.match(selectorSource, /ABLITERATION_GROUP,/);
    assert.match(
      selectorSource,
      /\[\.\.\.deepSeekModels, \.\.\.codexModels, \.\.\.abliterationModels, \.\.\.llamaCppModels, \.\.\.openRouterModels\]/,
    );
  });
  ok('(F7) routing selector excludes abliteration exactly like DeepSeek', () => {
    assert.match(routingSource, /import \{ isDeepSeekDirectModel, isAbliterationModel \} from '\.\.\/utils\/providers';/);
    assert.match(routingSource, /const isAbliteration = isAbliterationModel\(modelId\);/);
    assert.match(routingSource, /&& !isDeepSeek && !isAbliteration\)/);
    assert.match(routingSource, /if \(\(isDeepSeek \|\| isAbliteration\) && value !== null\) onChange\(null\);/);
    assert.match(routingSource, /Proveedor no disponible para Abliteration/);
  });
  ok('(F8) settings card reuses ProviderKeySection with the frozen props', () => {
    assert.match(settingsSource, /function AbliterationSection\(\)/);
    assert.match(settingsSource, /settingKey="abliteration_api_key"/);
    assert.match(settingsSource, /placeholder=\{hasSavedKey \? `Saved: /);
    assert.match(settingsSource, /'ak-\.\.\.'/);
    assert.match(settingsSource, /helpUrl="https:\/\/abliteration\.ai\/console"/);
    assert.match(settingsSource, /accentColor=\{ABLITERATION_ACCENT\}/);
    const deepAt = settingsSource.indexOf('<DeepSeekSection />');
    const ablAt = settingsSource.indexOf('<AbliterationSection />');
    const codexAt = settingsSource.indexOf('<ChatGPTSection />');
    assert.ok(deepAt >= 0 && ablAt > deepAt && codexAt > ablAt, 'card must mount between DeepSeek and ChatGPT');
  });
  ok('(F9) store holds the key pair + loadSettings arm', () => {
    assert.match(storeSource, /abliterationApiKey: string;/);
    assert.match(storeSource, /setAbliterationApiKey: \(key: string\) => void;/);
    assert.match(storeSource, /abliterationApiKey: '',/);
    assert.match(storeSource, /abliterationApiKey: data\.abliteration_api_key \?\? '',/);
  });
  ok('(F10) frontend never calls api.abliteration.ai directly (backend relay only)', () => {
    for (const [name, src] of [
      ['providers', frontendProvidersSource],
      ['client', clientSource],
      ['hook', hookSource],
      ['settings', settingsSource],
    ] as const) {
      assert.doesNotMatch(src, /api\.abliteration\.ai/, `${name} must not call the upstream directly`);
    }
  });

  // ---- crypto (GC §11) ------------------------------------------------------
  ok('(K1) abliteration_api_key is encrypted at rest', () => {
    assert.match(cryptoSource, /'abliteration_api_key',/);
    assert.match(cryptoSource, /SENSITIVE_SETTINGS_KEYS/);
  });

  // ---- forbidden (GC §11) ---------------------------------------------------
  ok('(A1) ultracode never appears outside the documented never-send comment', () => {
    assert.doesNotMatch(chatSource, /ultracode/);
    assert.doesNotMatch(councilSource, /ultracode/);
    assert.doesNotMatch(modelsSource, /ultracode/);
    assert.doesNotMatch(clientSource, /ultracode/);
    assert.doesNotMatch(selectorSource, /ultracode/);
    assert.doesNotMatch(routingSource, /ultracode/);
    assert.doesNotMatch(settingsSource, /ultracode/);
    assert.doesNotMatch(storeSource, /ultracode/);
  });
}

stabilityChecks();
seamChecks();

console.log(`abliteration chat-gates guardrail: OK (${checks} checks)`);
