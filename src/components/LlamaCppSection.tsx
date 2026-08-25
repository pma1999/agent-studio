import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { CheckCircle, AlertCircle, ChevronDown, ChevronUp, Loader2, RefreshCw, Play, Square, Terminal, ScrollText } from 'lucide-react';
import { AlertTriangle } from 'lucide-react';
import {
  settingsApi,
  modelsApi,
  llamacppApi,
  type LlamaCppModel,
  type LlamaCppPresetId,
  type LlamaCppPresetsRow,
  type LlamaCppSampling,
  type LlamaCppStatus,
} from '../api/client';
import { LLAMACPP_ACCENT, LLAMACPP_STATUS_CHANGED_EVENT } from '../utils/providers';
import { useLlamaCppModels } from '../hooks/useLlamaCppModels';
import {
  LLAMACPP_ACTIVE_PRESET_DEFAULT,
  LLAMACPP_CACHE_TYPES,
  LLAMACPP_CANONICAL_PRESETS,
  LLAMACPP_IDLE_UNLOAD_DEFAULT,
  LLAMACPP_KNOB_DEFAULTS,
  LLAMACPP_LOGS_MAX_BYTES,
  LLAMACPP_PORT_DEFAULT,
  LLAMACPP_PRESET_META,
  LLAMACPP_REASONING_FORMATS,
  LLAMACPP_SAMPLING_BOUNDS,
  LLAMACPP_SAMPLING_DEFAULTS,
  deriveLaunchRows,
  formatArgvLine,
  formatReasoningBudget,
  knobValueType,
  mergeKnobLayers,
  parseLlamaCppActivePreset,
  parseLlamaCppJsonRow,
  parseLlamaCppModelSamplingRow,
  parseLlamaCppPresetsRow,
  parseLlamaCppSamplingRow,
  phaseFromStatus,
  samplingValidationError,
  type LlamaCppKnobBag,
  type LlamaCppKnobKey,
  type LlamaCppKnobOverrides,
  type LlamaCppReasoningFormat,
  type LlamaCppSamplingOverride,
} from '../utils/llamacppKnobs';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

// llama.cpp (local provider) settings keys — global-constraints §3 scalars +
// §5 JSON knob rows + §3 Increment 2 preset/sampling rows. None are sensitive
// (loopback bind, no API key).
const KEY_EXE_PATH = 'llamacpp_exe_path';
const KEY_MODELS_DIR = 'llamacpp_models_dir';
const KEY_PORT = 'llamacpp_port';
const KEY_IDLE_MINUTES = 'llamacpp_idle_unload_minutes';
const KEY_LOAD_DEFAULTS = 'llamacpp_load_defaults';
const KEY_MODEL_OVERRIDES = 'llamacpp_model_overrides';
const KEY_PRESETS = 'llamacpp_presets';
const KEY_ACTIVE_PRESET = 'llamacpp_active_preset';
const KEY_SAMPLING = 'llamacpp_sampling';
const KEY_MODEL_SAMPLING = 'llamacpp_model_sampling';

/** Persisted overrides record: modelKey → partial knob bag (§3). */
type OverridesRecord = Record<string, LlamaCppKnobOverrides>;

/** Persisted per-model sampling record: modelKey → partial sampling row (§10 2d). */
type ModelSamplingRecord = Record<string, LlamaCppSamplingOverride>;

interface Notice { ok: boolean; text: string }

type NumKnobKey =
  | 'n_cpu_moe' | 'threads' | 'threads_batch' | 'ctx' | 'mtp' | 'parallel_slots';

const NUM_KNOBS: Array<{ key: NumKnobKey; label: string; min: number; max?: number }> = [
  { key: 'ctx', label: 'Context size', min: 1 },
  { key: 'parallel_slots', label: 'Parallel slots', min: 1 },
  { key: 'threads', label: 'Threads', min: 1 },
  { key: 'threads_batch', label: 'Batch threads', min: 1 },
  { key: 'n_cpu_moe', label: 'MoE blocks on CPU (0 = none)', min: 0 },
  { key: 'mtp', label: 'MTP draft tokens (0 = off)', min: 0, max: 5 },
];

/**
 * §4 Increment 2c OPTIONAL emit-when-set knobs. Blank input = unset = key
 * omitted from the persisted row = llama-server default applies (never a
 * stored 0 or 'auto').
 */
const OPTIONAL_NUMERIC_KNOBS: Array<{ key: 'logical_batch' | 'ubatch'; label: string }> = [
  { key: 'logical_batch', label: 'Logical batch (-b)' },
  { key: 'ubatch', label: 'Ubatch (-ub)' },
];

const REASONING_BUDGET_OPTIONS = [-1, 0, 512, 1024, 2048, 4096, 8192];

/** Sampling editor fields — labels pinned by the task brief. */
const SAMPLING_FIELDS: Array<{ key: keyof LlamaCppSampling; label: string }> = [
  { key: 'temp', label: 'Temperatura' },
  { key: 'top_p', label: 'top_p' },
  { key: 'top_k', label: 'top_k' },
  { key: 'min_p', label: 'min_p' },
  { key: 'repeat_penalty', label: 'repeat_penalty' },
];

/** §10 Increment 2d per-model editor fields — blank = inherit the global row
 * (presence_penalty additionally omitted from the request body when unset). */
const MODEL_SAMPLING_FIELDS: Array<{ key: keyof LlamaCppSampling; label: string }> = [
  { key: 'temp', label: 'Temperatura' },
  { key: 'top_p', label: 'top_p' },
  { key: 'top_k', label: 'top_k' },
  { key: 'min_p', label: 'min_p' },
  { key: 'repeat_penalty', label: 'repeat_penalty' },
  { key: 'presence_penalty', label: 'presence_penalty' },
];

function knobGridStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
    gap: '10px',
  };
}

/**
 * Settings → llama.cpp section (plan.md D5/D6/D7): connection scalars, global
 * launch-knob defaults + per-model overrides, honest status badges, Start/Stop
 * swap-and-wait controls, launch-config preview with per-knob origin, and a
 * bounded log viewer. Replaces the removed LM Studio section wholesale.
 */
