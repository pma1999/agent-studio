import yaml from 'js-yaml';

export const ALLOWED_FRONTMATTER_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const;

export interface RawSkillFrontmatter {
  name?: unknown;
  description?: unknown;
  license?: unknown;
  compatibility?: unknown;
  metadata?: unknown;
  'allowed-tools'?: unknown;
  [key: string]: unknown;
}

export interface NormalizedSkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

type ParseSkillResult =
  | { ok: true; frontmatter: RawSkillFrontmatter; body: string }
  | { ok: false; error: string };

const allowedFieldSet = new Set<string>(ALLOWED_FRONTMATTER_FIELDS);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isFrontmatterObject(value: unknown): value is RawSkillFrontmatter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnescapedColon(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ':') continue;
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) return true;
  }
  return false;
}

function quoteColonValues(frontmatter: string): string {
  return frontmatter
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*)([^:#][^:]*?):(\s+)(.*)$/);
      if (!match) return line;

      const [, indentation, key, spacing, value] = match;
      const trimmedValue = value.trimStart();
      if (!hasUnescapedColon(value) || trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
        return line;
      }

      return `${indentation}${key}:${spacing}"${value.replace(/"/g, '\\"')}"`;
    })
    .join('\n');
}

function parseYamlFrontmatter(frontmatter: string):
  | { ok: true; value: RawSkillFrontmatter }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatter);
  } catch (firstError) {
    try {
      parsed = yaml.load(quoteColonValues(frontmatter));
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      return { ok: false, error: `Unable to parse frontmatter YAML: ${message}` };
    }
  }

  if (!isFrontmatterObject(parsed)) {
    return { ok: false, error: 'Frontmatter YAML must be a mapping' };
  }
  return { ok: true, value: parsed };
}

export function parseSkillMd(raw: string): ParseSkillResult {
  const opening = raw.match(/^---[ \t]*\r?\n/);
  if (!opening) {
    return { ok: false, error: 'SKILL.md must start with a frontmatter delimiter (---)' };
  }

  const closingPattern = /^---[ \t]*(?:\r?\n|$)/gm;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(raw);
  if (!closing) {
    return { ok: false, error: 'SKILL.md frontmatter is missing its closing delimiter (---)' };
  }

  const frontmatterText = raw.slice(opening[0].length, closing.index);
  const parsed = parseYamlFrontmatter(frontmatterText);
  if (!parsed.ok) return parsed;

  let body = raw.slice(closing.index + closing[0].length);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);

  return { ok: true, frontmatter: parsed.value, body: body.trimEnd() };
}

export function normalizeSkillName(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

export function normalizeMetadata(metadata: unknown): Record<string, string> | undefined {
  if (!isPlainObject(metadata)) return undefined;
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [String(key), String(value)]));
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

export function validateFrontmatter(
  fm: RawSkillFrontmatter,
  opts?: { expectedDirectoryName?: string },
): { errors: string[]; warnings: string[]; normalized?: NormalizedSkillFrontmatter } {
  if (!isFrontmatterObject(fm)) {
    return { errors: ['frontmatter must be a mapping'], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const unknownFields = Object.keys(fm).filter((field) => !allowedFieldSet.has(field)).sort();
  if (unknownFields.length > 0) {
    errors.push(`Unexpected field(s) in frontmatter: ${unknownFields.join(', ')}`);
  }

  const rawName = fm.name;
  let normalizedName: string | undefined;
  if (rawName === undefined || rawName === null || rawName === '') {
    errors.push('name is required');
  } else if (typeof rawName !== 'string') {
    errors.push('name must be a string');
  } else {
    normalizedName = rawName.normalize('NFKC');
    const nameLength = characterCount(normalizedName);
    if (nameLength < 1 || nameLength > 64) {
      errors.push('name must be between 1 and 64 characters');
    }
    if (!/^[\p{L}\p{N}-]+$/u.test(normalizedName)) {
      errors.push('name must contain only Unicode letters, numbers, and hyphens');
    }
    if (normalizedName !== normalizedName.toLowerCase()) {
      errors.push('name must be lowercase');
    }
    if (normalizedName.startsWith('-') || normalizedName.endsWith('-')) {
      errors.push('name must not start or end with a hyphen');
    }
    if (normalizedName.includes('--')) {
      errors.push('name must not contain consecutive hyphens');
    }
  }

  const rawDescription = fm.description;
  let description: string | undefined;
  if (rawDescription === undefined || rawDescription === null || rawDescription === '') {
    errors.push('description is required');
  } else if (typeof rawDescription !== 'string') {
    errors.push('description must be a string');
  } else {
    description = rawDescription;
    if (characterCount(rawDescription) > 1024) {
      errors.push('description must be 1024 characters or fewer');
    }
  }

  let license: string | undefined;
  if (hasOwn(fm, 'license')) {
    if (typeof fm.license !== 'string') errors.push('license must be a string');
    else license = fm.license;
  }

  let compatibility: string | undefined;
  if (hasOwn(fm, 'compatibility')) {
    if (typeof fm.compatibility !== 'string') {
      errors.push('compatibility must be a string');
    } else {
      compatibility = fm.compatibility;
      if (characterCount(fm.compatibility) > 500) {
        errors.push('compatibility must be 500 characters or fewer');
      }
    }
  }

  let metadata: Record<string, string> | undefined;
  if (hasOwn(fm, 'metadata')) {
    if (!isPlainObject(fm.metadata)) {
      errors.push('metadata must be a plain object');
    } else {
      metadata = normalizeMetadata(fm.metadata);
    }
  }

  let allowedTools: string | undefined;
  if (hasOwn(fm, 'allowed-tools')) {
    if (typeof fm['allowed-tools'] !== 'string') errors.push('allowed-tools must be a string');
    else allowedTools = fm['allowed-tools'];
  }

  if (errors.length === 0 && normalizedName !== undefined && opts?.expectedDirectoryName !== undefined) {
    const expectedDirectoryName = opts.expectedDirectoryName.normalize('NFKC');
    if (normalizedName.normalize('NFKC') !== expectedDirectoryName) {
      warnings.push(
        `Skill name '${normalizedName}' does not match its folder name '${opts.expectedDirectoryName}'`,
      );
    }
  }

  if (errors.length > 0 || normalizedName === undefined || description === undefined) {
    return { errors, warnings };
  }

  const normalized: NormalizedSkillFrontmatter = { name: normalizedName, description };
  if (license !== undefined) normalized.license = license;
  if (compatibility !== undefined) normalized.compatibility = compatibility;
  if (allowedTools !== undefined) normalized.allowedTools = allowedTools;
  if (metadata !== undefined) normalized.metadata = metadata;
  return { errors, warnings, normalized };
}

export function serializeSkillMd(fm: NormalizedSkillFrontmatter, body: string): string {
  const frontmatter: Record<string, unknown> = {
    name: fm.name,
    description: fm.description,
  };
  if (fm.license !== undefined) frontmatter.license = fm.license;
  if (fm.compatibility !== undefined) frontmatter.compatibility = fm.compatibility;
  if (fm.allowedTools !== undefined) frontmatter['allowed-tools'] = fm.allowedTools;
  if (fm.metadata !== undefined) frontmatter.metadata = fm.metadata;

  const dumped = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false });
  return `---\n${dumped}---\n\n${body.trim()}\n`;
}

export function checkBodySizeWarning(body: string): string | null {
  if (body.split(/\r?\n/).length <= 500) return null;
  return 'Skill body exceeds the recommended 500-line limit';
}
