import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

// Point DB_DIRECTORY (and therefore SKILLS_DIR) at an isolated temp
// directory before importing anything from server/db.js, mirroring
// scripts/test-agent-files.ts's setup — this test never touches the real
// SKILLS_DIR.
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-storage-test-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'skill-storage-test.db');
process.env.JWT_SECRET = 'skill-storage-test-jwt-secret';

const { default: db } = await import('../server/db.js');
const {
  SKILLS_DIR,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_RESOURCE_FILE_BYTES,
  MAX_SKILL_RESOURCE_READ_CHARS,
  isLikelyTextFile,
  writeSkillBundleToDisk,
  readSkillResourceFile,
  listSkillResourceFiles,
  deleteSkillStorageDir,
  extractSkillZipEntries,
} = await import('../server/skills/storage.js');

// Table-based CRC-32, duplicated (not imported) from server/skills/storage.ts's
// internal implementation, and used here rather than `node:zlib`'s `crc32()`
// (only available from Node.js 21 onward) for the same portability reason:
// this repo's package.json declares `"node": ">=20.19.0"`, and this test
// should run correctly on that whole supported range, not just on whatever
// newer Node happens to be installed on a given dev machine.
let testCrc32Table: Uint32Array | null = null;
function testCrc32(data: Buffer): number {
  if (!testCrc32Table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    testCrc32Table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = testCrc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface RawZipEntrySpec {
  name: string;
  /** Bytes embedded verbatim in the archive (the entry's real content for
   *  STORE, or the pre-compressed DEFLATE stream for DEFLATE). */
  data: Buffer;
  /** ZIP compression method: 0 = STORE (default), 8 = DEFLATE. */
  method?: 0 | 8;
  /** Declared "uncompressed size" written into the local/central headers.
   *  Defaults to `data.length` (correct for STORE); pass an explicit,
   *  possibly-lying value to simulate a malicious/mismatched declaration
   *  (RC-01's exact attack shape). */
  declaredSize?: number;
  /** Declared CRC-32, written into the local/central headers. Defaults to
   *  `testCrc32(data)` (correct for STORE, where `data` is the real
   *  content); pass the real content's CRC explicitly for DEFLATE entries,
   *  since `data` there is the compressed stream, not the content. */
  crc?: number;
}

/**
 * Builds a raw zip archive by hand, without going through `adm-zip`'s own
 * writer (`addFile`) — `addFile` silently normalizes `..`-containing entry
 * names before they ever reach the archive (hiding the zip-slip attack
 * shape below) and always computes a correct, real `header.size` (hiding
 * the RC-01 resource-exhaustion attack shape, which depends on a entry
 * declaring a size that doesn't match its real decompressed length). Both
 * classes of attack require full control over what a zip's central
 * directory *declares*, independent of a real archive's actual content —
 * exactly what a malicious zip-writing tool (not `adm-zip`) could produce.
 */
function buildRawZip(entries: RawZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, data, method = 0, declaredSize, crc } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const resolvedCrc = (crc ?? testCrc32(data)) >>> 0;
    const resolvedSize = declaredSize ?? data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(resolvedCrc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size: always the real embedded byte length
    localHeader.writeUInt32LE(resolvedSize, 22); // declared uncompressed size: may deliberately lie
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(resolvedCrc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(resolvedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

try {
  // --- Cap constants exported exactly as specified. ---
  assert.equal(MAX_SKILL_BUNDLE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_SKILL_BUNDLE_FILES, 500);
  assert.equal(MAX_SKILL_RESOURCE_FILE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_SKILL_RESOURCE_READ_CHARS, 100_000);
  assert.equal(SKILLS_DIR, path.join(path.dirname(process.env.DATABASE_PATH!), 'skills'));

  // --- 1. Well-formed zip, SKILL.md at root + one nested resource file. ---
  {
    const skillMdText = '---\nname: pdf-processing\ndescription: café ☕ 日本語 test\n---\nBody text';
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from(skillMdText, 'utf8'));
    zip.addFile('references/x.md', Buffer.from('# reference doc', 'utf8'));

    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.skillMdRaw, skillMdText);
      assert.equal(result.skillMdSourceFilename, 'SKILL.md');
      assert.equal(result.inferredDirectoryName, null);
      assert.equal(result.resourceEntries.length, 1);
      assert.equal(result.resourceEntries[0].relativePath, 'references/x.md');
      assert.equal(result.resourceEntries[0].data.toString('utf8'), '# reference doc');
    }
  }

  // --- 2. Zip wrapped in a single top-level folder. ---
  {
    const zip = new AdmZip();
    zip.addFile('my-skill/SKILL.md', Buffer.from('---\nname: my-skill\ndescription: test\n---\nBody', 'utf8'));
    zip.addFile('my-skill/scripts/run.py', Buffer.from('print("hi")', 'utf8'));

    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.inferredDirectoryName, 'my-skill');
      assert.equal(result.skillMdSourceFilename, 'SKILL.md');
      assert.equal(result.resourceEntries.length, 1);
      assert.equal(result.resourceEntries[0].relativePath, 'scripts/run.py');
    }
  }

  // --- 2b. lowercase skill.md accepted, case-insensitively, inside a folder. ---
  {
    const zip = new AdmZip();
    zip.addFile('another-skill/skill.md', Buffer.from('---\nname: another-skill\ndescription: test\n---\nBody', 'utf8'));

    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.inferredDirectoryName, 'another-skill');
      assert.equal(result.skillMdSourceFilename, 'skill.md');
      assert.equal(result.resourceEntries.length, 0);
    }
  }

  // --- 3. No SKILL.md reachable by either case. ---
  {
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('no manifest here', 'utf8'));
    zip.addFile('docs/notes.txt', Buffer.from('also no manifest', 'utf8'));

    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /No SKILL\.md/);
    }
  }

  // --- 3b. Corrupt/unreadable archive. ---
  {
    const result = extractSkillZipEntries(Buffer.from('this is not a zip file'));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'Could not read zip archive');
    }
  }

  // --- 4. Zip-slip: raw, unsanitized `..`-containing entry names, crafted
  // outside adm-zip's own writer (which normalizes `..` segments away on
  // `addFile`, per the Named Risk in the task brief) — proves the read-side
  // defense holds regardless of what wrote the archive. ---
  {
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      { name: '../../evil.txt', data: Buffer.from('pwned', 'utf8') },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Unsafe path/);
    }
  }

  // --- 4b. Zip-slip via a nested `../../` segment mid-path. ---
  {
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      { name: 'nested/../../also-evil.txt', data: Buffer.from('pwned2', 'utf8') },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Unsafe path/);
    }
  }

  // --- 4c. Zip-slip via backslash-separated traversal (Windows-style
  // separators inside the entry name, per the Named Risk). ---
  {
    const backslashName = ['..', '..', 'evil.txt'].join(String.fromCharCode(92));
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      { name: backslashName, data: Buffer.from('pwned3', 'utf8') },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Unsafe path/);
    }
  }

  // --- 4d'. Zip-slip inside a wrapping-folder bundle (Case 2): the
  // manifest lives under `my-skill/`, and the malicious entry's raw name is
  // `my-skill/../../evil.txt` — after stripping the `my-skill/` prefix this
  // must still resolve to the unsafe `../../evil.txt` relative path and be
  // rejected, not silently accepted because it shares the wrapping folder's
  // prefix. This exercises the prefix-strip branch (the one path the
  // root-manifest fixtures above don't reach) with an adversarial input. ---
  {
    const raw = buildRawZip([
      { name: 'my-skill/SKILL.md', data: Buffer.from('---\nname: my-skill\ndescription: y\n---\nbody', 'utf8') },
      { name: 'my-skill/../../evil.txt', data: Buffer.from('pwned5', 'utf8') },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Unsafe path/);
    }
  }

  // --- 4d. Zip-slip via an absolute path entry name. ---
  {
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      { name: '/etc/passwd', data: Buffer.from('pwned4', 'utf8') },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Unsafe path/);
    }
  }

  // --- 5a. Zip exceeding MAX_SKILL_BUNDLE_FILES (entry count). ---
  {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8'));
    for (let i = 0; i < MAX_SKILL_BUNDLE_FILES; i += 1) {
      zip.addFile(`files/f${i}.txt`, Buffer.from('x', 'utf8'));
    }
    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /too many entries/);
    }
  }

  // --- 5b. Single entry exceeding MAX_SKILL_RESOURCE_FILE_BYTES. ---
  {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8'));
    zip.addFile('assets/big.bin', Buffer.alloc(MAX_SKILL_RESOURCE_FILE_BYTES + 1, 1));
    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /exceeds the per-file size limit/);
    }
  }

  // --- 5c. Total uncompressed size exceeding MAX_SKILL_BUNDLE_BYTES, with
  // every individual entry under the per-file cap. ---
  {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8'));
    const perFileSize = 4_500_000; // under MAX_SKILL_RESOURCE_FILE_BYTES (5 MiB)
    for (let i = 0; i < 5; i += 1) {
      zip.addFile(`assets/part${i}.bin`, Buffer.alloc(perFileSize, i + 1));
    }
    assert.ok(5 * perFileSize > MAX_SKILL_BUNDLE_BYTES);
    const result = extractSkillZipEntries(zip.toBuffer());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /exceeds the total uncompressed size limit/);
    }
  }

  // --- RC-01 regression: `entry.header.size` is attacker-controlled zip
  // metadata, not a real constraint — `extractSkillZipEntries` must bound
  // the *actual* decompressed output against MAX_SKILL_RESOURCE_FILE_BYTES/
  // MAX_SKILL_BUNDLE_BYTES regardless of what an entry declares. These
  // fixtures use real DEFLATE-compressed payloads (`zlib.deflateRawSync`,
  // never a `maxOutputLength`-bounded call, so the compressed bytes really
  // do inflate to the stated real size) paired with a raw, hand-crafted
  // declared `header.size` via `buildRawZip`, bypassing `adm-zip`'s own
  // writer (which always computes a correct declared size and so could
  // never reproduce this attack shape). Per the remediation instructions,
  // these assert on outcome only (ok:true/false and byte lengths), never on
  // wall-clock timing or RSS.

  // --- RC-01a. `header.size: 0` declared, real DEFLATE payload well over
  // MAX_SKILL_RESOURCE_FILE_BYTES — the exact trigger condition from the
  // review (adm-zip's own `maxOutputLength` guard is disabled only when the
  // declared size is exactly 0). Must reject cleanly, not throw. ---
  {
    const realPayload = Buffer.alloc(6 * 1024 * 1024, 0); // 6 MiB, well over the 5 MiB per-file cap
    const compressed = zlib.deflateRawSync(realPayload);
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      { name: 'bomb.bin', data: compressed, method: 8, declaredSize: 0 },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /per-file size limit/);
    }
  }

  // --- RC-01b. Positive-but-mismatched declared size (not zero), real
  // DEFLATE payload well over the cap — must also reject cleanly (the fix's
  // bound never depends on the declared value, positive or zero). ---
  {
    const realPayload = Buffer.alloc(6 * 1024 * 1024, 0);
    const compressed = zlib.deflateRawSync(realPayload);
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      { name: 'bomb2.bin', data: compressed, method: 8, declaredSize: 1000 },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /per-file size limit/);
    }
  }

  // --- RC-01c. Mismatched declared size (lies in the *other* direction —
  // wildly overstated), but the real DEFLATE payload is well under the cap:
  // must succeed, and the returned bytes must be the real decompressed
  // content at its real length, not the lied-about declared size. Proves
  // the fix reads actual bytes, never declared metadata, for the data it
  // hands back too. ---
  {
    const realPayload = Buffer.from('real content, not a lie', 'utf8');
    const compressed = zlib.deflateRawSync(realPayload);
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      {
        name: 'honest.txt',
        data: compressed,
        method: 8,
        declaredSize: 999_999_999, // wildly overstated, should be ignored
        crc: testCrc32(realPayload),
      },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resourceEntries.length, 1);
      assert.equal(result.resourceEntries[0].relativePath, 'honest.txt');
      assert.equal(result.resourceEntries[0].data.toString('utf8'), 'real content, not a lie');
      assert.equal(result.resourceEntries[0].data.length, realPayload.length);
    }
  }

  // --- RC-01d. STORED-method entry (no compression) with a declared size
  // smaller than its real content — per the review's Limitations note, this
  // is the same root cause via a different code path (adm-zip's own STORED
  // branch would silently truncate into an under-sized pre-allocated
  // buffer). Must not truncate: the real content, at its real length, comes
  // back intact. ---
  {
    const realContent = Buffer.from('this stored entry is longer than its declared size', 'utf8');
    const raw = buildRawZip([
      { name: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: y\n---\nbody', 'utf8') },
      {
        name: 'stored-mismatch.txt',
        data: realContent,
        method: 0,
        declaredSize: 5, // lies: real content is far longer than 5 bytes
      },
    ]);
    const result = extractSkillZipEntries(raw);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resourceEntries.length, 1);
      assert.equal(result.resourceEntries[0].data.toString('utf8'), realContent.toString('utf8'));
      assert.equal(result.resourceEntries[0].data.length, realContent.length);
    }
  }

  // --- 6. writeSkillBundleToDisk + listSkillResourceFiles round-trip. ---
  let roundTripStorageDir!: string;
  {
    roundTripStorageDir = writeSkillBundleToDisk({
      userId: 'user-1',
      skillId: 'skill-1',
      skillMdText: '---\nname: test\ndescription: test\n---\nBody',
      resourceEntries: [
        { relativePath: 'references/a.md', data: Buffer.from('a', 'utf8') },
        { relativePath: 'scripts/run.py', data: Buffer.from('print(1)', 'utf8') },
      ],
    });
    assert.equal(roundTripStorageDir, path.join(SKILLS_DIR, 'user-1', 'skill-1'));
    assert.equal(fs.readFileSync(path.join(roundTripStorageDir, 'SKILL.md'), 'utf8'), '---\nname: test\ndescription: test\n---\nBody');

    const listed = listSkillResourceFiles(roundTripStorageDir);
    assert.equal(listed.length, 2);
    assert.ok(!listed.some((f) => f.path === 'SKILL.md'));
    const byPath = Object.fromEntries(listed.map((f) => [f.path, f.size_bytes]));
    assert.equal(byPath['references/a.md'], 1);
    assert.equal(byPath['scripts/run.py'], 8);
  }

  // --- 6b. writeSkillBundleToDisk always writes the manifest as `SKILL.md`,
  // regardless of the caller's original file's casing (the caller is
  // responsible for passing the raw text; the filename on disk is fixed). ---
  {
    const dir = writeSkillBundleToDisk({
      userId: 'user-1',
      skillId: 'skill-lowercase-source',
      skillMdText: '---\nname: lowercase-source\ndescription: test\n---\nBody',
      resourceEntries: [],
    });
    assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
    deleteSkillStorageDir(dir);
  }

  // --- 6c. writeSkillBundleToDisk rejects an unsafe resourceEntries path
  // before writing anything (no partial writes). ---
  {
    const skillId = 'skill-partial-write-guard';
    const targetDir = path.join(SKILLS_DIR, 'user-1', skillId);
    assert.throws(() => {
      writeSkillBundleToDisk({
        userId: 'user-1',
        skillId,
        skillMdText: '---\nname: guard\ndescription: test\n---\nBody',
        resourceEntries: [
          { relativePath: 'ok.txt', data: Buffer.from('ok', 'utf8') },
          { relativePath: '../../escape.txt', data: Buffer.from('bad', 'utf8') },
        ],
      });
    }, /Unsafe resource path/);
    assert.equal(fs.existsSync(targetDir), false);
  }

  // --- 7. readSkillResourceFile: traversal, missing file, directory, and a
  // valid read, all against a real written storageDir. ---
  {
    const traversal = readSkillResourceFile(roundTripStorageDir, '../../../etc/passwd');
    assert.ok('error' in traversal);

    const traversalAbsolute = readSkillResourceFile(roundTripStorageDir, path.resolve(testDirectory, 'outside.txt'));
    assert.ok('error' in traversalAbsolute);

    const missing = readSkillResourceFile(roundTripStorageDir, 'does-not-exist.txt');
    assert.ok('error' in missing);

    const directory = readSkillResourceFile(roundTripStorageDir, 'references');
    assert.ok('error' in directory);

    const valid = readSkillResourceFile(roundTripStorageDir, 'references/a.md');
    assert.ok('data' in valid);
    if ('data' in valid) {
      assert.equal(valid.data.toString('utf8'), 'a');
    }

    // Confirm nothing outside storageDir was ever touched by the traversal
    // attempt: the file it targeted must not exist.
    assert.equal(fs.existsSync(path.resolve(roundTripStorageDir, '../../../etc/passwd')), false);
  }

  // --- 8. deleteSkillStorageDir never throws, including on an
  // already-nonexistent directory. ---
  {
    deleteSkillStorageDir(roundTripStorageDir);
    assert.equal(fs.existsSync(roundTripStorageDir), false);
    assert.doesNotThrow(() => deleteSkillStorageDir(roundTripStorageDir));
    assert.doesNotThrow(() => deleteSkillStorageDir(path.join(SKILLS_DIR, 'user-1', 'never-existed')));
  }

  // --- 9. isLikelyTextFile heuristic. ---
  {
    assert.equal(isLikelyTextFile(Buffer.from('# hello\nworld', 'utf8'), 'README.md'), true);

    const fakePngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(isLikelyTextFile(fakePngHeader, 'image.png'), false);

    assert.equal(isLikelyTextFile(Buffer.from('fn main() {}\n', 'utf8'), 'main.rs'), true);

    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd, 0xfc]);
    assert.equal(isLikelyTextFile(invalidUtf8, 'weird.rs'), false);
  }

  console.log('skill storage tests passed');
} finally {
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
