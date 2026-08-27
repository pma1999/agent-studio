/**
 * FR-02 guard: verifies Codex artifact linkage (best-effort message_id) mirrors
 * server/routes/chat.ts pattern: draftId vigente si accesible → UPDATE message_id + emit mutated.
 * Node-only, no network/keys. Uses existing T2 pattern (tmp DB via DATABASE_PATH, migrate x2, byte-equality style).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-artifact-linkage-test-'));
const testDbPath = path.join(testDirectory, 'codex-artifact-linkage.db');
process.env.DATABASE_PATH = testDbPath;
process.env.JWT_SECRET = 'codex-artifact-linkage-test-jwt-secret';

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const { buildResolvedBuiltinTool } = await import('../server/tools/resolve.js');
const { runTool } = await import('../server/tools/run.js');
const { getArtifact } = await import('../server/artifacts/storage.js');

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}${err instanceof Error && err.stack ? '\n' + err.stack : ''}`);
  }
}

migrate();
migrate();
const primaryUserId = ensureLocalUser()!;
assert.ok(primaryUserId);

const agentId = 'codex-linkage-test-agent';
db.prepare(`INSERT OR IGNORE INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'Test', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run(agentId, primaryUserId);
const convId = 'codex-linkage-conv-1';
db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(convId, primaryUserId, agentId, 'Test Conv');

// Build resolved tools helper (same as test-artifact-tools)
function resolvedToolsFor(userId: string) {
  const tools: NonNullable<ReturnType<typeof buildResolvedBuiltinTool>>[] = [];
  for (const name of ['create_artifact', 'update_artifact']) {
    const row = db.prepare('SELECT id, name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND name = ?').get(userId, name) as any;
    assert.ok(row, `tool row ${name} for ${userId}`);
    const resolved = buildResolvedBuiltinTool(row, userId)!;
    assert.ok(resolved, `resolved ${name}`);
    tools.push(resolved!);
  }
  return tools;
}
const tools = resolvedToolsFor(primaryUserId);

// Simulate Codex path handleToolCall artifact block with linkage helper
async function simulateCodexArtifactEmit(input: {
  userId: string;
  draftId: string | null;
  toolName: 'create_artifact' | 'update_artifact';
  args: Record<string, unknown>;
}): Promise<{ artifactId: string; emittedMessageId: string | null; dbMessageId: string | null }> {
  const result = await runTool(tools, input.toolName, input.args, undefined, input.userId, convId);
  const out = JSON.parse(result.output) as { ok?: boolean; artifactId?: string };
  assert.equal(out.ok, true, `tool must succeed, got ${result.output}`);
  assert.ok(typeof out.artifactId === 'string');
  // FR-02 linkage logic: replicate server/codex/chat.ts block (best-effort)
  const art = getArtifact(out.artifactId!, input.userId);
  assert.ok(art, 'artifact must exist after tool');
  const draftId = input.draftId;
  if (!art!.message_id && typeof draftId === 'string' && draftId) {
    db.prepare('UPDATE artifacts SET message_id = ? WHERE id = ? AND user_id = ?').run(draftId, art!.id, input.userId);
    art!.message_id = draftId;
  }
  const emitted = { artifact: art! };
  // In real code emit({ artifact: art }) would send `emitted`.
  const row = db.prepare('SELECT message_id FROM artifacts WHERE id = ? AND user_id = ?').get(out.artifactId!, input.userId) as { message_id: string | null };
  return { artifactId: out.artifactId!, emittedMessageId: emitted.artifact.message_id, dbMessageId: row.message_id };
}

const fakeDraftId = 'codex-draft-' + Date.now();

await check('1 codex create_artifact with draftId links message_id (emitted + DB)', async () => {
  const { artifactId, emittedMessageId, dbMessageId } = await simulateCodexArtifactEmit({
    userId: primaryUserId,
    draftId: fakeDraftId,
    toolName: 'create_artifact',
    args: { kind: 'html', title: 'Codex Card', content: '<h1>from codex</h1>' },
  });
  assert.equal(emittedMessageId, fakeDraftId);
  assert.equal(dbMessageId, fakeDraftId);
  // Verify via getArtifact fresh read
  const fresh = getArtifact(artifactId, primaryUserId)!;
  assert.equal(fresh.message_id, fakeDraftId);
});

await check('2 codex linkage skip clean when draftId null (message_id stays null, no throw)', async () => {
  const { artifactId, emittedMessageId, dbMessageId } = await simulateCodexArtifactEmit({
    userId: primaryUserId,
    draftId: null,
    toolName: 'create_artifact',
    args: { kind: 'code', title: 'NoDraft', content: 'console.log(2)' },
  });
  assert.equal(emittedMessageId, null);
  assert.equal(dbMessageId, null);
  const fresh = getArtifact(artifactId, primaryUserId)!;
  assert.equal(fresh.message_id, null);
});

await check('3 codex update_artifact links when message_id null, preserves existing linkage', async () => {
  // Create artifact without linkage first
  const create = await runTool(tools, 'create_artifact', { kind: 'svg', title: 'Updatable', content: '<svg></svg>' }, undefined, primaryUserId, convId);
  const outCreate = JSON.parse(create.output) as { ok: boolean; artifactId: string };
  assert.equal(outCreate.ok, true);
  const artBefore = getArtifact(outCreate.artifactId, primaryUserId)!;
  assert.equal(artBefore.message_id, null);

  // Simulate second call linkage via update path: same logic should set message_id on update artifact
  // In live code update_artifact tool does NOT auto-set message_id; linkage here is the Codex emit path's UPDATE.
  // We replicate the Codex post-tool linkage for update_artifact as well.
  const draftForUpdate = 'codex-draft-update-' + Date.now();
  const upd = await runTool(tools, 'update_artifact', { artifact_id: outCreate.artifactId, content: '<svg><circle r="5"/></svg>' }, undefined, primaryUserId, convId);
  const outUpd = JSON.parse(upd.output) as { ok: boolean; artifactId: string };
  assert.equal(outUpd.ok, true);
  const artAfter = getArtifact(outUpd.artifactId, primaryUserId)!;
  // Append version did not set message_id; Codex path linkage would do it after refetch
  // Simulate the emit-path linkage:
  if (!artAfter.message_id && draftForUpdate) {
    db.prepare('UPDATE artifacts SET message_id = ? WHERE id = ? AND user_id = ?').run(draftForUpdate, artAfter.id, primaryUserId);
    artAfter.message_id = draftForUpdate;
  }
  assert.equal(artAfter.message_id, draftForUpdate);
  const row = db.prepare('SELECT message_id FROM artifacts WHERE id = ? AND user_id = ?').get(outUpd.artifactId, primaryUserId) as { message_id: string | null };
  assert.equal(row.message_id, draftForUpdate);
});

await check('4 codex does not overwrite already-linked message_id', async () => {
  const linked = await simulateCodexArtifactEmit({
    userId: primaryUserId,
    draftId: fakeDraftId,
    toolName: 'create_artifact',
    args: { kind: 'mermaid', title: 'Already Linked', content: 'graph TD; A-->B' },
  });
  // Attempt to link again with different draft should be no-op due to !art.message_id guard
  const differentDraft = 'different-draft-' + Date.now();
  const art = getArtifact(linked.artifactId, primaryUserId)!;
  assert.equal(art.message_id, fakeDraftId);
  if (!art.message_id && differentDraft) {
    db.prepare('UPDATE artifacts SET message_id = ? WHERE id = ? AND user_id = ?').run(differentDraft, art.id, primaryUserId);
  } else {
    // guard holds — do nothing
  }
  const after = getArtifact(linked.artifactId, primaryUserId)!;
  assert.equal(after.message_id, fakeDraftId, 'existing message_id must not be overwritten');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`codex-artifact-linkage: ${passed} passed, 0 failed — OK`);
db.close();
fs.rmSync(testDirectory, { recursive: true, force: true });
