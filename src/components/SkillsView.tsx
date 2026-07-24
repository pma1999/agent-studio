import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Layers,
  Pencil,
  Trash2,
  Upload,
  FileText,
  FilePlus,
  Eye,
  X,
  Loader2,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import {
  skillsApi,
  type SkillCreatePayload,
  type SkillResourceEntry,
  type SkillParsePreviewResult,
} from '../api/client';
import type { Skill } from '../types';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { TextArea } from './ui/TextArea';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';
import { IconButton } from './ui/IconButton';
import { Segmented } from './ui/Segmented';
import { PremiumToggle } from './ui/PremiumToggle';
import { EmptyState } from './EmptyState';
import { useIsMobile } from '../utils/breakpoints';

type EntryMode = 'fields' | 'raw';
type SkillFieldsPayload = Extract<SkillCreatePayload, { name: string }>;

interface MetadataRow {
  key: string;
  value: string;
}

interface SkillFormState {
  name: string;
  description: string;
  body: string;
  license: string;
  compatibility: string;
  allowed_tools: string;
  metadata: MetadataRow[];
  disable_model_invocation: boolean;
}

type Notice = { type: 'success' | 'warning' | 'error'; text: string };

type PreviewState =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'error'; message: string };

const DESCRIPTION_TRUNCATE_LENGTH = 120;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function emptyForm(): SkillFormState {
  return {
    name: '',
    description: '',
    body: '',
    license: '',
    compatibility: '',
    allowed_tools: '',
    metadata: [],
    disable_model_invocation: false,
  };
}

function formFromSkill(skill: Skill): SkillFormState {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    license: skill.license ?? '',
    compatibility: skill.compatibility ?? '',
    allowed_tools: skill.allowed_tools ?? '',
    metadata: skill.metadata ? Object.entries(skill.metadata).map(([key, value]) => ({ key, value })) : [],
    disable_model_invocation: !!skill.disable_model_invocation,
  };
}

function buildFieldsPayload(form: SkillFormState): SkillFieldsPayload {
  const metadata: Record<string, string> = {};
  for (const row of form.metadata) {
    const key = row.key.trim();
    if (key) metadata[key] = row.value;
  }
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    body: form.body,
    license: form.license.trim() || undefined,
    compatibility: form.compatibility.trim() || undefined,
    allowed_tools: form.allowed_tools.trim() || undefined,
    metadata: Object.keys(metadata).length ? metadata : undefined,
    // Always sent explicitly (never elided to `undefined` like the string fields above):
    // this is a two-state toggle a user must be able to flip back off on an *update*, and
    // eliding `false` would omit the key entirely, silently leaving a previously-on flag
    // untouched under a tools.ts-style partial-merge PUT. Explicit `false` is a no-op on
    // create (DB column already defaults to 0).
    disable_model_invocation: form.disable_model_invocation,
  };
}

/**
 * Best-effort guard against rendering garbled/binary content in the resource preview
 * panel. The backend response shape doesn't distinguish text from binary, so this is a
 * cheap heuristic on the frontend — not real binary detection (see task brief's Named
 * Risks: don't over-invest here, just degrade gracefully).
 */
function looksBinary(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 2000);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) suspicious++;
  }
  return suspicious / sample.length > 0.02;
}

/**
 * Resource-file count badge for a list row. Fetched only when the user clicks it —
 * never eagerly for every row when the list loads (that would be unnecessary I/O for a
 * screen the user is just scanning).
 */
