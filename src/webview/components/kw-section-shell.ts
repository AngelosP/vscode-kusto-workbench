import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styles } from './kw-section-shell.styles.js';
import { codiconSheet } from '../shared/codicon-styles.js';

// ─── SVG icon constants (matching kw-chart-section.ts) ────────────────────────

const SVG_CLOSE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>';
const SVG_EYE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>';
const SVG_FIT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 6V3h3"/><path d="M13 10v3h-3"/><path d="M3 3l4 4"/><path d="M13 13l-4-4"/></svg>';
const SVG_COPILOT_SMALL = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="10" height="9" rx="2" /><path d="M6 12v1" /><path d="M10 12v1" /><circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" /><circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" /><path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" /></svg>';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-section-shell>` — Reusable section chrome wrapper.
 *
 * Provides the common header UI (drag handle, name input, show/hide toggle, close
 * button) with named slots for section-specific header buttons and body content.
 *
 * This component is PURE UI — it dispatches events and sections handle all logic.
 *
 * Slots:
 * - `header-buttons` — placed inside the header actions area, before the divider
 * - `header-extra` — rendered below the header row
 * - (default) — main body content, hidden when collapsed
 */
@customElement('kw-section-shell')
export class KwSectionShell extends LitElement {

	/** Section name displayed in the header input. */
	@property({ type: String })
	name = '';

	/** Whether the body content is visible. */
	@property({ type: Boolean })
	expanded = true;

	/** Section identifier, included in event details. */
	@property({ type: String, attribute: 'box-id' })
	boxId = '';

	/** Placeholder text for the name input. */
	@property({ type: String, attribute: 'name-placeholder' })
	namePlaceholder = 'Section name';

	/**
	 * Unsaved-change indicator: '' (none), 'modified', or 'new'.
	 * Reflected to the `has-changes` attribute for CSS styling.
	 */
	@property({ type: String, reflect: true, attribute: 'has-changes' })
	hasChanges: '' | 'modified' | 'new' = '';

	/** Whether to show the diff button in the header. */
	@property({ type: Boolean, attribute: 'show-diff-btn' })
	showDiffBtn = false;

	/**
	 * Whether this section was modified by Copilot or an agent tool.
	 * Reflected to the `agent-touched` attribute for CSS styling.
	 */
	@property({ type: Boolean, reflect: true, attribute: 'agent-touched' })
	agentTouched = false;

	@state() private _hasHeaderButtons = false;
	@state() private _copilotLogoUri = '';

	static override styles = [codiconSheet, styles];

	override connectedCallback(): void {
		super.connectedCallback();
		const cfg = (window as any).__kustoQueryEditorConfig;
		this._copilotLogoUri = (cfg && cfg.copilotLogoUri) ? String(cfg.copilotLogoUri) : '';
	}

	override render() {
		const showCopilotBadge = this.agentTouched && !!this.hasChanges;
		return html`
			<div class="section-header">
				${showCopilotBadge ? html`
				<span class="agent-touched-icon" title="Modified by Copilot">
					${this._copilotLogoUri
						? html`<img src=${this._copilotLogoUri} width="12" height="12" alt="" aria-hidden="true" />`
						: html`<span .innerHTML=${SVG_COPILOT_SMALL}></span>`}
				</span>
				` : nothing}
				<div class="query-name-group">
					<button type="button" class="section-drag-handle" draggable="true"
						title="Drag to reorder" aria-label="Reorder section"
						@dragstart=${this._onDragStart}>
						<span class="section-drag-handle-glyph" aria-hidden="true">⋮</span>
					</button>
					<input type="text" class="query-name"
						.value=${this.name}
						placeholder=${this.namePlaceholder}
						@input=${this._onNameInput} />
				</div>
				<div class="section-actions">
					<div class="md-tabs" role="tablist" aria-label="Section tools">
						${this.expanded ? html`
						<slot name="header-buttons" @slotchange=${this._onHeaderButtonsSlotChange}></slot>
						${this._hasHeaderButtons ? html`<span class="md-tabs-divider" aria-hidden="true"></span>` : nothing}
						` : nothing}
						${this.showDiffBtn ? html`
						<button class="unified-btn-secondary md-tab diff-btn"
							type="button" @click=${this._onDiffClick}
							title="Show unsaved changes" aria-label="Show unsaved changes">
							<span class="codicon codicon-git-compare" aria-hidden="true"></span>
						</button>
						` : nothing}
						${this.expanded ? html`
						<button class="unified-btn-secondary md-tab md-max-btn"
							type="button" @click=${this._onFitToContents}
							title="Fit to contents" aria-label="Fit to contents">
							<span .innerHTML=${SVG_FIT}></span>
						</button>
						` : nothing}
						<button class="unified-btn-secondary md-tab toggle-btn ${this.expanded ? 'is-active' : ''}"
							type="button" role="tab"
							aria-selected=${this.expanded ? 'true' : 'false'}
							@click=${this._onToggle}
							title=${(this.expanded ? 'Hide' : 'Show') + '\n\nClick + Shift: ' + (this.expanded ? 'Hide' : 'Show') + ' all\nClick + Ctrl + Shift: ' + (this.expanded ? 'Hide' : 'Show') + ' same type'}
							aria-label=${this.expanded ? 'Hide' : 'Show'}>
							<span .innerHTML=${SVG_EYE}></span>
						</button>
					</div>
					<button class="unified-btn-secondary unified-btn-icon-only close-btn"
						type="button" @click=${this._onClose}
						title="Remove" aria-label="Remove">
						<span .innerHTML=${SVG_CLOSE}></span>
					</button>
				</div>
			</div>
			${this.expanded ? html`
				<slot name="header-extra"></slot>
				<slot></slot>
			` : nothing}
		`;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _onHeaderButtonsSlotChange(e: Event): void {
		const slot = e.target as HTMLSlotElement;
		this._hasHeaderButtons = (slot.assignedElements().length > 0);
	}

	private _onDragStart(e: DragEvent): void {
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', this.boxId);
			e.dataTransfer.effectAllowed = 'move';
		}
		this.dispatchEvent(new CustomEvent('section-drag-start', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true,
		}));
	}

	private _onNameInput(e: Event): void {
		const val = (e.target as HTMLInputElement).value;
		this.dispatchEvent(new CustomEvent('name-change', {
			detail: { name: val },
			bubbles: true,
			composed: true,
		}));
	}

	private _onToggle(e: MouseEvent): void {
		const targetExpanded = !this.expanded;
		if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
			// Ctrl+Shift+Click: toggle all sections of the same type
			this.dispatchEvent(new CustomEvent('toggle-type-sections', {
				detail: { targetExpanded },
				bubbles: true,
				composed: true,
			}));
			return;
		}
		if (e.shiftKey) {
			// Shift+Click: toggle all sections
			this.dispatchEvent(new CustomEvent('toggle-all-sections', {
				detail: { targetExpanded },
				bubbles: true,
				composed: true,
			}));
			return;
		}
		this.dispatchEvent(new CustomEvent('toggle-visibility', {
			bubbles: true,
			composed: true,
		}));
	}

	private _onClose(): void {
		this.dispatchEvent(new CustomEvent('section-remove', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true,
		}));
	}

	private _onFitToContents(): void {
		this.dispatchEvent(new CustomEvent('fit-to-contents', {
			bubbles: true,
			composed: true,
		}));
	}

	private _onDiffClick(): void {
		this.dispatchEvent(new CustomEvent('show-section-diff', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true,
		}));
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-section-shell': KwSectionShell;
	}
}
