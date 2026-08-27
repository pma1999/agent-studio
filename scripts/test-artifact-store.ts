import assert from 'node:assert/strict';
import { useStore } from '../src/stores/store.ts';
import type { ChatArtifact } from '../src/types/index.ts';

function makeArtifact(overrides: Partial<ChatArtifact> & Pick<ChatArtifact, 'id' | 'conversation_id'>): ChatArtifact {
  return {
    kind: 'html',
    title: 'Test artifact',
    language: null,
    content: '<html></html>',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_id: null,
    ...overrides,
  };
}

function resetStore() {
  // Reset all artifact state to clean slate without touching unrelated keys.
  // Zustand allows partial setState.
  useStore.setState({
    artifactsByConversation: {},
    activeArtifactId: null,
    artifactPanelOpen: false,
  } as any);
}

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof assert.AssertionError) {
      console.error(err.stack);
    }
  }
}

// Ensure store exposes expected shape
test('store exposes state + actions with exact names', () => {
  const s = useStore.getState();
  assert.ok('artifactsByConversation' in s, 'missing artifactsByConversation');
  assert.ok('activeArtifactId' in s, 'missing activeArtifactId');
  assert.ok('artifactPanelOpen' in s, 'missing artifactPanelOpen');
  assert.equal(typeof s.upsertConversationArtifact, 'function');
  assert.equal(typeof s.hydrateConversationArtifacts, 'function');
  assert.equal(typeof s.setActiveArtifact, 'function');
  assert.equal(typeof s.closeArtifactPanel, 'function');
  assert.equal(typeof s.clearConversationArtifacts, 'function');
});

// upsert merge estable — first artifact auto-selects, last frame gana, panelOpen-aware
test('upsert: first artifact auto-selects even when panel closed', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA', title: 'A1', content: 'v1' });
  useStore.getState().upsertConversationArtifact('convA', art1);
  let s = useStore.getState();
  assert.deepEqual(s.artifactsByConversation['convA'], { a1: art1 });
  assert.equal(s.activeArtifactId, 'a1', 'first artifact should auto-select');
  assert.equal(s.artifactPanelOpen, false, 'upsert must NOT open panel by itself');
});

test('upsert: second artifact when panel open with same-conv active auto-selects last', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  const art2 = makeArtifact({ id: 'a2', conversation_id: 'convA' });
  // first upsert
  useStore.getState().upsertConversationArtifact('convA', art1);
  // open panel via setActive
  useStore.getState().setActiveArtifact('convA', 'a1');
  let s = useStore.getState();
  assert.equal(s.artifactPanelOpen, true);
  assert.equal(s.activeArtifactId, 'a1');
  // second upsert — panel open & active belongs to same conv => should auto-select a2
  useStore.getState().upsertConversationArtifact('convA', art2);
  s = useStore.getState();
  assert.equal(s.artifactsByConversation['convA']['a2'].id, 'a2');
  assert.equal(Object.keys(s.artifactsByConversation['convA']).length, 2);
  assert.equal(s.activeArtifactId, 'a2', 'panel open + same conv active => auto-select last');
});

test('upsert: merge stable — same id last frame gana (shallow copy bucket)', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA', content: 'v1', version: 1 });
  useStore.getState().upsertConversationArtifact('convA', art1);
  useStore.getState().setActiveArtifact('convA', 'a1'); // open panel
  const art1v2 = makeArtifact({ id: 'a1', conversation_id: 'convA', content: 'v2 updated', version: 2 });
  const prevBucketRef = useStore.getState().artifactsByConversation['convA'];
  useStore.getState().upsertConversationArtifact('convA', art1v2);
  const s = useStore.getState();
  assert.equal(s.artifactsByConversation['convA']['a1'].content, 'v2 updated');
  assert.equal(s.artifactsByConversation['convA']['a1'].version, 2);
  assert.notEqual(s.artifactsByConversation['convA'], prevBucketRef, 'bucket must be shallow-copied');
  assert.equal(s.activeArtifactId, 'a1');
});

