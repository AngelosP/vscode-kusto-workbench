import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-object-viewer.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';
import { customElement, property, state } from 'lit/decorators.js';
import { buildSearchRegex, navigateMatch, highlightMatches, type SearchMode } from './search-utils.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';
import './kw-search-bar.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: unknown): string {
	let str = s !== null && s !== undefined ? String(s) : '';
	str = str.replace(/&/g, '&amp;');
	str = str.replace(/</g, '&lt;');
	str = str.replace(/>/g, '&gt;');
	str = str.replace(/"/g, '&quot;');
	str = str.replace(/'/g, '&#39;');
	return str;
}


function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const s = value.trim();
	if (!s) return value;
	if (!(s.startsWith('{') || s.startsWith('[') || s === 'null' || s === 'true' || s === 'false' || /^-?\d/.test(s) || s.startsWith('"'))) return value;
	try { return JSON.parse(value); } catch { return value; }
}

function stringifyForSearch(value: unknown): string {
	try {
		if (value === null || value === undefined) return '';
		if (typeof value === 'string') return value;
		return JSON.stringify(value);
	} catch { return String(value); }
}

function formatScalarForTable(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try { return JSON.stringify(value); } catch { return String(value); }
}

function isComplexValue(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') {
		const s = value.trim();
		return s.startsWith('{') || s.startsWith('[');
	}
	return typeof value === 'object';
}

function syntaxHighlightJson(obj: unknown, indent = 0): string {
	const indentStr = '  '.repeat(indent);
	const nextIndent = '  '.repeat(indent + 1);
	if (obj === null) return '<span class="json-null">null</span>';
	if (typeof obj === 'string') return '<span class="json-string">"' + escapeHtml(obj) + '"</span>';
	if (typeof obj === 'number') return '<span class="json-number">' + obj + '</span>';
	if (typeof obj === 'boolean') return '<span class="json-boolean">' + obj + '</span>';
	if (Array.isArray(obj)) {
		if (obj.length === 0) return '[]';
		let result = '[\n';
		obj.forEach((item, index) => {
			result += nextIndent + syntaxHighlightJson(item, indent + 1);
			if (index < obj.length - 1) result += ',';
			result += '\n';
		});
		return result + indentStr + ']';
	}
	if (typeof obj === 'object') {
		const keys = Object.keys(obj as Record<string, unknown>);
		if (keys.length === 0) return '{}';
		let result = '{\n';
		keys.forEach((key, index) => {
			result += nextIndent + '<span class="json-key">"' + escapeHtml(key) + '"</span>: ';
			result += syntaxHighlightJson((obj as Record<string, unknown>)[key], indent + 1);
			if (index < keys.length - 1) result += ',';
			result += '\n';
		});
		return result + indentStr + '}';
	}
	return String(obj);
}

function formatJson(value: unknown): string {
	try {
		const obj = typeof value === 'string' ? JSON.parse(value) : value;
		return syntaxHighlightJson(obj);
	} catch {
		return '<span class="json-string">' + escapeHtml(value) + '</span>';
	}
}

interface StackFrame {
	label: string;
	value: unknown;
}

// ─── Copy-to-clipboard helper ─────────────────────────────────────────────────