function ResourceCountBadge({ skillId }: { skillId: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (loading || count !== null) return;
    setLoading(true);
    try {
      const resources = await skillsApi.listResources(skillId);
      setCount(resources.length);
    } catch {
      setCount(0);
    } finally {
      setLoading(false);
    }
  };

  if (count !== null) {
    return (
      <Badge tone="neutral">
        <FileText size={11} />
        {count} file{count === 1 ? '' : 's'}
      </Badge>
    );
  }

  return (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 10px',
        borderRadius: 'var(--radius-pill)',
        border: '1px solid var(--border)',
        background: 'transparent',
        color: 'var(--text-muted)',
        fontSize: '0.6875rem',
        cursor: loading ? 'default' : 'pointer',
      }}
    >
      {loading ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
      {loading ? 'Loading…' : 'Show files'}
    </button>
  );
}

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const isMobile = useIsMobile();

  // Create/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [entryMode, setEntryMode] = useState<EntryMode>('fields');
  const [form, setForm] = useState<SkillFormState>(emptyForm());
  const [rawText, setRawText] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<SkillParsePreviewResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Resource files (edit mode only)
  const [resources, setResources] = useState<SkillResourceEntry[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const resourceFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingResourceFile, setPendingResourceFile] = useState<File | null>(null);
  const [pendingResourcePath, setPendingResourcePath] = useState('');
  const [addingResource, setAddingResource] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewContent, setPreviewContent] = useState<PreviewState | null>(null);

  // Zip import
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const loadSkills = async () => {
    setLoading(true);
    try {
      const list = await skillsApi.list();
      setSkills(list);
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const resetModalState = () => {
    setEntryMode('fields');
    setForm(emptyForm());
    setRawText('');
    setValidationResult(null);
    setSubmitError(null);
    setResources([]);
    setPendingResourceFile(null);
    setPendingResourcePath('');
    setPreviewPath(null);
    setPreviewContent(null);
  };

  const openCreate = () => {
    setEditingSkill(null);
    resetModalState();
    setModalOpen(true);
  };

  const openEdit = async (skill: Skill) => {
    setEditingSkill(skill);
    resetModalState();
    // Prefill instantly from the list row so the modal never opens blank, then refine
    // with the authoritative `get(id)` response once it lands (list rows are typed as
    // full `Skill` objects today, but re-populating from `get(id)` is a cheap guard
    // against a future list endpoint that trims heavy fields like `body`).
    setForm(formFromSkill(skill));
    setModalOpen(true);
    setResourcesLoading(true);
    try {
      const full = await skillsApi.get(skill.id);
      setForm(formFromSkill(full));
      setResources(full.resources);
    } catch (err) {
      console.error('Failed to load skill resources:', err);
    } finally {
      setResourcesLoading(false);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingSkill(null);
  };

  const buildPayload = (): SkillCreatePayload =>
    entryMode === 'raw' ? { raw_skill_md: rawText } : buildFieldsPayload(form);

  const handleValidate = async () => {
    setValidating(true);
    try {
      const result = await skillsApi.parsePreview(buildPayload());
      setValidationResult(result);
    } catch (err) {
      setValidationResult({
        valid: false,
        errors: [err instanceof Error ? err.message : 'Validation failed'],
        warnings: [],
      });
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSubmitError(null);
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editingSkill) {
        await skillsApi.update(editingSkill.id, payload);
      } else {
        const result = await skillsApi.create(payload);
        if (result.warnings.length) {
          setNotice({ type: 'warning', text: result.warnings.join(' ') });
        }
      }
      await loadSkills();
      closeModal();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (skill: Skill) => {
    if (!confirm(`Delete skill "${skill.name}"? It will be unassigned from all agents.`)) return;
    try {
      await skillsApi.delete(skill.id);
      await loadSkills();
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  };

  const handleZipChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setNotice(null);
    try {
      const bytes = await file.arrayBuffer();
      const result = await skillsApi.importZip(bytes);
      await loadSkills();
      if (result.warnings.length) {
        setNotice({ type: 'warning', text: result.warnings.join(' ') });
      } else {
        setNotice({ type: 'success', text: `Imported "${result.skill.name}"` });
      }
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  // Metadata rows
  const addMetadataRow = () => setForm((f) => ({ ...f, metadata: [...f.metadata, { key: '', value: '' }] }));
  const updateMetadataRow = (idx: number, field: 'key' | 'value', value: string) =>
    setForm((f) => ({ ...f, metadata: f.metadata.map((row, i) => (i === idx ? { ...row, [field]: value } : row)) }));
  const removeMetadataRow = (idx: number) =>
    setForm((f) => ({ ...f, metadata: f.metadata.filter((_, i) => i !== idx) }));

  // Resource files
  const refreshResources = async () => {
    if (!editingSkill) return;
    try {
      const list = await skillsApi.listResources(editingSkill.id);
      setResources(list);
    } catch (err) {
      console.error('Failed to refresh resource list:', err);
    }
  };

  const handleAddResourceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPendingResourceFile(file);
    setPendingResourcePath(file.name);
  };

  const confirmAddResource = async () => {
    if (!editingSkill || !pendingResourceFile || !pendingResourcePath.trim()) return;
    setAddingResource(true);
    try {
      const bytes = await pendingResourceFile.arrayBuffer();
      await skillsApi.addResource(editingSkill.id, pendingResourcePath.trim(), bytes);
      setPendingResourceFile(null);
      setPendingResourcePath('');
      await refreshResources();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to add resource file');
    } finally {
      setAddingResource(false);
    }
  };

  const cancelAddResource = () => {
    setPendingResourceFile(null);
    setPendingResourcePath('');
  };

  const handleDeleteResource = async (path: string) => {
    if (!editingSkill) return;
    setDeletingPath(path);
    try {
      await skillsApi.deleteResource(editingSkill.id, path);
      if (previewPath === path) {
        setPreviewPath(null);
        setPreviewContent(null);
      }
      await refreshResources();
    } catch (err) {
      console.error('Failed to delete resource file:', err);
    } finally {
      setDeletingPath(null);
    }
  };

  const handlePreviewResource = async (path: string) => {
    if (!editingSkill) return;
    setPreviewPath(path);
    setPreviewContent(null);
    setPreviewLoading(true);
    try {
      const res = await skillsApi.getResourceContent(editingSkill.id, path);
      // The backend explicitly flags binary files (`binary: true`, `content: null`) —
      // trust that signal first, falling back to the `looksBinary` heuristic only when
      // the backend doesn't set it (e.g. `content` present but still garbled/non-UTF8).
      // `content ?? ''` guards `looksBinary`'s own `!text` early-return, which would
      // otherwise treat a `null` (binary) response as "not binary".
      setPreviewContent(
        res.binary || looksBinary(res.content ?? '')
          ? { kind: 'binary' }
          : { kind: 'text', text: res.content ?? '', truncated: res.truncated }
      );
    } catch (err) {
      setPreviewContent({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load file' });
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewPath(null);
    setPreviewContent(null);
  };

  if (loading && skills.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading skills...
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--content-padding-y) var(--content-padding-x)',
      overflowY: 'auto',
      height: '100%',
    }}>
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 'var(--section-gap)',
        gap: isMobile ? '16px' : 0,
      }}>
        <div>
          <motion.h1
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--heading-1-size)',
              fontWeight: 500,
              color: 'var(--text-primary)',
              marginBottom: '6px',
            }}
          >
            Skills
          </motion.h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
            Package step-by-step instructions and files an agent can pull in when a task calls for them.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            onChange={handleZipChange}
            style={{ display: 'none' }}
            aria-hidden
          />
          <Button
            variant="ghost"
            icon={importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            onClick={() => zipInputRef.current?.click()}
            disabled={importing}
            style={{ border: '1px solid var(--border)' }}
          >
            {importing ? 'Importing…' : 'Import .zip'}
          </Button>
          <Button onClick={openCreate} icon={<Plus size={16} />}>
            New Skill
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              padding: '10px 14px',
              marginBottom: '16px',
              borderRadius: 'var(--radius-sm)',
              background: notice.type === 'error' ? 'var(--state-danger-soft)' : notice.type === 'warning' ? 'var(--state-warning-soft)' : 'var(--state-success-soft)',
              color: notice.type === 'error' ? 'var(--error)' : notice.type === 'warning' ? 'var(--warning)' : 'var(--success)',
              fontSize: '0.8rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {notice.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
              <span>{notice.text}</span>
            </div>
            <IconButton label="Dismiss" size="sm" onClick={() => setNotice(null)}>
              <X size={14} />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>

      {skills.length === 0 && !loading ? (
        <EmptyState
          icon={<Layers size={32} />}
          title="No skills yet"
          description="Skills package step-by-step instructions — plus any reference files or scripts — that an agent can pull in when a task calls for them. Create one from scratch or import a SKILL.md bundle."
          action={
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <Button variant="secondary" icon={<Upload size={16} />} onClick={() => zipInputRef.current?.click()}>
                Import .zip
              </Button>
              <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>
                New Skill
              </Button>
            </div>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {skills.map((skill, i) => (
            <motion.div
              key={skill.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '14px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}
            >
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--accent-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Layers size={18} style={{ color: 'var(--accent)' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
                  {skill.name}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {truncate(skill.description, DESCRIPTION_TRUNCATE_LENGTH)}
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
                  <Badge tone={skill.disable_model_invocation ? 'neutral' : 'accent'}>
                    Model auto-activation: {skill.disable_model_invocation ? 'Off' : 'On'}
                  </Badge>
                  <ResourceCountBadge skillId={skill.id} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <IconButton label="Edit skill" onClick={() => openEdit(skill)}>
                  <Pencil size={16} />
                </IconButton>
                <IconButton label="Delete skill" variant="danger" onClick={() => handleDelete(skill)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editingSkill ? 'Edit Skill' : 'New Skill'}
        maxWidth="640px"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Segmented
            ariaLabel="Skill entry mode"
            value={entryMode}
            onChange={(value) => setEntryMode(value)}
            options={[
              { value: 'fields', label: 'Fields' },
              { value: 'raw', label: 'Paste SKILL.md' },
            ]}
          />

          {entryMode === 'fields' ? (
            <>
              <div>
                <Input
                  label="Name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. pdf-form-filler"
                  disabled={!!editingSkill}
                />
                <p className="form-field-hint">
                  {editingSkill
                    ? "Skill names can't be changed after creation."
                    : 'Lowercase letters, numbers, and hyphens only — no leading/trailing or double hyphens.'}
                </p>
              </div>
              <TextArea
                label="Description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                placeholder="When the model should reach for this skill..."
              />
              <TextArea
                label="Instructions"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={10}
                placeholder="The Markdown the model receives once this skill activates..."
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
              />
              <Input
                label="License (optional)"
                value={form.license}
                onChange={(e) => setForm((f) => ({ ...f, license: e.target.value }))}
              />
              <div>
                <Input
                  label="Compatibility (optional)"
                  value={form.compatibility}
                  onChange={(e) => setForm((f) => ({ ...f, compatibility: e.target.value }))}
                  placeholder='e.g. "Requires Python 3.14+"'
                />
                <p className="form-field-hint">Informational only — not checked or enforced by this app.</p>
              </div>
              <div>
                <Input
                  label="Allowed tools (optional)"
                  value={form.allowed_tools}
                  onChange={(e) => setForm((f) => ({ ...f, allowed_tools: e.target.value }))}
                  placeholder="e.g. read_file write_file"
                />
                <p className="form-field-hint">
                  Advisory only — space-separated tool-name patterns from the spec. Experimental; this app doesn't enforce it.
                </p>
              </div>
              <div>
                <label className="form-field-label" style={{ display: 'block', marginBottom: '8px' }}>Metadata (optional)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {form.metadata.map((row, idx) => (
                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px', alignItems: 'center' }}>
                      <Input
                        placeholder="key"
                        value={row.key}
                        onChange={(e) => updateMetadataRow(idx, 'key', e.target.value)}
                      />
                      <Input
                        placeholder="value"
                        value={row.value}
                        onChange={(e) => updateMetadataRow(idx, 'value', e.target.value)}
                      />
                      <IconButton label="Remove metadata row" onClick={() => removeMetadataRow(idx)}>
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<Plus size={14} />}
                  onClick={addMetadataRow}
                  style={{ marginTop: '8px' }}
                >
                  Add metadata field
                </Button>
              </div>
              <PremiumToggle
                checked={form.disable_model_invocation}
                onChange={(checked) => setForm((f) => ({ ...f, disable_model_invocation: checked }))}
                label="Only activate when explicitly invoked with /name"
              />
            </>
          ) : (
            <TextArea
              label="SKILL.md"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={18}
              placeholder={'---\nname: pdf-form-filler\ndescription: ...\n---\n\nInstructions body...'}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
            />
          )}

          {validationResult && (validationResult.errors.length > 0 || validationResult.warnings.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {validationResult.errors.map((err, i) => (
                <div
                  key={`e-${i}`}
                  style={{ padding: '8px 12px', background: 'var(--state-danger-soft)', borderRadius: 'var(--radius-sm)', color: 'var(--error)', fontSize: '0.8rem' }}
                >
                  {err}
                </div>
              ))}
              {validationResult.warnings.map((warn, i) => (
                <div
                  key={`w-${i}`}
                  style={{ padding: '8px 12px', background: 'var(--state-warning-soft)', borderRadius: 'var(--radius-sm)', color: 'var(--warning)', fontSize: '0.8rem' }}
                >
                  {warn}
                </div>
              ))}
            </div>
          )}
          {validationResult?.valid && validationResult.errors.length === 0 && validationResult.warnings.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--success)', fontSize: '0.8rem' }}>
              <CheckCircle size={14} /> Looks good.
            </div>
          )}

          {submitError && (
            <div style={{ padding: '8px 12px', background: 'var(--state-danger-soft)', borderRadius: 'var(--radius-sm)', color: 'var(--error)', fontSize: '0.8rem' }}>
              {submitError}
            </div>
          )}

          {editingSkill && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label className="form-field-label">Resource Files</label>
              {resourcesLoading ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading files…</p>
              ) : resources.length === 0 ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No resource files yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {resources.map((resource) => (
                    <div
                      key={resource.path}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 10px',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--bg-elevated)',
                      }}
                    >
                      <FileText size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span style={{
                        flex: 1,
                        minWidth: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.78rem',
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {resource.path}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {formatFileSize(resource.size_bytes)}
                      </span>
                      <IconButton label="Preview file" size="sm" onClick={() => handlePreviewResource(resource.path)}>
                        <Eye size={14} />
                      </IconButton>
                      <IconButton
                        label="Delete file"
                        size="sm"
                        variant="danger"
                        onClick={() => handleDeleteResource(resource.path)}
                        disabled={deletingPath === resource.path}
                      >
                        {deletingPath === resource.path ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}

              {previewPath && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', background: 'var(--bg-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{previewPath}</span>
                    <IconButton label="Close preview" size="sm" onClick={closePreview}>
                      <X size={14} />
                    </IconButton>
                  </div>
                  {previewLoading ? (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>Loading…</p>
                  ) : previewContent?.kind === 'binary' ? (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>Can't preview this file — it doesn't look like text.</p>
                  ) : previewContent?.kind === 'error' ? (
                    <p style={{ fontSize: '0.8rem', color: 'var(--error)', margin: 0 }}>{previewContent.message}</p>
                  ) : previewContent?.kind === 'text' ? (
                    <pre style={{
                      margin: 0,
                      maxHeight: '240px',
                      overflow: 'auto',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {previewContent.text}
                      {previewContent.truncated ? '\n… (truncated)' : ''}
                    </pre>
                  ) : null}
                </div>
              )}

              <input
                ref={resourceFileInputRef}
                type="file"
                onChange={handleAddResourceFileChange}
                style={{ display: 'none' }}
                aria-hidden
              />
              {pendingResourceFile ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <Input
                    label={`Target path for "${pendingResourceFile.name}"`}
                    value={pendingResourcePath}
                    onChange={(e) => setPendingResourcePath(e.target.value)}
                    placeholder="references/FORMS.md"
                  />
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <Button type="button" variant="ghost" size="sm" onClick={cancelAddResource}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={confirmAddResource}
                      loading={addingResource}
                      disabled={!pendingResourcePath.trim()}
                    >
                      Upload
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<FilePlus size={14} />}
                  onClick={() => resourceFileInputRef.current?.click()}
                  style={{ alignSelf: 'flex-start' }}
                >
                  Add file
                </Button>
              )}
            </div>
          )}

          <div className="agent-editor-actions">
            <Button type="button" variant="secondary" onClick={handleValidate} loading={validating}>
              Validate
            </Button>
            <Button type="button" variant="ghost" onClick={closeModal}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={handleSave} loading={saving} disabled={validating}>
              {editingSkill ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
