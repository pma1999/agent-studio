import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { DB_DIRECTORY } from '../db.js';

export const SKILLS_DIR = path.join(DB_DIRECTORY, 'skills');

// Size/count caps — see `plans/agent-skills-support/global-constraints.md`
// ("Storage layout" section) for the binding rationale behind each value.
export const MAX_SKILL_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_FILES = 500;
export const MAX_SKILL_RESOURCE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_RESOURCE_READ_CHARS = 100_000;

const TEXT_EXTENSION_ALLOWLIST = new Set([
  '.md', '.txt', '.py', '.js', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml',
  '.sh', '.html', '.css', '.csv', '.toml', '.ini', '.xml', '.rst',
]);

export function isLikelyTextFile(data: Buffer, relativePath: string): boolean {
  const probeLength = Math.min(data.length, 8192);
  for (let i = 0; i < probeLength; i += 1) {
    if (data[i] === 0x00) return false;
  }

  const extension = path.extname(relativePath).toLowerCase();
  if (TEXT_EXTENSION_ALLOWLIST.has(extension)) return true;

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, probeLength));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `candidate` (a `/`- or `\`-separated relative path, not yet
 * resolved against any root) is unsafe on its face: absolute, containing a
 * NUL/C0 control byte, or containing a `..`/`.` path segment. This is the
 * portion of the path-safety check that applies before a real storage
 * directory exists (e.g. while walking zip entries), independent of any
 * particular root.
 */
function hasUnsafePathSegments(candidate: string): boolean {
  if (path.isAbsolute(candidate)) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(candidate)) return true;
  const segments = candidate.split(/[\\/]/);
  return segments.some((segment) => segment === '..' || segment === '.');
}

/**
 * Full path-safety check used by `writeSkillBundleToDisk`'s validation and
 * `readSkillResourceFile`: resolves `candidate` against `root` and returns
 * the resolved absolute path, or `null` if `candidate` is unsafe by the
 * rules in `global-constraints.md` ("Path safety (zip-slip defense)").
 *
 * `shared/commandSafety.ts`'s `isPathWithinRoot(candidatePath, root)` was
 * evaluated for reuse per the brief, but its signature and behavior don't
 * cleanly fit: it returns a plain boolean rather than the resolved absolute
 * path this module's callers need to actually read/write, and it doesn't
 * reject NUL/control bytes or explicit `..`/`.` segments before resolution —
 * both required by this module's stricter zip-slip defense. A small local
 * helper implementing the exact algorithm from `global-constraints.md` is
 * used instead.
 */
function isSafeRelativePath(root: string, candidate: string): string | null {
  if (hasUnsafePathSegments(candidate)) return null;

  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!resolvedCandidate.startsWith(rootWithSep)) return null;

  return resolvedCandidate;
}

export function writeSkillBundleToDisk(params: {
  userId: string;
  skillId: string;
  skillMdText: string;
  resourceEntries: { relativePath: string; data: Buffer }[];
}): string {
  const storageDir = path.resolve(path.join(SKILLS_DIR, params.userId, params.skillId));

  // Validate every entry before touching the filesystem: on any single
  // failure, throw before any file (or directory) is written, so a rejected
  // bundle never leaves a partial write behind.
  const resolvedEntries: { absolutePath: string; data: Buffer }[] = [];
  for (const entry of params.resourceEntries) {
    const resolved = isSafeRelativePath(storageDir, entry.relativePath);
    if (!resolved) {
      throw new Error(`Unsafe resource path in skill bundle: ${entry.relativePath}`);
    }
    resolvedEntries.push({ absolutePath: resolved, data: entry.data });
  }

  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'SKILL.md'), params.skillMdText);
  for (const entry of resolvedEntries) {
    fs.mkdirSync(path.dirname(entry.absolutePath), { recursive: true });
    fs.writeFileSync(entry.absolutePath, entry.data);
  }

  return storageDir;
}

export function readSkillResourceFile(
  storageDir: string,
  relativePath: string,
): { data: Buffer } | { error: string } {
  const resolvedPath = isSafeRelativePath(storageDir, relativePath);
  if (!resolvedPath) {
    return { error: 'Path escapes the skill storage directory' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return { error: 'File not found' };
  }
  if (stat.isDirectory()) {
    return { error: 'Path is a directory' };
  }

  try {
    return { data: fs.readFileSync(resolvedPath) };
  } catch {
    return { error: 'Failed to read file' };
  }
}

export function listSkillResourceFiles(storageDir: string): { path: string; size_bytes: number }[] {
  const resolvedRoot = path.resolve(storageDir);
  const results: { path: string; size_bytes: number }[] = [];

  function walk(dir: string): void {
    if (results.length >= MAX_SKILL_BUNDLE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SKILL_BUNDLE_FILES) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(resolvedRoot, fullPath).split(path.sep).join('/');
        if (relativePath === 'SKILL.md') continue;
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          continue;
        }
        results.push({ path: relativePath, size_bytes: size });
      }
    }
  }

  walk(resolvedRoot);
  return results;
}

export function deleteSkillStorageDir(storageDir: string): void {
  try {
    fs.rmSync(storageDir, { recursive: true, force: true });
  } catch {
    // Never throws: an already-deleted (or otherwise inaccessible) directory
    // is not an error for this best-effort cleanup helper.
  }
}

// ZIP spec compression method identifiers (APPNOTE.TXT section 4.4.5) —
// hardcoded here rather than imported from `adm-zip`'s internal (non-public)
// `util/constants` module, since these two values are fixed by the file
// format itself, not an `adm-zip` implementation detail.
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATED = 8;

let crc32Table: Uint32Array | null = null;

/**
 * Table-based CRC-32 (the same ISO-HDLC variant the ZIP format itself uses
 * for its per-entry checksums), implemented locally rather than via
 * `node:zlib`'s `crc32()` — that function was only added in Node.js 21,
 * newer than this app's declared minimum (`"node": ">=20.19.0"` in
 * `package.json`) — so this stays correct on every supported Node version.
 */
function crc32(data: Buffer): number {
  if (!crc32Table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    crc32Table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Decompresses a single non-directory zip entry with an output-size bound
 * that is *fixed and module-owned* (`maxBytes`) — never derived from the
 * entry's own self-reported `header.size`, the way `adm-zip`'s own
 * `entry.getData()`/`zip.readAsText()` do internally.
 *
 * This exists to close a resource-exhaustion defect found in task review
 * round 1 (RC-01): `adm-zip` passes the entry's declared `header.size` to
 * `zlib.inflateRawSync(..., { maxOutputLength })`, but only when that
 * declared size is a positive number (`expectedLength > 0`, per
 * `adm-zip`'s `methods/inflater.js`) — a crafted entry that declares
 * `header.size: 0` while its real compressed payload inflates to hundreds
 * of megabytes decompresses **fully unbounded** through `entry.getData()`,
 * defeating `MAX_SKILL_RESOURCE_FILE_BYTES`/`MAX_SKILL_BUNDLE_BYTES`
 * entirely (confirmed end-to-end by the reviewer: a 299 KiB upload caused a
 * 611 MiB RSS spike in ~191ms). Reading the raw compressed bytes via the
 * public `entry.getCompressedData()` (which never decompresses on its own)
 * and inflating them here, ourselves, with a fixed `maxOutputLength`, bounds
 * the allocation regardless of what the entry declares.
 */
function decompressEntryBounded(
  entry: AdmZip.IZipEntry,
  maxBytes: number,
): { ok: true; data: Buffer } | { ok: false; error: string } {
  let compressed: Buffer;
  try {
    compressed = entry.getCompressedData();
  } catch {
    return { ok: false, error: `Could not read "${entry.entryName}" from the zip archive` };
  }

  let data: Buffer;
  if (entry.header.method === ZIP_METHOD_STORED) {
    // Stored (uncompressed) entries: the "compressed" bytes already are the
    // entry's real content, at their real length. Bound directly against
    // that real length — never against the declared `header.size`, which
    // `adm-zip`'s own STORED-branch reader uses to size a pre-allocated
    // target buffer and silently truncates into if it's smaller than the
    // real data (a separate instance of the same "don't trust the declared
    // size" defect, noted by the reviewer, not just a DEFLATE-only issue).
    if (compressed.length > maxBytes) {
      return {
        ok: false,
        error: `File "${entry.entryName}" exceeds the per-file size limit (${maxBytes} bytes)`,
      };
    }
    data = compressed;
  } else if (entry.header.method === ZIP_METHOD_DEFLATED) {
    try {
      data = zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch (error) {
      if (error instanceof RangeError) {
        return {
          ok: false,
          error: `File "${entry.entryName}" exceeds the per-file size limit (${maxBytes} bytes)`,
        };
      }
      return { ok: false, error: `Could not decompress "${entry.entryName}" (corrupt or malformed entry)` };
    }
  } else {
    return { ok: false, error: `Unsupported compression method for "${entry.entryName}"` };
  }

  if (crc32(data) !== (entry.header.crc >>> 0)) {
    return { ok: false, error: `Checksum mismatch for "${entry.entryName}" (corrupt entry)` };
  }

  return { ok: true, data };
}

export function extractSkillZipEntries(zipBuffer: Buffer):
  | {
      ok: true;
      skillMdRaw: string;
      skillMdSourceFilename: 'SKILL.md' | 'skill.md';
      inferredDirectoryName: string | null;
      resourceEntries: { relativePath: string; data: Buffer }[];
    }
  | { ok: false; error: string } {
  let zip: AdmZip;
  let entries: AdmZip.IZipEntry[];
  try {
    zip = new AdmZip(zipBuffer);
    entries = zip.getEntries();
  } catch {
    return { ok: false, error: 'Could not read zip archive' };
  }

  if (entries.length > MAX_SKILL_BUNDLE_FILES) {
    return { ok: false, error: `Zip archive contains too many entries (max ${MAX_SKILL_BUNDLE_FILES})` };
  }

  // Deliberately no declared-size cap check here (there was one, against
  // `entry.header.size`, before RC-01): that field is attacker-controlled
  // zip metadata, not a real constraint. Both size caps are enforced below,
  // against each entry's *actual* decompressed byte length as it's bounded
  // and produced by `decompressEntryBounded`, never against what an entry
  // merely declares.

  // Normalize entry names to forward slashes only (no other rewriting) so
  // Windows-authored zips (which may use backslash separators) and
  // POSIX-authored ones are treated identically for root/prefix detection —
  // never trust `adm-zip`'s raw `entryName` as already traversal-safe. A
  // leading slash is deliberately left intact here (not stripped) so an
  // entry name like `/etc/passwd` still reads as absolute and is caught by
  // `hasUnsafePathSegments` below, rather than being silently rewritten into
  // a seemingly-safe relative path before the safety check ever runs.
  const normalized = entries.map((entry) => ({
    entry,
    name: entry.entryName.replace(/\\/g, '/'),
  }));

  const isManifestBasename = (name: string): boolean => /^skill\.md$/i.test(name);

  // Case 1: manifest at the zip root (its name contains no `/`).
  const rootManifest = normalized.find(
    ({ entry, name }) => !entry.isDirectory && !name.includes('/') && isManifestBasename(name),
  );

  let manifestEntry: AdmZip.IZipEntry | null = null;
  let skillMdSourceFilename: 'SKILL.md' | 'skill.md' = 'SKILL.md';
  let inferredDirectoryName: string | null = null;
  let stripPrefix = '';

  if (rootManifest) {
    manifestEntry = rootManifest.entry;
    skillMdSourceFilename = rootManifest.name === 'SKILL.md' ? 'SKILL.md' : 'skill.md';
  } else {
    // Case 2: every entry shares a single common first path segment — look
    // for the manifest directly inside that segment.
    const firstSegments = new Set<string>();
    for (const { name } of normalized) {
      const slashIndex = name.indexOf('/');
      firstSegments.add(slashIndex === -1 ? '' : name.slice(0, slashIndex));
    }

    if (firstSegments.size === 1 && !firstSegments.has('')) {
      const folder = [...firstSegments][0];
      const folderManifest = normalized.find(({ entry, name }) => {
        if (entry.isDirectory) return false;
        const withinFolder = name.slice(folder.length + 1);
        return name.toLowerCase().startsWith(`${folder.toLowerCase()}/`)
          && !withinFolder.includes('/')
          && isManifestBasename(withinFolder);
      });
      if (folderManifest) {
        manifestEntry = folderManifest.entry;
        const baseName = folderManifest.name.slice(folder.length + 1);
        skillMdSourceFilename = baseName === 'SKILL.md' ? 'SKILL.md' : 'skill.md';
        inferredDirectoryName = folder;
        stripPrefix = `${folder}/`;
      }
    }
  }

  if (!manifestEntry) {
    return {
      ok: false,
      error: 'No SKILL.md (or skill.md) found at the zip root or inside a single top-level folder',
    };
  }

  // Path-safety pass first, before decompressing anything: compute and
  // validate every resource entry's relative path up front, so a bundle
  // containing one unsafe path is rejected in full without decompressing
  // any entry at all (matches the "reject before touching data" posture of
  // the size caps below, and avoids doing decompression work for entries
  // that would be thrown away regardless).
  const safeResourceEntries: { entry: AdmZip.IZipEntry; relativePath: string }[] = [];
  for (const { entry, name } of normalized) {
    if (entry === manifestEntry || entry.isDirectory) continue;

    const relativePath = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name;
    if (!relativePath || hasUnsafePathSegments(relativePath)) {
      return { ok: false, error: `Unsafe path in zip entry: ${entry.entryName}` };
    }
    safeResourceEntries.push({ entry, relativePath });
  }

  // Bounded-decompression pass: decompress the manifest plus every
  // path-validated resource entry, each capped at MAX_SKILL_RESOURCE_FILE_BYTES
  // regardless of what the entry declares (see decompressEntryBounded), and
  // track the running total against MAX_SKILL_BUNDLE_BYTES using each
  // entry's *actual* decompressed length as it's produced — not a
  // pre-checked sum of declared sizes.
  let totalDecompressedBytes = 0;

  const manifestResult = decompressEntryBounded(manifestEntry, MAX_SKILL_RESOURCE_FILE_BYTES);
  if (!manifestResult.ok) {
    return manifestResult;
  }
  totalDecompressedBytes += manifestResult.data.length;
  if (totalDecompressedBytes > MAX_SKILL_BUNDLE_BYTES) {
    return {
      ok: false,
      error: `Zip archive exceeds the total uncompressed size limit (${MAX_SKILL_BUNDLE_BYTES} bytes)`,
    };
  }

  const resourceEntries: { relativePath: string; data: Buffer }[] = [];
  for (const { entry, relativePath } of safeResourceEntries) {
    const result = decompressEntryBounded(entry, MAX_SKILL_RESOURCE_FILE_BYTES);
    if (!result.ok) {
      return result;
    }
    totalDecompressedBytes += result.data.length;
    if (totalDecompressedBytes > MAX_SKILL_BUNDLE_BYTES) {
      return {
        ok: false,
        error: `Zip archive exceeds the total uncompressed size limit (${MAX_SKILL_BUNDLE_BYTES} bytes)`,
      };
    }
    resourceEntries.push({ relativePath, data: result.data });
  }

  return {
    ok: true,
    skillMdRaw: manifestResult.data.toString('utf8'),
    skillMdSourceFilename,
    inferredDirectoryName,
    resourceEntries,
  };
}
