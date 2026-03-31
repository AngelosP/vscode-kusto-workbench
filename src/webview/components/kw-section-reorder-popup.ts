import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { pState } from '../shared/persistence-state.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SectionSummary {
	id: string;
	type: 'query' | 'markdown' | 'chart' | 'python' | 'url' | 'transformation';
	name: string;
	/** 1-based index in the document */
	index: number;
	/** Unsaved-change status from the section shell */
	changeStatus: '' | 'modified' | 'new';
}

// ─── Icons per section type (small inline SVGs) ──────────────────────────────

const sectionIcons: Record<SectionSummary['type'], TemplateResult> = {
	query: html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 3h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1zm0 3h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1zm0 3h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1zM3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11zM4.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-7z"/></svg>`,
	markdown: html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 3A1.5 1.5 0 0 0 1 4.5v7A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13.5 3h-11zM2 4.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-7zm1.5 1v5h1.5V8l1.5 2 1.5-2v2.5H9.5v-5H8L6.5 7.5 5 5.5H3.5zm8 0L10 8.5h1.5v2h1v-2H14L12.5 5.5h-1z"/></svg>`,
	chart: html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 14h14V2h-1v11H2V5H1v9zm3-9v7h2V5H4zm3 3v4h2V8H7zm3-2v6h2V6h-2z"/></svg>`,
	python: html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1C5.57 1 4 2.12 4 3.5V5h4v1H3.5C2.12 6 1 7.07 1 8.5v2C1 11.88 2.12 13 3.5 13H5v-1.5C5 10.12 6.12 9 7.5 9h3C11.33 9 12 8.33 12 7.5v-4C12 2.12 10.43 1 8.5 1h-1zM6 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM8.5 15c1.93 0 3.5-1.12 3.5-2.5V11H8v-1h4.5c1.38 0 2.5-1.07 2.5-2.5v-2C15 4.12 13.88 3 12.5 3H11v1.5C11 5.88 9.88 7 8.5 7h-3C4.67 7 4 7.67 4 8.5v4C4 13.88 5.57 15 7.5 15h1zm2.5-2.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/></svg>`,
	url: html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.354 5.354l-2 2a2.5 2.5 0 0 0 3.536 3.536l2-2a2.5 2.5 0 0 0 0-3.536l-.354-.354-.707.707.354.354a1.5 1.5 0 0 1 0 2.122l-2 2a1.5 1.5 0 1 1-2.122-2.122l2-2 .707-.707zM9.646 10.646l2-2a2.5 2.5 0 0 0-3.536-3.536l-2 2a2.5 2.5 0 0 0 0 3.536l.354.354.707-.707-.354-.354a1.5 1.5 0 0 1 0-2.122l2-2a1.5 1.5 0 1 1 2.122 2.122l-2 2-.707.707z"/></svg>`,
	transformation: html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM2 4V2h2v2H2zm9.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM12 4V2h2v2h-2zM1.5 11a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM2 14v-2h2v2H2zm9.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm.5 3v-2h2v2h-2zM8 5.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm-3 3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/></svg>`,
};

const sectionTypeLabels: Record<SectionSummary['type'], string> = {
	query: 'Query',
	markdown: 'Markdown',
	chart: 'Chart',
	python: 'Python',
	url: 'URL',
	transformation: 'Transformation',
};

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-section-reorder-popup')
export class KwSectionReorderPopup extends LitElement {

	static override styles = css`
		:host {
			display: none;
			position: fixed;
			inset: 0;
			z-index: 10000;
		}
		:host([open]) {
			display: flex;
			align-items: center;
			justify-content: center;
		}

		/* Backdrop */
		.backdrop {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.45);
			opacity: 0;
			transition: opacity 220ms ease;
		}
		:host([open]) .backdrop {
			opacity: 1;
		}

		/* Panel */
		.panel {
			position: relative;
			z-index: 1;
			background: var(--vscode-editor-background, #1e1e1e);
			border: 1px solid var(--vscode-widget-border, #454545);
			border-radius: 8px;
			box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
			min-width: 340px;
			max-width: 480px;
			max-height: 80vh;
			display: flex;
			flex-direction: column;
			transform: scale(0.92) translateY(12px);
			opacity: 0;
			transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1),
			            opacity 220ms ease;
		}
		:host([open]) .panel {
			transform: scale(1) translateY(0);
			opacity: 1;
		}

		/* Header */
		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 12px 16px 8px;
			border-bottom: 1px solid var(--vscode-widget-border, #454545);
			flex-shrink: 0;
		}
		.panel-title {
			font-size: 13px;
			font-weight: 600;
			color: var(--vscode-foreground, #ccc);
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.panel-title svg {
			width: 16px;
			height: 16px;
			opacity: 0.7;
		}
		.close-btn {
			background: none;
			border: none;
			color: var(--vscode-foreground, #ccc);
			cursor: pointer;
			padding: 4px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			opacity: 0.7;
			transition: opacity 120ms, background 120ms;
		}
		.close-btn:hover {
			opacity: 1;
			background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
		}
		.close-btn svg {
			width: 16px;
			height: 16px;
		}

		/* Section list */
		.section-list {
			overflow-y: auto;
			padding: 8px 12px;
			flex: 1 1 auto;
		}

		/* Section card */
		.section-card {
			display: flex;
			align-items: center;
			padding: 7px 10px;
			margin: 2px 0;
			border-radius: 6px;
			background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
			border: 1px solid transparent;
			border-left: 3px solid transparent;
			cursor: grab;
			user-select: none;
			/* NOTE: transform is NOT listed here — it is managed exclusively by the
			   FLIP animation code (inline styles) to avoid interference with the
			   panel entrance animation. */
			transition: background 150ms ease,
			            border-color 150ms ease,
			            box-shadow 150ms ease,
			            opacity 150ms ease;
		}
		.section-card:active {
			cursor: grabbing;
		}
		.section-card:hover {
			background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
			border-color: var(--vscode-focusBorder, rgba(0, 120, 212, 0.4));
		}

		/* The card that is currently being dragged */
		.section-card.is-dragging {
			opacity: 0.4;
			background: var(--vscode-list-activeSelectionBackground, rgba(0, 120, 212, 0.2));
			border-color: var(--vscode-focusBorder, #007fd4);
			box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
		}

		/* The card that was initially dragged (highlighted) */
		.section-card.is-origin {
			border-color: var(--vscode-focusBorder, #007fd4);
			box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4) inset;
			background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 12%, transparent);
		}

		/* Drop indicator */
		.drop-indicator {
			height: 2px;
			background: var(--vscode-focusBorder, #007fd4);
			border-radius: 1px;
			margin: 0 10px;
			opacity: 0;
			transition: opacity 120ms ease;
		}
		.drop-indicator.is-visible {
			opacity: 1;
		}

		/* Section card contents */
		.section-icon {
			width: 18px;
			height: 18px;
			flex-shrink: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			opacity: 0.7;
		}
		.section-icon svg {
			width: 16px;
			height: 16px;
		}
		.section-info {
			margin-left: 10px;
			flex: 1;
			min-width: 0;
		}
		.section-name {
			font-size: 12px;
			font-weight: 500;
			color: var(--vscode-foreground, #ccc);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.section-type-badge {
			font-size: 10px;
			color: var(--vscode-descriptionForeground, #999);
			margin-top: 1px;
		}
		.section-index {
			font-size: 10px;
			color: var(--vscode-descriptionForeground, #999);
			margin-left: 8px;
			flex-shrink: 0;
			min-width: 18px;
			text-align: right;
		}
		.drag-grip {
			flex-shrink: 0;
			margin-right: 6px;
			color: var(--vscode-descriptionForeground, #999);
			font-size: 12px;
			letter-spacing: -1px;
			opacity: 0.5;
			transition: opacity 120ms;
		}
		.section-card:hover .drag-grip {
			opacity: 1;
		}

		/* Unsaved-change indicators */
		.section-card[data-change-status="modified"] {
			border-left-color: var(--vscode-editorGutter-modifiedBackground, #1b81a8);
		}
		.section-card[data-change-status="new"] {
			border-left-color: var(--vscode-editorGutter-addedBackground, #2ea043);
		}

		/* Pinned first section */
		.section-card.is-pinned {
			cursor: default;
			opacity: 0.85;
			border-left-color: var(--vscode-descriptionForeground, #999);
		}
		.section-card.is-pinned:hover {
			cursor: default;
		}
		.pinned-icon {
			font-size: 13px;
			opacity: 0.8;
		}

		/* Footer hint */
		.panel-footer {
			padding: 6px 16px 10px;
			border-top: 1px solid var(--vscode-widget-border, #454545);
			flex-shrink: 0;
		}
		.panel-hint {
			font-size: 11px;
			color: var(--vscode-descriptionForeground, #999);
			text-align: center;
		}
	`;

	// ── State ────────────────────────────────────────────────────────────────

	@state() private _sections: SectionSummary[] = [];
	@state() private _originId = '';
	@state() private _draggingId = '';
	@state() private _dropIndex = -1;

	// Cached card positions for FLIP animation
	private _cardPositions = new Map<string, DOMRect>();

	// ── Public API ───────────────────────────────────────────────────────────

	/**
	 * Open the popup, scanning the document for all sections.
	 * @param originSectionId  The section the user initially dragged (highlighted).
	 */
	open(originSectionId?: string): void {
		this._sections = this._scanSections();
		this._originId = originSectionId ?? '';
		this._draggingId = '';
		this._dropIndex = -1;
		this.setAttribute('open', '');
		// Focus trap
		requestAnimationFrame(() => {
			this.shadowRoot?.querySelector<HTMLElement>('.panel')?.focus();
		});
	}

	close(): void {
		this.removeAttribute('open');
		this._draggingId = '';
		this._dropIndex = -1;
		this._originId = '';
		this._cardPositions.clear();
	}

	get isOpen(): boolean {
		return this.hasAttribute('open');
	}

	// ── Scanning DOM ─────────────────────────────────────────────────────────

	private _scanSections(): SectionSummary[] {
		const container = document.getElementById('queries-container');
		if (!container) return [];
		const children = Array.from(container.children) as HTMLElement[];
		const results: SectionSummary[] = [];
		let idx = 0;
		for (const el of children) {
			const id = el.id;
			if (!id) continue;
			const type = this._inferType(id, el);
			if (!type) continue;
			idx++;
			// Read unsaved-change status from the section shell
			let changeStatus: '' | 'modified' | 'new' = '';
			try {
				const shell = el.shadowRoot?.querySelector('kw-section-shell');
				const attr = shell?.getAttribute('has-changes') || '';
				if (attr === 'modified' || attr === 'new') changeStatus = attr;
			} catch { /* ignore */ }
			results.push({
				id,
				type,
				name: this._inferName(el, type),
				index: idx,
				changeStatus,
			});
		}
		return results;
	}

	private _inferType(id: string, el: HTMLElement): SectionSummary['type'] | null {
		if (id.startsWith('query_')) return 'query';
		if (id.startsWith('markdown_')) return 'markdown';
		if (id.startsWith('chart_')) return 'chart';
		if (id.startsWith('python_')) return 'python';
		if (id.startsWith('url_')) return 'url';
		if (id.startsWith('transformation_')) return 'transformation';
		// Fallback: tag name
		const tag = el.tagName.toLowerCase();
		if (tag === 'kw-query-section') return 'query';
		if (tag === 'kw-markdown-section') return 'markdown';
		if (tag === 'kw-chart-section') return 'chart';
		if (tag === 'kw-python-section') return 'python';
		if (tag === 'kw-url-section') return 'url';
		if (tag === 'kw-transformation-section') return 'transformation';
		return null;
	}

	private _inferName(el: HTMLElement, type: SectionSummary['type']): string {
		// Try public getName() for query sections
		if (typeof (el as any).getName === 'function') {
			const n = (el as any).getName();
			if (n) return n;
		}
		// Try name input in shadow DOM
		try {
			const input = el.shadowRoot?.querySelector<HTMLInputElement>('.query-name');
			if (input?.value) return input.value;
		} catch (e) { console.error('[kusto]', e); }
		// Try _name property
		try {
			const n = (el as any)._name;
			if (typeof n === 'string' && n) return n;
		} catch (e) { console.error('[kusto]', e); }
		// Fallback to type label
		return '';
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		return html`
			<div class="backdrop" @click=${this._onBackdropClick}></div>
			<div class="panel" tabindex="-1" @keydown=${this._onKeydown}>
				<div class="panel-header">
					<span class="panel-title">
						<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h10v1H3V3zm0 4h10v1H3V7zm0 4h10v1H3v-1z"/></svg>
						Section Manager
					</span>
					<button class="close-btn" type="button"
						title="Close" aria-label="Close"
						@click=${this.close}>
						<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
					</button>
				</div>
				<div class="section-list" @dragover=${this._onListDragOver} @drop=${this._onListDrop}>
					${this._sections.map((s, i) => this._renderCard(s, i))}
				</div>
				<div class="panel-footer">
					<div class="panel-hint">Drag sections to reorder &middot; Double click to scroll to them</div>
				</div>
			</div>
		`;
	}

	private _renderCard(s: SectionSummary, arrIndex: number): TemplateResult {
		const isDragging = s.id === this._draggingId;
		const isOrigin = s.id === this._originId;
		const showIndicator = this._dropIndex === arrIndex && this._draggingId && !isDragging;
		const isPinned = arrIndex === 0 && pState.firstSectionPinned;
		const displayName = s.name || '[Unnamed]';
		return html`
			<div class="drop-indicator ${showIndicator ? 'is-visible' : ''}" data-drop-index="${arrIndex}"></div>
			<div class="section-card ${isDragging ? 'is-dragging' : ''} ${isOrigin ? 'is-origin' : ''} ${isPinned ? 'is-pinned' : ''}"
				draggable="${isPinned ? 'false' : 'true'}"
				data-section-id="${s.id}"
				data-arr-index="${arrIndex}"
				data-change-status="${s.changeStatus}"
				@dragstart=${isPinned ? undefined : (e: DragEvent) => this._onCardDragStart(e, s)}
				@dragend=${this._onCardDragEnd}
				@dblclick=${() => this._onCardDoubleClick(s.id)}>
				${isPinned
					? html`<span class="drag-grip pinned-icon" aria-hidden="true" title="Pinned — this section's content is stored in the .kql/.csl file">📌</span>`
					: html`<span class="drag-grip" aria-hidden="true">⋮⋮</span>`
				}
				<span class="section-icon">${sectionIcons[s.type]}</span>
				<div class="section-info">
					<div class="section-name">${displayName}</div>
					<div class="section-type-badge">${sectionTypeLabels[s.type]}${isPinned ? ' (pinned)' : ''}</div>
				</div>
				<span class="section-index">#${s.index}</span>
			</div>
			${arrIndex === this._sections.length - 1 ? html`
				<div class="drop-indicator ${this._dropIndex === this._sections.length ? 'is-visible' : ''}" data-drop-index="${this._sections.length}"></div>
			` : nothing}
		`;
	}

	// ── Card drag handlers ───────────────────────────────────────────────────

	private _onCardDragStart(e: DragEvent, s: SectionSummary): void {
		this._draggingId = s.id;
		this._dropIndex = -1;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', s.id); } catch (e) { console.error('[kusto]', e); }
		}
		// Snapshot card positions for FLIP
		this._snapshotCardPositions();
	}

	private _onCardDragEnd = (): void => {
		this._draggingId = '';
		this._dropIndex = -1;
	};

	private _onListDragOver = (e: DragEvent): void => {
		if (!this._draggingId) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

		// Determine which slot the cursor is over
		const list = this.shadowRoot?.querySelector('.section-list');
		if (!list) return;
		const cards = Array.from(list.querySelectorAll<HTMLElement>('.section-card'));
		const y = e.clientY;
		let newDropIndex = this._sections.length; // default: end
		for (let i = 0; i < cards.length; i++) {
			const rect = cards[i].getBoundingClientRect();
			const midY = rect.top + rect.height / 2;
			if (y < midY) {
				newDropIndex = i;
				break;
			}
		}
		// Prevent dropping above the pinned first section.
		if (pState.firstSectionPinned && newDropIndex <= 0) {
			newDropIndex = 1;
		}
		if (newDropIndex !== this._dropIndex) {
			this._dropIndex = newDropIndex;
		}
	};

	private _onListDrop = (e: DragEvent): void => {
		e.preventDefault();
		if (!this._draggingId) return;

		const fromIndex = this._sections.findIndex(s => s.id === this._draggingId);
		let toIndex = this._dropIndex;
		if (fromIndex < 0 || toIndex < 0) {
			this._draggingId = '';
			this._dropIndex = -1;
			return;
		}

		// If dropping after the dragged item's original position, adjust index
		if (toIndex > fromIndex) toIndex--;
		if (toIndex === fromIndex) {
			this._draggingId = '';
			this._dropIndex = -1;
			return;
		}

		// Snapshot positions before DOM/state change for FLIP
		this._snapshotCardPositions();

		// Move in DOM
		this._moveSectionInDom(this._draggingId, fromIndex, toIndex);

		// Update internal state
		const arr = [...this._sections];
		const [moved] = arr.splice(fromIndex, 1);
		arr.splice(toIndex, 0, moved);
		// Re-index
		arr.forEach((s, i) => s.index = i + 1);
		this._sections = arr;

		// Highlight the moved section as origin
		this._originId = this._draggingId;
		this._draggingId = '';
		this._dropIndex = -1;

		// Animate FLIP after render
		this.updateComplete.then(() => this._animateFlip());
	};

	// ── DOM manipulation (actual section reorder) ────────────────────────────

	private _moveSectionInDom(sectionId: string, _from: number, toIndex: number): void {
		const container = document.getElementById('queries-container');
		if (!container) return;
		const el = document.getElementById(sectionId);
		if (!el) return;

		// Remove from current position
		container.removeChild(el);
		// Recalculate children after removal
		const remaining = Array.from(container.children).filter(c => c.id) as HTMLElement[];
		if (toIndex >= remaining.length) {
			container.appendChild(el);
		} else {
			container.insertBefore(el, remaining[toIndex]);
		}

		// Sync arrays and persist
		this._syncAndPersist(sectionId);
	}

	private _syncAndPersist(movedId: string): void {
		const _win = window;
		try {
			const container = document.getElementById('queries-container');
			if (container) {
				const ids = Array.from(container.children)
					.map((el: any) => el?.id ? String(el.id) : '')
					.filter(Boolean);
				try { if (typeof _win.setQueryBoxes === 'function') _win.setQueryBoxes(ids.filter((id: any) => id.startsWith('query_'))); else if (typeof _win.queryBoxes !== 'undefined') _win.queryBoxes = ids.filter((id: any) => id.startsWith('query_')); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof _win.markdownBoxes !== 'undefined') _win.markdownBoxes = ids.filter((id: any) => id.startsWith('markdown_')); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof _win.pythonBoxes !== 'undefined') _win.pythonBoxes = ids.filter((id: any) => id.startsWith('python_')); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof _win.urlBoxes !== 'undefined') _win.urlBoxes = ids.filter((id: any) => id.startsWith('url_')); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Re-layout moved editors
		try {
			const q = _win.queryEditors?.[movedId];
			const md = _win.markdownEditors?.[movedId];
			const py = _win.pythonEditors?.[movedId];
			const editors = [q, md, py].filter(Boolean);
			if (editors.length) {
				setTimeout(() => {
					for (const ed of editors) {
						try { if (ed && typeof ed.layout === 'function') ed.layout(); } catch (e) { console.error('[kusto]', e); }
					}
				}, 0);
			}
		} catch (e) { console.error('[kusto]', e); }

		try { _win.schedulePersist?.('reorder'); } catch (e) { console.error('[kusto]', e); }
		try { _win.__kustoRefreshAllDataSourceDropdowns?.(); } catch (e) { console.error('[kusto]', e); }
	}

	// ── FLIP animation ──────────────────────────────────────────────────────

	private _snapshotCardPositions(): void {
		this._cardPositions.clear();
		const cards = this.shadowRoot?.querySelectorAll<HTMLElement>('.section-card');
		if (!cards) return;
		for (const card of cards) {
			const id = card.dataset.sectionId;
			if (id) this._cardPositions.set(id, card.getBoundingClientRect());
		}
	}

	private _animateFlip(): void {
		const cards = this.shadowRoot?.querySelectorAll<HTMLElement>('.section-card');
		if (!cards) return;
		for (const card of cards) {
			const id = card.dataset.sectionId;
			if (!id) continue;
			const oldRect = this._cardPositions.get(id);
			if (!oldRect) continue;
			const newRect = card.getBoundingClientRect();
			const dx = oldRect.left - newRect.left;
			const dy = oldRect.top - newRect.top;
			if (dx === 0 && dy === 0) continue;
			card.style.transform = `translate(${dx}px, ${dy}px)`;
			card.style.transition = 'none';
			// Force reflow
			card.offsetHeight;
			card.style.transition = 'transform 280ms cubic-bezier(0.2, 0, 0, 1)';
			card.style.transform = '';
			card.addEventListener('transitionend', () => {
				card.style.transition = '';
			}, { once: true });
		}
	}

	// ── Double-click to scroll ───────────────────────────────────────────────

	private _onCardDoubleClick(sectionId: string): void {
		const el = document.getElementById(sectionId);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
		this.close();
	}

	// ── Dismiss ──────────────────────────────────────────────────────────────

	private _onBackdropClick = (): void => {
		this.close();
	};

	private _onKeydown = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			this.close();
		}
	};
}