function writeTextToClipboard(text: string, vscodePostMessage?: (msg: unknown) => void): void {
	if (vscodePostMessage) {
		vscodePostMessage({ type: 'copyToClipboard', text });
		return;
	}
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			void navigator.clipboard.writeText(text);
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ─── Virtual scroll for raw JSON ──────────────────────────────────────────────

/** Fixed line height in px for the virtual scroll container. */
const RAW_LINE_HEIGHT = 20;
/** Extra lines rendered above/below the visible viewport. */
const RAW_OVERSCAN = 20;

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-object-viewer')
export class KwObjectViewer extends LitElement {

	@property({ type: String }) title = '';
	@property({ type: String }) jsonText = '';
	@property({ type: Boolean }) open = false;

	/** Optional: used for clipboard via extension postMessage */
	copyCallback?: (msg: unknown) => void;

	@state() private _stack: StackFrame[] = [];
	@state() private _rawVisible = true;
	@state() private _rawWordWrap = true;
	@state() private _searchQuery = '';
	@state() private _searchMode: SearchMode = 'wildcard';
	@state() private _currentMatchIndex = 0;
	private _matchCount = 0;
	/** Number of entries currently visible in the properties table (pagination). */
	@state() private _entriesLimit = 200;

	// ── Raw JSON virtual scroll cache ─────────────────────────────────────────
	private _rawLines: string[] = [];
	private _rawPlainText = '';
	private _rawCacheValue: unknown = undefined;
	private _rawCacheSearch = '';
	private _rawCacheMode: SearchMode = 'wildcard';
	private _rawScrollTop = 0;
	private _rawScrollRaf = 0;
	/** Per-line count of `.json-highlight` spans, for mapping match index → line. */
	private _rawLineMatchCounts: number[] = [];

	// ── Public API ────────────────────────────────────────────────────────────

	private _dismissCb = (): void => { this.hide(); };

	show(title: string, jsonText: string, options?: { searchQuery?: string; searchMode?: SearchMode }): void {
		this.title = title;
		this.jsonText = jsonText;
		const rootValue = parseMaybeJson(jsonText);
		this._stack = [{ label: title, value: rootValue }];
		this._rawVisible = false;
		this._rawWordWrap = true;
		this._entriesLimit = 200;
		this._rawLines = [];
		this._rawPlainText = '';
		this._rawLineMatchCounts = [];
		this._rawCacheValue = undefined;
		this._rawScrollTop = 0;
		this._searchQuery = options?.searchQuery ?? '';
		this._searchMode = options?.searchMode ?? 'wildcard';
		this._currentMatchIndex = 0;
		this._matchCount = 0;
		this.open = true;
		pushDismissable(this._dismissCb);
	}

	hide(): void {
		this.open = false;
		this._stack = [];
		this._rawLines = [];
		this._rawPlainText = '';
		this._rawLineMatchCounts = [];
		this._rawCacheValue = undefined;
		if (this._rawScrollRaf) { cancelAnimationFrame(this._rawScrollRaf); this._rawScrollRaf = 0; }
		removeDismissable(this._dismissCb);
	}

	// ── Render ────────────────────────────────────────────────────────────────

	protected render(): TemplateResult | typeof nothing {
		if (!this.open || this._stack.length === 0) return nothing;
		const frame = this._stack[this._stack.length - 1];
		const depth = this._stack.length;

		// Build search regex
		const { regex, error: searchError } = buildSearchRegex(this._searchQuery, this._searchMode);

		// Always ensure raw lines are computed (needed for match counting even when collapsed)
		this._ensureRawLines(frame.value, regex, searchError ?? undefined);

		// Match count is based on the formatted raw text only (not the properties table)
		let matchCount = 0;
		if (regex && !searchError && this._searchQuery.trim()) {
			matchCount = this._countMatches(regex, this._rawPlainText);
		}
		this._matchCount = matchCount;

		// Build entries for properties table (paginated)
		const allEntries = this._getEntries(frame.value);
		const entries = allEntries.slice(0, this._entriesLimit);
		const hasMoreEntries = allEntries.length > this._entriesLimit;

		return html`
			<div class="modal-backdrop" @click=${this.hide}>
				<div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
					<div class="modal-header">
						<h3>${this.title}</h3>
						<div class="search-area">
							${this._renderSearchControl()}
							<span class="search-results">
								${this._searchQuery.trim()
									? (searchError ? searchError : (matchCount > 0 ? '(' + (this._currentMatchIndex + 1) + '/' + matchCount + ')' : 'No matches'))
									: ''}
							</span>
						</div>
						<button class="close-btn" type="button" title="Close" aria-label="Close" @click=${this.hide}>
							<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
								<path d="M4 4l8 8" /><path d="M12 4L4 12" />
							</svg>
						</button>
					</div>
					<div class="modal-body">
						<!-- Properties table -->
						<div class="section props-section">
							<div class="section-header">
							${depth > 1 ? html`<button class="tool-btn" type="button" title="Back" aria-label="Back" @click=${this._navigateBack}>${ICONS.arrowLeft}</button>` : nothing}
								<div class="section-title">${this._renderBreadcrumbs()}</div>
							</div>
							<table class="props-table" aria-label="Properties">
								<tbody>
									${entries.map(([key, parsedVal]) => {
										const keyStr = String(key);
										const valueStr = stringifyForSearch(parsedVal);
										const keyMatch = regex && !searchError && this._regexTest(regex, keyStr);
										const valMatch = regex && !searchError && this._regexTest(regex, valueStr);
										return html`
											<tr>
												<td class="${keyMatch ? 'search-match' : ''}">
													<div class="prop-key-cell">
														<button class="copy-btn prop-copy-btn" type="button" title="Copy name" aria-label="Copy property name"
															@click=${() => { writeTextToClipboard(keyStr, this.copyCallback); }}>
															<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
																<rect x="5" y="5" width="9" height="9" rx="2" /><path d="M3 11V4c0-1.1.9-2 2-2h7" />
															</svg>
														</button>
														<span class="prop-key-text">${keyMatch && regex ? highlightMatches(keyStr, regex, 'hl') : keyStr}</span>
														<button class="copy-btn prop-copy-btn" type="button" title="Copy value" aria-label="Copy value to clipboard"
															@click=${() => this._copyValue(parsedVal)}>
															<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
																<rect x="5" y="5" width="9" height="9" rx="2" /><path d="M3 11V4c0-1.1.9-2 2-2h7" />
															</svg>
														</button>
													</div>
												</td>
												<td class="${valMatch ? 'search-match' : ''}">
													${isComplexValue(parsedVal)
														? html`<a class="view-link" href="#" @click=${(e: MouseEvent) => { e.preventDefault(); this._navigateInto(key); }}>View</a>`
														: (valMatch && regex ? highlightMatches(formatScalarForTable(parsedVal), regex, 'hl') : formatScalarForTable(parsedVal))
													}
												</td>
											</tr>`;
									})}
									${entries.length === 0 ? html`<tr><td>(value)</td><td>${formatScalarForTable(frame.value)}</td></tr>` : nothing}
							${hasMoreEntries ? html`<tr><td colspan="2"><button class="show-more-btn" type="button" @click=${() => { this._entriesLimit += 200; }}>Show ${Math.min(200, allEntries.length - this._entriesLimit)} more… (${allEntries.length - this._entriesLimit} remaining)</button></td></tr>` : nothing}
							</table>
						</div>

						<!-- Raw value section -->
						<div class="section raw-section">
							<div class="section-header">
								<div class="section-title">Raw value</div>
								<div class="raw-actions">
									<button class="tool-btn" type="button" title="Copy to clipboard" aria-label="Copy to clipboard"
								@click=${() => this._copyRaw(stringifyForSearch(frame.value))}>
										<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
											<rect x="5" y="5" width="9" height="9" rx="2" /><path d="M3 11V4c0-1.1.9-2 2-2h7" />
										</svg>
									</button>								<button class="tool-btn ${this._rawWordWrap ? 'is-active' : ''}" type="button"
									title="${this._rawWordWrap ? 'Disable word wrap' : 'Enable word wrap'}"
									aria-label="${this._rawWordWrap ? 'Disable word wrap' : 'Enable word wrap'}"
									@click=${this._toggleWordWrap}>
									<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
										<path d="M2 3h12" /><path d="M2 7h10a2 2 0 0 1 0 4H9" /><path d="M10 12.5l-1.5-1.5L10 9.5" /><path d="M2 11h4" />
									</svg>
								</button>									<button class="tool-btn ${this._rawVisible ? 'is-active' : ''}" type="button"
										title="${this._rawVisible ? 'Hide raw value' : 'Show raw value'}"
										aria-label="${this._rawVisible ? 'Hide raw value' : 'Show raw value'}"
										@click=${this._toggleRaw}>
										<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
											<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />
											<circle cx="8" cy="8" r="2.1" />
										</svg>
									</button>
								</div>
							</div>
							${this._rawVisible ? html`
								<div class="raw-body">
									${this._rawWordWrap ? this._renderRawWrapped() : this._renderRawVirtual()}
								</div>
							` : nothing}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	// ── Search ────────────────────────────────────────────────────────────────

	private _renderSearchControl(): TemplateResult {
		return html`<kw-search-bar
			.query=${this._searchQuery}
			.mode=${this._searchMode}
			.matchCount=${this._matchCount}
			.currentMatch=${this._currentMatchIndex}
			.showClose=${false}
			.showStatus=${false}
			@search-input=${(e: CustomEvent) => { this._searchQuery = e.detail.query; this._currentMatchIndex = 0; }}
			@search-mode-change=${(e: CustomEvent) => { this._searchMode = e.detail.mode; this._currentMatchIndex = 0; }}
			@search-next=${() => this._navigateNextMatch()}
			@search-prev=${() => this._navigatePrevMatch()}
		></kw-search-bar>`;
	}

	private _countMatches(regex: RegExp, text: string): number {
		regex.lastIndex = 0;
		let count = 0;
		let m: RegExpExecArray | null;
		while ((m = regex.exec(text)) !== null) {
			count++;
			if (count >= 5000) break;
			if (!m[0]) regex.lastIndex++;
		}
		return count;
	}

	private _regexTest(regex: RegExp, text: string): boolean {
		try { regex.lastIndex = 0; return regex.test(text); } catch { return false; }
	}

	private _highlightInHtml(htmlStr: string, regex: RegExp): string {
		// Parse HTML, walk text nodes, wrap matches in <span class="json-highlight">
		const div = document.createElement('div');
		div.innerHTML = htmlStr;
		const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) nodes.push(node);
		for (const n of nodes) {
			const text = n.textContent || '';
			regex.lastIndex = 0;
			if (!regex.test(text)) continue;
			regex.lastIndex = 0;
			const frag = document.createDocumentFragment();
			let lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = regex.exec(text)) !== null) {
				if (!m[0]) break;
				if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
				const span = document.createElement('span');
				span.className = 'json-highlight';
				span.textContent = m[0];
				frag.appendChild(span);
				lastIndex = m.index + m[0].length;
			}
			if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
			n.parentNode?.replaceChild(frag, n);
		}
		return div.innerHTML;
	}

	// ── Raw JSON virtual scroll ───────────────────────────────────────────────

	/**
	 * Compute and cache the array of HTML lines for the raw JSON section.
	 * Also caches the plain-text form (for match counting) and per-line match counts
	 * (for mapping a global match index to a line number for virtual scroll navigation).
	 * Recomputes only when the frame value or search parameters change.
	 */
	private _ensureRawLines(value: unknown, regex: RegExp | null, searchError: string | undefined): void {
		const needsHighlight = !!(regex && !searchError);
		const cacheKey = this._searchQuery + '|' + this._searchMode;
		if (value === this._rawCacheValue && cacheKey === this._rawCacheSearch) return;
		const formatted = formatJson(value);

		// Strip HTML tags to get plain text for match counting
		this._rawPlainText = formatted.replace(/<[^>]*>/g, '');

		const fullHtml = needsHighlight ? this._highlightInHtml(formatted, regex!) : formatted;
		const lines = fullHtml.split('\n');
		this._rawLines = lines;

		// Count `.json-highlight` spans per line for match-index → line mapping
		if (needsHighlight) {
			const highlightRe = /<span class="json-highlight">/g;
			this._rawLineMatchCounts = lines.map(line => {
				let count = 0;
				highlightRe.lastIndex = 0;
				while (highlightRe.exec(line) !== null) count++;
				return count;
			});
		} else {
			this._rawLineMatchCounts = [];
		}

		this._rawCacheValue = value;
		this._rawCacheSearch = cacheKey;
	}

	/** Render the raw JSON as a simple word-wrapped div (no virtual scroll needed). */
	private _renderRawWrapped(): TemplateResult {
		const fullHtml = this._rawLines.join('\n');
		return html`<div class="raw-wrap-scroll"><div class="json-wrap" .innerHTML=${fullHtml}></div></div>`;
	}

	/** Render the raw JSON using a virtual scroll container that only creates DOM for visible lines. */
	private _renderRawVirtual(): TemplateResult {
		const lines = this._rawLines;
		const lineCount = lines.length;
		const totalH = lineCount * RAW_LINE_HEIGHT;
		const scrollTop = this._rawScrollTop;
		// Use a generous default viewport; the actual container height is set via CSS.
		const viewH = 400;

		const first = Math.max(0, Math.floor(scrollTop / RAW_LINE_HEIGHT) - RAW_OVERSCAN);
		const last = Math.min(lineCount, Math.ceil((scrollTop + viewH) / RAW_LINE_HEIGHT) + RAW_OVERSCAN);

		return html`
			<div class="raw-vscroll" @scroll=${this._onRawScroll}>
				<div style="height:${totalH}px;position:relative">
					${lines.slice(first, last).map((line, i) =>
						html`<div class="raw-vline" style="top:${(first + i) * RAW_LINE_HEIGHT}px" .innerHTML=${line}></div>`
					)}
				</div>
			</div>
		`;
	}

	private _onRawScroll = (e: Event): void => {
		const el = e.currentTarget as HTMLElement;
		const newTop = el.scrollTop;
		// Skip redundant updates
		if (Math.abs(newTop - this._rawScrollTop) < RAW_LINE_HEIGHT * 0.5) return;
		this._rawScrollTop = newTop;
		if (!this._rawScrollRaf) {
			this._rawScrollRaf = requestAnimationFrame(() => {
				this._rawScrollRaf = 0;
				this.requestUpdate();
			});
		}
	};

	// ── Navigation ────────────────────────────────────────────────────────────

	private _getEntries(value: unknown): Array<[string, unknown]> {
		if (value === null || value === undefined || typeof value !== 'object') return [];
		const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value as Record<string, unknown>);
		return keys.map(k => {
			let v: unknown;
			try { v = (value as Record<string, unknown>)[k]; } catch { v = undefined; }
			return [k, parseMaybeJson(v)] as [string, unknown];
		});
	}

	private _navigateInto(key: string): void {
		const frame = this._stack[this._stack.length - 1];
		if (!frame?.value || typeof frame.value !== 'object') return;
		const nextValue = (frame.value as Record<string, unknown>)[key];
		this._stack = [...this._stack, { label: String(key), value: parseMaybeJson(nextValue) }];
		this._entriesLimit = 200;
		this._rawScrollTop = 0;
	}

	private _navigateBack(): void {
		if (this._stack.length <= 1) return;
		this._stack = this._stack.slice(0, -1);
		this._entriesLimit = 200;
		this._rawScrollTop = 0;
	}

	private _navigateToDepth(depth: number): void {
		if (depth >= this._stack.length || depth < 1) return;
		this._stack = this._stack.slice(0, depth);
		this._entriesLimit = 200;
		this._rawScrollTop = 0;
	}

	private _renderBreadcrumbs(): TemplateResult {
		return html`${this._stack.map((frame, i) => {
			const isCurrent = i === this._stack.length - 1;
			return html`${i > 0 ? html`<span class="crumb-sep">></span>` : nothing}<button type="button" class="crumb" ?disabled=${isCurrent} @click=${() => this._navigateToDepth(i + 1)}>${frame.label}</button>`;
		})}`;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	private _toggleRaw(): void {
		this._rawVisible = !this._rawVisible;
	}

	private _toggleWordWrap(): void {
		this._rawWordWrap = !this._rawWordWrap;
	}

	private _navigateNextMatch(): void {
		if (this._matchCount < 1) return;
		if (this._matchCount === 1) { this._currentMatchIndex = 0; } else {
			this._currentMatchIndex = navigateMatch(this._currentMatchIndex, this._matchCount, 'next');
		}
		this._scrollRawToMatch(this._currentMatchIndex);
	}

	private _navigatePrevMatch(): void {
		if (this._matchCount < 1) return;
		if (this._matchCount === 1) { this._currentMatchIndex = 0; } else {
			this._currentMatchIndex = navigateMatch(this._currentMatchIndex, this._matchCount, 'prev');
		}
		this._scrollRawToMatch(this._currentMatchIndex);
	}

	/**
	 * Expand the raw section (if collapsed) and scroll so that the Nth match
	 * is visible, then highlight it. Works in both word-wrap and virtual-scroll modes.
	 */
	private _scrollRawToMatch(matchIndex: number): void {
		// Ensure raw section is expanded
		if (!this._rawVisible) {
			this._rawVisible = true;
		}

		if (this._rawWordWrap) {
			// Word-wrap mode: all highlights are in the DOM, just find the Nth one
			this.requestUpdate();
			void this.updateComplete.then(() => {
				const rawBody = this.shadowRoot?.querySelector('.raw-body');
				if (!rawBody) return;
				const highlights = rawBody.querySelectorAll('.json-highlight');
				for (const el of highlights) el.classList.remove('json-highlight-active');
				const target = highlights[matchIndex];
				if (!target) return;
				target.classList.add('json-highlight-active');
				try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { try { target.scrollIntoView(true); } catch (e) { console.error('[kusto]', e); } }
			});
			return;
		}

		// Virtual-scroll mode: map match index → line, scroll container, then highlight
		const counts = this._rawLineMatchCounts;
		let remaining = matchIndex;
		let targetLine = 0;
		for (let i = 0; i < counts.length; i++) {
			if (remaining < counts[i]) { targetLine = i; break; }
			remaining -= counts[i];
			targetLine = i;
		}

		// Scroll virtual scroll container to center the target line
		const targetTop = targetLine * RAW_LINE_HEIGHT;
		const viewH = 400; // matches CSS max-height
		this._rawScrollTop = Math.max(0, targetTop - viewH / 2);
		this.requestUpdate();

		// After render, set the scroll position and highlight the active match
		void this.updateComplete.then(() => {
			const container = this.shadowRoot?.querySelector('.raw-vscroll') as HTMLElement | null;
			if (container) container.scrollTop = this._rawScrollTop;

			const rawBody = this.shadowRoot?.querySelector('.raw-body');
			if (!rawBody) return;
			const highlights = rawBody.querySelectorAll('.json-highlight');
			for (const el of highlights) el.classList.remove('json-highlight-active');
			const firstRendered = Math.max(0, Math.floor(this._rawScrollTop / RAW_LINE_HEIGHT) - RAW_OVERSCAN);
			let offsetBefore = 0;
			for (let i = 0; i < firstRendered && i < counts.length; i++) offsetBefore += counts[i];
			const localIdx = matchIndex - offsetBefore;
			if (localIdx >= 0 && localIdx < highlights.length) {
				highlights[localIdx].classList.add('json-highlight-active');
			}
		});
	}

	private async _scrollToCurrentMatch(): Promise<void> {
		this._scrollRawToMatch(this._currentMatchIndex);
	}

	private _copyValue(value: unknown): void {
		writeTextToClipboard(stringifyForSearch(value), this.copyCallback);
	}

	private _copyRaw(rawStr: string): void {
		writeTextToClipboard(rawStr, this.copyCallback);
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = [scrollbarSheet, iconRegistryStyles, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-object-viewer': KwObjectViewer;
	}
}
