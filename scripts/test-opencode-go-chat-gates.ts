/**
 * Guardrail for the OpenCode Go provider (7th provider, GC §§1-10,
 * chat-completions phase-1).
 *
 * Source-regex assertions in the `test-arnict-chat-gates.ts` idiom
 * (STABILITY + SEAM, `ok N - name` logging). Two phases live in this one
 * script:
 *
 *   STABILITY — the openrouter/deepseek/codex/llamacpp/abliteration/arnict
 *   branches of providers/index.ts, chat.ts and councilExecutor.ts stay
 *   byte-stable across the Go edits (GC §8: existing branches byte-stable).
 *
 *   SEAM — each GC-frozen Go touchpoint exists exactly where the T1-T5
 *   reports say it landed: registry config/prefix/transport sets, static
 *   catalog routes + validate probe, chat guard/session/replay/reasoning
 *   arms/healing-max exclusions/cost arms/error mapping, council
 *   guard/bodies/cost arms/session headers/comparison skip, frontend
 *   prefix/group/picker/routing-exclusion/settings-card/store arms, and the
 *   crypto allowlist.
 *
 *   UNVERIFIED — the phase-1 recipe never sends `response_format` or any
 *   reasoning field for Go and keeps Go out of the title chain; gating stays
 *   on the generic key doors with no env allowlist. Pinned as tripwires.
 *
 * Transport/relay pins are N/A: Go is a hosted Bearer API relayed
 * server-side like DeepSeek/Abliteration/Arnict (no loopback transport module).
 *
 * Usage:
 *   npx tsx scripts/test-opencode-go-chat-gates.ts
 *
 * Reads source text only — offline-safe, db-free, no network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  goReasoningKnobFor,
  goReasoningNoControl,
  goReasoningOff,
  planGoMessagesBudget,
  planGoReasoningEffort,
} from '../shared/opencodeGoReasoning.js';

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
const hookSource = read('src/hooks/useOpencodeGoModels.ts');
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
  ok('(S3) resolveProviderId deepseek/abliteration/arnict/codex/llamacpp arms preserved', () => {
    assert.match(indexSource, /modelId\.startsWith\(DEEPSEEK_PREFIX\)\) return 'deepseek';/);
    assert.match(indexSource, /modelId\.startsWith\(ABLITERATION_PREFIX\)\) return 'abliteration';/);
    assert.match(indexSource, /modelId\.startsWith\(ARNICT_PREFIX\)\) return 'arnict';/);
    assert.match(indexSource, /modelId\.startsWith\(CODEX_PREFIX\)\) return 'codex';/);
    assert.match(indexSource, /modelId\.startsWith\(LLAMACPP_PREFIX\)\) return 'llamacpp';/);
  });
  ok('(S4) assistantReasoningField deepseek ternary preserved (no Go arm)', () => {
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
  ok('(S8) ARNICT_PREFIX + base URL + label preserved (stable neighbour)', () => {
    assert.match(indexSource, /export const ARNICT_PREFIX = 'arnict:';/);
    assert.match(indexSource, /export const ARNICT_BASE_URL = 'https:\/\/api\.arnict\.com';/);
    assert.match(indexSource, /label: 'Arnict \(Direct\)',/);
  });
  ok('(S9) chat codex branch anchor preserved', () => {
    assert.match(chatSource, /if \(provider\.id === 'codex'\) \{/);
  });
  ok('(S10) chat deepseek thinking assignment preserved', () => {
    assert.match(chatSource, /Object\.assign\(requestBody, buildDeepSeekThinking\(reasoningEnabled, reasoningEffort\)\);/);
  });
  ok('(S11) chat OpenRouter file-parser plugin attach preserved', () => {
    assert.match(chatSource, /requestBody\.plugins = \[\{ id: 'file-parser', pdf: \{ engine: pdf_engine \} \}\];/);
  });
  ok('(S12) council codex member dispatch preserved', () => {
    assert.match(councilSource, /if \(resolveProviderId\(modelId\) === 'codex'\) \{/);
    assert.match(councilSource, /return this\.executeMemberStreamCodex\(modelId, options\);/);
  });
  ok('(S13) council deepseek cost fallback preserved', () => {
    assert.match(councilSource, /else if \(ep\.provider\.id === 'deepseek'\) cost = computeDeepSeekCost\(usage, ep\.upstreamModel\);/);
  });
  ok('(S14) council codex turn bridge import preserved', () => {
    assert.match(councilSource, /import \{ runCodexTurn \} from '\.\.\/codex\/chat\.js';/);
  });
  ok('(S15) council arnict cost arms still exactly two (member + synthesis)', () => {
    const costs = councilSource.match(
      /else if \(ep\.provider\.id === 'arnict'\) cost = computeArnictCost\(usage, ep\.upstreamModel\);/g,
    ) ?? [];
    assert.equal(costs.length, 2);
  });
  ok('(S16) chat title chain stays OpenRouter > arnict > fallback (neighbour intact)', () => {
    assert.match(chatSource, /generateConversationTitleWithOpenRouter\(/);
    assert.match(chatSource, /generateConversationTitleWithArnict\(/);
    assert.match(chatSource, /getSettingValue\(userId, 'arnict_api_key'\)/);
  });
  ok('(S17) frontend arnict neighbour arms intact', () => {
    assert.match(modelUtilsSource, /\[ARNICT_GROUP\]: 'Arnict · Direct',/);
    assert.match(routingSource, /Proveedor no disponible para Arnict/);
  });
}

// ===========================================================================
// SEAMS — the GC-frozen Go touchpoints (T1-T5 as landed)
// ===========================================================================
function seamChecks(): void {
  // ---- registry: prefix / config / resolvers / transport / catalog (GC §1/§3)
  ok('(P1) ProviderId union carries opencode-go', () => {
    assert.match(indexSource, /'openrouter' \| 'deepseek' \| 'codex' \| 'lmstudio' \| 'llamacpp' \| 'abliteration' \| 'arnict' \| 'opencode-go'/);
  });
  ok('(P2) OPENCODE_GO_PREFIX + BASE_URL frozen', () => {
    assert.match(indexSource, /export const OPENCODE_GO_PREFIX = 'opencode-go:';/);
    assert.match(indexSource, /export const OPENCODE_GO_BASE_URL = 'https:\/\/opencode\.ai\/zen\/go\/v1';/);
  });
  ok('(P3) OPENCODE_GO_CONFIG pinned shape (label/endpoint/key/Bearer+UA/flags F,F,F,F)', () => {
    assert.match(indexSource, /label: 'OpenCode Go',/);
    assert.match(indexSource, /chatCompletionsUrl: OPENCODE_GO_CHAT_COMPLETIONS_URL,/);
    assert.match(indexSource, /apiKeySetting: 'opencode_go_api_key',/);
    assert.match(indexSource, /'Authorization': `Bearer \$\{apiKey\}`,/);
    assert.match(indexSource, /'User-Agent': OPENCODE_GO_USER_AGENT,/);
    assert.match(indexSource, /supportsProviderRouting: false,\s*\n\s*supportsPlugins: false,\s*\n\s*supportsReasoningParam: false,\s*\n\s*supportsJsonSchema: false,/);
  });
  ok('(P4) resolveProviderId + toUpstreamModelId opencode-go arms', () => {
    assert.match(indexSource, /modelId\.startsWith\(OPENCODE_GO_PREFIX\)\) return 'opencode-go';/);
    assert.match(indexSource, /modelId\.startsWith\(OPENCODE_GO_PREFIX\)\) return modelId\.slice\(OPENCODE_GO_PREFIX\.length\);/);
  });
  ok('(P5) isOpencodeGoModel classifier exported', () => {
    assert.match(indexSource, /export function isOpencodeGoModel\(/);
  });
  ok('(P6) persistedModelId keeps namespaced id for opencode-go', () => {
    assert.match(indexSource, /providerId === 'arnict' \|\| providerId === 'opencode-go'/);
  });
  ok('(P7) CONFIGS map wires opencode-go', () => {
    assert.match(indexSource, /'opencode-go': OPENCODE_GO_CONFIG,/);
  });
  ok('(P8) transport sets + helpers exported (chat/messages/responses/unknown)', () => {
    assert.match(indexSource, /export const OPENCODE_GO_CHAT_TRANSPORT_MODELS/);
    assert.match(indexSource, /export const OPENCODE_GO_NON_CHAT_TRANSPORT/);
    assert.match(indexSource, /export function opencodeGoTransportFor\(/);
    assert.match(indexSource, /export function opencodeGoWrongTransportMessage\(/);
    assert.match(indexSource, /export function opencodeGoFormatMismatchMessage\(/);
  });
  ok('(P9) static catalog + cost helpers implement the §6 3-form cache split', () => {
    assert.match(indexSource, /export const OPENCODE_GO_CATALOG/);
    assert.match(indexSource, /export function computeOpencodeGoCost\(/);
    assert.match(indexSource, /export function opencodeGoCachedTokens\(/);
    assert.match(
      indexSource,
      /usage\.prompt_cache_hit_tokens \?\? usage\.prompt_tokens_details\?\.cached_tokens \?\? 0/,
    );
  });
  ok('(P10) per-model replay set + field helper exported, no Go reasoning builder', () => {
    assert.match(indexSource, /export const OPENCODE_GO_REASONING_CONTENT_MODELS/);
    assert.match(indexSource, /export function opencodeGoHistoryReasoningField\(/);
    assert.doesNotMatch(indexSource, /buildOpencodeGoReasoning|buildOpenCodeGoReasoning/);
    assert.doesNotMatch(indexSource, /isOpencodeGoLargeModel|OPENCODE_GO_TOOLS_UNSUPPORTED_MESSAGE/);
  });

  // ---- models.ts: static catalog + validate probe (GC §3 + §7) -------------
  ok('(R1) models.ts imports the Go catalog + URL + validate model + UA', () => {
    assert.match(modelsSource, /OPENCODE_GO_CATALOG,/);
    assert.match(modelsSource, /OPENCODE_GO_CHAT_COMPLETIONS_URL,/);
    assert.match(modelsSource, /OPENCODE_GO_USER_AGENT,/);
    assert.match(modelsSource, /OPENCODE_GO_VALIDATE_MODEL/);
    assert.match(modelsSource, /OPENCODE_GO_CATALOG_VERSION/);
    assert.match(modelsSource, /OPENCODE_GO_BASE_URL/);
  });
  ok('(R2) GET /opencodego returns the static catalog with versioned meta (no key gate)', () => {
    assert.match(modelsSource, /router\.get\('\/opencodego',/);
    assert.match(modelsSource, /res\.json\(\{\s*\n?\s*data: OPENCODE_GO_CATALOG,\s*\n?\s*meta:/);
    assert.match(modelsSource, /version: OPENCODE_GO_CATALOG_VERSION,/);
    assert.match(modelsSource, /count: OPENCODE_GO_CATALOG\.length,/);
    assert.match(modelsSource, /fetchedAt: new Date\(\)\.toISOString\(\),/);
    assert.match(modelsSource, /OPENCODE_GO_DRIFT_TTL_MS = 60 \* 60 \* 1000/);
    assert.match(modelsSource, /maybeLogOpencodeGoDrift/);
    assert.match(modelsSource, /`\$\{OPENCODE_GO_BASE_URL\}\/models`/);
    assert.match(modelsSource, /drift detected \(version/);
  });
  ok('(R3) GET /opencodego/validate probes a 1-token POST behind the key gate', () => {
    assert.match(modelsSource, /router\.get\('\/opencodego\/validate',/);
    assert.match(modelsSource, /getSettingValue\(userId, 'opencode_go_api_key'\)/);
    assert.match(modelsSource, /error: 'OpenCode Go API key not configured'/);
    assert.match(modelsSource, /model: OPENCODE_GO_VALIDATE_MODEL,/);
    assert.match(modelsSource, /max_tokens: 1,/);
    assert.match(modelsSource, /'Authorization': `Bearer \$\{apiKey\}`,/);
    assert.match(modelsSource, /'User-Agent': OPENCODE_GO_USER_AGENT,/);
    assert.match(modelsSource, /'x-opencode-session': `validate-\$\{nanoid\(\)\}`,/);
  });
  ok('(R4) validate maps 401/402-429 with the frozen §7 envelopes, 500 on transport failure', () => {
    assert.match(modelsSource, /error: 'Invalid OpenCode Go API key\. Check your key in Settings → OpenCode Go\.',/);
    assert.match(modelsSource, /response\.status === 402 \|\| response\.status === 429/);
    assert.match(modelsSource, /OpenCode Go usage limit reached for this model\. Check usage in the OpenCode console/);
    assert.match(modelsSource, /res\.json\(\{ ok: true, model: OPENCODE_GO_VALIDATE_MODEL \}\);/);
    assert.match(modelsSource, /res\.status\(500\)\.json\(\{ ok: false, error: 'Failed to reach OpenCode Go' \}\);/);
  });
  ok('(R5) no .env.example entry (settings-only like DeepSeek/Abliteration/Arnict)', () => {
    assert.doesNotMatch(envSource, /opencode/i);
  });

  // ---- chat.ts (GC §4/§5/§6/§7/§8) -----------------------------------------
  ok('(C1) chat imports the five Go helpers and grants no key exemption', () => {
    assert.match(chatSource, /computeOpencodeGoCost,/);
    assert.match(chatSource, /opencodeGoCachedTokens,/);
    assert.match(chatSource, /opencodeGoFormatMismatchMessage,/);
    assert.match(chatSource, /opencodeGoHistoryReasoningField,/);
    assert.match(chatSource, /opencodeGoTransportFor,/);
    // T5: the phase-2 hard-fail is retired (both transports send), so the
    // wrong-transport helper is no longer imported by the sender.
    assert.doesNotMatch(chatSource, /opencodeGoWrongTransportMessage/);
    assert.doesNotMatch(chatSource, /isOpencodeGoModel/);
  });
  ok('(C2) chat has no wrong-transport guard: every known transport sends behind the generic key gate', () => {
    assert.doesNotMatch(chatSource, /opencodeGoWrongTransportMessage/);
    assert.doesNotMatch(chatSource, /const goTransport = opencodeGoTransportFor\(upstreamModel\);/);
    assert.match(chatSource, /const apiKey = getSettingValue\(userId, provider\.apiKeySetting\);/);
  });
  ok('(C3) chat replays history per-model in both sites (map + tool-loop push)', () => {
    const replays = chatSource.match(
      /provider\.id === 'opencode-go' \? opencodeGoHistoryReasoningField\(upstreamModel\) : assistantReasoningField\(provider\.id\)/g,
    ) ?? [];
    assert.equal(replays.length, 2);
  });
  ok('(C4) chat sets the per-POST session header', () => {
    assert.match(chatSource, /headers\['x-opencode-session'\] = conversation_id;/);
  });
  ok('(C5) chat Go arm sends planned reasoning_effort top-level (K1-GO; thinking never travels)', () => {
    assert.match(chatSource, /\} else if \(provider\.id === 'opencode-go'\) \{/);
    const armAt = chatSource.indexOf("} else if (provider.id === 'opencode-go') {");
    assert.ok(armAt >= 0, 'Go reasoning arm missing');
    const armEnd = chatSource.indexOf('\n    }\n', armAt);
    assert.ok(armEnd > armAt, 'Go reasoning arm bounds missing');
    const arm = chatSource.slice(armAt, armEnd);
    assert.match(arm, /requestBody\.reasoning_effort/);
    assert.match(arm, /!isGoMessages && !isGoResponses/);
    assert.doesNotMatch(arm, /requestBody\.reasoning\s*=/);
    assert.doesNotMatch(arm, /requestBody\.thinking/);
    assert.doesNotMatch(arm, /requestBody\.effort/);
    assert.doesNotMatch(arm, /buildDeepSeekThinking|buildAbliterationReasoning|buildArnictReasoning/);
  });
  ok('(C6) chat Go turns set the stream_options usage frame (chat transport; messages/responses carry usage in-band)', () => {
    assert.match(
      chatSource,
      /if \(provider\.id === 'opencode-go' && !isGoMessages && !isGoResponses\) \{[\s\S]{0,600}?requestBody\.stream_options = \{ include_usage: true \};/,
    );
  });
  ok('(C7) chat healing + effort-max exclusions name opencode-go', () => {
    assert.match(
      chatSource,
      /provider\.id !== 'arnict' && provider\.id !== 'opencode-go';/,
    );
    assert.match(chatSource, /const useResponseHealing = .* && provider\.id !== 'opencode-go';/);
    assert.match(chatSource, /const requestedMaxEffort = .* && provider\.id !== 'opencode-go';/);
  });
  ok('(C8) chat healing + streaming usage blocks compute static cost without overwriting', () => {
    assert.match(chatSource, /cachedTokens = opencodeGoCachedTokens\(au\);/);
    assert.match(chatSource, /if \(u\.cost === undefined\) cost = computeOpencodeGoCost\(au, upstreamModel\);/);
    assert.match(chatSource, /cachedTokens = opencodeGoCachedTokens\(usage\);/);
    assert.match(chatSource, /if \(usage\.cost === undefined\) cost = computeOpencodeGoCost\(usage, upstreamModel\);/);
  });
  ok('(C9) chat maps 401/402-429/mismatch with the frozen §7 literals', () => {
    assert.match(chatSource, /errorMsg = 'Invalid OpenCode Go API key\. Check your key in Settings → OpenCode Go\.';/);
    assert.match(chatSource, /\} else if \(goStatus === 402 \|\| goStatus === 429\) \{/);
    assert.match(chatSource, /errorMsg = 'OpenCode Go usage limit reached for this model\. Check usage in the OpenCode console \(https:\/\/opencode\.ai\/docs\/go\/\) or enable the Zen-balance fallback there\.';/);
    assert.match(chatSource, /\/not supported for format\|oa-compat\/i/);
    assert.match(chatSource, /errorMsg = opencodeGoFormatMismatchMessage\(upstreamModel, goPrefix \|\| `status \$\{goStatus\}`\);/);
    assert.match(chatSource, /const goPrefix = goDetail\.slice\(0, 300\);/);
    assert.match(chatSource, /errorMsg = `OpenCode Go request failed \(status \$\{goStatus\}\): \$\{goPrefix \|\| 'unknown error'\}`;/);
  });

  // ---- councilExecutor.ts mirrors (GC §4/§5/§6/§7/§8) -----------------------
  ok('(M1) council imports the Go helpers and grants no key exemption', () => {
    assert.match(councilSource, /computeOpencodeGoCost,/);
    assert.match(councilSource, /opencodeGoFormatMismatchMessage,/);
    assert.match(councilSource, /opencodeGoHistoryReasoningField,/);
    assert.match(councilSource, /opencodeGoTransportFor,/);
    // T5: no hard-fail left (both phase-2 transports send), so the
    // wrong-transport helper is no longer imported by the executor.
    assert.doesNotMatch(councilSource, /opencodeGoWrongTransportMessage/);
    assert.doesNotMatch(councilSource, /isOpencodeGoModel/);
  });
  ok('(M2) council member + synthesis have no wrong-transport guard (both transports send)', () => {
    assert.doesNotMatch(councilSource, /const goTransport = opencodeGoTransportFor\(ep\.upstreamModel\);/);
    assert.doesNotMatch(councilSource, /opencodeGoWrongTransportMessage/);
    const responsesFlags = councilSource.match(/const isGoResponses = ep\.provider\.id === 'opencode-go' && opencodeGoTransportFor\(ep\.upstreamModel\) === 'responses';/g) ?? [];
    assert.equal(responsesFlags.length, 2);
  });
  ok('(M3) council member + synthesis map the fail-open mismatch', () => {
    const maps = councilSource.match(
      /if \(ep\.provider\.id === 'opencode-go' && \/not supported for format\|oa-compat\/i\.test\(errorText\)\) \{/g,
    ) ?? [];
    assert.equal(maps.length, 2);
    // T4: the messages branches reuse the same frozen helper (member +
    // synthesis), so the helper call appears 4x total (2 chat + 2 messages).
    const throws = councilSource.match(
      /throw new Error\(opencodeGoFormatMismatchMessage\(ep\.upstreamModel, errorText\.slice\(0, 200\)\)\);/g,
    ) ?? [];
    assert.equal(throws.length, 4);
  });
  ok('(M4) council member + synthesis usage blocks compute static cost (chat transport; messages via mappedUsage)', () => {
    const costs = councilSource.match(
      /else if \(ep\.provider\.id === 'opencode-go' && !isGoMessages\) cost = computeOpencodeGoCost\(usage, ep\.upstreamModel\);/g,
    ) ?? [];
    assert.equal(costs.length, 2);
  });
  ok('(M5) council member tool-loop replays per-model (single site)', () => {
    const replays = councilSource.match(
      /ep\.provider\.id === 'opencode-go' \? opencodeGoHistoryReasoningField\(ep\.upstreamModel\) : assistantReasoningField\(ep\.provider\.id\)/g,
    ) ?? [];
    assert.equal(replays.length, 1);
  });
  ok('(M6) council sets the session header on member/synthesis/comparison', () => {
    const headers = councilSource.match(/ep\.headers\['x-opencode-session'\]/g) ?? [];
    assert.equal(headers.length, 3);
    assert.match(councilSource, /ep\.headers\['x-opencode-session'\] = options\.conversationId \?\? options\.userId \?\? 'unknown';/);
    assert.match(councilSource, /ep\.headers\['x-opencode-session'\] = userId \?\? 'unknown';/);
  });
  ok('(M7) council comparison skips Go via the generic json_schema gate; preflight untouched', () => {
    assert.match(councilSource, /if \(!getProviderForModel\(synthesizerModel\)\.supportsJsonSchema\) \{/);
    assert.doesNotMatch(chatCouncilSource, /opencode-go/i);
  });
  ok('(M8) council resolveEndpoint stays generic: no Go key exemption', () => {
    assert.match(councilSource, /if \(!apiKey\?\.trim\(\) && provider\.id !== 'lmstudio' && provider\.id !== 'llamacpp'\) \{/);
  });

  // ---- frontend (GC §9) ----------------------------------------------------
  ok('(F1) frontend prefix/group/accent literals frozen', () => {
    assert.match(frontendProvidersSource, /export const OPENCODE_GO_PREFIX = 'opencode-go:';/);
    assert.match(frontendProvidersSource, /export const OPENCODE_GO_GROUP = 'opencode-go-direct';/);
    assert.match(frontendProvidersSource, /export const OPENCODE_GO_ACCENT = '#a855f7';/);
  });
  ok('(F2) frontend classifier + display strip', () => {
    assert.match(frontendProvidersSource, /export function isOpencodeGoModel\(/);
    assert.match(frontendProvidersSource, /export function stripOpencodeGoPrefix\(/);
  });
  ok('(F3) picker groups/displays OpenCode Go Direct (premium/brain) after arnict', () => {
    assert.match(modelUtilsSource, /\[OPENCODE_GO_GROUP\]: 'OpenCode Go · Direct',/);
    assert.match(modelUtilsSource, /\[OPENCODE_GO_GROUP\]: OPENCODE_GO_ACCENT,/);
    assert.match(modelUtilsSource, /\[OPENCODE_GO_GROUP\]: \{ name: 'OpenCode Go · Direct', color: OPENCODE_GO_ACCENT, iconName: 'brain', tier: 'premium' \},/);
    assert.match(modelUtilsSource, /if \(isOpencodeGoModel\(id\)\) return OPENCODE_GO_GROUP;/);
    assert.match(modelUtilsSource, /if \(modelId\.startsWith\(OPENCODE_GO_PREFIX\)\) return modelId\.slice\(OPENCODE_GO_PREFIX\.length\);/);
    const arnAt = modelUtilsSource.indexOf('ARNICT_GROUP,');
    const goAt = modelUtilsSource.indexOf('OPENCODE_GO_GROUP,');
    const llamaAt = modelUtilsSource.indexOf('LLAMACPP_GROUP,');
    assert.ok(arnAt >= 0 && goAt > arnAt && llamaAt > goAt, 'priority slot must sit after arnict, before llamacpp');
  });
  ok('(F4) API client hits both Go routes with the frozen validate shape', () => {
    assert.match(clientSource, /opencodego: \(\) => request<\{ data: OpenRouterModel\[\]; meta\?: OpencodeGoListMeta \}>\('\/models\/opencodego'\),/);
    assert.match(clientSource, /export interface OpencodeGoListMeta \{/);
    assert.match(clientSource, /version: string;/);
    assert.match(clientSource, /count: number;/);
    assert.match(clientSource, /fetchedAt: string;/);
    assert.match(clientSource, /validate: \(\) => request<OpencodeGoValidateResult>\('\/models\/opencodego\/validate'\),/);
    assert.match(clientSource, /export interface OpencodeGoValidateResult \{/);
    assert.match(clientSource, /ok: boolean;/);
    assert.match(clientSource, /model\?: string;/);
    assert.match(clientSource, /ids\?: string\[\];/);
    assert.match(clientSource, /error\?: string;/);
  });
  ok('(F5) catalog hook is module-cached and fail-soft', () => {
    assert.match(hookSource, /export const OPENCODE_GO_STATUS_CHANGED_EVENT = 'opencode-go:status-changed';/);
    assert.match(hookSource, /SWR_TTL_MS/);
    assert.match(hookSource, /modelsApi\s*\n?\s*\.opencodego\(\)/);
    assert.match(hookSource, /window\.addEventListener\(OPENCODE_GO_STATUS_CHANGED_EVENT,/);
    assert.match(hookSource, /window\.removeEventListener\(OPENCODE_GO_STATUS_CHANGED_EVENT,/);
    assert.match(hookSource, /return \{ models, loading, error, meta, refresh \};/);
  });
  ok('(F6) picker spreads Go models between arnict and llamacpp + expands the group', () => {
    assert.match(selectorSource, /import \{ useOpencodeGoModels \} from '\.\.\/hooks\/useOpencodeGoModels';/);
    assert.match(selectorSource, /\.\.\.arnictModels, \.\.\.opencodeGoModels, \.\.\.llamaCppModels/);
    assert.match(selectorSource, /ARNICT_GROUP, OPENCODE_GO_GROUP, LLAMACPP_GROUP,/);
  });
  ok('(F7) routing selector excludes Go exactly like DeepSeek/Abliteration/Arnict', () => {
    assert.match(routingSource, /const isOpencodeGo = isOpencodeGoModel\(modelId\);/);
    assert.match(routingSource, /&& !isArnict && !isOpencodeGo\)/);
    assert.match(routingSource, /isArnict \|\| isOpencodeGo\) && value !== null\) onChange\(null\);/);
    assert.match(routingSource, /Proveedor no disponible para OpenCode Go/);
  });
  ok('(F8) settings card reuses ProviderKeySection with the frozen props', () => {
    assert.match(settingsSource, /function OpenCodeGoSection\(\)/);
    assert.match(settingsSource, /settingKey="opencode_go_api_key"/);
    assert.match(settingsSource, /accentColor=\{OPENCODE_GO_ACCENT\}/);
    assert.match(settingsSource, /helpUrl="https:\/\/opencode\.ai\/docs\/go\/"/);
    assert.match(settingsSource, /Requires an OpenCode Go subscription/);
    assert.match(settingsSource, /'Paste your OpenCode Go API key'/);
    assert.match(settingsSource, /OpenCode Go key is valid \(probe model:/);
    const arnAt = settingsSource.indexOf('<ArnictSection />');
    const goAt = settingsSource.indexOf('<OpenCodeGoSection />');
    const codexAt = settingsSource.indexOf('<ChatGPTSection />');
    assert.ok(arnAt >= 0 && goAt > arnAt && codexAt > goAt, 'card must mount between Arnict and ChatGPT');
    assert.match(settingsSource, /OPENCODE_GO_STATUS_CHANGED_EVENT/);
    assert.match(settingsSource, /window\.dispatchEvent\(new Event\(OPENCODE_GO_STATUS_CHANGED_EVENT\)\)/);
  });
  ok('(F9) frontend never calls the upstream directly (backend relay only)', () => {
    for (const [name, src] of [
      ['providers', frontendProvidersSource],
      ['client', clientSource],
      ['hook', hookSource],
      ['settings', settingsSource],
    ] as const) {
      assert.doesNotMatch(src, /api\.opencode\.ai/, `${name} must not call the upstream directly`);
    }
  });

  // ---- crypto (GC §2) + store (§ Interfaces) --------------------------------
  ok('(K1) opencode_go_api_key is encrypted at rest', () => {
    assert.match(cryptoSource, /'opencode_go_api_key',/);
    assert.match(cryptoSource, /SENSITIVE_SETTINGS_KEYS/);
  });
  ok('(A1) store holds the key pair + loadSettings arm', () => {
    assert.match(storeSource, /opencodeGoApiKey: string;/);
    assert.match(storeSource, /setOpencodeGoApiKey: \(key: string\) => void;/);
    assert.match(storeSource, /opencodeGoApiKey: '',/);
    assert.match(storeSource, /opencodeGoApiKey: data\.opencode_go_api_key \?\? '',/);
  });

  // ---- UNVERIFIED tripwires (phase-1 recipe: pinned as never-sent) ----------
  ok('(U1) no response_format assignment is reachable for Go (single gated site)', () => {
    const assigns = chatSource.match(/requestBody\.response_format = responseFormat;/g) ?? [];
    assert.equal(assigns.length, 1);
    assert.match(chatSource, /if \(provider\.supportsJsonSchema && structuredEnabled/);
  });
  ok('(U2) Go chat arm sends only reasoning_effort top-level (K1 VERIFIED; thinking never travels)', () => {
    // Retired UNVERIFIED tripwire: K1 keyed VERIFIED `reasoning_effort` with
    // `thinking` measured no-op, so the arm now sends exactly one field.
    const armAt = chatSource.indexOf("} else if (provider.id === 'opencode-go') {");
    assert.ok(armAt >= 0, 'Go reasoning arm missing');
    const armEnd = chatSource.indexOf('\n    }\n', armAt);
    assert.ok(armEnd > armAt, 'Go reasoning arm bounds missing');
    const arm = chatSource.slice(armAt, armEnd);
    assert.match(arm, /requestBody\.reasoning_effort/);
    assert.doesNotMatch(arm, /requestBody\.reasoning\s*=/);
    assert.doesNotMatch(arm, /requestBody\.thinking/);
  });
  ok('(U3) title chain never spends Go quota (OpenRouter > arnict > fallback only)', () => {
    const start = chatSource.indexOf('// Update conversation title if first message');
    const end = chatSource.indexOf('// Build messages array (include tool_calls');
    assert.ok(start >= 0 && end > start, 'title block bounds missing');
    const block = chatSource.slice(start, end);
    assert.doesNotMatch(block, /opencode-go/i);
    assert.doesNotMatch(block, /opencode_go/i);
  });
  ok('(U4) gating is generic: no Go env allowlist, no Go key exemption', () => {
    const server = indexSource + chatSource + councilSource + modelsSource + cryptoSource;
    assert.doesNotMatch(server, /opencode[-_]go[-_]allowed/i);
    assert.doesNotMatch(server, /process\.env\.(OPENCODE_GO|OPENCODE_ZEN|OPENCODE_API_KEY)/);
    assert.match(chatSource, /!apiKey\?\.trim\(\) && !isCodexModel\(effectiveModel\) && !isLlamacppModel\(effectiveModel\)/);
  });

  // ---- forbidden (GC §7/§9: no foreign provider fields in Go touchpoints) ---
  ok('(A3) ultracode never appears in the Go touchpoints', () => {
    assert.doesNotMatch(chatSource, /ultracode/);
    assert.doesNotMatch(councilSource, /ultracode/);
    assert.doesNotMatch(modelsSource, /ultracode/);
    assert.doesNotMatch(clientSource, /ultracode/);
    assert.doesNotMatch(selectorSource, /ultracode/);
    assert.doesNotMatch(routingSource, /ultracode/);
    assert.doesNotMatch(settingsSource, /ultracode/);
    assert.doesNotMatch(storeSource, /ultracode/);
    // `ultracode` legitimately appears once in the abliteration builder
    // comment; pin its absence in the Go block only.
    const goAt = indexSource.indexOf('// Context windows: https://models.opencode.ai/api.json');
    assert.ok(goAt >= 0, 'Go catalog block missing');
    assert.doesNotMatch(indexSource.slice(goAt), /ultracode/);
  });
}

// ===========================================================================
// T4 — messages transport sender (Anthropic shape, T3 VERIFIED-shape with the
// x-api-key auth divergence). responses still hard-fails, unknown still
// fail-opens; the §7 literals and 401/402/429 texts are shared with chat.
// ===========================================================================
function t4Checks(): void {
  ok('(T4-1) chat has no wrong-transport guard left (messages sends since T4, responses since T5)', () => {
    assert.doesNotMatch(chatSource, /if \(goTransport === 'responses'\) \{/);
    assert.doesNotMatch(chatSource, /goTransport === 'messages' \|\| goTransport === 'responses'/);
    assert.doesNotMatch(chatSource, /goTransport/);
  });
  ok('(T4-2) chat messages sender posts to OPENCODE_GO_MESSAGES_URL with model bare + max_tokens + stream', () => {
    assert.match(chatSource, /OPENCODE_GO_MESSAGES_URL/);
    assert.match(chatSource, /buildOpencodeGoMessagesBody/);
    assert.match(chatSource, /stream: true/);
  });
  ok('(T4-3) chat messages sender sets anthropic-version + x-api-key (T3 divergence, Bearer kept)', () => {
    assert.match(chatSource, /OPENCODE_GO_ANTHROPIC_VERSION/);
    assert.match(chatSource, /'anthropic-version'/);
    assert.match(chatSource, /'x-api-key'/);
  });
  ok('(T4-4) chat maps tools to the Anthropic native form (never the OpenAI shape)', () => {
    assert.match(chatSource, /input_schema/);
    assert.match(chatSource, /tool_use/);
    assert.match(chatSource, /tool_result/);
  });
  ok('(T4-5) chat parses the Anthropic SSE sequence (content_block_delta + message_delta)', () => {
    assert.match(chatSource, /content_block_delta/);
    assert.match(chatSource, /message_delta/);
    assert.match(chatSource, /content_block_start/);
    assert.match(chatSource, /message_stop/);
  });
  ok('(T4-6) chat maps Anthropic usage to computeOpencodeGoCost (hit=cache_read, write=cache_creation, contextTokens; upstream cost wins)', () => {
    assert.match(chatSource, /cache_read_input_tokens/);
    assert.match(chatSource, /cache_creation_input_tokens/);
    assert.match(chatSource, /prompt_cache_write_tokens/);
    assert.match(chatSource, /contextTokens/);
    assert.match(chatSource, /computeOpencodeGoCost\(mappedUsage, upstreamModel, \{ contextTokens/);
  });
  ok('(T4-7) chat messages errors reuse the frozen 401/402/429 + mismatch literals (Content-Type lie read as text)', () => {
    assert.match(chatSource, /await apiResponse\.text\(\)/);
    assert.match(chatSource, /errorMsg = 'Invalid OpenCode Go API key\. Check your key in Settings → OpenCode Go\.';/);
    assert.match(chatSource, /errorMsg = 'OpenCode Go usage limit reached for this model/);
    assert.match(chatSource, /errorMsg = opencodeGoFormatMismatchMessage\(upstreamModel, goPrefix/);
  });
  ok('(T4-8) council member + synthesis have no wrong-transport guard left (both transports send)', () => {
    assert.doesNotMatch(councilSource, /if \(goTransport === 'responses'\) \{/);
    assert.doesNotMatch(councilSource, /goTransport === 'messages' \|\| goTransport === 'responses'/);
    assert.doesNotMatch(councilSource, /goTransport/);
  });
  ok('(T4-9) council messages sender mirrors chat (URL + version + x-api-key + Anthropic SSE + cost)', () => {
    assert.match(councilSource, /OPENCODE_GO_MESSAGES_URL/);
    assert.match(councilSource, /OPENCODE_GO_ANTHROPIC_VERSION/);
    assert.match(councilSource, /'anthropic-version'/);
    assert.match(councilSource, /'x-api-key'/);
    assert.match(councilSource, /content_block_delta/);
    assert.match(councilSource, /message_delta/);
    assert.match(councilSource, /cache_read_input_tokens/);
    assert.match(councilSource, /cache_creation_input_tokens/);
    assert.match(councilSource, /contextTokens/);
    assert.match(councilSource, /input_schema/);
  });
  ok('(T4-10) no transport hard-fails and unknown still fail-opens (§7 intact)', () => {
    assert.doesNotMatch(chatSource, /opencodeGoWrongTransportMessage/);
    assert.doesNotMatch(councilSource, /opencodeGoWrongTransportMessage/);
    assert.match(chatSource, /opencodeGoFormatMismatchMessage\(upstreamModel, goPrefix/);
  });
}

// ===========================================================================
// T5 — responses transport sender (Responses API, T3 VERIFIED GO Bearer-only).
// Both phase-2 transports send now; `unknown` still fail-opens; the §7
// literals and 401/402/429 texts are shared with chat/messages.
// ===========================================================================
function t5Checks(): void {
  ok('(T5-1) chat responses sender posts to OPENCODE_GO_RESPONSES_URL with model bare + input + stream', () => {
    assert.match(chatSource, /OPENCODE_GO_RESPONSES_URL/);
    assert.match(chatSource, /buildOpencodeGoResponsesBody/);
    assert.match(chatSource, /mapOpencodeGoResponsesUsage/);
  });
  ok('(T5-2) chat responses auth is Bearer-only (no x-api-key, no anthropic-version on the responses path)', () => {
    assert.match(chatSource, /const isGoResponses = provider\.id === 'opencode-go' && opencodeGoTransportFor\(upstreamModel\) === 'responses';/);
    assert.match(chatSource, /apiUrl = OPENCODE_GO_RESPONSES_URL;/);
    const apiKeySets = chatSource.match(/headers\['x-api-key'\]/g) ?? [];
    assert.equal(apiKeySets.length, 1);
  });
  ok('(T5-3) chat responses body emits planned effort + cost guard (T3; fixed low gone, toggle threaded)', () => {
    assert.doesNotMatch(chatSource, /reasoning: \{ effort: 'low' \}/);
    assert.match(chatSource, /max_output_tokens/);
    assert.match(chatSource, /instructions/);
    const fnAt = chatSource.indexOf('export function buildOpencodeGoResponsesBody');
    assert.ok(fnAt >= 0, 'responses body builder missing');
    const fnBody = chatSource.slice(fnAt, fnAt + 3200);
    assert.match(fnBody, /reasoningEnabled/);
    assert.match(fnBody, /reasoningEffort/);
    assert.match(fnBody, /planOpencodeGoResponsesEffort|planGoReasoningEffort|goReasoningOff/);
    assert.doesNotMatch(fnBody, /reasoning_max_tokens/);
  });
  ok('(T5-4) chat parses the Responses SSE sequence (output_text deltas + response.completed + ping cost)', () => {
    assert.match(chatSource, /output_text\.delta/);
    assert.match(chatSource, /response\.completed/);
    assert.match(chatSource, /function_call/);
  });
  ok('(T5-5) chat maps Responses usage to computeOpencodeGoCost (hit=cached_tokens, miss=in-cached, tier by contextTokens; upstream cost wins)', () => {
    assert.match(chatSource, /input_tokens_details/);
    assert.match(chatSource, /cached_tokens/);
    assert.match(chatSource, /reasoning_tokens/);
    assert.match(chatSource, /computeOpencodeGoCost\(mappedResponsesUsage, upstreamModel, \{ contextTokens/);
  });
  ok('(T5-6) chat responses errors reuse the frozen 401/402/429 + mismatch literals (Content-Type lie read as text)', () => {
    assert.match(chatSource, /await apiResponse\.text\(\)/);
    assert.match(chatSource, /errorMsg = 'Invalid OpenCode Go API key\. Check your key in Settings → OpenCode Go\.';/);
    assert.match(chatSource, /errorMsg = 'OpenCode Go usage limit reached for this model/);
    assert.match(chatSource, /errorMsg = opencodeGoFormatMismatchMessage\(upstreamModel, goPrefix/);
  });
  ok('(T5-7) council member + synthesis mirror chat on the responses path (URL + Bearer-only + SSE + cost)', () => {
    assert.match(councilSource, /OPENCODE_GO_RESPONSES_URL/);
    assert.match(councilSource, /buildCouncilGoResponsesBody/);
    assert.match(councilSource, /mapCouncilGoResponsesUsage/);
    assert.match(councilSource, /output_text\.delta/);
    assert.match(councilSource, /response\.completed/);
    assert.match(councilSource, /input_tokens_details/);
    assert.match(councilSource, /contextTokens/);
  });
  ok('(T5-8) council responses paths add no x-api-key (Bearer-only per T3; the 2 messages sets stay)', () => {
    const apiKeySets = councilSource.match(/ep\.headers\['x-api-key'\]/g) ?? [];
    assert.equal(apiKeySets.length, 2);
    const versions = councilSource.match(/ep\.headers\['anthropic-version'\]/g) ?? [];
    assert.equal(versions.length, 2);
  });
}

// ===========================================================================
// T6 — responses tools in flat Responses form (400 `tools[0] missing required
// field name` fix). Both responses builders map each Chat-form tool
// {type:'function',function:{name,description,parameters}} to the flat
// Responses wire {type:'function',name,description,parameters} (no nested
// `function`, no `input_schema`, no `strict`, no tool_choice/
// parallel_tool_calls/stream_options on this wire); invalid names fail locally
// naming the tool index, before any POST. Messages mapping + the
// none/includeTools:false omissions stay intact.
// ===========================================================================
function t6Checks(): void {
  const chatResponsesAt = chatSource.indexOf('export function buildOpencodeGoResponsesBody');
  assert.ok(chatResponsesAt >= 0, 'chat responses builder missing');
  const chatResponsesEnd = chatSource.indexOf('export interface OpencodeGoResponsesUsage', chatResponsesAt);
  assert.ok(chatResponsesEnd > chatResponsesAt, 'chat responses builder bounds missing');
  const chatResponsesBody = chatSource.slice(chatResponsesAt, chatResponsesEnd);
  const councilResponsesAt = councilSource.indexOf('function buildCouncilGoResponsesBody');
  assert.ok(councilResponsesAt >= 0, 'council responses builder missing');
  const councilResponsesEnd = councilSource.indexOf('interface CouncilGoResponsesUsage', councilResponsesAt);
  assert.ok(councilResponsesEnd > councilResponsesAt, 'council responses builder bounds missing');
  const councilResponsesBody = councilSource.slice(councilResponsesAt, councilResponsesEnd);

  ok('(T6-1) chat responses builder flattens tools to the Responses wire form', () => {
    assert.match(chatResponsesBody, /body\.tools = opts\.openRouterTools\.map\(\(t/);
    assert.match(chatResponsesBody, /type: 'function',/);
    assert.match(chatResponsesBody, /t\.function\?\.name|t\.function\.name/);
    assert.match(chatResponsesBody, /description: t\.function\.description,/);
    assert.match(chatResponsesBody, /parameters: t\.function\.parameters,/);
    assert.doesNotMatch(chatResponsesBody, /body\.tools = opts\.openRouterTools;/);
    assert.doesNotMatch(chatResponsesBody, /input_schema/);
    assert.doesNotMatch(chatResponsesBody, /strict\s*:/);
    assert.doesNotMatch(chatResponsesBody, /tool_choice|parallel_tool_calls|stream_options/);
  });
  ok('(T6-2) council responses builder mirrors the flat wire form', () => {
    assert.match(councilResponsesBody, /body\.tools = opts\.openRouterTools\.map\(\(t/);
    assert.match(councilResponsesBody, /type: 'function',/);
    assert.match(councilResponsesBody, /t\.function\?\.name|t\.function\.name/);
    assert.match(councilResponsesBody, /description: t\.function\.description,/);
    assert.match(councilResponsesBody, /parameters: t\.function\.parameters,/);
    assert.doesNotMatch(councilResponsesBody, /body\.tools = opts\.openRouterTools;/);
    assert.doesNotMatch(councilResponsesBody, /input_schema/);
    assert.doesNotMatch(councilResponsesBody, /strict\s*:/);
    assert.doesNotMatch(councilResponsesBody, /tool_choice|parallel_tool_calls|stream_options/);
  });
  ok('(T6-3) invalid tool names fail locally naming the tool index (both builders)', () => {
    for (const [name, src] of [['chat', chatResponsesBody], ['council', councilResponsesBody]] as const) {
      assert.match(src, /A-Za-z0-9_-/, `${name} responses builder must pin the tool-name pattern`);
      assert.match(src, /1,128/, `${name} responses builder must pin the tool-name length`);
      assert.match(src, /tool at index/, `${name} responses builder must name the tool index`);
      assert.match(src, /throw new Error/, `${name} responses builder must fail before any POST`);
    }
  });
  ok("(T6-4) toolChoice==='none' (chat) / includeTools:false (council) still omit the tools key", () => {
    assert.match(chatResponsesBody, /toolChoice !== 'none'/);
    assert.match(councilResponsesBody, /includeTools &&/);
  });
  ok('(T6-5) Messages mapping stays intact (regression pin)', () => {
    const chatMessagesAt = chatSource.indexOf('export function buildOpencodeGoMessagesBody');
    assert.ok(chatMessagesAt >= 0, 'chat messages builder missing');
    const chatMessagesBody = chatSource.slice(chatMessagesAt, chatResponsesAt);
    assert.match(chatMessagesBody, /input_schema: t\.function\.parameters,/);
    assert.match(chatMessagesBody, /toolChoice !== 'none'/);
    const councilMessagesAt = councilSource.indexOf('function buildCouncilGoMessagesBody');
    assert.ok(councilMessagesAt >= 0, 'council messages builder missing');
    const councilMessagesBody = councilSource.slice(councilMessagesAt, councilResponsesAt);
    assert.match(councilMessagesBody, /input_schema: t\.function\.parameters,/);
    assert.match(councilMessagesBody, /includeTools &&/);
  });
}

// ===========================================================================
// T7 — regulación responses (T3): el toggle + esfuerzo viajan a los 4 modelos
// responses vía `reasoning:{effort}` planificado con el módulo T1 (clamp por
// matriz api.json 2026-09-15; T8/F-04 excluye grok-4.5 NO-GO del catálogo y
// de la matriz — ni enviable ni seleccionable — y prohibido omitir
// `reasoning`). `temperature` sigue viajando (gateway defaultea a 1: inocuo,
// K3). Sin retry max→xhigh.
// ===========================================================================
function t7Checks(): void {
  const chatResponsesAt = chatSource.indexOf('export function buildOpencodeGoResponsesBody');
  assert.ok(chatResponsesAt >= 0, 'chat responses builder missing');
  const chatResponsesEnd = chatSource.indexOf('export interface OpencodeGoResponsesUsage', chatResponsesAt);
  assert.ok(chatResponsesEnd > chatResponsesAt, 'chat responses builder bounds missing');
  const chatResponsesBody = chatSource.slice(chatResponsesAt, chatResponsesEnd);
  const councilResponsesAt = councilSource.indexOf('function buildCouncilGoResponsesBody');
  assert.ok(councilResponsesAt >= 0, 'council responses builder missing');
  const councilResponsesEnd = councilSource.indexOf('interface CouncilGoResponsesUsage', councilResponsesAt);
  assert.ok(councilResponsesEnd > councilResponsesAt, 'council responses builder bounds missing');
  const councilResponsesBody = councilSource.slice(councilResponsesAt, councilResponsesEnd);
  // El planificador local vive justo antes del builder: esta vista ampliada
  // cubre helper+builder (ahí están las ramas off/on y el fallback `low`).
  const chatPlanAt = chatSource.indexOf('function planOpencodeGoResponsesEffort');
  assert.ok(chatPlanAt >= 0 && chatPlanAt < chatResponsesAt, 'chat responses planner missing');
  const chatPlanBody = chatSource.slice(chatPlanAt, chatResponsesEnd);
  const councilPlanAt = councilSource.indexOf('function planCouncilGoResponsesEffort');
  assert.ok(councilPlanAt >= 0 && councilPlanAt < councilResponsesAt, 'council responses planner missing');
  const councilPlanBody = councilSource.slice(councilPlanAt, councilResponsesEnd);

  ok('(T7-1) both responses builders accept { reasoningEnabled, reasoningEffort } and plan via the T1 module', () => {
    for (const [name, src] of [['chat', chatResponsesBody], ['council', councilResponsesBody]] as const) {
      assert.match(src, /reasoningEnabled: boolean/, `${name} builder must take reasoningEnabled`);
      assert.match(src, /reasoningEffort: string \| null/, `${name} builder must take reasoningEffort`);
      assert.match(src, /planOpencodeGoResponsesEffort|planCouncilGoResponsesEffort/, `${name} builder must plan via its local planner`);
    }
    for (const [name, src] of [['chat', chatPlanBody], ['council', councilPlanBody]] as const) {
      assert.match(src, /planGoReasoningEffort/, `${name} planner must clamp on+effort via T1`);
      assert.match(src, /goReasoningOff/, `${name} planner must map off via T1`);
    }
    assert.match(chatSource, /from '\.\.\/\.\.\/shared\/opencodeGoReasoning\.js'/);
    assert.match(councilSource, /from '\.\.\/\.\.\/shared\/opencodeGoReasoning\.js'/);
  });
  ok('(T7-2) clamp truth table per K3 (luna full+none=off; spark cap xhigh+minimal floor; grok-4.6 cap xhigh/low floor; grok-4.5 excluido)', () => {
    assert.equal(planGoReasoningEffort('gpt-5.6-luna', 'max'), 'max');
    assert.equal(goReasoningOff('gpt-5.6-luna'), 'none');
    assert.equal(planGoReasoningEffort('muse-spark-1.3-contributor', 'max'), 'xhigh');
    assert.equal(goReasoningOff('muse-spark-1.3-contributor'), 'minimal');
    assert.equal(planGoReasoningEffort('muse-spark-1.2-contributor', 'max'), 'xhigh');
    assert.equal(goReasoningOff('muse-spark-1.2-contributor'), 'minimal');
    assert.equal(planGoReasoningEffort('grok-4.6', 'max'), 'xhigh');
    assert.equal(goReasoningOff('grok-4.6'), 'low');
    // T8/F-04: grok-4.5 excluido (deprecated, `Model is unavailable` ×3 en
    // K3 2026-09-15, sustituto live grok-4.6) — sin knob: ni enviable ni
    // seleccionable. El lookup unknown es teórico (ya no se lista).
    assert.equal(goReasoningKnobFor('grok-4.5'), null);
    assert.equal(goReasoningOff('grok-4.5'), null);
  });
  ok('(T7-3) off falls back to low only when T1 yields null; on without effort falls back to low', () => {
    for (const [name, src] of [['chat', chatPlanBody], ['council', councilPlanBody]] as const) {
      assert.match(src, /\?\? 'low'/, `${name} planner must fall back to low, never omit`);
      assert.match(src, /if \(!reasoningEnabled\)/, `${name} planner must branch off first`);
      assert.match(src, /if \(reasoningEffort == null\)/, `${name} planner must default on-without-effort to low`);
    }
    assert.doesNotMatch(chatPlanBody, /reasoning: \{ effort: 'low' \}/);
    assert.doesNotMatch(councilPlanBody, /reasoning: \{ effort: 'low' \}/);
  });
  ok('(T7-4) reasoning_max_tokens never travels; temperature/max_output_tokens/tools stay intact', () => {
    for (const [name, src] of [['chat', chatResponsesBody], ['council', councilResponsesBody]] as const) {
      assert.doesNotMatch(src, /reasoning_max_tokens/, `${name} builder must not send reasoning_max_tokens`);
      assert.match(src, /temperature: opts\.temperature,/, `${name} builder keeps temperature (K3: gateway defaults, inocuo)`);
      assert.match(src, /max_output_tokens: opts\.maxTokens,/, `${name} builder keeps the cost guard`);
    }
  });
  ok('(T7-5) chat threads toggle+effort at first send (precedence mensaje > agente > general intacta)', () => {
    const firstSendAt = chatSource.indexOf('? buildOpencodeGoResponsesBody({');
    assert.ok(firstSendAt >= 0, 'chat first-send responses call missing');
    const firstSend = chatSource.slice(firstSendAt, firstSendAt + 800);
    assert.match(firstSend, /reasoningEnabled/);
    assert.match(firstSend, /reasoningEffort/);
    // La resolución con precedencia vive antes del primer envío (no después).
    const resolutionAt = chatSource.indexOf('let reasoningEnabled = !!agent.reasoning_enabled;');
    assert.ok(resolutionAt >= 0, 'chat reasoning resolution missing');
    assert.ok(resolutionAt < firstSendAt, 'chat reasoning must resolve before the first responses send');
    assert.match(chatSource, /if \(reasoningOverride\.enabled !== undefined\) reasoningEnabled = reasoningOverride\.enabled;/);
    assert.match(chatSource, /if \(reasoningOverride\.effort !== undefined\) reasoningEffort = reasoningOverride\.effort;/);
  });
  ok('(T7-6) chat tool-loop re-derives the same effort every lap (no drift entre vueltas)', () => {
    const loopAt = chatSource.indexOf('const rebuilt = buildOpencodeGoResponsesBody({');
    assert.ok(loopAt >= 0, 'chat tool-loop responses rebuild missing');
    const loop = chatSource.slice(loopAt, loopAt + 1200);
    assert.match(loop, /reasoningEnabled/);
    assert.match(loop, /reasoningEffort/);
    assert.match(chatSource, /requestBody\.reasoning = rebuilt\.reasoning;/);
  });
  ok('(T7-7) council member + synthesis thread via builders (resolveCouncilReasoning; loop re-deriva)', () => {
    const memberAt = councilSource.indexOf('? buildCouncilGoResponsesBody({');
    assert.ok(memberAt >= 0, 'council member responses call missing');
    const member = councilSource.slice(memberAt, memberAt + 800);
    assert.match(member, /reasoningEnabled/);
    assert.match(member, /reasoningEffort/);
    assert.match(councilSource, /resolveCouncilReasoning\(options\.conversationId, options\.userId\)/);
    const loopAt = councilSource.indexOf('const rebuilt = buildCouncilGoResponsesBody({');
    assert.ok(loopAt >= 0, 'council tool-loop responses rebuild missing');
    const loop = councilSource.slice(loopAt, loopAt + 1200);
    assert.match(loop, /reasoningEnabled/);
    assert.match(loop, /reasoningEffort/);
    assert.match(councilSource, /requestBody\.reasoning = rebuilt\.reasoning;/);
    const synthAt = councilSource.indexOf('? buildCouncilGoResponsesBody({', memberAt + 1);
    assert.ok(synthAt >= 0, 'council synthesis responses call missing');
    const synth = councilSource.slice(synthAt, synthAt + 800);
    assert.match(synth, /reasoningEnabled/);
    assert.match(synth, /reasoningEffort/);
  });
}

// ===========================================================================
// T8 — regulación chat-transport (T4, K1-GO): el toggle + esfuerzo viajan a
// los modelos chat vía `reasoning_effort` top-level planificado con el módulo
// T1 (clamp por matriz api.json 2026-09-15 + pre-flight clamp con log `(go)`).
// K1 VERIFIED: enum 7 valores; `none`=off; `thinking` jamás viaja (no-op);
// mimo (`[]`) y longcat (sin validador) omiten con log; `unknown` fail-open.
// Off → `none` donde listado, floor donde K1 midió burn (default-sin-knob
// thinking-on); on sin esfuerzo → omit (default del proveedor). Council
// miembro + síntesis llevan el mismo arm en el cuerpo genérico chat/unknown;
// `parallel_tool_calls`/allowlist y la rama responses de T3 intactas.
// ===========================================================================
function t8Checks(): void {
  ok('(T8-1) chat truth table per K1 (kimi-k3 low→max; glm-5.3 medium→low nearest-below; hy off→none)', () => {
    assert.equal(planGoReasoningEffort('kimi-k3', 'low'), 'max');
    assert.equal(planGoReasoningEffort('glm-5.3', 'medium'), 'low');
    assert.equal(goReasoningOff('hy3'), 'none');
    assert.equal(goReasoningOff('hy4-preview'), 'none');
  });
  ok('(T8-2) no-control models plan to null (omit) and unknown fail-opens with the chat arm', () => {
    assert.equal(planGoReasoningEffort('mimo-v2.5', 'low'), null);
    assert.equal(planGoReasoningEffort('mimo-v2.5-pro', 'low'), null);
    assert.equal(planGoReasoningEffort('kimi-k2.6', 'low'), null);
    assert.equal(planGoReasoningEffort('longcat-2.0', 'low'), null);
    assert.equal(goReasoningOff('mimo-v2.5'), null);
    assert.equal(goReasoningOff('longcat-2.0'), null);
    assert.equal(planGoReasoningEffort('some-unknown-id', 'low'), 'low');
  });
  ok('(T8-3) chat pre-flight clamps Go effort with the (go) log format (T2 shape, responses input intact)', () => {
    assert.match(chatSource, /Reasoning effort clamped \(go\): requested=.*applied=.*model=/);
    const clampAt = chatSource.indexOf('Reasoning effort clamped (go)');
    assert.ok(clampAt >= 0, 'Go pre-flight clamp log missing');
    const clamp = chatSource.slice(Math.max(0, clampAt - 900), clampAt + 300);
    assert.match(clamp, /provider\.id === 'opencode-go' && !isGoMessages && !isGoResponses/);
    assert.match(clamp, /planGoReasoningEffort/);
  });
  ok('(T8-4) chat arm assigns requestBody.reasoning_effort on chat-transport only (tool-loop safe)', () => {
    const assigns = chatSource.match(/requestBody\.reasoning_effort = /g) ?? [];
    assert.equal(assigns.length, 1);
    assert.doesNotMatch(chatSource, /delete requestBody\.reasoning_effort/);
  });
  ok('(T8-5) council member + synthesis thread the same arm via resolveCouncilReasoning (loop safe)', () => {
    const assigns = councilSource.match(/requestBody\.reasoning_effort = /g) ?? [];
    assert.equal(assigns.length, 2);
    assert.match(councilSource, /planCouncilGoChatEffort/);
    assert.match(councilSource, /resolveCouncilReasoning\(options\.conversationId, options\.userId\)/);
    assert.doesNotMatch(councilSource, /delete requestBody\.reasoning_effort/);
  });
  ok('(T8-6) off without none-listing falls to floor (K1 burn) and on-without-effort plans null (omit)', () => {
    assert.equal(goReasoningOff('kimi-k3'), 'max');
    assert.equal(goReasoningOff('glm-5.3'), 'low');
    assert.equal(planGoReasoningEffort('kimi-k3', null), null);
  });
}

// ===========================================================================
// T9 — regulación messages-transport (T5, K2-GO condicionado): el toggle (+
// esfuerzo/presupuesto donde aplique) viaja a los 8 modelos messages vía el
// wire que K2 confirmó por familia — minimax-m3 presencia clásica
// `thinking:{type,budget_tokens}` (enabled/1024→thinking-path, disabled =
// default, bogus→enabled: solo la presencia conmuta); qwen adaptativo
// `output_config:{effort}` (xhigh aceptado) + `disabled` para off (off real);
// clásico `thinking.enabled` en qwen → 400 `{"model":"qwen3.8-flash"}` (jamás
// se envía); `effort` top-level ignorado sin validar (jamás se envía: un typo
// sería no-op silencioso). `minimax-m2.7/m2.5` (`[]`) nunca envían thinking.
// Budgets vía `planGoMessagesBudget` (techos 81920/262144). El parser SSE
// captura deltas thinking → `reasoning_content`; el replay preserva `content`
// tal cual sin fabricar bloques (K2: replay con y sin thinking 200, sin
// fricción; qwen bloques `thinking+signature:""` efímeros, no reinyectables).
// `temperature`, tools `input_schema` y comparación intactos; headers
// `x-api-key` intactos (T4-3/T5-8 los pinean).
// ===========================================================================
function t9Checks(): void {
  const chatMessagesAt = chatSource.indexOf('export function buildOpencodeGoMessagesBody');
  assert.ok(chatMessagesAt >= 0, 'chat messages builder missing');
  const chatMessagesEnd = chatSource.indexOf('export interface OpencodeGoMessagesUsage', chatMessagesAt);
  assert.ok(chatMessagesEnd > chatMessagesAt, 'chat messages builder bounds missing');
  const chatMessagesBody = chatSource.slice(chatMessagesAt, chatMessagesEnd);
  const chatPlanAt = chatSource.indexOf('function planOpencodeGoMessagesThinking');
  assert.ok(chatPlanAt >= 0 && chatPlanAt < chatMessagesAt, 'chat messages planner missing');
  const chatPlanBody = chatSource.slice(chatPlanAt, chatMessagesEnd);
  const councilMessagesAt = councilSource.indexOf('function buildCouncilGoMessagesBody');
  assert.ok(councilMessagesAt >= 0, 'council messages builder missing');
  const councilMessagesEnd = councilSource.indexOf('function mapCouncilGoMessagesUsage', councilMessagesAt);
  assert.ok(councilMessagesEnd > councilMessagesAt, 'council messages builder bounds missing');
  const councilMessagesBody = councilSource.slice(councilMessagesAt, councilMessagesEnd);
  const councilPlanAt = councilSource.indexOf('function planCouncilGoMessagesThinking');
  assert.ok(councilPlanAt >= 0 && councilPlanAt < councilMessagesAt, 'council messages planner missing');
  const councilPlanBody = councilSource.slice(councilPlanAt, councilMessagesEnd);

  ok('(T9-1) both messages builders accept { reasoningEnabled, reasoningEffort, reasoningMaxTokens } and plan via the T1 module', () => {
    for (const [name, src] of [['chat', chatMessagesBody], ['council', councilMessagesBody]] as const) {
      assert.match(src, /reasoningEnabled: boolean/, `${name} builder must take reasoningEnabled`);
      assert.match(src, /reasoningEffort: string \| null/, `${name} builder must take reasoningEffort`);
      assert.match(src, /reasoningMaxTokens: number \| null/, `${name} builder must take reasoningMaxTokens`);
      assert.match(src, /planOpencodeGoMessagesThinking|planCouncilGoMessagesThinking/, `${name} builder must emit via its local planner`);
    }
    for (const [name, src] of [['chat', chatPlanBody], ['council', councilPlanBody]] as const) {
      assert.match(src, /goReasoningNoControl/, `${name} planner must gate no-control models`);
      assert.match(src, /goReasoningKnobFor/, `${name} planner must read the T1 knob`);
      assert.match(src, /planGoMessagesBudget/, `${name} planner must budget via T1`);
      assert.match(src, /planGoReasoningEffort/, `${name} planner must clamp adaptive effort via T1`);
    }
    assert.match(chatSource, /from '\.\.\/\.\.\/shared\/opencodeGoReasoning\.js'/);
    assert.match(councilSource, /from '\.\.\/\.\.\/shared\/opencodeGoReasoning\.js'/);
  });
  ok('(T9-2) clamp truth table per K2 + T1 techos (flash max→xhigh; 3.6-plus 100000→81920; []→null)', () => {
    assert.equal(planGoReasoningEffort('qwen3.8-flash', 'max'), 'xhigh');
    assert.equal(planGoReasoningEffort('qwen3.8-max', 'max'), 'xhigh');
    assert.equal(planGoMessagesBudget('qwen3.6-plus', { maxTokens: 100000 }), 81920);
    assert.equal(planGoMessagesBudget('qwen3.7-max', { maxTokens: 1000000 }), 262144);
    assert.equal(planGoMessagesBudget('qwen3.7-plus', { maxTokens: 100 }), 1024);
    assert.equal(planGoMessagesBudget('qwen3.6-plus', {}), 8192);
    assert.equal(planGoMessagesBudget('minimax-m3', {}), 8192);
    assert.equal(planGoMessagesBudget('minimax-m2.7', { maxTokens: 5000 }), null);
    assert.equal(planGoMessagesBudget('minimax-m2.5', { maxTokens: 5000 }), null);
    assert.equal(goReasoningNoControl('minimax-m2.7'), true);
    assert.equal(goReasoningNoControl('minimax-m2.5'), true);
    assert.equal(goReasoningNoControl('minimax-m3'), false);
    assert.equal(goReasoningNoControl('qwen3.6-plus'), false);
  });
  ok('(T9-3) minimax presence-toggle wire (on→enabled+budget, off→disabled, []→never; adaptive never)', () => {
    for (const [name, src] of [['chat', chatPlanBody], ['council', councilPlanBody]] as const) {
      assert.match(src, /type: 'enabled'/, `${name} planner must emit the classic enabled presence`);
      assert.match(src, /budget_tokens: budget/, `${name} planner must carry the T1 budget`);
      assert.match(src, /type: 'disabled'/, `${name} planner must emit explicit disabled for off`);
      assert.doesNotMatch(src, /type: 'adaptive'/, `${name} planner must not invent the adaptive thinking form (never probed)`);
    }
  });
  ok('(T9-4) qwen adaptive wire (on→output_config.effort clamped, off→disabled; classic/effort-top never)', () => {
    for (const [name, src] of [['chat', chatPlanBody], ['council', councilPlanBody]] as const) {
      assert.match(src, /output_config: \{ effort: planned \}/, `${name} planner must emit the K2-confirmed adaptive wire`);
      assert.doesNotMatch(src, /output_config: \{ effort: '/, `${name} planner must never hardcode an effort literal`);
    }
    for (const [name, src] of [['chat', chatMessagesBody], ['council', councilMessagesBody]] as const) {
      assert.doesNotMatch(src, /body\.effort\s*=/, `${name} builder must never send top-level effort (K2: ignored, typo would silent no-op)`);
      assert.doesNotMatch(src, /effort: opts\.reasoningEffort/, `${name} builder must never forward raw effort (clamp first)`);
    }
  });
  ok('(T9-5) reasoning_max_tokens never travels raw; temperature/input_schema intact', () => {
    for (const [name, src] of [['chat', chatMessagesBody], ['council', councilMessagesBody]] as const) {
      assert.doesNotMatch(src, /reasoning_max_tokens/, `${name} builder must not send reasoning_max_tokens`);
      assert.match(src, /temperature: opts\.temperature,/, `${name} builder keeps temperature`);
      assert.match(src, /max_tokens: opts\.maxTokens,/, `${name} builder keeps the response cap`);
      assert.match(src, /input_schema: t\.function\.parameters,/, `${name} builder keeps the Anthropic tools mapping`);
    }
  });
  ok('(T9-6) messages SSE parsers capture thinking deltas into reasoning_content (signature ignored: replay needs no blocks)', () => {
    assert.match(chatSource, /thinking_delta/, 'chat messages parser must handle thinking deltas');
    assert.match(chatSource, /typeof d\.thinking === 'string'/, 'chat messages parser must capture delta thinking text');
    assert.match(councilSource, /thinking_delta/, 'council member parser must handle thinking deltas');
    assert.match(councilSource, /typeof d\.thinking === 'string'/, 'council member parser must capture delta thinking text');
    const synthAt = councilSource.indexOf('T4 Anthropic stream state (same wire sequence as members).');
    assert.ok(synthAt >= 0, 'council synthesis parser anchor missing');
    const synthParse = councilSource.slice(synthAt, synthAt + 2500);
    assert.match(synthParse, /typeof d\.thinking === 'string'/, 'council synthesis parser must capture delta thinking text');
  });
  ok('(T9-7) tool-loops preserve the thinking wire every lap (chat + council member)', () => {
    const chatLoopAt = chatSource.indexOf('const rebuilt = buildOpencodeGoMessagesBody({');
    assert.ok(chatLoopAt >= 0, 'chat tool-loop messages rebuild missing');
    const chatLoop = chatSource.slice(chatLoopAt, chatLoopAt + 1400);
    assert.match(chatLoop, /reasoningEnabled/, 'chat loop must re-derive with the same toggle');
    assert.match(chatLoop, /reasoningMaxTokens/, 'chat loop must re-derive with the same budget');
    assert.match(chatSource, /requestBody\.thinking = rebuilt\.thinking;/, 'chat loop must carry thinking forward');
    assert.match(chatSource, /requestBody\.output_config = rebuilt\.output_config;/, 'chat loop must carry output_config forward');
    const councilLoopAt = councilSource.indexOf('const rebuilt = buildCouncilGoMessagesBody({');
    assert.ok(councilLoopAt >= 0, 'council tool-loop messages rebuild missing');
    const councilLoop = councilSource.slice(councilLoopAt, councilLoopAt + 1400);
    assert.match(councilLoop, /reasoningEnabled/, 'council loop must re-derive with the same toggle');
    assert.match(councilLoop, /reasoningMaxTokens/, 'council loop must re-derive with the same budget');
    assert.match(councilSource, /requestBody\.thinking = rebuilt\.thinking;/, 'council loop must carry thinking forward');
    assert.match(councilSource, /requestBody\.output_config = rebuilt\.output_config;/, 'council loop must carry output_config forward');
  });
  ok('(T9-8) first sends thread toggle+effort+budget (chat; council member+synthesis via builders, budget null per frozen resolveCouncilReasoning)', () => {
    const chatFirstAt = chatSource.indexOf('? buildOpencodeGoMessagesBody({');
    assert.ok(chatFirstAt >= 0, 'chat first-send messages call missing');
    const chatFirst = chatSource.slice(chatFirstAt, chatFirstAt + 800);
    assert.match(chatFirst, /reasoningEnabled/);
    assert.match(chatFirst, /reasoningEffort/);
    assert.match(chatFirst, /reasoningMaxTokens/);
    const memberAt = councilSource.indexOf('? buildCouncilGoMessagesBody({');
    assert.ok(memberAt >= 0, 'council member messages call missing');
    const member = councilSource.slice(memberAt, memberAt + 800);
    assert.match(member, /reasoningEnabled/);
    assert.match(member, /reasoningEffort/);
    assert.match(member, /reasoningMaxTokens: null/, 'council passes null budget (resolveCouncilReasoning carries no max_tokens by global constraint)');
    const synthAt = councilSource.indexOf('? buildCouncilGoMessagesBody({', memberAt + 1);
    assert.ok(synthAt >= 0, 'council synthesis messages call missing');
    const synth = councilSource.slice(synthAt, synthAt + 800);
    assert.match(synth, /reasoningEnabled/);
    assert.match(synth, /reasoningEffort/);
  });
}

stabilityChecks();
seamChecks();
t4Checks();
t5Checks();
t6Checks();
t7Checks();
t8Checks();
t9Checks();

console.log(`opencode-go chat-gates guardrail: OK (${checks} checks)`);
