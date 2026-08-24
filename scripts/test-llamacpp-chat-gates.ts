/**
 * Guardrail for task 3 (llama.cpp replaces LM Studio in the request path).
 *
 * chat.ts is the hot path for EVERY provider (context-map risk R1), so the
 * integration is guarded by source-regex assertions (idiom inherited from
 * test-lmstudio-chat-gates.ts / test-tool-call-budget.ts). Two phases live in
 * this one script:
 *
 *   STABILITY assertions (every phase) — the openrouter/deepseek/codex branches
 *   of providers/index.ts, chat.ts and councilExecutor.ts stay byte-stable
 *   across the task-3 edits (global-constraints.md §9).
 *
 *   PRE assertions (--phase=pre only) — the OLD §6 sampling pin (Increment 1
 *   baseline): green on the pristine tree, gone once the §10 seam lands.
 *
 *   SEAM assertions (--phase=post or default) — each enumerated global-
 *   constraints.md §6 touchpoint exists post-edit, the Increment 2 sampling
 *   seam (shared resolveLlamacppSampling in chat.ts AND councilExecutor) is
 *   present, LLAMACPP_SAMPLING_TOP_P is absent, and the pure registry exports
 *   behave per §1 (D8 legacy guard included).
 *
 * Usage:
 *   npx tsx scripts/test-llamacpp-chat-gates.ts --phase=pre   # baseline on the PRISTINE tree
 *   npx tsx scripts/test-llamacpp-chat-gates.ts --phase=post  # after the edits land
 *   npx tsx scripts/test-llamacpp-chat-gates.ts               # everything (red before, green after)
 *
 * Reads source text only — offline-safe, db-free.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = process.argv.find((a) => a.startsWith('--phase='));
const phase = arg?.split('=')[1] === 'post' ? 'post' : arg?.split('=')[1] === 'pre' ? 'pre' : 'all';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');
const chatSource = read('server/routes/chat.ts');
const councilSource = read('server/services/councilExecutor.ts');
const chatCouncilSource = read('server/routes/chatCouncil.ts');
const indexSource = read('server/providers/index.ts');
const modelsSource = read('server/routes/models.ts');
const envSource = read('.env.example');

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ===========================================================================
// STABILITY — byte-stable anchors in the untouched provider branches (§9)
// ===========================================================================
function stabilityChecks(): void {
  // ---- chat.ts: codex branch entry + bridge stays verbatim -----------------
  ok('(S1) codex branch anchor preserved in chat.ts', () => {
    assert.match(chatSource, /if \(provider\.id === 'codex'\) \{/);
  });
  ok('(S2) codex branch doc-comment preserved in chat.ts', () => {
    assert.match(chatSource, /\/\/ ChatGPT \(Codex app-server\) branch/);
  });
  ok('(S3) codex thread lookup preserved in chat.ts', () => {
    assert.match(chatSource, /'SELECT codex_thread_id FROM conversations WHERE id = \?'/);
  });

  // ---- chat.ts: deepseek arms byte-stable ----------------------------------
  ok('(S4) deepseek/openrouter reasoning-field normalization preserved', () => {
    assert.match(chatSource, /const reasoningChunk = delta\?\.reasoning \|\| delta\?\.reasoning_content;/);
  });
  ok('(S5) deepseek thinking toggle assignment preserved', () => {
    assert.match(chatSource, /Object\.assign\(requestBody, buildDeepSeekThinking\(reasoningEnabled, reasoningEffort\)\);/);
  });
  ok('(S6) all three persistedModelId call sites preserved in chat.ts', () => {
    const uses = chatSource.match(/persistedModelId\(provider\.id, effectiveModel, actualModelFromResponse\)/g) ?? [];
    assert.ok(uses.length >= 3, `expected >=3 persistedModelId( uses, found ${uses.length}`);
  });
  ok('(S7) response-healing condition prefix byte-stable', () => {
    assert.match(
      chatSource,
      /useResponseHealing = !!agent\.response_healing_enabled && !!responseFormat && provider\.id !== 'codex' && provider\.id !==/,
    );
  });
  ok('(S8) effort-max retry condition prefix byte-stable', () => {
    assert.match(
      chatSource,
      /requestedMaxEffort = reasoningEnabled && reasoningEffort === 'max' && provider\.id !== 'codex' && provider\.id !==/,
    );
  });
  ok('(S9) OpenRouter file-parser plugin attach preserved', () => {
    assert.match(chatSource, /requestBody\.plugins = \[\{ id: 'file-parser', pdf: \{ engine: pdf_engine \} \}\];/);
  });

  // ---- councilExecutor.ts: codex/deepseek arms byte-stable ------------------
  ok('(S10) council codex member dispatch preserved', () => {
    assert.match(councilSource, /if \(resolveProviderId\(modelId\) === 'codex'\) \{/);
    assert.match(councilSource, /return this\.executeMemberStreamCodex\(modelId, options\);/);
  });
  ok('(S11) council reasoning-field normalization preserved', () => {
    assert.match(councilSource, /\[assistantReasoningField\(ep\.provider\.id\)\]: fullReasoning/);
  });
  ok('(S12) council deepseek cost fallback preserved', () => {
    assert.match(councilSource, /else if \(ep\.provider\.id === 'deepseek'\) cost = computeDeepSeekCost\(usage, ep\.upstreamModel\);/);
  });
  ok('(S13) council codex turn bridge import preserved', () => {
    assert.match(councilSource, /import \{ runCodexTurn \} from '\.\.\/codex\/chat\.js';/);
  });

  // ---- providers/index.ts: openrouter/deepseek/codex entries byte-stable ----
  ok('(S14) OPENROUTER_CONFIG url preserved', () => {
    assert.match(indexSource, /chatCompletionsUrl: 'https:\/\/openrouter\.ai\/api\/v1\/chat\/completions',/);
  });
  ok('(S15) OPENROUTER_CONFIG headers preserved', () => {
    assert.match(indexSource, /'HTTP-Referer': 'http:\/\/localhost:5173',/);
  });
  ok('(S16) resolveProviderId deepseek/codex arms preserved', () => {
    assert.match(indexSource, /modelId\.startsWith\(DEEPSEEK_PREFIX\)\) return 'deepseek';/);
    assert.match(indexSource, /modelId\.startsWith\(CODEX_PREFIX\)\) return 'codex';/);
  });
  ok('(S17) assistantReasoningField deepseek ternary preserved', () => {
    assert.match(indexSource, /return id === 'deepseek' \? 'reasoning_content' : 'reasoning';/);
  });
  ok('(S18) CODEX_CONFIG keyless shape preserved', () => {
    assert.match(indexSource, /apiKeySetting: '',/);
  });
}

// ===========================================================================
// SEAMS — the enumerated §6 integration points (post-edit only)
// ===========================================================================
function seamChecks(): void {
  // ---- providers/index.ts registry swap -------------------------------------
  ok('(P1) ProviderId union carries llamacpp AND retained lmstudio', () => {
    assert.match(indexSource, /'openrouter' \| 'deepseek' \| 'codex' \| 'lmstudio' \| 'llamacpp'/);
  });
  ok('(P2) LLAMACPP_PREFIX exported', () => {
    assert.match(indexSource, /export const LLAMACPP_PREFIX = 'llamacpp:';/);
  });
  ok('(P3) LLAMACPP_CONFIG pinned shape present', () => {
    assert.match(indexSource, /label: 'llama\.cpp \(Local\)'/);
    assert.match(indexSource, /apiKeySetting: 'llamacpp_api_key_unused'/);
    assert.match(indexSource, /buildHeaders: \(\) => \(\{ 'Content-Type': 'application\/json' \}\)/);
  });
  ok('(P4) LMSTUDIO_REMOVED_CONFIG stub replaces the live config', () => {
    assert.match(indexSource, /LMSTUDIO_REMOVED_CONFIG/);
    assert.match(indexSource, /label: 'LM Studio \(removed\)'/);
    assert.doesNotMatch(indexSource, /label: 'LM Studio \(Local\)'/);
    assert.doesNotMatch(indexSource, /apiKeySetting: 'lmstudio_api_token'/);
  });
  ok('(P5) resolveProviderId keeps lmstudio AND adds llamacpp arm', () => {
    assert.match(indexSource, /modelId\.startsWith\(LMSTUDIO_PREFIX\)\) return 'lmstudio';/);
    assert.match(indexSource, /modelId\.startsWith\(LLAMACPP_PREFIX\)\) return 'llamacpp';/);
  });
  ok('(P6) toUpstreamModelId strips the llamacpp prefix', () => {
    assert.match(indexSource, /modelId\.startsWith\(LLAMACPP_PREFIX\)\) return modelId\.slice\(LLAMACPP_PREFIX\.length\);/);
  });
  ok('(P7) isLlamacppModel exported beside retained isLmStudioModel', () => {
    assert.match(indexSource, /export function isLlamacppModel\(/);
    assert.match(indexSource, /export function isLmStudioModel\(/);
  });
  ok('(P8) persistedModelId keeps namespaced id for llamacpp', () => {
    assert.match(indexSource, /providerId === 'deepseek' \|\| providerId === 'lmstudio' \|\| providerId === 'llamacpp'/);
  });
  ok('(P9) CONFIGS map wires both entries', () => {
    assert.match(indexSource, /llamacpp: LLAMACPP_CONFIG,/);
    assert.match(indexSource, /lmstudio: LMSTUDIO_REMOVED_CONFIG,/);
  });

  // ---- chat.ts enumerated touchpoints (global-constraints §6) ---------------
  ok('(C1) key gate exempts isLlamacppModel beside isCodexModel', () => {
    assert.match(
      chatSource,
      /!apiKey\?\.trim\(\) && !isCodexModel\(effectiveModel\) && !isLlamacppModel\(effectiveModel\)/,
    );
  });
  ok('(C2) D8 legacy lmstudio guard fires right after provider resolution', () => {
    const resolvedAt = chatSource.indexOf('const provider = getProviderForModel(effectiveModel)');
    const guardedAt = chatSource.indexOf('isLegacyLmStudioModel(effectiveModel)');
    const gatedAt = chatSource.indexOf("!apiKey?.trim() && !isCodexModel(effectiveModel)");
    assert.ok(resolvedAt >= 0, 'provider resolution missing');
    assert.ok(guardedAt > resolvedAt, 'legacy guard must come AFTER provider resolution');
    assert.ok(gatedAt > guardedAt, 'legacy guard must fire BEFORE the key gate (and any network work)');
    assert.match(chatSource, /if \(isLegacyLmStudioModel\(effectiveModel\)\) \{/);
    assert.match(chatSource, /REMOVED_LMSTUDIO_MESSAGE/);
  });
  ok('(C3) apiUrl override builds the resolved loopback endpoint', () => {
    assert.match(chatSource, /apiUrl = `http:\/\/127\.0\.0\.1:\$\{llamacppConfig\.port\}\/v1\/chat\/completions`;/);
  });
  ok('(C4) llamacpp branch injects the resolved llamacpp_sampling row via the shared §10 resolver', () => {
    assert.match(chatSource, /const s = resolveLlamacppSampling\(userId\);/);
    assert.match(
      chatSource,
      /requestBody\.temperature = s\.temp;\s*\n\s*requestBody\.top_p = s\.top_p;\s*\n\s*requestBody\.top_k = s\.top_k;\s*\n\s*requestBody\.min_p = s\.min_p;\s*\n\s*requestBody\.repeat_penalty = s\.repeat_penalty;/,
    );
    // The seam must sit INSIDE the llamacpp-only branch, after the generic
    // `temperature: agent.temperature` literal stays for every other provider.
    assert.match(chatSource, /temperature: agent\.temperature,/);
    const genericAt = chatSource.indexOf('temperature: agent.temperature,');
    const seamAt = chatSource.indexOf('resolveLlamacppSampling(userId)');
    assert.ok(seamAt > genericAt, 'sampling seam must come after the generic request-body literal');
  });
  ok('(C4b) OLD pin deleted: LLAMACPP_SAMPLING_TOP_P and top_p=0.8 are gone from chat.ts', () => {
    assert.doesNotMatch(chatSource, /LLAMACPP_SAMPLING_TOP_P/);
    assert.doesNotMatch(chatSource, /requestBody\.top_p = 0\.8/);
  });
  ok('(C5) stream_options include_usage + chat_template_kwargs extras present', () => {
    assert.match(chatSource, /requestBody\.stream_options = \{ include_usage: true \};/);
    assert.match(chatSource, /requestBody\.chat_template_kwargs = \{ enable_thinking: !reasoningEnabled \};/);
  });
  ok('(C6) tools attach without the old veto flag', () => {
    assert.doesNotMatch(chatSource, /lmstudioToolsOmitted/);
    const attaches = chatSource.match(/if \(openRouterTools\.length > 0\) \{/g) ?? [];
    assert.ok(attaches.length >= 2, `expected >=2 unconditional tool attaches, found ${attaches.length}`);
  });
  ok('(C7) healing exclusion names llamacpp', () => {
    assert.match(
      chatSource,
      /useResponseHealing = !!agent\.response_healing_enabled && !!responseFormat && provider\.id !== 'codex' && provider\.id !== 'llamacpp';/,
    );
  });
  ok('(C8) effort-max retry exclusion names llamacpp', () => {
    assert.match(
      chatSource,
      /requestedMaxEffort = reasoningEnabled && reasoningEffort === 'max' && provider\.id !== 'codex' && provider\.id !== 'llamacpp';/,
    );
  });
  ok('(C9) pre-flight calls ensureLlamacppRunning under a 15 s SSE keepalive', () => {
    assert.match(chatSource, /await ensureLlamacppRunning\(userId, upstreamModel\)/);
    assert.match(chatSource, /clearInterval\(llamacppKeepalive\)/);
    assert.match(chatSource, /\}, 15_000\);/);
  });
  ok('(C10) think splitter gated on llamacpp at all three sites', () => {
    assert.match(chatSource, /= provider\.id === 'llamacpp' \? createThinkStreamSplitter\(\) : null;/);
    assert.match(chatSource, /emitThinkSplit\(thinkSplitter\.push\(delta\.content\)\)/);
    assert.match(chatSource, /emitThinkSplit\(thinkSplitter\.flush\(\)\)/);
    assert.doesNotMatch(chatSource, /provider\.id === 'lmstudio'/);
  });
  ok('(C11) fetch fork routes llamacpp through llamacppFetch', () => {
    assert.match(
      chatSource,
      /apiResponse = provider\.id === 'llamacpp'\s*\n\s*\? await llamacppFetch\(userId, '\/v1\/chat\/completions', \{/,
    );
  });

  // ---- councilExecutor.ts mirrors -------------------------------------------
  ok('(M1) council imports the new llamacpp modules', () => {
    assert.match(councilSource, /from '\.\.\/providers\/llamacppTransport\.js'/);
    assert.match(councilSource, /llamacppFetch/);
  });
  ok('(M2) council legacy guard precedes any upstream resolution', () => {
    const guardedAt = councilSource.indexOf('isLegacyLmStudioModel(modelId)');
    const resolvedAt = councilSource.indexOf('const provider = getProviderForModel(modelId)');
    assert.ok(guardedAt >= 0, 'legacy guard missing');
    assert.ok(resolvedAt > guardedAt, 'legacy guard must fire BEFORE provider/key resolution');
    assert.match(councilSource, /throw new Error\(REMOVED_LMSTUDIO_MESSAGE\)/);
  });
  ok('(M3) council key gate exempts llamacpp', () => {
    assert.match(councilSource, /!apiKey\?\.trim\(\) && provider\.id !== 'lmstudio' && provider\.id !== 'llamacpp'/);
  });
  ok('(M4) council fetchUpstream rides llamacppFetch for llamacpp ids', () => {
    assert.match(councilSource, /ep\.provider\.id === 'llamacpp'/);
    assert.match(councilSource, /return llamacppFetch\(userId, '\/v1\/chat\/completions', init\);/);
  });
  ok('(M5) council enforces the §2 capability gate before any llamacpp send', () => {
    // FF-T3-01: the gate must fire INSIDE the llamacpp arm of fetchUpstream,
    // AFTER the userId guard and BEFORE calling llamacppFetch (the transport
    // module is task-2-owned and degrades connected-but-incapable agents to a
    // generic unreachable 502 — the frozen message must come from HERE).
    assert.match(councilSource, /import \{ getAgentCapabilities[^]*from '\.\.\/agentRelay\/registry\.js';/);
    assert.match(
      councilSource,
      /if \(ep\.provider\.id === 'llamacpp'\) \{\s*\n\s*if \(!userId\) throw new Error\('llama\.cpp requires a user context'\);\s*\n(?:\s*\/\/[^\n]*\n\s*)*if \(!\(getAgentCapabilities\(userId\)\?\.includes\('llamacpp'\) \?\? false\)\) \{\s*\n\s*throw new Error\(LLAMACPP_CAPABILITY_ERROR\);\s*\n\s*\}\s*\n\s*return llamacppFetch\(userId, '\/v1\/chat\/completions', init\);/,
      'fetchUpstream llamacpp arm must gate capability (frozen message) between userId check and llamacppFetch',
    );
    const armAt = councilSource.indexOf("ep.provider.id === 'llamacpp'");
    const gateAt = councilSource.indexOf("getAgentCapabilities(userId)?.includes('llamacpp')");
    const fetchAt = councilSource.indexOf('return llamacppFetch(');
    assert.ok(gateAt > armAt, 'capability gate must sit inside the llamacpp arm');
    assert.ok(fetchAt > gateAt, 'capability gate must precede the llamacppFetch call');
  });
  ok('(M6) council member AND synthesis bodies sample via the SAME shared §10 resolver', () => {
    const uses = councilSource.match(/resolveLlamacppSampling\(options\.userId\)/g) ?? [];
    assert.ok(uses.length >= 2, `expected >=2 shared-resolver uses (member + synthesis), found ${uses.length}`);
  });
  ok('(M7) non-llamacpp council arms KEEP their fixed temp-0.7 body shape', () => {
    const fixed = councilSource.match(/temperature: 0\.7,/g) ?? [];
    assert.ok(fixed.length >= 2, `expected >=2 fixed-temperature literals preserved, found ${fixed.length}`);
  });

  // ---- chatCouncil.ts route-layer pre-flight (FF-T3-02, R8 consumer) --------
  ok('(CC1) chatCouncil imports the D8 legacy-guard constants', () => {
    assert.match(
      chatCouncilSource,
      /import \{ isLegacyLmStudioModel, REMOVED_LMSTUDIO_MESSAGE \} from '\.\.\/providers\/llamacpp\.js';/,
    );
  });
  ok('(CC2) chatCouncil short-circuits legacy lmstudio members BEFORE key validation', () => {
    const guardAt = chatCouncilSource.indexOf('isLegacyLmStudioModel(modelId)');
    const keyAt = chatCouncilSource.indexOf('const key = getSettingValue');
    assert.ok(guardAt >= 0, 'legacy lmstudio member/synthesizer short-circuit missing in pre-flight loop');
    assert.ok(keyAt > guardAt, 'legacy guard must fire BEFORE provider key validation');
    assert.match(chatCouncilSource, /res\.status\(400\)\.json\(\{ error: REMOVED_LMSTUDIO_MESSAGE \}\)/);
  });
  ok('(CC3) chatCouncil key pre-flight exempts llamacpp beside codex', () => {
    assert.match(chatCouncilSource, /if \(providerId === 'codex'\) \{/);
    assert.match(chatCouncilSource, /if \(providerId === 'llamacpp'\) \{\s*\n\s*continue;/);
  });

  // ---- absence of dead lmstudio identifiers in the consumers (§6/(e)) -------
  const forbiddenConsumer = /\bisLmStudioModel\b|\blmstudioFetch\b|\bgetLmStudioSettings\b|\bensureModelLoaded\b|\bgetModelCapabilities\b|\bprobeLmStudio\b|\bresolveLmStudioSampling\b|lmstudioToolsOmitted/;
  ok('(A1) no lmstudio identifiers remain in chat.ts', () => {
    assert.doesNotMatch(chatSource, forbiddenConsumer);
    assert.doesNotMatch(chatSource, /from '\.\.\/providers\/lmstudio(\.js|Transport\.js)'/);
  });
  ok('(A2) no lmstudio identifiers remain in councilExecutor.ts', () => {
    assert.doesNotMatch(councilSource, forbiddenConsumer);
    assert.doesNotMatch(councilSource, /from '\.\.\/providers\/lmstudio(\.js|Transport\.js)'/);
  });

  // ---- models.ts: six llamacpp routes replace the five lmstudio ones --------
  ok('(R1) six llamacpp routes exist', () => {
    for (const route of [
      "router.get('/llamacpp'",
      "router.get('/llamacpp/status'",
      "router.post('/llamacpp/start'",
      "router.post('/llamacpp/stop'",
      "router.post('/llamacpp/config'",
      "router.get('/llamacpp/logs'",
    ]) {
      assert.match(modelsSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
  ok('(R2) every action route passes the capability gate helper', () => {
    const gates = modelsSource.match(/llamacppGate\(req, res\)/g) ?? [];
    assert.ok(gates.length >= 6, `expected >=6 capability-gated routes, found ${gates.length}`);
  });
  ok('(R3) catalog cache TTL pinned at 30 s', () => {
    assert.match(modelsSource, /LLAMACPP_CATALOG_TTL_MS = 30_000;/);
  });
  ok('(R4) lmstudio routes are gone from models.ts', () => {
    assert.doesNotMatch(modelsSource, /\/lmstudio/);
    assert.doesNotMatch(modelsSource, /lmstudio(\.js|Transport\.js)'/);
    assert.doesNotMatch(modelsSource, /requireLmStudioModel|LMSTUDIO_MODELS_CACHE_TTL/);
  });

  // ---- .env.example documentation -------------------------------------------
  ok('(E1) .env.example documents the llamacpp vars', () => {
    for (const key of ['LLAMACPP_EXE_PATH', 'LLAMACPP_MODELS_DIR', 'LLAMACPP_PORT', 'LLAMACPP_IDLE_UNLOAD_MINUTES']) {
      assert.match(envSource, new RegExp(`# ${key}=`));
    }
    assert.match(envSource, /# AGENT_HTTP_PROXY_ALLOW_HOSTS=/);
    assert.doesNotMatch(envSource, /LMSTUDIO_/);
  });
}

// ===========================================================================
// Dynamic smoke of the PURE registry exports consumed by chat.ts
// (server/providers/index.ts and llamacpp.ts import nothing db/network-related)
// ===========================================================================
async function dynamicSmoke(): Promise<void> {
  const {
    resolveProviderId,
    toUpstreamModelId,
    isLlamacppModel,
    persistedModelId,
    getProviderConfig,
  } = await import('../server/providers/index.js');
  const {
    createThinkStreamSplitter,
    LLAMACPP_ACTIVE_PRESET_DEFAULT,
    LLAMACPP_CANONICAL_PRESETS,
    LLAMACPP_PRESET_IDS,
    LLAMACPP_SAMPLING_DEFAULTS,
    REMOVED_LMSTUDIO_MESSAGE,
  } = await import('../server/providers/llamacpp.js');

  ok('(D1) resolveProviderId routing per §1/D8', () => {
    assert.equal(resolveProviderId('llamacpp:Qwen3.6-35B-A3B-UD-Q4_K_M'), 'llamacpp');
    assert.equal(resolveProviderId('lmstudio:qwen/qwen3-coder-30b'), 'lmstudio'); // NEVER openrouter
    assert.equal(resolveProviderId('deepseek:deepseek-v4-flash'), 'deepseek');
    assert.equal(resolveProviderId('gpt-x'), 'openrouter');
  });
  ok('(D2) toUpstreamModelId strips the llamacpp prefix', () => {
    assert.equal(toUpstreamModelId('llamacpp:Qwen3.6'), 'Qwen3.6');
  });
  ok('(D3) isLlamacppModel classifies both ways', () => {
    assert.equal(isLlamacppModel('llamacpp:m'), true);
    assert.equal(isLlamacppModel('openrouter/auto'), false);
  });
  ok('(D4) persistedModelId keeps namespaced llamacpp ids', () => {
    assert.equal(persistedModelId('llamacpp', 'llamacpp:key', 'key'), 'llamacpp:key');
    assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
  });
  ok('(D5) config labels per brief', () => {
    assert.equal(getProviderConfig('llamacpp').label, 'llama.cpp (Local)');
    assert.equal(getProviderConfig('lmstudio').label, 'LM Studio (removed)');
  });
  ok('(D6) frozen constants: legacy message + §3 canonical presets/sampling row', () => {
    assert.equal(
      REMOVED_LMSTUDIO_MESSAGE,
      'This conversation uses the removed LM Studio provider (lmstudio:<id>). Pick an llamacpp: model in the model selector.',
    );
    assert.deepEqual([...LLAMACPP_PRESET_IDS], ['rapido', 'equilibrado', 'profundo']);
    assert.equal(LLAMACPP_ACTIVE_PRESET_DEFAULT, 'equilibrado');
    assert.deepEqual(
      { ...LLAMACPP_CANONICAL_PRESETS },
      {
        rapido: { reasoning_budget: 1024, mtp: 2 },
        equilibrado: { reasoning_budget: 2048, mtp: 0 },
        profundo: { reasoning_budget: 4096, mtp: 0 },
      },
    );
    assert.deepEqual(
      { ...LLAMACPP_SAMPLING_DEFAULTS },
      { temp: 0.6, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1 },
    );
  });
  ok('(D7) think splitter still behaves (copied pure module)', () => {
    const splitter = createThinkStreamSplitter();
    assert.deepEqual(splitter.push('<th'), { reasoning: '', content: '' });
    assert.deepEqual(splitter.push('ink>why'), { reasoning: 'why', content: '' });
    assert.deepEqual(splitter.push('</think>ans'), { reasoning: '', content: 'ans' });
    assert.deepEqual(splitter.flush(), { reasoning: '', content: '' });
  });
}

// ===========================================================================
// PRE-phase — the OLD §6 seams on the PRISTINE tree (green BEFORE the
// Increment 2 chat.ts/councilExecutor edits land). Runs ONLY with --phase=pre.
// ===========================================================================
function preChecks(): void {
  ok('(C4-PRE) OLD top_p pin present behind the llamacpp gate (pristine tree)', () => {
    assert.match(
      chatSource,
      /if \(isLlamacppModel\(effectiveModel\)\) \{\s*(?:\/\/[^\n]*\n\s*)*requestBody\.top_p = LLAMACPP_SAMPLING_TOP_P;/,
    );
  });
  ok('(C4-PRE2) chat.ts still imports LLAMACPP_SAMPLING_TOP_P (pristine tree)', () => {
    assert.match(chatSource, /LLAMACPP_SAMPLING_TOP_P/);
  });
  ok('(C4-PRE3) councilExecutor has NO shared-sampling resolver yet (pristine tree)', () => {
    assert.doesNotMatch(councilSource, /resolveLlamacppSampling/);
  });
}

stabilityChecks();
if (phase === 'pre') {
  preChecks();
} else {
  seamChecks();
  await dynamicSmoke();
}

console.log(
  phase === 'pre'
    ? `llamacpp chat-gates guardrail PRE-phase (stability baseline): OK (${checks} checks)`
    : `llamacpp chat-gates guardrail${phase === 'post' ? ' POST-phase' : ''}: OK (${checks} checks)`,
);
