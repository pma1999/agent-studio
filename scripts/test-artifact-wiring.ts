import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildArtifactsByMessageIndex, clampPanelPct, shouldAutoOpenPanel } from '../src/utils/artifactWiring.ts';
import type { ChatArtifact } from '../src/types/index.ts';

function makeArtifact(overrides: Partial<ChatArtifact> & Pick<ChatArtifact, 'id' | 'conversation_id'>): ChatArtifact {
  return {
    kind: 'html',
    title: 'Test',
    language: null,
    content: '<html></html>',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_id: null,
    ...overrides,
  };
}

let failures = 0;
let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); passed++; } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

test('buildArtifactsByMessageIndex: groups by message_id, ignores null', () => {
  const a1 = makeArtifact({ id: 'a1', conversation_id: 'c1', message_id: 'm1' });
  const a2 = makeArtifact({ id: 'a2', conversation_id: 'c1', message_id: 'm1' });
  const a3 = makeArtifact({ id: 'a3', conversation_id: 'c1', message_id: 'm2' });
  const a4 = makeArtifact({ id: 'a4', conversation_id: 'c1', message_id: null });
  const map = buildArtifactsByMessageIndex([a1, a2, a3, a4]);
  assert.equal(map.size, 2);
  assert.equal(map.get('m1')!.length, 2);
  assert.equal(map.get('m2')!.length, 1);
  assert.equal(map.has('null' as string), false);
});

test('buildArtifactsByMessageIndex: empty input -> empty map', () => {
  const map = buildArtifactsByMessageIndex([]);
  assert.equal(map.size, 0);
});

test('clampPanelPct: within range unchanged', () => {
  assert.equal(clampPanelPct(45), 45);
  assert.equal(clampPanelPct(30), 30);
  assert.equal(clampPanelPct(60), 60);
});

test('clampPanelPct: clamps to 30–60', () => {
  assert.equal(clampPanelPct(10), 30);
  assert.equal(clampPanelPct(99), 60);
  assert.equal(clampPanelPct(-5), 30);
});

test('clampPanelPct: non-finite -> 38 default', () => {
  assert.equal(clampPanelPct(NaN), 38);
  assert.equal(clampPanelPct(Infinity), 38);
  assert.equal(clampPanelPct(-Infinity), 38);
});

test('shouldAutoOpenPanel: only when panel closed and not yet opened this turn', () => {
  assert.equal(shouldAutoOpenPanel(false, false), true);
  assert.equal(shouldAutoOpenPanel(true, false), false);
  assert.equal(shouldAutoOpenPanel(false, true), false);
  assert.equal(shouldAutoOpenPanel(true, true), false);
});

test('streamChat signature: onArtifact is last param (positional)', () => {
  const src = fs.readFileSync('src/api/client.ts', 'utf8');
  const sig = src.slice(src.indexOf('export async function streamChat'));
  const idxArtifact = sig.indexOf('onArtifact');
  const idxMcp = sig.indexOf('onMcpApprovalRequired');
  assert.ok(idxMcp > 0 && idxArtifact > idxMcp, 'onArtifact must appear after onMcpApprovalRequired');
  // Ensure onArtifact is before the closing ): Promise<void>
  const tail = sig.slice(idxArtifact, idxArtifact + 500);
  assert.ok(tail.includes('ChatArtifact'), 'onArtifact should be typed with ChatArtifact');
});

test('no static mermaid import outside MermaidDiagram', () => {
  const files = ['src/components/ChatView.tsx', 'src/components/MessageBubble.tsx', 'src/hooks/useChat.ts', 'src/api/client.ts'];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/^\s*import\s+.*from\s+['"]mermaid['"]/m.test(s), `${f} must not statically import mermaid`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nartifact-wiring: ${passed} passed, 0 failed — OK`);
