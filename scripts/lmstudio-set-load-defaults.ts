/**
 * lmstudio-set-load-defaults.ts — DEV-ONLY utility, never part of any test chain.
 *
 * WHY THIS EXISTS
 * The REST load endpoint (POST /api/v1/models/load) can only set context_length,
 * flash_attention, offload_kv_cache_to_gpu and eval_batch_size. The remaining
 * profile knobs — GPU offload ("auto"), K/V-cache quantization (Q8_0), parallel
 * requests (=1) and CPU threads ("auto") — are not REST-settable, so LM Studio
 * would silently use its own defaults (parallel=4!) and the compliance panel
 * would report those knobs unmet. This script applies them through the
 * @lmstudio/sdk IPC channel instead of REST.
 *
 * WHAT SDK 1.5.0 CAN ACTUALLY DO (verified against node_modules/@lmstudio/sdk
 * dist/index.d.ts): LLMLoadModelConfig accepts contextLength, flashAttention,
 * offloadKVCacheToGpu, evalBatchSize, llamaKCacheQuantizationType /
 * llamaVCacheQuantizationType (enum values are LOWERCASE, e.g. "q8_0"; V-cache
 * requires flash attention) and gpu {ratio: number | "max" | "off"} — there is
 * NO "auto" literal, so this script omits `gpu` entirely, which is exactly the
 * engine default (automatic offload). There is NO public API to persist
 * per-model defaults (the daemon-side userModelDefault/modelDefault layers are
 * not writable via SDK), and NO load-config field for parallel requests or CPU
 * threads (cpuThreads exists only as a per-request prediction option). So this
 * script LOADS each model once with the full knob set: the values stay active
 * on that instance (visible to the compliance panel) and the two truly
 * un-expressible knobs are reported with GUI guidance instead of being faked.
 *
 * DEV-ONLY WARNING: talks directly to your local LM Studio daemon and loads
 * real models into memory. Never imported by server/** runtime code and never
 * executed by tests/CI. Live runs require the LM Studio desktop app running.
 *
 * Usage:
 *   npx tsx scripts/lmstudio-set-load-defaults.ts <model-key> [more-keys...] [rapido|equilibrado|contexto_grande]
 *   npx tsx scripts/lmstudio-set-load-defaults.ts --help
 *
 * The trailing profile id is optional and defaults to "equilibrado".
 */

import process from 'node:process';

/** Profiles mirror global-constraints.md §3 (REST context lengths; shared fixed knobs). */
const PROFILES = {
  rapido: { label: 'RÁPIDO', contextLength: 32768 },
  equilibrado: { label: 'EQUILIBRADO', contextLength: 65536 },
  contexto_grande: { label: 'CONTEXTO GRANDE', contextLength: 131072 },
} as const;

type ProfileId = keyof typeof PROFILES;

/** Knobs carried in ONE load call (all verified LLMLoadModelConfig fields). */
function buildLoadConfig(profile: ProfileId): Record<string, unknown> {
  return {
    contextLength: PROFILES[profile].contextLength,
    flashAttention: true,
    offloadKVCacheToGpu: false,
    evalBatchSize: 512,
    llamaKCacheQuantizationType: 'q8_0', // SDK enum is lowercase; Q8_0 in GUI spelling
    llamaVCacheQuantizationType: 'q8_0',
    // `gpu` intentionally omitted => engine default = automatic GPU offload ("auto").
  };
}

/** Human-readable knob list for per-knob reporting. */
function describeKnobs(profile: ProfileId): Array<[string, string]> {
  return [
    ['context_length', String(PROFILES[profile].contextLength)],
    ['flash_attention', 'true'],
    ['offload_kv_cache_to_gpu', 'false'],
    ['eval_batch_size', '512'],
    ['gpu_offload', 'auto (SDK engine default; gpu field omitted)'],
    ['llama_k_cache_quantization_type', 'q8_0'],
    ['llama_v_cache_quantization_type', 'q8_0'],
  ];
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx scripts/lmstudio-set-load-defaults.ts <model-key> [more-keys...] [rapido|equilibrado|contexto_grande]

Arguments:
  <model-key>     One or more LM Studio model keys (as shown by \`lms ls\`, e.g. qwen/qwen3-coder-30b).
  profile         Optional trailing profile id: rapido | equilibrado (default) | contexto_grande.
                  Sets the context length (32768 / 65536 / 131072); all other knobs are fixed.

What it sets per model (via @lmstudio/sdk IPC, one load call):
  ${describeKnobs('equilibrado').map(([k, v]) => `${k}=${v}`).join('\n  ')}

Not programmatically settable with @lmstudio/sdk 1.5.0 (reported, not faked):
  parallel_stable=1 (Max Concurrent Predictions; GUI loader advanced settings, default is 4!)
  cpu_threads=auto  (exists only as a per-request prediction option in the SDK)

Requires: npm i -D @lmstudio/sdk   AND   the LM Studio desktop app running.`);
}

