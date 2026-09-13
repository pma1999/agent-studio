/**
 * Guardrail for the arnict.com provider (6th provider, GC §§1-11, keyed
 * full-parity).
 *
 * Source-regex assertions in the `test-abliteration-chat-gates.ts` idiom
 * (STABILITY + SEAM, `ok N - name` logging). Two phases live in this one
 * script:
 *
 *   STABILITY — the openrouter/deepseek/codex/llamacpp/abliteration branches
 *   of providers/index.ts, chat.ts and councilExecutor.ts stay byte-stable
 *   across the arnict edits (GC §8: existing branches byte-stable).
 *
 *   SEAM — each GC-frozen arnict touchpoint exists exactly once where the
 *   T1-T5 reports say it landed: registry config/prefix, static catalog
 *   routes + validate code-match, chat tools-send/stream_options/reasoning
 *   arms/healing-max exclusions/cost arms/titles fallback, council
 *   tools-send/bodies/cost arms/comparison reasoning-off, frontend
 *   prefix/group/picker/routing-exclusion/settings-card/store arms, and the
 *   crypto allowlist.
 *
 *   UNVERIFIED — forms the keyed recipe never proved (`strict:false`,
 *   `tool_choice` object, arnict-specific tools overrides, `video`, `http`
 *   image URLs) are pinned as never-sent tripwires.
 *
 * Transport/relay pins are N/A: arnict is a hosted Bearer API relayed
 * server-side like DeepSeek/Abliteration (no loopback transport module).
 *
 * Usage:
 *   npx tsx scripts/test-arnict-chat-gates.ts
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
const chatCouncilSource = read('server/routes/chatCouncil.ts');
const modelsSource = read('server/routes/models.ts');
const cryptoSource = read('server/crypto.ts');
const envSource = read('.env.example');
const frontendProvidersSource = read('src/utils/providers.ts');
const modelUtilsSource = read('src/utils/modelUtils.ts');
const clientSource = read('src/api/client.ts');
const hookSource = read('src/hooks/useArnictModels.ts');
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
  ok('(S3) resolveProviderId deepseek/codex/llamacpp/abliteration arms preserved', () => {
    assert.match(indexSource, /modelId\.startsWith\(DEEPSEEK_PREFIX\)\) return 'deepseek';/);
    assert.match(indexSource, /modelId\.startsWith\(CODEX_PREFIX\)\) return 'codex';/);
    assert.match(indexSource, /modelId\.startsWith\(LLAMACPP_PREFIX\)\) return 'llamacpp';/);
    assert.match(indexSource, /modelId\.startsWith\(ABLITERATION_PREFIX\)\) return 'abliteration';/);
  });
  ok('(S4) assistantReasoningField deepseek ternary preserved (no arnict arm)', () => {
    assert.match(indexSource, /return id === 'deepseek' \? 'reasoning_content' : 'reasoning';/);
  });
  ok('(S5) CODEX_CONFIG keyless shape preserved', () => {
    assert.match(indexSource, /apiKeySetting: '',/);
  });
  ok('(S6) LLAMACPP_PREFIX + config label preserved', () => {
    assert.match(indexSource, /export const LLAMACPP_PREFIX = 'llamacpp:';/);
    assert.match(indexSource, /label: 'llama\.cpp \(Local\)'/);
  });
  ok('(S7) ABLITERATION_PREFIX + base URL preserved', () => {
    assert.match(indexSource, /export const ABLITERATION_PREFIX = 'abliteration:';/);
    assert.match(indexSource, /export const ABLITERATION_BASE_URL = 'https:\/\/api\.abliteration\.ai';/);
  });
  ok('(S8) chat codex branch anchor preserved', () => {
    assert.match(chatSource, /if \(provider\.id === 'codex'\) \{/);
  });
  ok('(S9) chat deepseek thinking assignment preserved', () => {
    assert.match(chatSource, /Object\.assign\(requestBody, buildDeepSeekThinking\(reasoningEnabled, reasoningEffort\)\);/);
  });
  ok('(S10) chat OpenRouter file-parser plugin attach preserved', () => {
    assert.match(chatSource, /requestBody\.plugins = \[\{ id: 'file-parser', pdf: \{ engine: pdf_engine \} \}\];/);
  });
  ok('(S11) council codex member dispatch preserved', () => {
    assert.match(councilSource, /if \(resolveProviderId\(modelId\) === 'codex'\) \{/);
    assert.match(councilSource, /return this\.executeMemberStreamCodex\(modelId, options\);/);
  });
  ok('(S12) council deepseek cost fallback preserved', () => {
    assert.match(councilSource, /else if \(ep\.provider\.id === 'deepseek'\) cost = computeDeepSeekCost\(usage, ep\.upstreamModel\);/);
  });
  ok('(S13) council codex turn bridge import preserved', () => {
    assert.match(councilSource, /import \{ runCodexTurn \} from '\.\.\/codex\/chat\.js';/);
  });
  ok('(S14) council abliteration cost arms still exactly two (member + synthesis)', () => {
    const costs = councilSource.match(
      /else if \(ep\.provider\.id === 'abliteration'\) cost = computeAbliterationCost\(usage, ep\.upstreamModel\);/g,
    ) ?? [];
    assert.equal(costs.length, 2);
  });
}

// ===========================================================================
// SEAMS — the GC-frozen arnict touchpoints (T1-T4 as landed)
// ===========================================================================
function seamChecks(): void {
  // ---- registry: prefix / config / resolvers (GC §1) -----------------------
  ok('(P1) ProviderId union carries arnict', () => {
    assert.match(indexSource, /'openrouter' \| 'deepseek' \| 'codex' \| 'lmstudio' \| 'llamacpp' \| 'abliteration' \| 'arnict'/);
  });
  ok('(P2) ARNICT_PREFIX + BASE_URL frozen', () => {
    assert.match(indexSource, /export const ARNICT_PREFIX = 'arnict:';/);
    assert.match(indexSource, /export const ARNICT_BASE_URL = 'https:\/\/api\.arnict\.com';/);
  });
  ok('(P3) ARNICT_CONFIG pinned shape (label/endpoint/key/Bearer/flags F,F,F,T)', () => {
    assert.match(indexSource, /label: 'Arnict \(Direct\)',/);
    assert.match(indexSource, /chatCompletionsUrl: `\$\{ARNICT_BASE_URL\}\/v1\/chat\/completions`,/);
    assert.match(indexSource, /apiKeySetting: 'arnict_api_key',/);
    assert.match(indexSource, /'Authorization': `Bearer \$\{apiKey\}`,/);
    assert.match(indexSource, /supportsProviderRouting: false,\s*\n\s*supportsPlugins: false,\s*\n\s*supportsReasoningParam: false,\s*\n\s*supportsJsonSchema: true,/);
  });
  ok('(P4) resolveProviderId + toUpstreamModelId arnict arms', () => {
    assert.match(indexSource, /modelId\.startsWith\(ARNICT_PREFIX\)\) return 'arnict';/);
    assert.match(indexSource, /modelId\.startsWith\(ARNICT_PREFIX\)\) return modelId\.slice\(ARNICT_PREFIX\.length\);/);
  });
  ok('(P5) isArnictModel classifier exported', () => {
    assert.match(indexSource, /export function isArnictModel\(/);
  });
  ok('(P6) tools-unsupported guard eliminated; builder owns the reasoning contract', () => {
    assert.doesNotMatch(indexSource, /ARNICT_TOOLS_UNSUPPORTED_MESSAGE/);
    assert.match(indexSource, /export function buildArnictReasoning\(/);
  });
  ok('(P7) persistedModelId keeps namespaced id for arnict', () => {
    assert.match(
      indexSource,
      /providerId === 'deepseek' \|\| providerId === 'lmstudio' \|\| providerId === 'llamacpp' \|\| providerId === 'abliteration' \|\| providerId === 'arnict'/,
    );
  });
  ok('(P8) CONFIGS map wires arnict', () => {
    assert.match(indexSource, /arnict: ARNICT_CONFIG,/);
  });
  ok('(P9) static catalog carries the two frozen upstream ids + prices', () => {
    assert.match(indexSource, /export const ARNICT_CATALOG/);
    assert.match(indexSource, /ARNICT_PREFIX\}zai\/glm-5\.3-flash-uncensored/);
    assert.match(indexSource, /ARNICT_PREFIX\}qwen\/qwen3\.8-27b/);
    assert.match(indexSource, /name: 'GLM 5\.3 Flash Uncensored',/);
    assert.match(indexSource, /name: 'Qwen 3\.8 27B',/);
    assert.match(indexSource, /context_length: 1048576,/);
    assert.match(indexSource, /context_length: 262144,/);
    assert.match(indexSource, /pricing: \{ prompt: '0\.000000125', completion: '0\.0000005' \}/);
    assert.match(indexSource, /pricing: \{ prompt: '0', completion: '0' \}/);
  });
  ok('(P10) cost helpers implement the §6 single-field hit rule', () => {
    assert.match(indexSource, /export function computeArnictCost\(/);
    assert.match(indexSource, /export function arnictCachedTokens\(/);
    assert.match(
      indexSource,
      /usage\.prompt_tokens_details\?\.cached_tokens \?\? 0/,
    );
  });
  ok('(P11) reasoning builder present, no large-model guard, no ultracode in the arnict block', () => {
    assert.match(indexSource, /export function buildArnictReasoning\(/);
    assert.doesNotMatch(indexSource, /isArnictLargeModel/);
    // `ultracode` legitimately appears once in the abliteration effort arm
    // (L479 fail-safe list); pin its absence in the arnict block only.
    const arnictAt = indexSource.indexOf('// Arnict-direct catalog');
    assert.ok(arnictAt >= 0, 'arnict catalog block missing');
    assert.doesNotMatch(indexSource.slice(arnictAt), /ultracode/);
  });

  // ---- models.ts: static catalog + validate probe (GC §3 + §9) -------------
  ok('(R1) models.ts imports the arnict catalog + base URL', () => {
    assert.match(modelsSource, /ARNICT_BASE_URL, ARNICT_CATALOG/);
  });
  ok('(R2) GET /arnict returns the static catalog with no key gate', () => {
    assert.match(modelsSource, /router\.get\('\/arnict',/);
    assert.match(modelsSource, /res\.json\(\{ data: ARNICT_CATALOG \}\);/);
  });
  ok('(R3) GET /arnict/validate probes GET /v1/models behind the key gate', () => {
    assert.match(modelsSource, /router\.get\('\/arnict\/validate',/);
    assert.match(modelsSource, /getSettingValue\(userId, 'arnict_api_key'\)/);
    assert.match(modelsSource, /`\$\{ARNICT_BASE_URL\}\/v1\/models`/);
    assert.match(modelsSource, /error: 'Arnict API key not configured'/);
  });
  ok('(R4) validate matches on error.code with the frozen 401/429/403 envelopes, never 402', () => {
    assert.match(modelsSource, /errJson\.error\?\.code/);
    assert.match(modelsSource, /response\.status === 401 \|\| code === 'invalid_api_key'/);
    assert.match(modelsSource, /error: 'Invalid Arnict API key'/);
    assert.match(modelsSource, /code === 'insufficient_quota'/);
    assert.match(modelsSource, /error: 'Insufficient Arnict credits — top up at arnict\.com'/);
    assert.match(modelsSource, /code === 'rate_limit_exceeded' \|\| response\.status === 429/);
    assert.match(modelsSource, /error: 'Arnict rate limit exceeded — retry later'/);
    assert.match(modelsSource, /error: message \|\| 'Arnict key expired or restricted'/);
    // The 402 branch and total_credits passthrough belong to abliteration
    // only: slice the arnict validate block and pin their absence there.
    const start = modelsSource.indexOf("router.get('/arnict/validate'");
    const end = modelsSource.indexOf("router.get('/llamacpp'");
    assert.ok(start >= 0 && end > start, 'arnict validate block bounds missing');
    const block = modelsSource.slice(start, end);
    assert.doesNotMatch(block, /402/);
    assert.doesNotMatch(block, /total_credits/);
  });
  ok('(R5) validate success returns {ok,models,ids} (VERIFIED-keyed, no owned_by) and catch returns 500', () => {
    assert.match(modelsSource, /Success payload VERIFIED-keyed/);
    assert.match(modelsSource, /with no `owned_by`, so read ids from/);
    assert.match(modelsSource, /Live may list 4 ids; the app catalog stays at 2/);
    assert.match(modelsSource, /res\.json\(\{ ok: true, models: ids\.length, ids \}\);/);
    assert.match(modelsSource, /res\.status\(500\)\.json\(\{ ok: false, error: 'Failed to reach Arnict' \}\);/);
  });
  ok('(R6) no .env.example entry (settings-only like DeepSeek/Abliteration)', () => {
    assert.doesNotMatch(envSource, /ARNICT/);
    assert.doesNotMatch(envSource, /arnict/);
  });

  // ---- chat.ts (GC §4/§5/§6/§7/§8) -----------------------------------------
  ok('(C1) chat imports the arnict helpers incl. the builder (guard message gone)', () => {
    assert.match(chatSource, /arnictCachedTokens,/);
    assert.match(chatSource, /computeArnictCost,/);
    assert.match(chatSource, /buildArnictReasoning,/);
    assert.doesNotMatch(chatSource, /ARNICT_TOOLS_UNSUPPORTED_MESSAGE/);
    assert.doesNotMatch(chatSource, /isArnictLargeModel/);
  });
  ok('(C2) chat sends tools for arnict via the generic attach (no 400 gate)', () => {
    // Single generic attach (+ its per-segment re-attach): no arnict veto.
    assert.match(chatSource, /if \(openRouterTools\.length > 0\) \{\s*\n\s*requestBody\.tools = openRouterTools;/);
    assert.match(chatSource, /requestBody\.tool_choice = agent\.tool_choice === 'none' \? 'none' : 'auto';/);
    assert.match(chatSource, /requestBody\.parallel_tool_calls = agent\.parallel_tool_calls === 0 \? false : true;/);
    const attaches = chatSource.match(/requestBody\.tools = openRouterTools;/g) ?? [];
    assert.equal(attaches.length, 2);
    // The wave-1 gate is gone: no 400, no message, no arnict-gated tools arm.
    assert.doesNotMatch(chatSource, /ARNICT_TOOLS_UNSUPPORTED_MESSAGE/);
    assert.doesNotMatch(chatSource, /provider\.id === 'arnict' && openRouterTools\.length > 0/);
    assert.doesNotMatch(chatSource, /res\.status\(400\)\.json\(\{ error: ARNICT_TOOLS_UNSUPPORTED_MESSAGE \}\);/);
  });
  ok('(C3) chat arnict turns set stream_options usage frame', () => {
    assert.match(
      chatSource,
      /if \(provider\.id === 'arnict'\) \{[\s\S]{0,600}?requestBody\.stream_options = \{ include_usage: true \};/,
    );
  });
  ok('(C4) chat healing exclusion names arnict', () => {
    assert.match(
      chatSource,
      /provider\.id !== 'codex' && provider\.id !== 'llamacpp' && provider\.id !== 'abliteration' && provider\.id !== 'arnict';/,
    );
  });
  ok('(C5) chat effort-max retry exclusion names arnict', () => {
    assert.match(
      chatSource,
      /requestedMaxEffort = reasoningEnabled && reasoningEffort === 'max' && provider\.id !== 'codex' && provider\.id !== 'llamacpp' && provider\.id !== 'abliteration' && provider\.id !== 'arnict';/,
    );
  });
  ok('(C6) chat stream + non-stream usage blocks compute static cost without overwriting', () => {
    const costs = chatSource.match(/computeArnictCost\(/g) ?? [];
    assert.ok(costs.length >= 2, `expected >=2 static-cost arms (stream + non-stream), found ${costs.length}`);
    const cached = chatSource.match(/arnictCachedTokens\(/g) ?? [];
    assert.ok(cached.length >= 2, `expected >=2 cached-tokens arms, found ${cached.length}`);
    assert.match(chatSource, /if \(u\.cost === undefined\) cost = computeArnictCost\(au, upstreamModel\);/);
    assert.match(chatSource, /if \(usage\.cost === undefined\) cost = computeArnictCost\(usage, upstreamModel\);/);
  });
  ok('(C7) chat key gate stays generic: arnict gets no exemption', () => {
    assert.match(chatSource, /!apiKey\?\.trim\(\) && !isCodexModel\(effectiveModel\) && !isLlamacppModel\(effectiveModel\)/);
    assert.doesNotMatch(chatSource, /isArnictModel/);
  });
  ok('(C8) chat arnict reasoning arm via the builder (schema forces enabled:false)', () => {
    assert.match(chatSource, /\} else if \(provider\.id === 'arnict'\) \{/);
    assert.match(chatSource, /requestBody\.reasoning = buildArnictReasoning\(reasoningEnabled, reasoningEffort\);/);
    assert.match(
      chatSource,
      /if \(responseFormat\) \{\s*\n\s*requestBody\.reasoning = \{ enabled: false \};/,
    );
    assert.match(chatSource, /reasoning disabled for arnict/);
    // The arm never sends top-level fields or the agent budget knob: slice
    // the arm and pin the absence on the `requestBody.*` write shape (the
    // prose comment legitimately names `reasoning_max_tokens`).
    const armAt = chatSource.indexOf("} else if (provider.id === 'arnict') {");
    assert.ok(armAt >= 0, 'arnict reasoning arm missing');
    const arm = chatSource.slice(armAt, armAt + 900);
    assert.doesNotMatch(arm, /requestBody\.reasoning_effort/);
    assert.doesNotMatch(arm, /requestBody\.thinking/);
    assert.doesNotMatch(arm, /requestBody\.reasoningMaxTokens/);
    assert.doesNotMatch(arm, /requestBody\.effort/);
  });
  ok('(C9) chat titles fall back to arnict when the OpenRouter key is absent', () => {
    assert.match(chatSource, /generateConversationTitleWithArnict,/);
    assert.match(chatSource, /\} else if \(titleEnabled\) \{/);
    assert.match(chatSource, /getSettingValue\(userId, 'arnict_api_key'\)/);
    assert.match(chatSource, /generatedTitlePromise = generateConversationTitleWithArnict\(\{/);
  });

  // ---- councilExecutor.ts mirrors (GC §4/§5/§6/§7/§8) -----------------------
  ok('(M1) council imports the arnict helpers incl. the builder (guard message gone)', () => {
    assert.match(councilSource, /computeArnictCost,/);
    assert.match(councilSource, /buildArnictReasoning,/);
    assert.doesNotMatch(councilSource, /ARNICT_TOOLS_UNSUPPORTED_MESSAGE/);
    assert.doesNotMatch(councilSource, /isArnictLargeModel/);
  });
  ok('(M2) council member sends tools for arnict (throw gone, generic attach applies)', () => {
    assert.doesNotMatch(councilSource, /ARNICT_TOOLS_UNSUPPORTED_MESSAGE/);
    assert.doesNotMatch(councilSource, /ep\.provider\.id === 'arnict' && openRouterTools\.length > 0/);
    assert.doesNotMatch(councilSource, /throw new Error\(ARNICT_TOOLS_UNSUPPORTED_MESSAGE\);/);
    assert.match(councilSource, /requestBody\.tool_choice = 'auto';/);
    assert.match(councilSource, /requestBody\.parallel_tool_calls = true;/);
  });
  ok('(M3) council member + synthesis bodies set the usage frame + object reasoning arm', () => {
    assert.match(
      councilSource,
      /if \(ep\.provider\.id === 'arnict'\) \{[\s\S]{0,400}?requestBody\.stream_options = \{ include_usage: true \};/,
    );
    const arms = councilSource.match(
      /requestBody\.reasoning = buildArnictReasoning\(reasoning\.enabled, reasoning\.effort\);/g,
    ) ?? [];
    assert.equal(arms.length, 2);
    const frames = councilSource.match(/if \(ep\.provider\.id === 'arnict'\) \{/g) ?? [];
    assert.equal(frames.length, 2);
  });
  ok('(M4) council member + synthesis usage blocks compute static cost', () => {
    const costs = councilSource.match(
      /else if \(ep\.provider\.id === 'arnict'\) cost = computeArnictCost\(usage, ep\.upstreamModel\);/g,
    ) ?? [];
    assert.equal(costs.length, 2);
  });
  ok('(M5) council comparison allows arnict via the json_schema gate + reasoning:{enabled:false}', () => {
    assert.match(councilSource, /if \(!getProviderForModel\(synthesizerModel\)\.supportsJsonSchema\) \{/);
    assert.match(
      councilSource,
      /\.\.\.\(ep\.provider\.id === 'arnict' \? \{ reasoning: \{ enabled: false \} \} : \{\}\),/,
    );
    assert.doesNotMatch(chatCouncilSource, /arnict/i);
  });
  ok('(M6) council resolveEndpoint stays generic: arnict gets no key exemption', () => {
    assert.match(councilSource, /if \(!apiKey\?\.trim\(\) && provider\.id !== 'lmstudio' && provider\.id !== 'llamacpp'\) \{/);
  });

  // ---- frontend (GC §10) ----------------------------------------------------
  ok('(F1) frontend prefix/group/accent literals frozen', () => {
    assert.match(frontendProvidersSource, /export const ARNICT_PREFIX = 'arnict:';/);
    assert.match(frontendProvidersSource, /export const ARNICT_GROUP = 'arnict-direct';/);
    assert.match(frontendProvidersSource, /export const ARNICT_ACCENT = '#14b8a6';/);
  });
  ok('(F2) frontend classifier + display strip', () => {
    assert.match(frontendProvidersSource, /export function isArnictModel\(/);
    assert.match(frontendProvidersSource, /export function stripArnictPrefix\(/);
  });
  ok('(F3) picker groups/displays Arnict Direct (premium/brain) after abliteration', () => {
    assert.match(modelUtilsSource, /\[ARNICT_GROUP\]: 'Arnict · Direct',/);
    assert.match(modelUtilsSource, /\[ARNICT_GROUP\]: ARNICT_ACCENT,/);
    assert.match(modelUtilsSource, /\[ARNICT_GROUP\]: \{ name: 'Arnict · Direct', color: ARNICT_ACCENT, iconName: 'brain', tier: 'premium' \},/);
    assert.match(modelUtilsSource, /if \(isArnictModel\(id\)\) return ARNICT_GROUP;/);
    assert.match(modelUtilsSource, /if \(modelId\.startsWith\(ARNICT_PREFIX\)\) return modelId\.slice\(ARNICT_PREFIX\.length\);/);
    const ablAt = modelUtilsSource.indexOf('ABLITERATION_GROUP,');
    const arnAt = modelUtilsSource.indexOf('ARNICT_GROUP,');
    const llamaAt = modelUtilsSource.indexOf('LLAMACPP_GROUP,');
    assert.ok(ablAt >= 0 && arnAt > ablAt && llamaAt > arnAt, 'priority slot must sit after abliteration, before llamacpp');
  });
  ok('(F4) API client hits both arnict routes with the frozen validate shape', () => {
    assert.match(clientSource, /arnict: \(\) => request<\{ data: OpenRouterModel\[\] \}>\('\/models\/arnict'\),/);
    assert.match(clientSource, /validate: \(\) => request<ArnictValidateResult>\('\/models\/arnict\/validate'\),/);
    assert.match(clientSource, /export interface ArnictValidateResult \{/);
  });
  ok('(F5) catalog hook is module-cached and fail-soft', () => {
    assert.match(hookSource, /export function useArnictModels\(/);
    assert.match(hookSource, /modelsApi\s*\n?\s*\.arnict\(\)/);
    assert.match(hookSource, /return \{ models, loading, error \};/);
  });
  ok('(F6) picker spreads arnict models between abliteration and llamacpp', () => {
    assert.match(selectorSource, /import \{ useArnictModels \} from '\.\.\/hooks\/useArnictModels';/);
    assert.match(selectorSource, /ARNICT_GROUP,/);
    assert.match(
      selectorSource,
      /\[\.\.\.deepSeekModels, \.\.\.codexModels, \.\.\.abliterationModels, \.\.\.arnictModels, \.\.\.llamaCppModels, \.\.\.openRouterModels\]/,
    );
  });
  ok('(F7) routing selector excludes arnict exactly like DeepSeek/Abliteration', () => {
    assert.match(routingSource, /const isArnict = isArnictModel\(modelId\);/);
    assert.match(routingSource, /&& !isDeepSeek && !isAbliteration && !isArnict\)/);
    assert.match(routingSource, /if \(\(isDeepSeek \|\| isAbliteration \|\| isArnict\) && value !== null\) onChange\(null\);/);
    assert.match(routingSource, /Proveedor no disponible para Arnict/);
  });
  ok('(F8) settings card reuses ProviderKeySection with the frozen props', () => {
    assert.match(settingsSource, /function ArnictSection\(\)/);
    assert.match(settingsSource, /settingKey="arnict_api_key"/);
    assert.match(settingsSource, /'arn_live-\.\.\.'/);
    assert.match(settingsSource, /helpUrl="https:\/\/arnict\.com\/"/);
    assert.match(settingsSource, /accentColor=\{ARNICT_ACCENT\}/);
    assert.match(settingsSource, /Arnict key is valid\. \$\{result\.models \?\? 0\} models/);
    const ablAt = settingsSource.indexOf('<AbliterationSection />');
    const arnAt = settingsSource.indexOf('<ArnictSection />');
    const codexAt = settingsSource.indexOf('<ChatGPTSection />');
    assert.ok(ablAt >= 0 && arnAt > ablAt && codexAt > arnAt, 'card must mount between Abliteration and ChatGPT');
  });
  ok('(F9) frontend never calls api.arnict.com directly (backend relay only)', () => {
    for (const [name, src] of [
      ['providers', frontendProvidersSource],
      ['client', clientSource],
      ['hook', hookSource],
      ['settings', settingsSource],
    ] as const) {
      assert.doesNotMatch(src, /api\.arnict\.com/, `${name} must not call the upstream directly`);
    }
  });

  // ---- crypto (GC §11) ------------------------------------------------------
  ok('(K1) arnict_api_key is encrypted at rest', () => {
    assert.match(cryptoSource, /'arnict_api_key',/);
    assert.match(cryptoSource, /SENSITIVE_SETTINGS_KEYS/);
  });

  // ---- store + api shapes (GC §10) ------------------------------------------
  ok('(A1) store holds the key pair + loadSettings arm', () => {
    assert.match(storeSource, /arnictApiKey: string;/);
    assert.match(storeSource, /setArnictApiKey: \(key: string\) => void;/);
    assert.match(storeSource, /arnictApiKey: '',/);
    assert.match(storeSource, /arnictApiKey: data\.arnict_api_key \?\? '',/);
  });
  ok('(A2) ArnictValidateResult carries the frozen {ok,models,ids,error} shape', () => {
    assert.match(clientSource, /export interface ArnictValidateResult \{/);
    assert.match(clientSource, /ok: boolean;/);
    assert.match(clientSource, /models\?: number;/);
    assert.match(clientSource, /ids\?: string\[\];/);
    assert.match(clientSource, /error\?: string;/);
  });

  // ---- UNVERIFIED (keyed recipe never proved: pinned as never-sent) --------
  ok('(U1) no strict:false literal is ever sent (chat + council)', () => {
    assert.doesNotMatch(chatSource, /strict:\s*false/);
    assert.doesNotMatch(councilSource, /strict:\s*false/);
  });
  ok('(U2) no tool_choice object form is ever sent (chat + council)', () => {
    assert.doesNotMatch(chatSource, /tool_choice:\s*\{/);
    assert.doesNotMatch(chatSource, /tool_choice = \{/);
    assert.doesNotMatch(councilSource, /tool_choice:\s*\{/);
    assert.doesNotMatch(councilSource, /tool_choice = \{/);
  });
  ok('(U3) no arnict-gated tools override exists (single generic attach family)', () => {
    assert.doesNotMatch(chatSource, /arnict[\s\S]{0,120}requestBody\.tools/);
    assert.doesNotMatch(councilSource, /arnict[\s\S]{0,120}requestBody\.tools/);
  });
  ok('(U4) no video field is ever sent (chat + council)', () => {
    assert.doesNotMatch(chatSource, /requestBody\.video/);
    assert.doesNotMatch(chatSource, /['"]video['"]\s*:/);
    assert.doesNotMatch(councilSource, /requestBody\.video/);
    assert.doesNotMatch(councilSource, /['"]video['"]\s*:/);
  });
  ok('(U5) no http image URL fallback is ever built (chat + council)', () => {
    assert.doesNotMatch(chatSource, /image_url[^;]*https?:\/\//);
    assert.doesNotMatch(chatSource, /https?:\/\/[^'"]*image_url/);
    assert.doesNotMatch(councilSource, /image_url[^;]*https?:\/\//);
    assert.doesNotMatch(councilSource, /https?:\/\/[^'"]*image_url/);
  });

  // ---- forbidden (GC §11) ---------------------------------------------------
  ok('(A3) ultracode never appears in the arnict touchpoints', () => {
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

console.log(`arnict chat-gates guardrail: OK (${checks} checks)`);
