/**
 * Shared OverlayScrollbars VS Code theme overrides.
 *
 * Applied on top of the OverlayScrollbars library CSS to match VS Code's
 * scrollbar appearance: 14px rail, 8px rounded thumb, theme-aware colors.
 *
 * Usage:
 *   • document.adoptedStyleSheets — for light-DOM containers
 *   • Lit `static styles = [osThemeSheet, ...]` — for Shadow DOM components
 *
 * IMPORTANT: Must be a real `CSSStyleSheet` instance — Lit's `adoptStyles`
 * checks `instanceof CSSStyleSheet`.
 */

const css = /* css */ `
.os-scrollbar { --os-padding-perpendicular: 3px; }
.os-scrollbar-vertical { width: 14px; }
.os-scrollbar-horizontal { height: 14px; }
.os-scrollbar .os-scrollbar-track { background: transparent; }
.os-scrollbar .os-scrollbar-handle { background: var(--vscode-scrollbarSlider-background); border-radius: var(--vscode-cornerRadius-small, 4px); }
.os-scrollbar .os-scrollbar-handle:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
.os-scrollbar .os-scrollbar-handle:active,
.os-scrollbar .os-scrollbar-handle.active { background: var(--vscode-scrollbarSlider-activeBackground); }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
export const osThemeSheet: CSSStyleSheet = sheet;
