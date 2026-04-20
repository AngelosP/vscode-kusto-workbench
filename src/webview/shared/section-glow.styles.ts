import { css } from 'lit';

/**
 * Shared glow effect for sections with unsaved changes.
 *
 * Import into each section's `static styles` array so that `:host([has-changes])`
 * rules target the section element.
 *
 * The glow is rendered via `box-shadow` directly on the host, which paints at the
 * element's own border-box level and cannot be blocked by child elements.
 *
 * NOTE: query and sql sections receive their border/shadow from the outer-context
 * `.query-box` rule in queryEditor.css, which beats shadow-DOM `:host` selectors.
 * Those sections get their glow via `.query-box[has-changes]` rules in
 * queryEditor.css instead — the styles below are harmlessly overridden for them.
 */
export const sectionGlowStyles = css`

	/* ── Glow + border accent (direct on host) ──────────────────────── */

	/* Default (unfocused): static minimum glow, no animation.
	   Sash background is transparent so the section border provides the visual;
	   only the hover accent inherits the glow color. */
	:host([has-changes="modified"]) {
		border-color: rgba(27, 129, 168, 0.3);
		box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(27, 129, 168, 0.12);
		transition: border-color 0.4s ease;
	}
	:host([has-changes="new"]) {
		border-color: rgba(46, 160, 67, 0.3);
		box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(46, 160, 67, 0.12);
		transition: border-color 0.4s ease;
	}

	/* Active (focused): pulsating glow + stronger sash.
	   Gated on the '.is-active-section' class (managed by active-section-tracker.ts)
	   rather than ':focus-within' so brief focus drops while the user is interacting
	   inside the section don't cancel and restart the animation. */
	:host([has-changes="modified"].is-active-section) {
		animation: section-glow-modified 3s ease-in-out infinite alternate;
	}
	:host([has-changes="new"].is-active-section) {
		animation: section-glow-new 3s ease-in-out infinite alternate;
	}

	@keyframes section-glow-modified {
		from { border-color: rgba(27, 129, 168, 0.3);  box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(27, 129, 168, 0.12); }
		to   { border-color: rgba(27, 129, 168, 0.65); box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(27, 129, 168, 0.35); }
	}
	@keyframes section-glow-new {
		from { border-color: rgba(46, 160, 67, 0.3);  box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(46, 160, 67, 0.12); }
		to   { border-color: rgba(46, 160, 67, 0.65); box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(46, 160, 67, 0.35); }
	}

	/* ── Accessibility ───────────────────────────────────────────────── */

	@media (prefers-reduced-motion: reduce) {
		:host([has-changes="modified"].is-active-section) {
			animation: none;
			border-color: rgba(27, 129, 168, 0.55);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(27, 129, 168, 0.35);
		}
		:host([has-changes="new"].is-active-section) {
			animation: none;
			border-color: rgba(46, 160, 67, 0.55);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow), 0 0 12px 3px rgba(46, 160, 67, 0.35);
		}
	}

	@media (forced-colors: active) {
		:host([has-changes="modified"]) {
			animation: none;
			box-shadow: none;
			outline: 2px solid Highlight;
			outline-offset: 1px;
		}
		:host([has-changes="new"]) {
			animation: none;
			box-shadow: none;
			outline: 2px solid Highlight;
			outline-offset: 1px;
		}
	}
`;
