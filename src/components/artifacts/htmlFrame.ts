/**
 * Pure helpers for HtmlPreviewFrame — no DOM, no React.
 * Extracted so node-only tests can import without a browser.
 */

export const IFRAME_SANDBOX_TOKENS =
  'allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-forms';

export const MIN_IFRAME_HEIGHT = 120;
export const MAX_IFRAME_HEIGHT = 4000;

/**
 * Clamp a raw postMessage height into the allowed visible range.
 * Ensures the iframe never collapses nor grows unbounded (GC4, AC).
 */
export function clampHeight(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_IFRAME_HEIGHT;
  return Math.min(MAX_IFRAME_HEIGHT, Math.max(MIN_IFRAME_HEIGHT, Math.round(raw)));
}

/**
 * Bootstrap script injected BEFORE user HTML. Communicates height via
 * postMessage({ type:'artifact-resize', height:number }).
 *
 * Literal adaptation of integration-render-libraries.md §2 "Script interno de resize"
 * with debounce ~100 ms (risk #4) to avoid flooding on animated content.
 * Uses '*' targetOrigin because the parent origin serialises as "null" under
 * sandbox without allow-same-origin — parent filters by e.source instead (GC4).
 */
export const RESIZE_BOOTSTRAP_SCRIPT = `<script>
(function(){
  var t=null;
  var lastH=-1;
  function post(){
    try{
      var h=document.body?document.body.scrollHeight:0;
      if(Math.abs(h-lastH)<=2) return;
      lastH=h;
      parent.postMessage({type:'artifact-resize',height:h},'*');
    }catch(e){}
  }
  function schedule(){
    if(t) return;
    t=setTimeout(function(){t=null;post();},100);
  }
  window.addEventListener('load',schedule);
  window.addEventListener('resize',schedule);
  window.addEventListener('DOMContentLoaded',schedule);
  if('ResizeObserver' in window){
    try{ new ResizeObserver(schedule).observe(document.body); }catch(e){}
  }
  try{ new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true}); }catch(e){}
  post();
})();
</script>`;

export function buildBootstrapWrappedHtml(source: string): string {
  return RESIZE_BOOTSTRAP_SCRIPT + source;
}
