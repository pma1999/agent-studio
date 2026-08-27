import assert from 'node:assert/strict';
import {
  buildBootstrapWrappedHtml,
  clampHeight,
  IFRAME_SANDBOX_TOKENS,
  RESIZE_BOOTSTRAP_SCRIPT,
  MIN_IFRAME_HEIGHT,
  MAX_IFRAME_HEIGHT,
} from '../src/components/artifacts/htmlFrame';

let passed = 0;
let failed = 0;

function ok(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    failed++;
  }
}

ok('sandbox tokens exact — no allow-same-origin', () => {
  assert.equal(IFRAME_SANDBOX_TOKENS, 'allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-forms');
  assert.equal(IFRAME_SANDBOX_TOKENS.includes('allow-same-origin'), false);
  // required tokens present
  for (const tok of ['allow-scripts', 'allow-modals', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-forms']) {
    assert.ok(IFRAME_SANDBOX_TOKENS.split(' ').includes(tok), `missing token ${tok}`);
  }
});

ok('bootstrap script contains artifact-resize + debounce', () => {
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes('artifact-resize'), 'missing message type');
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes('setTimeout'), 'missing debounce');
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes('100'), 'missing 100ms debounce');
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes("parent.postMessage"), 'missing postMessage');
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes("'*'"), 'missing wildcard targetOrigin');
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes('ResizeObserver'), 'missing ResizeObserver');
  assert.ok(RESIZE_BOOTSTRAP_SCRIPT.includes('MutationObserver'), 'missing MutationObserver');
});

ok('buildBootstrapWrappedHtml includes marker + script + user html intact', () => {
  const marker = '<div id="marker-xyz">hello world</div>';
  const wrapped = buildBootstrapWrappedHtml(marker);
  assert.ok(wrapped.includes(RESIZE_BOOTSTRAP_SCRIPT.slice(0, 40)), 'script not prepended');
  assert.ok(wrapped.includes(marker), 'user html not intact');
  assert.ok(wrapped.indexOf('<script>') < wrapped.indexOf(marker), 'script must be before user html');
});

ok('buildBootstrapWrappedHtml preserves script tags in user html', () => {
  const html = '<script>alert(1)</script><p>hi</p>';
  const wrapped = buildBootstrapWrappedHtml(html);
  assert.ok(wrapped.includes(html), 'user script not preserved verbatim');
});

ok('clampHeight — min guard', () => {
  assert.equal(clampHeight(0), MIN_IFRAME_HEIGHT);
  assert.equal(clampHeight(-100), MIN_IFRAME_HEIGHT);
  assert.equal(clampHeight(50), MIN_IFRAME_HEIGHT);
  assert.equal(clampHeight(120), 120);
});

ok('clampHeight — max guard', () => {
  assert.equal(clampHeight(20000), MAX_IFRAME_HEIGHT);
  assert.equal(clampHeight(4000), 4000);
  assert.equal(clampHeight(4001), 4000);
});

ok('clampHeight — normal + NaN/Infinity', () => {
  assert.equal(clampHeight(320), 320);
  assert.equal(clampHeight(500.6), 501);
  assert.equal(clampHeight(NaN), MIN_IFRAME_HEIGHT);
  assert.equal(clampHeight(Infinity), MIN_IFRAME_HEIGHT);
  assert.equal(clampHeight(-Infinity), MIN_IFRAME_HEIGHT);
});

ok('no static mermaid import in viewers (textual guard)', async () => {
  const fs = await import('node:fs');
  const files = ['src/components/artifacts/MermaidDiagram.tsx', 'src/components/artifacts/ArtifactViewer.tsx', 'src/components/artifacts/ArtifactPanel.tsx', 'src/components/artifacts/HtmlPreviewFrame.tsx'];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // forbid: import mermaid from 'mermaid'  or import * as mermaid / from "mermaid"
    const hasStaticMermaid = /^\s*import\s+.*from\s+['"]mermaid['"]/m.test(src);
    assert.equal(hasStaticMermaid, false, `${f} has static mermaid import`);
  }
  // MermaidDiagram must use dynamic import('mermaid')
  const mermaidSrc = fs.readFileSync('src/components/artifacts/MermaidDiagram.tsx', 'utf8');
  assert.ok(mermaidSrc.includes("import('mermaid')"), 'MermaidDiagram must use dynamic import');
});

console.log(`\nartifact-render-utils: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('artifact-render-utils: OK');