export function LlamaCppSection() {
  // --- Connection scalars (settings keys, §3) -----------------------------
  const [exePath, setExePath] = useState('');
  const [exePathSaved, setExePathSaved] = useState('');
  const [modelsDir, setModelsDir] = useState('');
  const [modelsDirSaved, setModelsDirSaved] = useState('');
  const [portText, setPortText] = useState(String(LLAMACPP_PORT_DEFAULT));
  const [portSaved, setPortSaved] = useState(String(LLAMACPP_PORT_DEFAULT));
  const [idleMinutesText, setIdleMinutesText] = useState(String(LLAMACPP_IDLE_UNLOAD_DEFAULT));
  const [idleMinutesSaved, setIdleMinutesSaved] = useState(String(LLAMACPP_IDLE_UNLOAD_DEFAULT));

  // --- Launch knobs (JSON rows via POST /config, §5) ----------------------
  const [defaults, setDefaults] = useState<LlamaCppKnobBag>({ ...LLAMACPP_KNOB_DEFAULTS });
  const [overrides, setOverrides] = useState<OverridesRecord>({});
  const [overrideKey, setOverrideKey] = useState('');
  const [knobsSaving, setKnobsSaving] = useState(false);
  const [knobsNotice, setKnobsNotice] = useState<Notice | null>(null);

  // --- Presets & sampling (§3 Increment 2 rows via POST /config) ----------
  const [presets, setPresets] = useState<LlamaCppPresetsRow>(() => parseLlamaCppPresetsRow(null));
  const [activePreset, setActivePreset] = useState<LlamaCppPresetId>(LLAMACPP_ACTIVE_PRESET_DEFAULT);
  const [expandedPreset, setExpandedPreset] = useState<LlamaCppPresetId | null>(null);
  const [presetsSaving, setPresetsSaving] = useState(false);
  const [presetsNotice, setPresetsNotice] = useState<Notice | null>(null);
  const [sampling, setSampling] = useState<LlamaCppSampling>({ ...LLAMACPP_SAMPLING_DEFAULTS });
  const [samplingErrors, setSamplingErrors] = useState<Partial<Record<keyof LlamaCppSampling, string>>>({});
  const [samplingSaving, setSamplingSaving] = useState(false);
  const [samplingNotice, setSamplingNotice] = useState<Notice | null>(null);
  // --- Sampling por modelo (§10 Increment 2d row via POST /config) --------
  const [modelSampling, setModelSampling] = useState<ModelSamplingRecord>({});
  const [modelSamplingKey, setModelSamplingKey] = useState('');
  const [modelSamplingErrors, setModelSamplingErrors] = useState<Record<string, Partial<Record<keyof LlamaCppSampling, string>>>>({});
  const [modelSamplingSaving, setModelSamplingSaving] = useState(false);
  const [modelSamplingNotice, setModelSamplingNotice] = useState<Notice | null>(null);

  // --- Status / start / stop / logs ---------------------------------------
  const [status, setStatus] = useState<LlamaCppStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [startKey, setStartKey] = useState('');
  const [starting, setStarting] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [startNotice, setStartNotice] = useState<Notice | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<Notice | null>(null);
  const [applyingRestart, setApplyingRestart] = useState(false);
  const [logs, setLogs] = useState<{ text: string; truncated: boolean } | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const { models: catalog } = useLlamaCppModels();

  const fireStatusChanged = useCallback(
    () => window.dispatchEvent(new Event(LLAMACPP_STATUS_CHANGED_EVENT)),
    []
  );

  const refreshStatus = useCallback(async () => {
    try {
      const s = await modelsApi.llamacppStatus(); // never-throws shape, but request() can still fail on transport errors
      if (!mountedRef.current) return;
      setStatus(s);
      setStatusError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatusError(err instanceof Error ? err.message : 'Could not read llama.cpp status');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      settingsApi.get(KEY_EXE_PATH),
      settingsApi.get(KEY_MODELS_DIR),
      settingsApi.get(KEY_PORT),
      settingsApi.get(KEY_IDLE_MINUTES),
      settingsApi.get(KEY_LOAD_DEFAULTS),
      settingsApi.get(KEY_MODEL_OVERRIDES),
      settingsApi.get(KEY_PRESETS),
      settingsApi.get(KEY_ACTIVE_PRESET),
      settingsApi.get(KEY_SAMPLING),
      settingsApi.get(KEY_MODEL_SAMPLING),
    ]).then(([exe, dir, port, idle, defaultsRaw, overridesRaw, presetsRaw, activePresetRaw, samplingRaw, modelSamplingRaw]) => {
      if (cancelled) return;
      setExePath(exe.value ?? '');
      setExePathSaved(exe.value ?? '');
      setModelsDir(dir.value ?? '');
      setModelsDirSaved(dir.value ?? '');
      const parsedPort = Number(port.value);
      const normPort = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
        ? String(parsedPort)
        : String(LLAMACPP_PORT_DEFAULT);
      setPortText(normPort);
      setPortSaved(normPort);
      const parsedIdle = Number(idle.value);
      const normIdle = Number.isFinite(parsedIdle) && parsedIdle >= 0
        ? String(Math.floor(parsedIdle))
        : String(LLAMACPP_IDLE_UNLOAD_DEFAULT);
      setIdleMinutesText(normIdle);
      setIdleMinutesSaved(normIdle);
      setDefaults(parseLlamaCppJsonRow(defaultsRaw.value, { ...LLAMACPP_KNOB_DEFAULTS }));
      setOverrides(parseLlamaCppJsonRow<OverridesRecord>(overridesRaw.value, {}));
      setPresets(parseLlamaCppPresetsRow(presetsRaw.value));
      setActivePreset(parseLlamaCppActivePreset(activePresetRaw.value));
      setSampling(parseLlamaCppSamplingRow(samplingRaw.value));
      setSamplingErrors({});
      setModelSampling(parseLlamaCppModelSamplingRow(modelSamplingRaw.value));
    }).catch(() => {});
    void refreshStatus();
    return () => { cancelled = true; };
  }, [refreshStatus]);

  // Poll ≤2 s ONLY while a start is in flight (swap-and-wait UX); the effect
  // cleanup guarantees no leak after unmount (named risk).
  useEffect(() => {
    if (!starting) return;
    const id = window.setInterval(() => { void refreshStatus(); }, 2000);
    return () => window.clearInterval(id);
  }, [starting, refreshStatus]);

  // Elapsed counter while the health wait runs (can exceed 60 s).
  useEffect(() => {
    if (!starting) return;
    setElapsedSec(0);
    const id = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [starting]);

  // --- Scalar saves: optimistic with rollback (SettingsPanel idiom) -------
  const commitExePath = async () => {
    const next = exePath.trim();
    if (next === exePathSaved) return;
    const previous = exePathSaved;
    setExePathSaved(next); // optimistic
    try {
      await settingsApi.set(KEY_EXE_PATH, next);
      fireStatusChanged();
    } catch (err) {
      console.error('Failed to save llama.cpp executable path:', err);
      setExePathSaved(previous);
      setExePath(previous);
    }
  };

  const commitModelsDir = async () => {
    const next = modelsDir.trim();
    if (next === modelsDirSaved) return;
    const previous = modelsDirSaved;
    setModelsDirSaved(next);
    try {
      await settingsApi.set(KEY_MODELS_DIR, next);
      fireStatusChanged();
    } catch (err) {
      console.error('Failed to save llama.cpp models directory:', err);
      setModelsDirSaved(previous);
      setModelsDir(previous);
    }
  };

  const commitPort = async () => {
    const parsed = Number(portText.trim());
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      setPortText(portSaved); // invalid input snaps back to the persisted value
      return;
    }
    const normalized = String(parsed);
    if (normalized === portSaved) return;
    const previous = portSaved;
    setPortSaved(normalized);
    try {
      await settingsApi.set(KEY_PORT, normalized);
      fireStatusChanged();
    } catch (err) {
      console.error('Failed to save llama.cpp port:', err);
      setPortSaved(previous);
      setPortText(previous);
    }
  };

  // Invalid/negative idle minutes normalize to the server default (45, 0 = off).
  const commitIdleMinutes = async () => {
    const parsed = Number(idleMinutesText.trim());
    const normalized = Number.isFinite(parsed) && parsed >= 0 ? String(Math.floor(parsed)) : String(LLAMACPP_IDLE_UNLOAD_DEFAULT);
    setIdleMinutesText(normalized);
    if (normalized === idleMinutesSaved) return;
    const previousSaved = idleMinutesSaved;
    setIdleMinutesSaved(normalized);
    try {
      await settingsApi.set(KEY_IDLE_MINUTES, normalized);
    } catch (err) {
      console.error('Failed to save llama.cpp idle unload minutes:', err);
      setIdleMinutesSaved(previousSaved);
      setIdleMinutesText(previousSaved);
    }
  };

  // --- Knob saves: one POST /config carrying BOTH rows (each provided
  // section replaces its whole settings row server-side) -------------------
  const saveKnobs = async () => {
    if (knobsSaving) return;
    setKnobsSaving(true);
    setKnobsNotice(null);
    try {
      await llamacppApi.config({ defaults: { ...defaults }, overrides });
      setKnobsNotice({ ok: true, text: 'Launch configuration saved — applies on the next start.' });
      fireStatusChanged();
    } catch (err) {
      setKnobsNotice({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to save the launch configuration',
      });
    } finally {
      setKnobsSaving(false);
    }
  };

  // --- Presets & sampling saves (§5 Increment 2: each POST /config section is
  // validated independently; key-level 400 detail arrives in error.message) --
  const selectPreset = async (id: LlamaCppPresetId) => {
    if (id === activePreset || presetsSaving) return;
    const previous = activePreset;
    setActivePreset(id); // optimistic
    setPresetsNotice(null);
    try {
      await llamacppApi.config({ activePreset: id });
      if (!mountedRef.current) return;
      fireStatusChanged();
      void refreshStatus(); // pendingRestart may change while a model runs
    } catch (err) {
      if (!mountedRef.current) return;
      setActivePreset(previous);
      setPresetsNotice({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to set the active preset',
      });
    }
  };

  const savePresets = async () => {
    if (presetsSaving) return;
    setPresetsSaving(true);
    setPresetsNotice(null);
    try {
      await llamacppApi.config({ presets });
      if (!mountedRef.current) return;
      setPresetsNotice({ ok: true, text: 'Presets saved — applies on the next start.' });
      fireStatusChanged();
      void refreshStatus();
    } catch (err) {
      if (!mountedRef.current) return;
      setPresetsNotice({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to save the presets',
      });
    } finally {
      if (mountedRef.current) setPresetsSaving(false);
    }
  };

  const updatePresetSlot = useCallback(
    (id: LlamaCppPresetId, key: 'reasoning_budget' | 'mtp', value: number) => {
      setPresets((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
    },
    [],
  );

  // Local bounds first (§3 zod bounds); a server 400 with key-level detail
  // (e.g. "sampling.top_p: …") is mapped onto the offending field inline.
  const saveSampling = async () => {
    const errors: Partial<Record<keyof LlamaCppSampling, string>> = {};
    for (const field of SAMPLING_FIELDS) {
      const value = sampling[field.key];
      if (value === undefined) continue; // OPTIONAL members validate only when set
      const invalid = samplingValidationError(field.key, value);
      if (invalid) errors[field.key] = invalid;
    }
    if (sampling.presence_penalty !== undefined) {
      const invalid = samplingValidationError('presence_penalty', sampling.presence_penalty);
      if (invalid) errors.presence_penalty = invalid;
    }
    setSamplingErrors(errors);
    if (Object.keys(errors).length > 0 || samplingSaving) return;
    setSamplingSaving(true);
    setSamplingNotice(null);
    try {
      // Explicit payload so an UNSET presence_penalty stays absent from the
      // persisted row (absent = omitted from every request body).
      const payload: LlamaCppSampling = {
        temp: sampling.temp,
        top_p: sampling.top_p,
        top_k: sampling.top_k,
        min_p: sampling.min_p,
        repeat_penalty: sampling.repeat_penalty,
      };
      if (sampling.presence_penalty !== undefined) payload.presence_penalty = sampling.presence_penalty;
      await llamacppApi.config({ sampling: payload });
      if (!mountedRef.current) return;
      setSamplingNotice({ ok: true, text: 'Sampling settings saved — applies on the next start.' });
      fireStatusChanged();
      void refreshStatus();
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to save the sampling settings';
      const keyMatch = /sampling\.(\w+)/.exec(message);
      const keyed = keyMatch && keyMatch[1] in LLAMACPP_SAMPLING_BOUNDS
        ? (keyMatch[1] as keyof LlamaCppSampling)
        : null;
      if (keyed) setSamplingErrors({ [keyed]: message });
      else setSamplingNotice({ ok: false, text: message });
    } finally {
      if (mountedRef.current) setSamplingSaving(false);
    }
  };

  // §10 Increment 2d OPTIONAL global knob: blank input = UNSET — the key is
  // deleted from the draft row so it never reaches the request body.
  const updateOptionalSampling = useCallback((key: 'presence_penalty', raw: string) => {
    setSampling((prev) => {
      const next = { ...prev };
      if (raw.trim() === '') {
        delete next[key];
        return next;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return prev; // half-typed numbers are ignored
      next[key] = n;
      return next;
    });
    setSamplingErrors((prev) => {
      const n = Number(raw);
      const next = { ...prev };
      delete next[key];
      const invalid = raw.trim() !== '' && Number.isFinite(n) ? samplingValidationError(key, n) : null;
      if (invalid) next[key] = invalid;
      return next;
    });
  }, []);

  // --- Sampling por modelo (§10 Increment 2d): pick/add a modelKey → partial
  // fields (blank = inherit), delete row, POST the modelSampling section ----
  const updateModelSampling = useCallback((modelKey: string, field: keyof LlamaCppSampling, raw: string) => {
    setModelSampling((prev) => {
      const row: LlamaCppSamplingOverride = { ...(prev[modelKey] ?? {}) };
      if (raw.trim() === '') {
        delete row[field]; // blank ⇒ inherit the global sampling row again
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) return prev; // half-typed numbers are ignored
        row[field] = n;
      }
      const next: ModelSamplingRecord = { ...prev };
      if (Object.keys(row).length === 0) delete next[modelKey];
      else next[modelKey] = row;
      return next;
    });
    setModelSamplingErrors((prev) => {
      if (!(modelKey in prev)) return prev;
      const rowErrors = { ...prev[modelKey] };
      delete rowErrors[field];
      const next = { ...prev };
      if (Object.keys(rowErrors).length === 0) delete next[modelKey];
      else next[modelKey] = rowErrors;
      return next;
    });
  }, []);

  const removeModelSamplingRow = useCallback((modelKey: string) => {
    setModelSampling((prev) => {
      if (!(modelKey in prev)) return prev;
      const next = { ...prev };
      delete next[modelKey];
      return next;
    });
    setModelSamplingErrors((prev) => {
      if (!(modelKey in prev)) return prev;
      const next = { ...prev };
      delete next[modelKey];
      return next;
    });
  }, []);

  const saveModelSampling = async () => {
    if (modelSamplingSaving) return;
    // Local bounds first: every DEFINED value in every row must be in range.
    const errors: Record<string, Partial<Record<keyof LlamaCppSampling, string>>> = {};
    for (const [modelKey, row] of Object.entries(modelSampling)) {
      for (const field of MODEL_SAMPLING_FIELDS) {
        const value = row[field.key];
        if (value === undefined) continue; // blank = inherit global
        const invalid = samplingValidationError(field.key, value);
        if (invalid) errors[modelKey] = { ...(errors[modelKey] ?? {}), [field.key]: invalid };
      }
    }
    setModelSamplingErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setModelSamplingSaving(true);
    setModelSamplingNotice(null);
    try {
      await llamacppApi.config({ modelSampling });
      if (!mountedRef.current) return;
      setModelSamplingNotice({ ok: true, text: 'Sampling por modelo guardado — aplica en el próximo start.' });
      fireStatusChanged();
      void refreshStatus();
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to save the per-model sampling';
      // Fail-soft key-level mapping: "modelSampling.<key>.<field>: …" lands on
      // the offending input; anything else surfaces as the section notice.
      const match = /^modelSampling\.([^.]+)(?:\.(\w+)):/.exec(message);
      const errField = match?.[2];
      if (match && errField && MODEL_SAMPLING_FIELDS.some((f) => f.key === errField)) {
        const errKey = match[1];
        setModelSamplingErrors((prev) => ({
          ...prev,
          [errKey]: { ...(prev[errKey] ?? {}), [errField]: message },
        }));
      } else {
        setModelSamplingNotice({ ok: false, text: message });
      }
    } finally {
      if (mountedRef.current) setModelSamplingSaving(false);
    }
  };

  const updateDefault = useCallback((key: LlamaCppKnobKey, value: LlamaCppKnobBag[LlamaCppKnobKey]) => {
    setDefaults((prev) => ({ ...prev, [key]: value }) as LlamaCppKnobBag);
  }, []);

  // §4 Increment 2c OPTIONAL knobs: blank input = UNSET — the key is deleted
  // from the defaults row so llama-server's own default applies. Invalid or
  // half-typed numbers are ignored (existing fail-soft input discipline).
  const updateOptionalNumberDefault = useCallback((key: 'logical_batch' | 'ubatch', raw: string) => {
    setDefaults((prev) => {
      const next = { ...prev } as LlamaCppKnobBag;
      if (raw.trim() === '') {
        delete next[key];
        return next;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return prev;
      (next as unknown as Record<string, unknown>)[key] = n;
      return next;
    });
  }, []);

  const updateDefaultReasoningFormat = useCallback((raw: string) => {
    setDefaults((prev) => {
      const next = { ...prev } as LlamaCppKnobBag;
      if (raw === '') {
        delete next.reasoning_format; // '(server default)' option = omitted key
        return next;
      }
      next.reasoning_format = raw as LlamaCppReasoningFormat;
      return next;
    });
  }, []);

  const updateOverride = useCallback((modelKey: string, knobKey: LlamaCppKnobKey, raw: string) => {
    setOverrides((prev) => {
      const row: LlamaCppKnobOverrides = { ...(prev[modelKey] ?? {}) };
      // knobValueType (not typeof-defaults) so the OPTIONAL §4 Increment 2c
      // knobs type-check even though they are absent from the canonical bag.
      const currentType = knobValueType(knobKey);
      let value: unknown = raw;
      if (currentType === 'number') {
        value = Number(raw);
        if (!Number.isFinite(value as number)) return prev; // half-typed numbers are ignored
      } else if (currentType === 'boolean') {
        value = raw === 'true';
      }
      if (raw === '') delete row[knobKey]; // empty ⇒ inherit from global again
      else (row as Record<string, unknown>)[knobKey] = value;
      const next: OverridesRecord = { ...prev };
      if (Object.keys(row).length === 0) delete next[modelKey];
      else next[modelKey] = row;
      return next;
    });
  }, []);

  const removeOverrideRow = useCallback((modelKey: string) => {
    setOverrides((prev) => {
      if (!(modelKey in prev)) return prev;
      const next = { ...prev };
      delete next[modelKey];
      return next;
    });
  }, []);

  // --- Start / Stop --------------------------------------------------------
  const effectiveStartKey = startKey || status?.modelKey || catalog[0]?.id.replace(/^[^:]*:/, '') || '';

  const handleStart = async (keyArg?: string) => {
    const targetKey = keyArg ?? effectiveStartKey;
    if (starting || !targetKey) return;
    setStarting(true);
    setStartNotice(null);
    try {
      const res = await llamacppApi.start(targetKey);
      if (!mountedRef.current) return;
      // Merge launch truth into local status so the preview renders instantly.
      setStatus((prev) => ({
        ...(prev ?? {
          agentConnected: true, capabilitySupported: true, running: false, pid: null,
          modelPath: null, modelKey: null, port: null, transport: null, healthy: null,
          startedAt: null, lastExitCode: null, argv: null, mtpActive: false, pendingRestart: false,
        }),
        running: true,
        healthy: true,
        pid: res.pid,
        port: res.port,
        argv: res.argv,
        modelKey: targetKey,
      }));
      setStartNotice({ ok: true, text: `llama-server ready (pid ${res.pid}, port ${res.port}, waited ${(res.waitedMs / 1000).toFixed(1)}s).` });
      fireStatusChanged();
    } catch (err) {
      if (!mountedRef.current) return;
      setStartNotice({ ok: false, text: err instanceof Error ? err.message : 'Failed to start llama-server' });
      void refreshStatus(); // report actual process state after a failed start
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  // Compliance-panel heritage: confirm-free, optimistic, fail-soft inline error.
  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    setStopNotice({ ok: true, text: 'Stopping…' });
    try {
      const res = await llamacppApi.stop();
      setStopNotice({ ok: true, text: res.status === 'not-running' ? 'Model was not running.' : 'Model stopped.' });
      fireStatusChanged();
      void refreshStatus();
    } catch (err) {
      setStopNotice({ ok: false, text: err instanceof Error ? err.message : 'Failed to stop llama-server' });
    } finally {
      setStopping(false);
    }
  };

  // pendingRestart applier (§5 Increment 2): reuses the EXISTING stop→start
  // flows for the CURRENT model key — no auto-restart anywhere.
  const handleRestartApply = async () => {
    const key = status?.modelKey;
    if (starting || stopping || applyingRestart || !key) return;
    setApplyingRestart(true);
    try {
      await handleStop();
      await handleStart(key);
      await refreshStatus();
    } finally {
      if (mountedRef.current) setApplyingRestart(false);
    }
  };

  const handleTestStatus = async () => {
    setTesting(true);
    setStatusError(null);
    try {
      const s = await modelsApi.llamacppStatus();
      setStatus(s);
      fireStatusChanged();
    } catch (err) {
      setStatus(null);
      setStatusError(err instanceof Error ? err.message : 'Could not check llama.cpp status');
    } finally {
      setTesting(false);
    }
  };

  const loadLogs = async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const res = await llamacppApi.logs(LLAMACPP_LOGS_MAX_BYTES);
      setLogs({ text: res.text, truncated: res.truncated });
    } catch (err) {
      setLogs(null);
      setLogsError(err instanceof Error ? err.message : 'Failed to load llama-server logs');
    } finally {
      setLogsLoading(false);
    }
  };

  // --- Derived view data ----------------------------------------------------
  const phase = phaseFromStatus(status);
  const transportBadge = status?.transport === 'direct' ? 'Direct' : status?.transport === 'relay' ? 'Relay' : '—';
  const catalogByKey = useMemo(() => {
    const map = new Map<string, LlamaCppModel>();
    for (const m of catalog) map.set(m.id.replace(/^[^:]*:/, ''), m);
    return map;
  }, [catalog]);

  // Preview target: the recorded launch (running OR last-stopped instance).
  const previewKey = status?.modelKey ?? null;
  const previewMtpCapable = previewKey ? (catalogByKey.get(previewKey)?.mtp_capable ?? null) : null;
  const previewRows = useMemo(
    () => deriveLaunchRows({
      defaults,
      overrides: previewKey ? overrides[previewKey] ?? {} : {},
      modelKey: previewKey,
      mtpCapable: previewMtpCapable,
      mtpActive: status?.mtpActive ?? null,
      preset: presets[activePreset] ?? {},
      presetId: activePreset,
    }),
    [defaults, overrides, previewKey, previewMtpCapable, status?.mtpActive, presets, activePreset]
  );

  const overrideKeys = useMemo(
    () => Array.from(new Set([...Object.keys(overrides), ...catalog.map((m) => m.id.replace(/^[^:]*:/, ''))])),
    [overrides, catalog]
  );
  const activeOverrideRow = overrideKey ? overrides[overrideKey] ?? {} : {};
  // Inherited-value preview for override placeholders (global ⊕ this model's row).
  const mergedOverride = useMemo(
    () => mergeKnobLayers(defaults, activeOverrideRow),
    [defaults, activeOverrideRow]
  );
  const inheritLabel = (key: LlamaCppKnobKey): string => {
    const v = mergedOverride[key];
    return v === undefined ? 'server default' : String(v);
  };

  // §10 Increment 2d: per-model sampling keys (stored rows ∪ catalog), the
  // active row, and the inherited (= global sampling) placeholder values.
  const modelSamplingKeys = useMemo(
    () => Array.from(new Set([...Object.keys(modelSampling), ...catalog.map((m) => m.id.replace(/^[^:]*:/, ''))])),
    [modelSampling, catalog]
  );
  const activeModelSamplingRow: LlamaCppSamplingOverride = modelSamplingKey ? modelSampling[modelSamplingKey] ?? {} : {};
  const inheritedSampling = (key: keyof LlamaCppSampling): string =>
    sampling[key] !== undefined ? String(sampling[key]) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: 'var(--radius-sm)',
          background: `${LLAMACPP_ACCENT}18`,
          border: `1px solid ${LLAMACPP_ACCENT}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: LLAMACPP_ACCENT,
        }}>
          <Terminal size={15} />
        </div>
        <h4 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.1rem',
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}>
          llama.cpp (Local)
        </h4>
      </div>

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        Run models on your own machine through <code>llama-server</code> — free, private, no cloud
        billing. The backend spawns and manages the server through your paired local agent; scanned
        <code> .gguf</code> files appear in the model selector automatically. One model is loaded at
        a time — starting another swaps it.
      </p>

      {/* Paths & port */}
      <Input
        label="llama-server executable path"
        type="text"
        value={exePath}
        onChange={(e) => setExePath(e.target.value)}
        onBlur={() => void commitExePath()}
        placeholder="C:\\llama\\llama-server.exe"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
      />
      <Input
        label="Models directory"
        type="text"
        value={modelsDir}
        onChange={(e) => setModelsDir(e.target.value)}
        onBlur={() => void commitModelsDir()}
        placeholder="C:\\llama\\models"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
      />
      <div style={knobGridStyle()}>
        <Input
          label="Server port"
          type="number"
          min={1024}
          max={65535}
          step={1}
          value={portText}
          onChange={(e) => setPortText(e.target.value)}
          onBlur={() => void commitPort()}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
        />
        <div>
          <Input
            label="Idle unload"
            type="number"
            min={0}
            step={1}
            value={idleMinutesText}
            onChange={(e) => setIdleMinutesText(e.target.value)}
            onBlur={() => void commitIdleMinutes()}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
          />
          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>(minutes, 0 = off)</div>
        </div>
      </div>

      {/* Status */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleTestStatus()}
          loading={testing}
          style={{ alignSelf: 'flex-start' }}
          aria-label="Test llama.cpp status"
        >
          <RefreshCw size={14} />
          Test status
        </Button>

        <div aria-live="polite">
          {statusError && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '10px 14px', background: 'rgba(201, 107, 107, 0.1)',
              border: '1px solid rgba(201, 107, 107, 0.2)', borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem', color: 'var(--error)',
            }}>
              <AlertCircle size={14} />
              {statusError}
            </div>
          )}

          {status && !status.agentConnected && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <AlertCircle size={14} style={{ color: 'var(--state-warning)' }} />
              <span style={{ color: 'var(--state-warning)', fontWeight: 600 }}>Local agent offline.</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Pair and connect the local agent to scan models and run llama-server.
              </span>
            </div>
          )}

          {status?.agentConnected && !status.capabilitySupported && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              display: 'flex', flexDirection: 'column', gap: '4px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertCircle size={14} style={{ color: 'var(--state-warning)' }} />
                <span style={{ color: 'var(--state-warning)', fontWeight: 600 }}>Update the local agent.</span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                The connected agent predates llama.cpp support — update it to enable this provider.
              </span>
            </div>
          )}

          {status?.agentConnected && status.capabilitySupported && !status.running && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(122, 184, 143, 0.06)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              display: 'flex', flexDirection: 'column', gap: '4px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle size={14} style={{ color: 'var(--success)' }} />
                <span>Agent connected — no model loaded.</span>
                <span style={{
                  fontSize: '0.5625rem', padding: '1px 5px', background: `${LLAMACPP_ACCENT}18`,
                  color: LLAMACPP_ACCENT, borderRadius: '4px', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>
                  {transportBadge}
                </span>
                {status.lastExitCode != null && (
                  <span style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    last exit code: {status.lastExitCode}
                  </span>
                )}
              </div>
            </div>
          )}

          {status?.running && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(122, 184, 143, 0.1)',
              border: '1px solid rgba(122, 184, 143, 0.2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              display: 'flex', flexDirection: 'column', gap: '4px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <CheckCircle size={14} style={{ color: 'var(--success)' }} />
                <span style={{ fontWeight: 600, color: 'var(--success)' }}>Running</span>
                <span style={{
                  fontSize: '0.5625rem', padding: '1px 5px', background: `${LLAMACPP_ACCENT}18`,
                  color: LLAMACPP_ACCENT, borderRadius: '4px', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>
                  {transportBadge}
                </span>
                {status.modelKey && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                    {status.modelKey}
                  </span>
                )}
                {status.pid != null && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                    pid {status.pid}{status.port != null ? ` · port ${status.port}` : ''}
                  </span>
                )}
                {status.mtpActive && (
                  <span style={{
                    fontSize: '0.5625rem', padding: '1px 5px', background: 'var(--accent-soft)',
                    color: 'var(--accent)', borderRadius: '4px', fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.04em',
                  }}>
                    MTP active
                  </span>
                )}
              </div>
              {status.healthy === false && (
                <div style={{ fontSize: '0.6875rem', color: 'var(--state-warning)' }}>
                  Process is up but /health has not answered yet…
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Start / Stop */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Model control
        </span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={effectiveStartKey}
            onChange={(e) => setStartKey(e.target.value)}
            disabled={starting || catalog.length === 0}
            aria-label="Model to start"
            style={{
              flex: '1 1 240px',
              maxWidth: '360px',
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
            }}
          >
            {catalog.length === 0 && <option value="">No scanned models</option>}
            {catalog.map((m) => (
              <option key={m.id} value={m.id.replace(/^[^:]*:/, '')}>
                {m.id.replace(/^[^:]*:/, '')}{m.loaded ? ' (loaded)' : ''}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleStart()}
            loading={starting}
            disabled={!effectiveStartKey || (!!status?.running && status.modelKey === effectiveStartKey)}
            aria-label="Start model"
          >
            <Play size={13} />
            Start model
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleStop()}
            loading={stopping}
            disabled={!status?.running}
            aria-label="Stop model"
            title="Stop model"
          >
            <Square size={13} />
            Stop model
          </Button>
          {status?.running && status.pendingRestart && !starting && !stopping && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 6px 4px 10px',
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
              color: 'var(--state-warning)',
              fontWeight: 600,
            }}>
              <AlertTriangle size={13} />
              Reiniciar para aplicar cambios
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleRestartApply()}
                loading={applyingRestart}
                disabled={starting || stopping || applyingRestart || status.modelKey == null}
                aria-label="Restart model to apply changes"
              >
                <RefreshCw size={13} />
                Reiniciar ahora
              </Button>
            </span>
          )}
        </div>

        <div aria-live="polite">
          {starting && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ textTransform: 'capitalize' }}>{phase}</span>
              · waiting for /health… ({elapsedSec}s elapsed — first load can take over a minute)
            </div>
          )}
          {startNotice && !starting && (
            <div style={{ fontSize: '0.75rem', color: startNotice.ok ? 'var(--success)' : 'var(--error)', display: 'flex', gap: 6, alignItems: 'center' }}>
              {startNotice.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}
              {startNotice.text}
            </div>
          )}
          {stopNotice && (
            <div style={{ fontSize: '0.75rem', color: stopNotice.ok ? 'var(--success)' : 'var(--error)', display: 'flex', gap: 6, alignItems: 'center' }}>
              {stopNotice.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}
              {stopNotice.text}
            </div>
          )}
        </div>
      </div>

      {/* Launch-config preview (D6/D7) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Launch configuration
        </span>
        {previewKey && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {status?.running ? 'Currently running' : 'Last launched'}:{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{previewKey}</span>
          </div>
        )}
        <pre
          style={{
            margin: 0,
            padding: '10px 12px',
            background: 'var(--bg-base)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: 'var(--text-secondary)',
          }}
        >
          {formatArgvLine(status?.argv)}
        </pre>
        {!status?.argv && (
          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            No launch recorded yet — start a model to capture the exact command line.
            The table below shows the planned knobs and where each value comes from.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {previewRows.map((row) => (
            <div
              key={row.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
                padding: '6px 10px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.75rem',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', minWidth: 130 }}>
                {row.flag ?? '(omitted)'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: row.origin === 'inert' ? 'var(--text-muted)' : 'var(--accent)' }}>
                {row.origin === 'inert' ? '—' : row.value}
              </span>
              <span style={{
                marginLeft: 'auto',
                fontSize: '0.5625rem',
                padding: '1px 5px',
                background: row.origin === 'inert' ? 'rgba(245, 158, 11, 0.12)' : 'var(--accent-soft)',
                color: row.origin === 'inert' ? 'var(--state-warning)' : 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                fontWeight: 600,
                letterSpacing: '0.04em',
                flexShrink: 0,
              }}>
                {row.origin === 'inert'
                  ? `inert — ${row.inertReason === 'requires-parallel-1' ? 'requires parallel_slots = 1' : 'model file is not an MTP build'}`
                  : row.origin}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Presets (§3 Increment 2): three editable cards + active pointer.
          Titles/usage copy pinned EXACTLY by §10; clicking a card persists the
          pointer immediately via POST /config { activePreset }. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Presets
        </span>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Pick how much thinking budget each profile gets. Click a card to make it active —
          the choice applies on the next start. Expand a card to edit its own knobs.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '10px' }}>
          {LLAMACPP_PRESET_META.map((meta) => {
            const slot = presets[meta.id] ?? {};
            const budget = typeof slot.reasoning_budget === 'number' ? slot.reasoning_budget : 0;
            const mtp = typeof slot.mtp === 'number' ? slot.mtp : 0;
            const unlimited = budget === -1;
            const isActive = activePreset === meta.id;
            const isExpanded = expandedPreset === meta.id;
            return (
              <div
                key={meta.id}
                role="button"
                tabIndex={0}
                onClick={() => void selectPreset(meta.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void selectPreset(meta.id);
                  }
                }}
                aria-pressed={isActive}
                aria-label={`${meta.label} preset`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${isActive ? LLAMACPP_ACCENT : 'var(--border)'}`,
                  background: isActive ? `${LLAMACPP_ACCENT}12` : 'var(--bg-elevated)',
                  boxShadow: isActive ? `0 0 0 1px ${LLAMACPP_ACCENT}40` : 'none',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    fontWeight: 600,
                    fontSize: '0.8125rem',
                    letterSpacing: '0.04em',
                    color: isActive ? LLAMACPP_ACCENT : 'var(--text-primary)',
                  }}>
                    {meta.label}
                  </span>
                  {isActive && (
                    <span style={{
                      fontSize: '0.5625rem', padding: '1px 5px',
                      background: `${LLAMACPP_ACCENT}18`, color: LLAMACPP_ACCENT,
                      borderRadius: '4px', fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                      Active
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedPreset(isExpanded ? null : meta.id);
                    }}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? `Collapse ${meta.label} editor` : `Expand ${meta.label} editor`}
                    style={{
                      marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', padding: '2px', display: 'flex', alignItems: 'center',
                    }}
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {meta.usage}
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: '0.6875rem',
                  color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px',
                }}>
                  <span>budget {formatReasoningBudget(budget)}</span>
                  <span>·</span>
                  <span>MTP {mtp > 0 ? 'on' : 'off'}</span>
                </div>
                {isExpanded && (
                  <div
                    style={{
                      display: 'flex', flexDirection: 'column', gap: '8px',
                      paddingTop: '8px', borderTop: '1px solid var(--border)', cursor: 'default',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Input
                      label="Reasoning budget"
                      type="number"
                      min={0}
                      step={1}
                      disabled={unlimited}
                      value={String(unlimited ? '' : budget)}
                      placeholder={unlimited ? '∞ ilimitado' : undefined}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) {
                          updatePresetSlot(meta.id, 'reasoning_budget', n);
                        }
                      }}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
                    />
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                      fontSize: '0.75rem', color: 'var(--text-primary)',
                    }}>
                      <input
                        type="checkbox"
                        checked={unlimited}
                        onChange={(e) =>
                          updatePresetSlot(meta.id, 'reasoning_budget', e.target.checked ? -1 : LLAMACPP_CANONICAL_PRESETS[meta.id].reasoning_budget ?? 0)}
                        style={{ width: '15px', height: '15px', accentColor: 'var(--accent)' }}
                        aria-label={`Unlimited reasoning budget for ${meta.label}`}
                      />
                      <span>∞ ilimitado ({formatReasoningBudget(-1)})</span>
                    </label>
                    <div>
                      <label className="form-field-label">MTP draft tokens</label>
                      <select
                        value={String(mtp)}
                        onChange={(e) => updatePresetSlot(meta.id, 'mtp', Number(e.target.value))}
                        aria-label={`MTP draft tokens for ${meta.label}`}
                        style={{
                          width: '100%',
                          padding: '7px 10px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border)',
                          background: 'var(--bg-surface)',
                          color: 'var(--text-primary)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.8125rem',
                        }}
                      >
                        <option value="0">Off (0)</option>
                        <option value="2">On (2)</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" onClick={() => void savePresets()} loading={presetsSaving}>
            Guardar presets
          </Button>
          {presetsNotice && (
            <span style={{ fontSize: '0.75rem', color: presetsNotice.ok ? 'var(--success)' : 'var(--error)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {presetsNotice.ok ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
              {presetsNotice.text}
            </span>
          )}
        </div>
      </div>

      {/* Sampling row editor (§3 Increment 2) — independent of presets; rides
          the request body on every llamacpp call (chat and council alike). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Sampling
        </span>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Sampler values injected into every llama.cpp request — shared by all presets.
          Applies on the next start.
        </div>
        <div style={knobGridStyle()}>
          {SAMPLING_FIELDS.map(({ key, label }) => (
            <Input
              key={key}
              label={label}
              type="number"
              min={LLAMACPP_SAMPLING_BOUNDS[key].min}
              max={LLAMACPP_SAMPLING_BOUNDS[key].max}
              step={LLAMACPP_SAMPLING_BOUNDS[key].integer ? 1 : 0.01}
              error={samplingErrors[key]}
              value={String(sampling[key])}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return; // half-typed numbers are ignored
                setSampling((prev) => ({ ...prev, [key]: n }));
                setSamplingErrors((prev) => {
                  const next = { ...prev };
                  const invalid = samplingValidationError(key, n);
                  if (invalid) next[key] = invalid;
                  else delete next[key];
                  return next;
                });
              }}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
            />
          ))}
          {/* §10 Increment 2d — OPTIONAL: blank = unset = never sent. */}
          <Input
            label="presence_penalty"
            type="number"
            min={LLAMACPP_SAMPLING_BOUNDS.presence_penalty.min}
            max={LLAMACPP_SAMPLING_BOUNDS.presence_penalty.max}
            step={0.01}
            placeholder="(vacío = no se envía)"
            error={samplingErrors.presence_penalty}
            value={sampling.presence_penalty !== undefined ? String(sampling.presence_penalty) : ''}
            onChange={(e) => updateOptionalSampling('presence_penalty', e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" onClick={() => void saveSampling()} loading={samplingSaving}>
            Save sampling
          </Button>
          {samplingNotice && (
            <span style={{ fontSize: '0.75rem', color: samplingNotice.ok ? 'var(--success)' : 'var(--error)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {samplingNotice.ok ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
              {samplingNotice.text}
            </span>
          )}
        </div>
      </div>

      {/* Sampling por modelo (§10 Increment 2d) — compact per-key editor over
          the llamacpp_model_sampling row; blank fields inherit the global
          Sampling above and are omitted from the request body. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Sampling por modelo
        </span>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Ajusta el sampler de un modelo concreto (p. ej. temp 1.0 + presence_penalty 1.5 para un modelo
          tuneado) sin tocar los valores del resto. Los campos vacíos heredan el Sampling global.
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={modelSamplingKey}
            onChange={(e) => setModelSamplingKey(e.target.value)}
            aria-label="Modelo para sampling por modelo"
            style={{
              flex: '1 1 260px',
              maxWidth: '380px',
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
            }}
          >
            <option value="">Selecciona un modelo…</option>
            {modelSamplingKeys.map((k) => (
              <option key={k} value={k}>{k}{modelSampling[k] ? ' ●' : ''}</option>
            ))}
          </select>
          {modelSamplingKey && modelSampling[modelSamplingKey] && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => removeModelSamplingRow(modelSamplingKey)}
              aria-label={`Eliminar sampling por modelo de ${modelSamplingKey}`}
            >
              Eliminar fila
            </Button>
          )}
        </div>
        {modelSamplingKey && (
          <div style={knobGridStyle()}>
            {MODEL_SAMPLING_FIELDS.map(({ key, label }) => (
              <Input
                key={key}
                label={label}
                type="number"
                min={LLAMACPP_SAMPLING_BOUNDS[key].min}
                max={LLAMACPP_SAMPLING_BOUNDS[key].max}
                step={LLAMACPP_SAMPLING_BOUNDS[key].integer ? 1 : 0.01}
                placeholder={`hereda: ${inheritedSampling(key)}`}
                error={modelSamplingErrors[modelSamplingKey]?.[key]}
                value={activeModelSamplingRow[key] !== undefined ? String(activeModelSamplingRow[key]) : ''}
                onChange={(e) => updateModelSampling(modelSamplingKey, key, e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
              />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" onClick={() => void saveModelSampling()} loading={modelSamplingSaving}>
            Guardar sampling por modelo
          </Button>
          {modelSamplingNotice && (
            <span style={{ fontSize: '0.75rem', color: modelSamplingNotice.ok ? 'var(--success)' : 'var(--error)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {modelSamplingNotice.ok ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
              {modelSamplingNotice.text}
            </span>
          )}
        </div>
      </div>

      {/* Global knob defaults */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Default launch knobs
        </span>
        <div style={knobGridStyle()}>
          {NUM_KNOBS.map(({ key, label, min, max }) => (
            <Input
              key={key}
              label={label}
              type="number"
              min={min}
              max={max}
              step={1}
              value={String(defaults[key])}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) updateDefault(key, n);
              }}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
            />
          ))}
          {OPTIONAL_NUMERIC_KNOBS.map(({ key, label }) => (
            <Input
              key={key}
              label={label}
              type="number"
              min={1}
              step={1}
              placeholder="(blank = server default)"
              value={defaults[key] !== undefined ? String(defaults[key]) : ''}
              onChange={(e) => updateOptionalNumberDefault(key, e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
            />
          ))}
          <div>
            <label className="form-field-label">Reasoning budget</label>
            <select
              value={String(defaults.reasoning_budget)}
              onChange={(e) => updateDefault('reasoning_budget', Number(e.target.value))}
              aria-label="Reasoning budget (-1 = unrestricted)"
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8125rem',
              }}
            >
              {REASONING_BUDGET_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v === -1 ? '-1 (unlimited)' : v === 0 ? '0 (thinking off)' : v}
                </option>
              ))}
            </select>
          </div>
          {(['cache_type_k', 'cache_type_v'] as const).map((key) => (
            <div key={key}>
              <label className="form-field-label">{key === 'cache_type_k' ? 'KV cache K type' : 'KV cache V type'}</label>
              <select
                value={defaults[key]}
                onChange={(e) => updateDefault(key, e.target.value)}
                aria-label={`Default ${key}`}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                }}
              >
                {LLAMACPP_CACHE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          ))}
          <div>
            <label className="form-field-label">Device</label>
            <select
              value={defaults.device}
              onChange={(e) => updateDefault('device', e.target.value === 'cuda' ? 'cuda' : 'cpu')}
              aria-label="Default device"
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8125rem',
              }}
            >
              <option value="cuda">CUDA</option>
              <option value="cpu">CPU</option>
            </select>
          </div>
          <div>
            <label className="form-field-label">Reasoning format</label>
            <select
              value={defaults.reasoning_format ?? ''}
              onChange={(e) => updateDefaultReasoningFormat(e.target.value)}
              aria-label="Default reasoning format"
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8125rem',
              }}
            >
              <option value="">(server default)</option>
              {LLAMACPP_REASONING_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
              unset / auto = llama-server default
            </div>
          </div>
          <div>
            <label className="form-field-label">Flash attention</label>
            <select
              value={defaults.flash_attn}
              onChange={(e) => updateDefault('flash_attn', e.target.value)}
              aria-label="Default flash attention"
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8125rem',
              }}
            >
              {['on', 'off', 'auto'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <Input
            label="GPU layers ('all' | 'auto' | N)"
            type="text"
            value={defaults.gpu_layers}
            onChange={(e) => updateDefault('gpu_layers', e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
          />
          <label
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
              fontSize: '0.8125rem', color: 'var(--text-primary)', marginTop: '22px',
            }}
          >
            <input
              type="checkbox"
              checked={defaults.mmap}
              onChange={(e) => updateDefault('mmap', e.target.checked)}
              style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
              aria-label="Use mmap load mode by default"
            />
            <span>mmap load mode</span>
          </label>
        </div>
      </div>

      {/* Per-model overrides */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{
          fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Per-model overrides
        </span>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Pick a model and override only the knobs that differ — empty fields inherit the global
          defaults above. Overrides apply on the next start of that model.
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={overrideKey}
            onChange={(e) => setOverrideKey(e.target.value)}
            aria-label="Model to override"
            style={{
              flex: '1 1 260px',
              maxWidth: '380px',
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
            }}
          >
            <option value="">Select a model…</option>
            {overrideKeys.map((k) => (
              <option key={k} value={k}>{k}{overrides[k] ? ' ●' : ''}</option>
            ))}
          </select>
          {overrideKey && overrides[overrideKey] && (
            <Button variant="secondary" size="sm" onClick={() => removeOverrideRow(overrideKey)} aria-label={`Remove all overrides for ${overrideKey}`}>
              Remove overrides
            </Button>
          )}
        </div>
        {overrideKey && (
          <div style={knobGridStyle()}>
            {NUM_KNOBS.map(({ key, label, min, max }) => (
              <Input
                key={key}
                label={label}
                type="number"
                min={min}
                max={max}
                step={1}
                placeholder={`inherit: ${mergeKnobLayers(defaults, activeOverrideRow)[key]}`}
                value={activeOverrideRow[key] !== undefined ? String(activeOverrideRow[key]) : ''}
                onChange={(e) => updateOverride(overrideKey, key, e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
              />
            ))}
            {OPTIONAL_NUMERIC_KNOBS.map(({ key, label }) => (
              <Input
                key={key}
                label={label}
                type="number"
                min={1}
                step={1}
                placeholder={`inherit: ${inheritLabel(key)}`}
                value={activeOverrideRow[key] !== undefined ? String(activeOverrideRow[key]) : ''}
                onChange={(e) => updateOverride(overrideKey, key, e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
              />
            ))}
            <div>
              <label className="form-field-label">Reasoning budget</label>
              <select
                value={activeOverrideRow.reasoning_budget !== undefined ? String(activeOverrideRow.reasoning_budget) : ''}
                onChange={(e) => updateOverride(overrideKey, 'reasoning_budget', e.target.value)}
                aria-label={`Override reasoning budget for ${overrideKey}`}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                }}
              >
                <option value="">inherit ({mergeKnobLayers(defaults, activeOverrideRow).reasoning_budget})</option>
                {REASONING_BUDGET_OPTIONS.map((v) => (
                  <option key={v} value={v}>{v === -1 ? '-1 (unlimited)' : v}</option>
                ))}
              </select>
            </div>
            {(['cache_type_k', 'cache_type_v'] as const).map((key) => (
              <div key={key}>
                <label className="form-field-label">{key === 'cache_type_k' ? 'KV cache K type' : 'KV cache V type'}</label>
                <select
                  value={activeOverrideRow[key] ?? ''}
                  onChange={(e) => updateOverride(overrideKey, key, e.target.value)}
                  aria-label={`Override ${key}`}
                  style={{
                    width: '100%',
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8125rem',
                  }}
                >
                  <option value="">inherit ({mergeKnobLayers(defaults, activeOverrideRow)[key]})</option>
                  {LLAMACPP_CACHE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            ))}
            <div>
              <label className="form-field-label">Device</label>
              <select
                value={activeOverrideRow.device ?? ''}
                onChange={(e) => updateOverride(overrideKey, 'device', e.target.value)}
                aria-label="Override device"
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                }}
              >
                <option value="">inherit</option>
                <option value="cuda">CUDA</option>
                <option value="cpu">CPU</option>
              </select>
            </div>
            <div>
              <label className="form-field-label">Flash attention</label>
              <select
                value={activeOverrideRow.flash_attn ?? ''}
                onChange={(e) => updateOverride(overrideKey, 'flash_attn', e.target.value)}
                aria-label="Override flash attention"
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                }}
              >
                <option value="">inherit</option>
                {['on', 'off', 'auto'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="form-field-label">Reasoning format</label>
              <select
                value={activeOverrideRow.reasoning_format ?? ''}
                onChange={(e) => updateOverride(overrideKey, 'reasoning_format', e.target.value)}
                aria-label={`Override reasoning format for ${overrideKey}`}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                }}
              >
                <option value="">inherit ({inheritLabel('reasoning_format')})</option>
                {LLAMACPP_REASONING_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <Input
              label="GPU layers override"
              type="text"
              placeholder={`inherit: ${mergeKnobLayers(defaults, activeOverrideRow).gpu_layers}`}
              value={activeOverrideRow.gpu_layers ?? ''}
              onChange={(e) => updateOverride(overrideKey, 'gpu_layers', e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
            />
            <div>
              <label className="form-field-label">mmap</label>
              <select
                value={activeOverrideRow.mmap !== undefined ? (activeOverrideRow.mmap ? 'true' : 'false') : ''}
                onChange={(e) => updateOverride(overrideKey, 'mmap', e.target.value)}
                aria-label="Override mmap load mode"
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                }}
              >
                <option value="">inherit</option>
                <option value="true">mmap</option>
                <option value="false">none (RAM load)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Save knobs */}
      <div className="settings-provider-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void saveKnobs()}
          loading={knobsSaving}
        >
          <ScrollText size={13} />
          Save launch configuration
        </Button>
        {knobsNotice && (
          <span style={{ fontSize: '0.75rem', color: knobsNotice.ok ? 'var(--success)' : 'var(--error)' }}>
            {knobsNotice.ok ? <CheckCircle size={12} style={{ verticalAlign: -2 }} /> : <AlertTriangle size={12} style={{ verticalAlign: -2 }} />}{' '}
            {knobsNotice.text}
          </span>
        )}
      </div>

      {/* Bounded log viewer */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadLogs()}
            loading={logsLoading}
            disabled={!status?.running && !status?.argv}
            aria-label="View llama-server logs"
          >
            <ScrollText size={13} />
            View logs
          </Button>
          {logs?.truncated && (
            <span style={{
              fontSize: '0.5625rem', padding: '1px 5px', background: 'rgba(245, 158, 11, 0.12)',
              color: 'var(--state-warning)', borderRadius: '4px', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>
              Truncated
            </span>
          )}
          {logs && (
            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
              last {LLAMACPP_LOGS_MAX_BYTES / 1024} KiB of merged stdout+stderr
            </span>
          )}
        </div>
        {logsError && (
          <div style={{ fontSize: '0.75rem', color: 'var(--error)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <AlertCircle size={13} />
            {logsError}
          </div>
        )}
        {logs && (
          <pre
            style={{
              margin: 0,
              maxHeight: '240px',
              overflow: 'auto',
              padding: '10px 12px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-secondary)',
            }}
          >
            {logs.text || '(no output captured)'}
          </pre>
        )}
      </div>
    </div>
  );
}