test('upsert: panel open but active belongs to other conv — no auto-select except first-in-conv', () => {
  resetStore();
  const artA1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', artA1);
  useStore.getState().setActiveArtifact('convA', 'a1'); // panel open with convA
  // first artifact in convB should auto-select because isFirstInConversation true, even though active was convA
  const artB1 = makeArtifact({ id: 'b1', conversation_id: 'convB' });
  useStore.getState().upsertConversationArtifact('convB', artB1);
  let s = useStore.getState();
  assert.equal(s.activeArtifactId, 'b1', 'first in convB should auto-select regardless of previous active conv');
  // second in convB when active is b1 (same conv) => auto-select
  const artB2 = makeArtifact({ id: 'b2', conversation_id: 'convB' });
  useStore.getState().upsertConversationArtifact('convB', artB2);
  s = useStore.getState();
  assert.equal(s.activeArtifactId, 'b2');
  // now active is convB, add second to convA (not first, panel open but active NOT in convA) => should NOT auto-select
  const artA2 = makeArtifact({ id: 'a2', conversation_id: 'convA' });
  // active is b2 (convB), prevBucket convA has a1, so activeBelongsToThisConv = false => should NOT auto-select
  useStore.getState().upsertConversationArtifact('convA', artA2);
  s = useStore.getState();
  assert.equal(s.activeArtifactId, 'b2', 'upsert to convA when active is convB and not first should NOT change active');
  assert.equal(Object.keys(s.artifactsByConversation['convA']).length, 2);
});

test('upsert: when panel closed, non-first does NOT auto-select', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', art1);
  // panel is closed, active is a1 from first
  let s = useStore.getState();
  assert.equal(s.artifactPanelOpen, false);
  assert.equal(s.activeArtifactId, 'a1');
  // close panel already closed, manually set panel closed but active stays
  useStore.getState().closeArtifactPanel(); // remains false
  const art2 = makeArtifact({ id: 'a2', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', art2);
  s = useStore.getState();
  // panel closed => shouldAutoSelect false (needs panel open), so active remains a1
  assert.equal(s.activeArtifactId, 'a1', 'when panel closed, non-first upsert must not change active');
});

test('hydrate: replace-all and active reset when not in new bucket, panel stays open', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  const art2 = makeArtifact({ id: 'a2', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', art1);
  useStore.getState().upsertConversationArtifact('convA', art2);
  // need panel open to test hydrate panel preservation
  useStore.getState().setActiveArtifact('convA', 'a2');
  let s = useStore.getState();
  assert.equal(s.artifactPanelOpen, true);
  // hydrate with only art1 (art2 removed)
  useStore.getState().hydrateConversationArtifacts('convA', [art1]);
  s = useStore.getState();
  assert.deepEqual(Object.keys(s.artifactsByConversation['convA']), ['a1'], 'hydrate must replace bucket');
  assert.equal(s.activeArtifactId, null, 'active not in new bucket => reset to null');
  assert.equal(s.artifactPanelOpen, true, 'panel stays open (empty-state) after hydrate reset');
  // hydrate with art1 still present, active is null, but panel open — hydrate should keep null active if we hydrate again without that id?
  // Now set active to a1, then hydrate with a1+a2 again => active preserved
  useStore.getState().setActiveArtifact('convA', 'a1');
  useStore.getState().hydrateConversationArtifacts('convA', [art1, art2]);
  s = useStore.getState();
  assert.equal(s.activeArtifactId, 'a1', 'active still in new bucket => preserved');
  assert.equal(s.artifactPanelOpen, true);
});

test('hydrate: empty array clears bucket but keeps panel open state', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', art1);
  useStore.getState().setActiveArtifact('convA', 'a1');
  useStore.getState().hydrateConversationArtifacts('convA', []);
  const s = useStore.getState();
  assert.deepEqual(s.artifactsByConversation['convA'], {});
  assert.equal(s.activeArtifactId, null);
  assert.equal(s.artifactPanelOpen, true, 'panel remains open showing empty-state');
});

test('setActive: co-set panelOpen when id !== null', () => {
  resetStore();
  useStore.getState().setActiveArtifact('convA', 'a1');
  let s = useStore.getState();
  assert.equal(s.activeArtifactId, 'a1');
  assert.equal(s.artifactPanelOpen, true);
  // setActive with null should set active null but not close panel
  useStore.getState().setActiveArtifact(null, null);
  s = useStore.getState();
  assert.equal(s.activeArtifactId, null);
  assert.equal(s.artifactPanelOpen, true, 'setActive(null) must not close panel');
});

test('closeArtifactPanel: only sets panelOpen false, preserves selection', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', art1);
  useStore.getState().setActiveArtifact('convA', 'a1');
  useStore.getState().closeArtifactPanel();
  const s = useStore.getState();
  assert.equal(s.artifactPanelOpen, false);
  assert.equal(s.activeArtifactId, 'a1', 'close must preserve selection for instant re-open');
  assert.ok(s.artifactsByConversation['convA']['a1'], 'bucket untouched');
});

