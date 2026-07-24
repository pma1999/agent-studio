import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type NextFunction, type Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import {
  checkBodySizeWarning,
  parseSkillMd,
  serializeSkillMd,
  validateFrontmatter,
  type NormalizedSkillFrontmatter,
  type RawSkillFrontmatter,
} from '../skills/parser.js';
import {
  deleteSkillStorageDir,
  extractSkillZipEntries,
  isLikelyTextFile,
  listSkillResourceFiles,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_RESOURCE_READ_CHARS,
  readSkillResourceFile,
  writeSkillBundleToDisk,
} from '../skills/storage.js';

const router = Router();
const STRUCTURED_SKILL_FIELDS = [
  'name',
  'description',
  'body',
  'license',
  'compatibility',
  'metadata',
  'allowed_tools',
  'disable_model_invocation',
] as const;

type SkillSourceFilename = 'SKILL.md' | 'skill.md';
type SkillResource = { path: string; size_bytes: number };

interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  body: string;
  license: string | null;
  compatibility: string | null;
  metadata: string | null;
  allowed_tools: string | null;
  disable_model_invocation: number;
  source_filename: SkillSourceFilename;
  storage_dir: string;
  created_at: string;
  updated_at: string;
}

interface PreparedSkill {
  normalized: NormalizedSkillFrontmatter;
  body: string;
  skillMdText: string;
  warnings: string[];
  sourceFilename: SkillSourceFilename;
  disableModelInvocation?: boolean;
  hasDisableModelInvocation: boolean;
}

type PreparationResult =
  | { ok: true; skill: PreparedSkill }
  | { ok: false; errors: string[]; warnings: string[]; requestError?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseMetadata(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

function toApiSkill(row: SkillRow, resources?: SkillResource[]): Record<string, unknown> {
  return {
    ...row,
    metadata: parseMetadata(row.metadata),
    disable_model_invocation: !!row.disable_model_invocation,
    ...(resources === undefined ? {} : { resources }),
  };
}

function validatePreparedSkill(
  frontmatter: RawSkillFrontmatter,
  body: string,
  options: {
    skillMdText: string;
    sourceFilename: SkillSourceFilename;
    expectedDirectoryName?: string;
    disableModelInvocation?: boolean;
    hasDisableModelInvocation: boolean;
  },
): PreparationResult {
  const validation = validateFrontmatter(frontmatter, {
    expectedDirectoryName: options.expectedDirectoryName,
  });
  const errors = [...validation.errors];
  if (errors.length === 0 && validation.normalized) {
    const bodyWarning = checkBodySizeWarning(body);
    const warnings = [...validation.warnings];
    if (bodyWarning) warnings.push(bodyWarning);
    return {
      ok: true,
      skill: {
        normalized: validation.normalized,
        body,
        skillMdText: options.skillMdText,
        warnings,
        sourceFilename: options.sourceFilename,
        disableModelInvocation: options.disableModelInvocation,
        hasDisableModelInvocation: options.hasDisableModelInvocation,
      },
    };
  }
  return { ok: false, errors, warnings: validation.warnings };
}

function prepareSkillRequest(body: unknown): PreparationResult {
  if (!isRecord(body)) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      requestError: 'Request body must be a JSON object',
    };
  }

  if (typeof body.raw_skill_md === 'string') {
    const parsed = parseSkillMd(body.raw_skill_md);
    if (!parsed.ok) {
      return { ok: false, errors: [parsed.error], warnings: [] };
    }
    return validatePreparedSkill(parsed.frontmatter, parsed.body, {
      skillMdText: body.raw_skill_md,
      sourceFilename: 'SKILL.md',
      hasDisableModelInvocation: false,
    });
  }

  const hasStructuredFields = STRUCTURED_SKILL_FIELDS.some((field) => hasOwn(body, field));
  if (!hasStructuredFields) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      requestError: 'Request body must contain raw_skill_md or structured skill fields',
    };
  }

  const frontmatter: RawSkillFrontmatter = {
    name: body.name,
    description: body.description,
  };
  if (hasOwn(body, 'license')) frontmatter.license = body.license;
  if (hasOwn(body, 'compatibility')) frontmatter.compatibility = body.compatibility;
  if (hasOwn(body, 'metadata')) frontmatter.metadata = body.metadata;
  if (hasOwn(body, 'allowed_tools')) frontmatter['allowed-tools'] = body.allowed_tools;

  const errors: string[] = [];
  if (body.body === undefined || body.body === null) errors.push('body is required');
  else if (typeof body.body !== 'string') errors.push('body must be a string');

  let disableModelInvocation: boolean | undefined;
  const hasDisableModelInvocation = hasOwn(body, 'disable_model_invocation');
  if (hasDisableModelInvocation) {
    if (typeof body.disable_model_invocation !== 'boolean') {
      errors.push('disable_model_invocation must be a boolean');
    } else {
      disableModelInvocation = body.disable_model_invocation;
    }
  }

  const bodyText = typeof body.body === 'string' ? body.body : '';
  const prepared = validatePreparedSkill(frontmatter, bodyText, {
    skillMdText: '',
    sourceFilename: 'SKILL.md',
    disableModelInvocation,
    hasDisableModelInvocation,
  });
  if (!prepared.ok) {
    return { ok: false, errors: [...prepared.errors, ...errors], warnings: prepared.warnings };
  }
  if (errors.length > 0) return { ok: false, errors, warnings: [] };

  prepared.skill.skillMdText = serializeSkillMd(prepared.skill.normalized, prepared.skill.body);
  return prepared;
}

