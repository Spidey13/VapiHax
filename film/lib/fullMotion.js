// The film shows the app's designed motion even when the machine rendering it asks for reduced motion
// (Windows with "Animation effects" off makes Chrome report prefers-reduced-motion: reduce). The app honours
// that setting in two places, and both are switched off here, for the film page only:
//  - style.css's @media (prefers-reduced-motion: reduce) block, set to match nothing;
//  - the app's script checks of that query (render.js, branchMapView.js), answered "no".
// The app's files stay untouched.

const QUERY = /prefers-reduced-motion\s*:\s*reduce/;

let patched = false;
export function forceFullMotion() {
  if (!patched) {
    patched = true;
    const original = window.matchMedia.bind(window);
    window.matchMedia = (q) => (QUERY.test(q) ? original('not all') : original(q));
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // a cross-origin sheet: not ours
    for (const r of Array.from(rules)) {
      if (r instanceof CSSMediaRule && QUERY.test(r.conditionText ?? r.media.mediaText)) r.media.mediaText = 'not all';
    }
  }
}