test('clearConversationArtifacts: deletes bucket and resets active/panel only if active was in that bucket', () => {
  resetStore();
  const artA1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  const artB1 = makeArtifact({ id: 'b1', conversation_id: 'convB' });
  useStore.getState().upsertConversationArtifact('convA', artA1);
  useStore.getState().upsertConversationArtifact('convB', artB1);
  useStore.getState().setActiveArtifact('convA', 'a1'); // active in convA, panel open
  // clear convA => should reset active and close panel
  useStore.getState().clearConversationArtifacts('convA');
  let s = useStore.getState();
  assert.equal(s.artifactsByConversation['convA'], undefined);
  assert.ok(s.artifactsByConversation['convB'], 'other bucket intact');
  assert.equal(s.activeArtifactId, null);
  assert.equal(s.artifactPanelOpen, false);

  // reset: active in convB, clear convA (active NOT in that bucket) => no reset
  resetStore();
  useStore.getState().upsertConversationArtifact('convA', artA1);
  useStore.getState().upsertConversationArtifact('convB', artB1);
  useStore.getState().setActiveArtifact('convB', 'b1');
  useStore.getState().clearConversationArtifacts('convA');
  s = useStore.getState();
  assert.equal(s.artifactsByConversation['convA'], undefined);
  assert.equal(s.activeArtifactId, 'b1', 'active not in cleared bucket => preserved');
  assert.equal(s.artifactPanelOpen, true, 'panel stays open when cleared bucket did not own active');
});

test('clearConversationArtifacts: no-op when bucket missing', () => {
  resetStore();
  const art1 = makeArtifact({ id: 'a1', conversation_id: 'convA' });
  useStore.getState().upsertConversationArtifact('convA', art1);
  useStore.getState().setActiveArtifact('convA', 'a1');
  const before = useStore.getState();
  useStore.getState().clearConversationArtifacts('nonexistent');
  const after = useStore.getState();
  assert.deepEqual(after.artifactsByConversation, before.artifactsByConversation);
  assert.equal(after.activeArtifactId, before.activeArtifactId);
  assert.equal(after.artifactPanelOpen, before.artifactPanelOpen);
});

// Verify type-only re-export compiles: runtime check that shared file exists and shape is correct
test('shared/artifactTypes contract shape (runtime)', async () => {
  const mod = await import('../shared/artifactTypes.ts');
  assert.ok(Array.isArray(mod.ARTIFACT_KINDS));
  assert.ok(mod.ARTIFACT_KINDS.includes('html'));
  assert.equal(mod.MAX_ARTIFACT_CONTENT_CHARS, 400_000);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nartifact-store: OK');
