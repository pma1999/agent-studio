/**
 * Provider wiring guardrail — one pass over every provider the app offers.
 *
 * What a provider *offers* (models, prices, transports, thinking levels) is
 * discovered at runtime and asserted live in `test-model-catalog.ts`,
 * `test-pricing.ts` and the per-provider harnesses. What stays fixed is the
 * wiring around it: the registry entry, the key gate and its encryption, the
 * validate route, the settings card, and the invariants that must hold for
 * every provider at once. Those are asserted here, table-driven, so adding a
 * provider means adding one row instead of a new near-duplicate test file.
 *
 * Replaces test-{abliteration,arnict,opencode-go}-chat-gates.ts.
 *
 * Usage:
 *   npx tsx scripts/test-provider-wiring.ts
 *
 * Reads source text only — offline-safe, db-free, no network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProviderConfig } from '../server/providers/index.js';
import { PROVIDER_PREFIXES, providerOfModelId, upstreamIdOf, type ProviderId } from '../shared/models/providers.js';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');
const chatSource = read('server/routes/chat.ts');
const councilSource = read('server/services/councilExecutor.ts');
const chatCouncilSource = read('server/routes/chatCouncil.ts');
const indexSource = read('server/providers/index.ts');
const modelsSource = read('server/routes/models.ts');
const cryptoSource = read('server/crypto.ts');
const clientSource = read('src/api/client.ts');
const settingsSource = read('src/components/SettingsPanel.tsx');
const storeSource = read('src/stores/store.ts');
const selectorSource = read('src/components/ModelSelectorCore.tsx');
const providersUiSource = read('src/utils/providers.ts');
const catalogIndexSource = read('server/catalog/index.ts');

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// The table: one row per provider that needs a user-supplied credential.
// ---------------------------------------------------------------------------

interface KeyedProvider {
  id: ProviderId;
  /** Settings key holding the credential. */
  setting: string;
  /** Vendor host the browser must never call directly. */
  host: string;
  /** Settings card component. */
  card: string;
  /** Zustand field pair. */
  storeField: string;
}

const KEYED: KeyedProvider[] = [
  { id: 'openrouter', setting: 'openrouter_api_key', host: 'openrouter.ai', card: '', storeField: 'apiKey' },
  { id: 'deepseek', setting: 'deepseek_api_key', host: 'api.deepseek.com', card: 'DeepSeekSection', storeField: 'deepSeekApiKey' },
  { id: 'abliteration', setting: 'abliteration_api_key', host: 'api.abliteration.ai', card: 'AbliterationSection', storeField: 'abliterationApiKey' },
  { id: 'arnict', setting: 'arnict_api_key', host: 'api.arnict.com', card: 'ArnictSection', storeField: 'arnictApiKey' },
  { id: 'opencode-go', setting: 'opencode_go_api_key', host: 'opencode.ai', card: 'OpenCodeGoSection', storeField: 'opencodeGoApiKey' },
];

/** Providers served over HTTP with an endpoint of their own. */
const HTTP_PROVIDERS: ProviderId[] = ['openrouter', 'deepseek', 'abliteration', 'arnict', 'opencode-go'];

// ---------------------------------------------------------------------------
// Registry: every provider is complete and self-describing
// ---------------------------------------------------------------------------

ok('every prefixed provider has a scheme, and OpenRouter has none', () => {
  for (const [provider, prefix] of Object.entries(PROVIDER_PREFIXES)) {
    assert.equal(prefix, `${provider}:`, provider);
    assert.equal(providerOfModelId(`${prefix}some-model`), provider);
    assert.equal(upstreamIdOf(`${prefix}some-model`), 'some-model');
  }
  assert.equal(providerOfModelId('author/slug'), 'openrouter');
  assert.equal(upstreamIdOf('author/slug'), 'author/slug');
});

