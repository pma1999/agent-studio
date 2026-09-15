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
  ok('(C5) chat reasoning arm omits every reasoning field (log only)', () => {
    assert.match(chatSource, /\} else if \(provider\.id === 'opencode-go'\) \{/);
    assert.match(chatSource, /opencode-go reasoning ignored \(phase-1 omit\)/);
    const armAt = chatSource.indexOf("} else if (provider.id === 'opencode-go') {");
    assert.ok(armAt >= 0, 'Go reasoning arm missing');
    const arm = chatSource.slice(armAt, armAt + 900);
    assert.doesNotMatch(arm, /requestBody\.reasoning/);
    assert.doesNotMatch(arm, /requestBody\.reasoning_effort/);
    assert.doesNotMatch(arm, /requestBody\.thinking/);
    assert.doesNotMatch(arm, /requestBody\.effort/);
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
  ok('(U2) no reasoning field is ever assigned in the Go arm', () => {
    // Covered by (C5) at seam level; repeated here as the UNVERIFIED tripwire:
    // the wire shape of Go reasoning was never proved with a paid key (D4).
    const armAt = chatSource.indexOf("} else if (provider.id === 'opencode-go') {");
    assert.ok(armAt >= 0, 'Go reasoning arm missing');
    assert.doesNotMatch(chatSource.slice(armAt, armAt + 900), /requestBody\.reasoning/);
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
  ok('(T5-3) chat responses body caps reasoning/output (T3 high-by-default burns window) and ignores the app toggle', () => {
    assert.match(chatSource, /reasoning: \{ effort: 'low' \}/);
    assert.match(chatSource, /max_output_tokens/);
    assert.match(chatSource, /instructions/);
    const fnAt = chatSource.indexOf('export function buildOpencodeGoResponsesBody');
    assert.ok(fnAt >= 0, 'responses body builder missing');
    const fnBody = chatSource.slice(fnAt, fnAt + 2600);
    assert.doesNotMatch(fnBody, /reasoningEffort/);
    assert.doesNotMatch(fnBody, /reasoningEnabled/);
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

stabilityChecks();
seamChecks();
t4Checks();
t5Checks();

console.log(`opencode-go chat-gates guardrail: OK (${checks} checks)`);