function getOwnedSkill(skillId: string, userId: string): SkillRow | undefined {
  return db.prepare('SELECT * FROM skills WHERE id = ? AND user_id = ?').get(skillId, userId) as SkillRow | undefined;
}

function insertSkillRow(
  skill: PreparedSkill,
  userId: string,
  skillId: string,
  storageDir: string,
): void {
  const { normalized } = skill;
  db.prepare(`
    INSERT INTO skills (
      id, user_id, name, description, body, license, compatibility, metadata,
      allowed_tools, disable_model_invocation, source_filename, storage_dir
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skillId,
    userId,
    normalized.name,
    normalized.description,
    skill.body,
    normalized.license ?? null,
    normalized.compatibility ?? null,
    normalized.metadata ? JSON.stringify(normalized.metadata) : null,
    normalized.allowedTools ?? null,
    skill.disableModelInvocation === true ? 1 : 0,
    skill.sourceFilename,
    storageDir,
  );
}

function sendValidationError(
  res: Response,
  prepared: PreparationResult,
): prepared is Extract<PreparationResult, { ok: false }> {
  if (prepared.ok) return false;
  if (prepared.requestError) {
    res.status(400).json({ error: prepared.requestError });
  } else {
    res.status(400).json({ error: prepared.errors.join('; ') });
  }
  return true;
}

function resourcePathFromQuery(req: AuthRequest): string {
  return typeof req.query.path === 'string' ? req.query.path : '';
}

function isSkillManifestPath(resourcePath: string): boolean {
  return path.basename(resourcePath).toLowerCase() === 'skill.md';
}

// Literal POST paths are registered before the parameterized resource routes.
router.post(
  '/import-zip',
  express.raw({ type: 'application/zip', limit: '20mb' }),
  (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'A non-empty zip body is required' });
      }

      const extracted = extractSkillZipEntries(req.body);
      if (!extracted.ok) return res.status(400).json({ error: extracted.error });

      const parsed = parseSkillMd(extracted.skillMdRaw);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const prepared = validatePreparedSkill(parsed.frontmatter, parsed.body, {
        skillMdText: '',
        sourceFilename: extracted.skillMdSourceFilename,
        expectedDirectoryName: extracted.inferredDirectoryName ?? undefined,
        hasDisableModelInvocation: false,
      });
      if (sendValidationError(res, prepared)) return;
      prepared.skill.skillMdText = serializeSkillMd(prepared.skill.normalized, prepared.skill.body);

      const duplicate = db.prepare('SELECT id FROM skills WHERE user_id = ? AND name = ?').get(userId, prepared.skill.normalized.name);
      if (duplicate) return res.status(400).json({ error: 'A skill with this name already exists' });

      const skillId = nanoid();
      let storageDir = '';
      try {
        storageDir = writeSkillBundleToDisk({
          userId,
          skillId,
          skillMdText: prepared.skill.skillMdText,
          resourceEntries: extracted.resourceEntries,
        });
        insertSkillRow(prepared.skill, userId, skillId, storageDir);
      } catch (error) {
        if (storageDir) deleteSkillStorageDir(storageDir);
        throw error;
      }

      const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as SkillRow;
      const resources = listSkillResourceFiles(storageDir);
      return res.status(201).json({
        skill: toApiSkill(row, resources),
        warnings: prepared.skill.warnings,
        resources,
      });
    } catch (error) {
      console.error('Error importing skill:', error);
      return res.status(500).json({ error: 'Failed to import skill' });
    }
  },
);

router.post('/parse-preview', (req: AuthRequest, res: Response) => {
  const prepared = prepareSkillRequest(req.body);
  if (!prepared.ok && prepared.requestError) {
    return res.status(400).json({ error: prepared.requestError });
  }
  if (!prepared.ok) {
    return res.json({
      valid: false,
      errors: prepared.errors,
      warnings: prepared.warnings,
      catalog_entry: undefined,
    });
  }
  return res.json({
    valid: true,
    errors: [],
    warnings: prepared.skill.warnings,
    catalog_entry: {
      name: prepared.skill.normalized.name,
      description: prepared.skill.normalized.description,
    },
  });
});

router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = db.prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY name ASC').all(userId) as SkillRow[];
    return res.json(rows.map((row) => toApiSkill(row)));
  } catch (error) {
    console.error('Error listing skills:', error);
    return res.status(500).json({ error: 'Failed to list skills' });
  }
});

router.post('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const prepared = prepareSkillRequest(req.body);
    if (sendValidationError(res, prepared)) return;

    const duplicate = db.prepare('SELECT id FROM skills WHERE user_id = ? AND name = ?').get(userId, prepared.skill.normalized.name);
    if (duplicate) return res.status(400).json({ error: 'A skill with this name already exists' });

    const skillId = nanoid();
    let storageDir = '';
    try {
      storageDir = writeSkillBundleToDisk({
        userId,
        skillId,
        skillMdText: prepared.skill.skillMdText,
        resourceEntries: [],
      });
      insertSkillRow(prepared.skill, userId, skillId, storageDir);
    } catch (error) {
      if (storageDir) deleteSkillStorageDir(storageDir);
      throw error;
    }

    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as SkillRow;
    const resources: SkillResource[] = [];
    return res.status(201).json({
      skill: toApiSkill(row, resources),
      warnings: prepared.skill.warnings,
      resources,
    });
  } catch (error) {
    console.error('Error creating skill:', error);
    return res.status(500).json({ error: 'Failed to create skill' });
  }
});

router.get('/:id/resources/content', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = getOwnedSkill(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'Skill not found' });

    const resourcePath = resourcePathFromQuery(req);
    const result = readSkillResourceFile(row.storage_dir, resourcePath);
    if ('error' in result) return res.status(404).json({ error: result.error });

    if (!isLikelyTextFile(result.data, resourcePath)) {
      return res.json({
        path: resourcePath,
        content: null,
        size_bytes: result.data.length,
        truncated: false,
        binary: true,
      });
    }

    const text = result.data.toString('utf8');
    const truncated = text.length > MAX_SKILL_RESOURCE_READ_CHARS;
    return res.json({
      path: resourcePath,
      content: truncated ? text.slice(0, MAX_SKILL_RESOURCE_READ_CHARS) : text,
      size_bytes: result.data.length,
      truncated,
    });
  } catch (error) {
    console.error('Error reading skill resource:', error);
    return res.status(500).json({ error: 'Failed to read skill resource' });
  }
});

router.get('/:id/resources', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = getOwnedSkill(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'Skill not found' });
    return res.json(listSkillResourceFiles(row.storage_dir));
  } catch (error) {
    console.error('Error listing skill resources:', error);
    return res.status(500).json({ error: 'Failed to list skill resources' });
  }
});

router.post(
  '/:id/resources',
  express.raw({ type: 'application/octet-stream', limit: '5mb' }),
  (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const row = getOwnedSkill(req.params.id, userId);
      if (!row) return res.status(404).json({ error: 'Skill not found' });

      const encodedPath = req.get('X-Resource-Path-B64');
      if (!encodedPath) return res.status(400).json({ error: 'X-Resource-Path-B64 header is required' });
      const content = req.body;
      if (!Buffer.isBuffer(content)) return res.status(400).json({ error: 'A binary body is required' });

      const relativePath = Buffer.from(encodedPath, 'base64').toString('utf8');
      if (isSkillManifestPath(relativePath)) {
        return res.status(400).json({ error: 'SKILL.md cannot be overwritten' });
      }
      const existingResources = listSkillResourceFiles(row.storage_dir);
      const currentBytes = existingResources.reduce((total, resource) => total + resource.size_bytes, 0);
      if (currentBytes + content.length > MAX_SKILL_BUNDLE_BYTES) {
        return res.status(413).json({ error: `Skill bundle exceeds the total size limit (${MAX_SKILL_BUNDLE_BYTES} bytes)` });
      }

      const manifest = readSkillResourceFile(row.storage_dir, 'SKILL.md');
      if ('error' in manifest) return res.status(500).json({ error: 'Skill manifest is missing' });
      try {
        writeSkillBundleToDisk({
          userId,
          skillId: row.id,
          skillMdText: manifest.data.toString('utf8'),
          resourceEntries: [{ relativePath, data: content }],
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unsafe resource path')) {
          return res.status(400).json({ error: error.message });
        }
        throw error;
      }

      const refreshed = listSkillResourceFiles(row.storage_dir);
      // The resource endpoint returns the same per-entry shape as GET /resources.
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const resource = refreshed.find((entry) => entry.path === normalizedPath)
        ?? { path: normalizedPath, size_bytes: content.length };
      return res.status(201).json(resource);
    } catch (error) {
      console.error('Error adding skill resource:', error);
      return res.status(500).json({ error: 'Failed to add skill resource' });
    }
  },
);

router.delete('/:id/resources', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = getOwnedSkill(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'Skill not found' });

    const resourcePath = resourcePathFromQuery(req);
    if (isSkillManifestPath(resourcePath)) {
      return res.status(400).json({ error: 'SKILL.md cannot be deleted' });
    }
    const result = readSkillResourceFile(row.storage_dir, resourcePath);
    if ('error' in result) {
      if (result.error === 'Path escapes the skill storage directory') {
        return res.status(400).json({ error: result.error });
      }
      return res.status(404).json({ error: result.error });
    }

    try {
      fs.unlinkSync(path.resolve(row.storage_dir, resourcePath));
    } catch {
      return res.status(500).json({ error: 'Failed to delete skill resource' });
    }
    return res.json(listSkillResourceFiles(row.storage_dir));
  } catch (error) {
    console.error('Error deleting skill resource:', error);
    return res.status(500).json({ error: 'Failed to delete skill resource' });
  }
});

router.get('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = getOwnedSkill(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'Skill not found' });
    return res.json(toApiSkill(row, listSkillResourceFiles(row.storage_dir)));
  } catch (error) {
    console.error('Error getting skill:', error);
    return res.status(500).json({ error: 'Failed to get skill' });
  }
});

router.put('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const existing = getOwnedSkill(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Skill not found' });

    const prepared = prepareSkillRequest(req.body);
    if (sendValidationError(res, prepared)) return;
    if (prepared.skill.normalized.name !== existing.name) {
      return res.status(400).json({ error: 'Skill names cannot be changed after creation' });
    }

    writeSkillBundleToDisk({
      userId,
      skillId: existing.id,
      skillMdText: prepared.skill.skillMdText,
      resourceEntries: [],
    });

    const updates = [
      'description = ?',
      'body = ?',
      'license = ?',
      'compatibility = ?',
      'metadata = ?',
      'allowed_tools = ?',
    ];
    const values: unknown[] = [
      prepared.skill.normalized.description,
      prepared.skill.body,
      prepared.skill.normalized.license ?? null,
      prepared.skill.normalized.compatibility ?? null,
      prepared.skill.normalized.metadata ? JSON.stringify(prepared.skill.normalized.metadata) : null,
      prepared.skill.normalized.allowedTools ?? null,
    ];
    if (prepared.skill.hasDisableModelInvocation) {
      updates.push('disable_model_invocation = ?');
      values.push(prepared.skill.disableModelInvocation === true ? 1 : 0);
    }
    updates.push("updated_at = datetime('now')");
    values.push(existing.id, userId);
    db.prepare(`UPDATE skills SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM skills WHERE id = ? AND user_id = ?').get(existing.id, userId) as SkillRow;
    const resources = listSkillResourceFiles(row.storage_dir);
    return res.json({
      skill: toApiSkill(row, resources),
      warnings: prepared.skill.warnings,
      resources,
    });
  } catch (error) {
    console.error('Error updating skill:', error);
    return res.status(500).json({ error: 'Failed to update skill' });
  }
});

router.delete('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = getOwnedSkill(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'Skill not found' });

    db.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(row.id);
    db.prepare('DELETE FROM conversation_skills WHERE skill_id = ?').run(row.id);
    deleteSkillStorageDir(row.storage_dir);
    db.prepare('DELETE FROM skills WHERE id = ?').run(row.id);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting skill:', error);
    return res.status(500).json({ error: 'Failed to delete skill' });
  }
});

router.use((error: unknown, _req: AuthRequest, res: Response, next: NextFunction) => {
  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body exceeds the allowed size' });
    return;
  }
  next(error);
});

export default router;