/** Minimal structural types so the file typechecks WITHOUT @lmstudio/sdk installed. */
interface LmStudioSdkLike {
  LMStudioClient: new (opts?: unknown) => {
    llm: {
      load: (modelKey: string, opts?: { config?: Record<string, unknown> }) => Promise<unknown>;
    };
    system: {
      getLMStudioVersion: () => Promise<unknown>;
    };
  };
}

/**
 * Guarded dynamic import. The module name lives in a variable on purpose: TS
 * and bundlers must never statically resolve this optional devDependency
 * (global-constraints §10 — the SDK never enters server runtime or builds).
 */
async function importSdk(): Promise<LmStudioSdkLike> {
  const moduleName = '@lmstudio/sdk';
  try {
    return (await import(moduleName)) as unknown as LmStudioSdkLike;
  } catch {
    console.error(
      [
        '',
        'The @lmstudio/sdk package is not installed.',
        'Install it as a dev dependency and make sure the LM Studio desktop app is running:',
        '',
        '    npm i -D @lmstudio/sdk',
        '',
        '(The SDK talks to the local LM Studio daemon over IPC; it is used ONLY by this',
        ' dev script — never by the server runtime.)',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

function printDaemonUnreachable(error: unknown): void {
  console.error(
    [
      '',
      'Could not reach the LM Studio daemon. Start the LM Studio desktop app first',
      '(and run `npm i -D @lmstudio/sdk` if you have not yet). Underlying error:',
      '',
      `    ${formatError(error)}`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  // The SDK kicks off its daemon connection in the background and may reject
  // OUTSIDE our awaited calls (observed with @lmstudio/sdk 1.5.0 when LM Studio
  // is not running: an unhandled rejection crashes raw). Convert any such late
  // rejection into the friendly message + clean nonzero exit.
  process.on('unhandledRejection', (reason) => {
    printDaemonUnreachable(reason);
    process.exit(1);
  });

  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const modelKeys: string[] = [];
  let profile: ProfileId = 'equilibrado';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile') {
      const value = args[++i];
      if (!value || !(value in PROFILES)) {
        console.error(`--profile must be one of: ${Object.keys(PROFILES).join(', ')}`);
        process.exit(1);
      }
      profile = value as ProfileId;
    } else if (arg in PROFILES) {
      profile = arg as ProfileId;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    } else {
      modelKeys.push(arg);
    }
  }

  if (modelKeys.length === 0) {
    console.error('No model key given.\n');
    printUsage();
    process.exit(1);
  }

  console.error(`Profile: ${profile} (${PROFILES[profile].label}, context_length=${PROFILES[profile].contextLength})`);

  const sdk = await importSdk();
  const client = new sdk.LMStudioClient();

  try {
    // First real IPC round-trip; fails here when the daemon is not running.
    await client.system.getLMStudioVersion();
  } catch (error) {
    printDaemonUnreachable(error);
    process.exit(1);
  }

  const config = buildLoadConfig(profile);
  let failures = 0;

  for (const modelKey of modelKeys) {
    console.log(`\n=== ${modelKey} (${PROFILES[profile].label}) ===`);
    try {
      await client.llm.load(modelKey, { config });
      for (const [knob, value] of describeKnobs(profile)) {
        console.log(`  OK    ${knob} = ${value}`);
      }
      console.log('  NOTE  model left LOADED so the Agent Studio compliance panel can verify the knobs.');
    } catch (error) {
      failures++;
      for (const [knob, value] of describeKnobs(profile)) {
        console.log(`  FAIL  ${knob} = ${value}`);
      }
      console.error(`  SDK/daemon rejected the load for "${modelKey}". Error (verbatim):`);
      console.error(`    ${formatError(error)}`);
    }
  }

  console.log(
    '\nNot settable via @lmstudio/sdk 1.5.0 (set once in the LM Studio GUI loader if needed):',
  );
  console.log('  - parallel_stable = 1  ("Max Concurrent Predictions"; GUI default is 4)');
  console.log('  - cpu_threads = auto   (SDK exposes cpuThreads only as a per-request prediction option)');
  console.log('  - gpu "auto" is the engine default and therefore already active.');

  if (failures > 0) {
    console.error(`\n${failures} of ${modelKeys.length} model(s) FAILED (see verbatim errors above).`);
    process.exit(2);
  }
  console.log(`\nDone: ${modelKeys.length} model(s) processed successfully.`);
}

main().catch((error: unknown) => {
  console.error(`Unexpected failure (verbatim):\n${formatError(error)}`);
  process.exit(1);
});
