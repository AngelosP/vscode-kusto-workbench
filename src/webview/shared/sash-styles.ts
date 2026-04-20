/**
 * Shared sash / resizer stylesheet for both light-DOM and shadow-DOM components.
 *
 * Provides two layout variants:
 *   `.resizer`   — horizontal sash (ns-resize, grows height on hover)
 *   `.resizer-v` — vertical sash   (ew-resize, grows width on hover)
 *
 * Colors and dimensions are controlled via CSS custom properties so that
 * consumers can override them contextually (e.g. glow-accent on unsaved
 * sections):
 *
 *   --kw-sash-bg             Resting background (default: panel border)
 *   --kw-sash-accent         Hover / drag highlight (default: VS Code sash blue)
 *   --kw-sash-hover-size     Thickness of the highlight bar (default: 4px)
 *   --kw-sash-reveal-delay   Delay before hover highlight appears (default: 0.5s)
 *
 * Adoption:
 *   • document.adoptedStyleSheets — covers all light-DOM resizers
 *   • Lit `static styles = [sashSheet, ...]` — covers shadow-DOM components
 *
 * IMPORTANT: Must be a real `CSSStyleSheet` instance — Lit's `adoptStyles`
 * checks `instanceof CSSStyleSheet` and a Proxy wrapper would fail that check.
 */

const css = /* css */ `

/* ── Horizontal sash (ns-resize) ─────────────────────────────── */

.resizer {
	flex: 0 0 1px;
	height: 1px;
	cursor: ns-resize;
	background: var(--kw-sash-bg, var(--vscode-panel-border, rgba(128,128,128,0.35)));
	position: relative;
	touch-action: none;
	z-index: 1;
}

/* Extended hit area for comfortable resizing */
.resizer::after {
	content: '';
	position: absolute;
	left: 0;
	right: 0;
	top: -3px;
	bottom: -3px;
}

/* Sash highlight on hover / drag */
.resizer::before {
	content: '';
	position: absolute;
	left: 0;
	right: 0;
	top: 50%;
	height: 0;
	transform: translateY(-50%);
	background: var(--kw-sash-accent, var(--vscode-sash-hoverBorder, #007fd4));
	transition: height 0.1s ease;
	pointer-events: none;
	z-index: 1;
}

.resizer:hover::before {
	height: var(--kw-sash-hover-size, 4px);
	transition-delay: var(--kw-sash-reveal-delay, 0.5s);
}

.resizer.is-dragging::before {
	height: var(--kw-sash-hover-size, 4px);
	transition-delay: 0s;
}

/* ── Vertical sash (ew-resize) ───────────────────────────────── */

.resizer-v {
	flex: 0 0 1px;
	width: 1px;
	cursor: ew-resize;
	background: var(--kw-sash-bg, var(--vscode-panel-border, rgba(128,128,128,0.35)));
	position: relative;
	touch-action: none;
	z-index: 1;
}

/* Extended hit area */
.resizer-v::after {
	content: '';
	position: absolute;
	top: 0;
	bottom: 0;
	left: -3px;
	right: -3px;
}

/* Sash highlight on hover / drag */
.resizer-v::before {
	content: '';
	position: absolute;
	top: 0;
	bottom: 0;
	left: 50%;
	width: 0;
	transform: translateX(-50%);
	background: var(--kw-sash-accent, var(--vscode-sash-hoverBorder, #007fd4));
	transition: width 0.1s ease;
	pointer-events: none;
	z-index: 1;
}

.resizer-v:hover::before {
	width: var(--kw-sash-hover-size, 4px);
	transition-delay: var(--kw-sash-reveal-delay, 0.5s);
}

.resizer-v.is-dragging::before {
	width: var(--kw-sash-hover-size, 4px);
	transition-delay: 0s;
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
export const sashSheet: CSSStyleSheet = sheet;
