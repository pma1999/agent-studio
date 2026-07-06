import assert from 'node:assert/strict';
import { detectBlock, type BlockDetectionResult, type BlockSignal } from '../server/tools/blockDetection.js';

function assertBlocked(result: BlockDetectionResult, signal: BlockSignal): void {
  assert.equal(result.blocked, true);
  if (result.blocked) {
    assert.equal(result.signal, signal);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
}

assertBlocked(
  detectBlock({
    originHttpStatus: 403,
    content: 'contenido normal suficientemente largo para no activar vacio',
    respondWith: 'markdown',
  }),
  'origin_status'
);

assertBlocked(
  detectBlock({
    originWarning: 'Target URL returned error 403: Forbidden',
    content: 'contenido normal suficientemente largo para no activar vacio',
    respondWith: 'markdown',
  }),
  'origin_warning'
);

assertBlocked(
  detectBlock({
    content: '## Checking your browser before accessing\n\n...',
    respondWith: 'markdown',
  }),
  'text_pattern'
);

assertBlocked(
  detectBlock({
    content: 'ok',
    respondWith: 'markdown',
  }),
  'empty_content'
);

assert.deepEqual(
  detectBlock({
    content:
      '## Walter Benjamin\n\nEste es un articulo normal con varios parrafos y suficiente contenido para superar el umbral de deteccion.',
    respondWith: 'markdown',
  }),
  { blocked: false }
);

assert.deepEqual(
  detectBlock({
    content: 'ok',
    respondWith: 'html',
  }),
  { blocked: false }
);

console.log('web fetch block detection tests passed');