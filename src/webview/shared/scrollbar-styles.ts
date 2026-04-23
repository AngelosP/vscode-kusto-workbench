/**
 * Shared scrollbar stylesheet for both light-DOM and shadow-DOM components.
 *
 * Produces VS Code-style scrollbars: thin rectangular thumbs, no arrow
 * buttons, transparent tracks, and theme-aware colors via the standard
 * `--vscode-scrollbarSlider-*` CSS custom properties.
 *
 * Adoption:
 *   • document.adoptedStyleSheets — covers all light-DOM scrollable elements
 *   • Lit `static styles = [scrollbarSheet, ...]` — covers shadow-DOM components
 *
 * IMPORTANT: Must be a real `CSSStyleSheet` instance — Lit's `adoptStyles`
 * checks `instanceof CSSStyleSheet` and a Proxy wrapper would fail that check.
 */

const css = /* css */ `

/* Custom scrollbar styling via WebKit pseudo-elements.
   These completely replace the native scrollbar — no arrow buttons, no
   native chrome.  Do NOT add scrollbar-width or scrollbar-color alongside
   these; on Chromium 134 the standards properties take precedence and
   re-enable native rendering (including arrows on Windows). */
::-webkit-scrollbar { width: 14px; height: 14px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
::-webkit-scrollbar-corner { background: transparent; }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
export const scrollbarSheet: CSSStyleSheet = sheet;