ok('every HTTP provider has an endpoint, a key setting and Bearer auth', () => {
  for (const id of HTTP_PROVIDERS) {
    const config = getProviderConfig(id);
    assert.match(config.chatCompletionsUrl, /^https:\/\//, id);
    assert.ok(config.apiKeySetting.length > 0, `${id} key setting`);
    const headers = config.buildHeaders('k');
    assert.equal(headers['Content-Type'], 'application/json', id);
    assert.equal(headers['Authorization'], 'Bearer k', id);
  }
});

ok('only OpenRouter claims plugins and endpoint routing', () => {
  for (const id of HTTP_PROVIDERS) {
    const config = getProviderConfig(id);
    const expected = id === 'openrouter';
    assert.equal(config.supportsPlugins, expected, `${id} plugins`);
    assert.equal(config.supportsProviderRouting, expected, `${id} routing`);
  }
});

ok('the registry no longer carries model knowledge', () => {
  for (const symbol of [
    'DEEPSEEK_CATALOG',
    'ABLITERATION_CATALOG',
    'ARNICT_CATALOG',
    'OPENCODE_GO_CATALOG',
    'OPENCODE_GO_PRICING',
    'OPENCODE_GO_CHAT_TRANSPORT_MODELS',
    'OPENCODE_GO_NON_CHAT_TRANSPORT',
    'OPENCODE_GO_REASONING_CONTENT_MODELS',
    'supportsReasoningParam',
    'assistantReasoningField',
    'computeDeepSeekCost',
    'computeAbliterationCost',
    'computeArnictCost',
    'computeOpencodeGoCost',
  ]) {
    assert.ok(!indexSource.includes(symbol), `${symbol} still in the provider registry`);
  }
});

ok('every provider has a catalog adapter, exhaustively keyed', () => {
  for (const id of [...HTTP_PROVIDERS, 'codex', 'llamacpp'] as ProviderId[]) {
    assert.match(catalogIndexSource, new RegExp(`${id.includes('-') ? `'${id}'` : id}:`), id);
  }
  // The removed local provider is declared unsupported rather than omitted.
  assert.match(catalogIndexSource, /lmstudio:/);
});

// ---------------------------------------------------------------------------
// Credentials: encrypted, gated, validated
// ---------------------------------------------------------------------------

ok('every provider key is encrypted at rest', () => {
  assert.match(cryptoSource, /SENSITIVE_SETTINGS_KEYS/);
  for (const provider of KEYED) {
    assert.match(cryptoSource, new RegExp(`'${provider.setting}'`), provider.setting);
  }
});

ok('every keyed provider has a validate route behind its own key gate', () => {
  for (const provider of KEYED) {
    if (provider.id === 'openrouter') continue;
    const route = provider.id === 'opencode-go' ? 'opencodego' : provider.id;
    assert.match(modelsSource, new RegExp(`router\\.get\\('/${route}/validate'`), provider.id);
    assert.match(modelsSource, new RegExp(`getSettingValue\\(userId, '${provider.setting}'\\)`), provider.setting);
  }
});

ok('validate failures name the provider instead of leaking upstream text', () => {
  for (const label of ['DeepSeek', 'Abliteration', 'Arnict', 'OpenCode Go']) {
    assert.match(modelsSource, new RegExp(`'Invalid ${label} API key`), label);
  }
  // Only the provider that publishes a credit balance reads one.
  const start = modelsSource.indexOf("router.get('/arnict/validate'");
  const end = modelsSource.indexOf("router.get('", start + 10);
  assert.ok(start >= 0 && end > start, 'arnict validate block bounds');
  assert.doesNotMatch(modelsSource.slice(start, end), /total_credits/);
});

ok('the browser never calls a provider host directly (everything relays)', () => {
  // Help links and displayed base URLs are fine; an actual request is not.
  const quotes = ["'", '"', '`'];
  for (const source of [clientSource, settingsSource, storeSource, selectorSource, providersUiSource]) {
    for (const provider of KEYED) {
      for (const quote of quotes) {
        assert.ok(!source.includes(`fetch(${quote}https://${provider.host}`), `${provider.host} fetched from the browser`);
      }
    }
  }
});

ok('each keyed provider has a settings card and a store field', () => {
  for (const provider of KEYED) {
    if (!provider.card) continue;
    assert.match(settingsSource, new RegExp(`function ${provider.card}\\(`), provider.card);
    assert.match(settingsSource, new RegExp(`settingKey="${provider.setting}"`), provider.setting);
    assert.match(storeSource, new RegExp(`${provider.storeField}: string;`), provider.storeField);
  }
});

// ---------------------------------------------------------------------------
// One send path: no per-provider branches left
// ---------------------------------------------------------------------------

ok('chat and council resolve the model in the catalog before sending', () => {
  for (const [name, source] of [['chat', chatSource], ['council', councilSource]] as const) {
    assert.match(source, /modelCatalog\(\)\.resolveModel\(/, name);
    assert.match(source, /planReasoning\(/, name);
  }
});

ok('transports come from the catalog, never from a hard-coded id list', () => {
  for (const [name, source] of [['chat', chatSource], ['council', councilSource]] as const) {
    assert.match(source, /catalogModel\.transport|model\.transport/, name);
    assert.doesNotMatch(source, /opencodeGoTransportFor/, name);
  }
});

ok('costs go through the one pricing engine', () => {
  for (const [name, source] of [['chat', chatSource], ['council', councilSource]] as const) {
    assert.doesNotMatch(source, /computeDeepSeekCost|computeAbliterationCost|computeArnictCost|computeOpencodeGoCost/, name);
  }
  assert.match(chatSource, /priceChatUsage|computeCost\(/);
  assert.match(councilSource, /computeCost\(/);
});

ok('the key gate stays generic: only keyless providers are exempt', () => {
  // Codex authenticates with a ChatGPT account, llama.cpp runs locally.
  assert.match(chatSource, /isCodexModel\(/);
  assert.match(chatSource, /isLlamacppModel\(/);
  for (const provider of ['abliteration', 'arnict', 'opencode-go', 'deepseek']) {
    assert.doesNotMatch(chatSource, new RegExp(`skip.{0,40}key.{0,40}${provider}`, 'i'), provider);
  }
});

ok('council pre-flight validates keys for every provider the same way', () => {
  assert.match(chatCouncilSource, /resolveProviderId\(/);
  assert.match(chatCouncilSource, /getSettingValue\(/);
});

// ---------------------------------------------------------------------------
// Invariants that must hold for every provider at once
// ---------------------------------------------------------------------------

const SEND_PATHS: Array<[string, string]> = [
  ['chat', chatSource],
  ['council', councilSource],
];

ok('no strict:false is ever sent', () => {
  for (const [name, source] of SEND_PATHS) assert.doesNotMatch(source, /strict:\s*false/, name);
});

ok('no tool_choice object form is ever sent', () => {
  for (const [name, source] of SEND_PATHS) {
    assert.doesNotMatch(source, /tool_choice:\s*\{/, name);
    assert.doesNotMatch(source, /tool_choice = \{/, name);
  }
});

ok('no video field and no http image fallback is ever built', () => {
  for (const [name, source] of SEND_PATHS) {
    assert.doesNotMatch(source, /requestBody\.video/, name);
    assert.doesNotMatch(source, /image_url[^;]*https?:\/\//, name);
  }
});

ok('`ultra` never reaches a wire or a label', () => {
  const wireSource = read('server/providers/wire/reasoning.ts');
  const copySource = read('src/components/reasoning/reasoningCopy.ts');
  for (const [name, source] of [...SEND_PATHS, ['wire', wireSource], ['copy', copySource]] as const) {
    assert.doesNotMatch(source, /'ultra'|"ultra"|ultracode/, name);
  }
});

// ---------------------------------------------------------------------------
// Frontend: one catalog, one thinking control
// ---------------------------------------------------------------------------

ok('the per-provider model hooks are gone; the catalog hook replaces them', () => {
  for (const hook of [
    'useOpenRouterModels',
    'useDeepSeekModels',
    'useCodexModels',
    'useAbliterationModels',
    'useArnictModels',
    'useOpencodeGoModels',
    'useLlamaCppModels',
  ]) {
    assert.ok(!selectorSource.includes(hook), `${hook} still imported by the picker`);
    assert.ok(!settingsSource.includes(hook), `${hook} still imported by settings`);
  }
  assert.match(selectorSource, /useModelCatalog/);
});

ok('the picker reads provider state from the catalog, one section each', () => {
  assert.match(selectorSource, /providerState/);
  assert.match(selectorSource, /ProviderStateHint/);
  assert.match(selectorSource, /DIRECT_PROVIDERS/);
});

ok('every surface renders the same thinking control from the capability', () => {
  for (const file of ['src/components/ChatView.tsx', 'src/components/AgentEditor.tsx', 'src/components/SettingsPanel.tsx']) {
    const source = read(file);
    assert.match(source, /<ReasoningControl/, file);
    assert.match(source, /useCatalogModel\(/, file);
    // No local level tables survive.
    assert.doesNotMatch(source, /EFFORT_OPTIONS|EFFORT_LEVELS|reasoningEffortOptions/, file);
  }
});

ok('provider UI facts live in one table', () => {
  assert.match(providersUiSource, /export const PROVIDER_UI/);
  for (const provider of ['deepseek', 'codex', 'abliteration', 'arnict', "'opencode-go'", 'llamacpp']) {
    assert.match(providersUiSource, new RegExp(`${provider}: \\{ label:`), provider);
  }
});

console.log(`provider wiring guardrail: OK (${checks} checks)`);
