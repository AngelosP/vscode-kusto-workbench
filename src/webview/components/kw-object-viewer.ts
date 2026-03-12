import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-object-viewer.styles.js';
import { customElement, property, state } from 'lit/decorators.js';

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

function escapeRegex(str: string): string {
	return String(str || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
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

type SearchMode = 'wildcard' | 'regex';

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
	} catch { /* ignore */ }
}

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
	@state() private _searchQuery = '';
	@state() private _searchMode: SearchMode = 'wildcard';
	@state() private _currentMatchIndex = 0;
	private _matchCount = 0;

	// ── Public API ────────────────────────────────────────────────────────────

	show(title: string, jsonText: string, options?: { searchQuery?: string; searchMode?: SearchMode }): void {
		this.title = title;
		this.jsonText = jsonText;
		const rootValue = parseMaybeJson(jsonText);
		this._stack = [{ label: title, value: rootValue }];
		this._rawVisible = true;
		this._searchQuery = options?.searchQuery ?? '';
		this._searchMode = options?.searchMode ?? 'wildcard';
		this._currentMatchIndex = 0;
		this._matchCount = 0;
		this.open = true;
	}

	hide(): void {
		this.open = false;
		this._stack = [];
	}

	// ── Render ────────────────────────────────────────────────────────────────

	protected render(): TemplateResult | typeof nothing {
		if (!this.open || this._stack.length === 0) return nothing;
		const frame = this._stack[this._stack.length - 1];
		const depth = this._stack.length;
		const rawStr = stringifyForSearch(frame.value);
		const formatted = formatJson(frame.value);

		// Build search regex
		const { regex, error: searchError } = this._buildSearchRegex();
		const matchCount = regex ? this._countMatches(regex, rawStr) : 0;
		this._matchCount = matchCount;

		// Highlighted raw JSON
		let highlightedRaw = formatted;
		if (regex && !searchError) {
			highlightedRaw = this._highlightInHtml(formatted, regex);
		}

		// Build entries for properties table
		const entries = this._getEntries(frame.value);

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
								${depth > 1 ? html`<button class="back-btn" type="button" title="Back" aria-label="Back" @click=${this._navigateBack}>←</button>` : nothing}
								<div class="section-title">${this._renderBreadcrumbs()}</div>
							</div>
							<table class="props-table" aria-label="Properties">
								<tbody>
									${entries.map(([key, parsedVal]) => {
										const keyStr = String(key);
										const valueStr = stringifyForSearch(parsedVal);
										const isMatch = regex && !searchError && (this._regexTest(regex, keyStr) || this._regexTest(regex, valueStr));
										return html`
											<tr class="${isMatch ? 'search-match' : ''}">
												<td>
													<div class="prop-key-cell">
														<span class="prop-key-text">${keyStr}</span>
														<button class="copy-btn prop-copy-btn" type="button" title="Copy value to clipboard" aria-label="Copy value to clipboard"
															@click=${() => this._copyValue(parsedVal)}>
															<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
																<rect x="5" y="5" width="9" height="9" rx="2" /><path d="M3 11V4c0-1.1.9-2 2-2h7" />
															</svg>
														</button>
													</div>
												</td>
												<td>
													${isComplexValue(parsedVal)
														? html`<button class="view-btn" type="button" @click=${() => this._navigateInto(key)}>${'View'}</button>`
														: formatScalarForTable(parsedVal)
													}
												</td>
											</tr>`;
									})}
									${entries.length === 0 ? html`<tr><td>(value)</td><td>${formatScalarForTable(frame.value)}</td></tr>` : nothing}
								</tbody>
							</table>
						</div>

						<!-- Raw value section -->
						<div class="section raw-section">
							<div class="section-header">
								<div class="section-title">Raw value</div>
								<div class="raw-actions">
									<button class="tool-btn" type="button" title="Copy to clipboard" aria-label="Copy to clipboard"
										@click=${() => this._copyRaw(rawStr)}>
										<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
											<rect x="5" y="5" width="9" height="9" rx="2" /><path d="M3 11V4c0-1.1.9-2 2-2h7" />
										</svg>
									</button>
									<button class="tool-btn ${this._rawVisible ? 'is-active' : ''}" type="button"
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
									<div class="json-wrap" .innerHTML=${highlightedRaw}></div>
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
		const isRegex = this._searchMode === 'regex';
		return html`
			<div class="search-control">
				<span class="search-icon" aria-hidden="true">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>
				</span>
				<input type="text" class="search-input" placeholder="Search..." autocomplete="off" spellcheck="false"
					.value=${this._searchQuery}
					@input=${this._onSearchInput}
					@keydown=${this._onSearchKeydown} />
				<button type="button" class="mode-toggle" title="${isRegex ? 'Regex mode (click to switch to Wildcard)' : 'Wildcard mode (click to switch to Regex)'}"
					@click=${this._toggleSearchMode}>
					${isRegex
						? html`<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="1" y="12" font-size="10" font-weight="bold" font-family="monospace">.*</text></svg>`
						: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="3" y="12" font-size="11" font-weight="bold" font-family="monospace">*</text></svg>`
					}
				</button>
				<span class="nav-divider" aria-hidden="true"></span>
				<button type="button" class="nav-btn nav-prev" title="Previous match (Shift+Enter)" aria-label="Previous match"
					?disabled=${this._matchCount < 2}
					@click=${this._navigatePrevMatch}>
					<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 5.5L3.5 10l.707.707L8 6.914l3.793 3.793.707-.707L8 5.5z"/></svg>
				</button>
				<button type="button" class="nav-btn nav-next" title="Next match (Enter)" aria-label="Next match"
					?disabled=${this._matchCount < 2}
					@click=${this._navigateNextMatch}>
					<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 10.5l4.5-4.5-.707-.707L8 9.086 4.207 5.293 3.5 6 8 10.5z"/></svg>
				</button>
			</div>
		`;
	}

	private _onSearchInput(e: Event): void {
		this._searchQuery = (e.target as HTMLInputElement).value;
		this._currentMatchIndex = 0;
	}

	private _onSearchKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			if (e.shiftKey) {
				this._navigatePrevMatch();
			} else {
				this._navigateNextMatch();
			}
			e.preventDefault();
		}
	}

	private _toggleSearchMode(): void {
		this._searchMode = this._searchMode === 'regex' ? 'wildcard' : 'regex';
		this._currentMatchIndex = 0;
	}

	private _buildSearchRegex(): { regex: RegExp | null; error: string | null } {
		const q = this._searchQuery.trim();
		if (!q) return { regex: null, error: null };
		let pattern: string;
		if (this._searchMode === 'regex') {
			pattern = q;
		} else {
			pattern = q.split('*').map(escapeRegex).join('.*?');
		}
		try {
			const regex = new RegExp(pattern, 'gi');
			const nonGlobal = new RegExp(regex.source, regex.flags.replace(/g/g, ''));
			if (nonGlobal.test('')) return { regex: null, error: 'Pattern matches empty text' };
			return { regex, error: null };
		} catch {
			return { regex: null, error: 'Invalid regex' };
		}
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
	}

	private _navigateBack(): void {
		if (this._stack.length <= 1) return;
		this._stack = this._stack.slice(0, -1);
	}

	private _navigateToDepth(depth: number): void {
		if (depth >= this._stack.length || depth < 1) return;
		this._stack = this._stack.slice(0, depth);
	}

	private _renderBreadcrumbs(): TemplateResult {
		return html`${this._stack.map((frame, i) => {
			const isCurrent = i === this._stack.length - 1;
			return html`${i > 0 ? html`<span class="crumb-sep">></span>` : nothing}<button type="button" class="crumb" ?disabled=${isCurrent} @click=${() => this._navigateToDepth(i + 1)}>${frame.label}</button>`;
		})}`;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	private _toggleRaw(): void { this._rawVisible = !this._rawVisible; }

	private _navigateNextMatch(): void {
		if (this._matchCount < 2) return;
		this._currentMatchIndex = (this._currentMatchIndex + 1) % this._matchCount;
		this._scrollToCurrentMatch();
	}

	private _navigatePrevMatch(): void {
		if (this._matchCount < 2) return;
		this._currentMatchIndex = (this._currentMatchIndex - 1 + this._matchCount) % this._matchCount;
		this._scrollToCurrentMatch();
	}

	private async _scrollToCurrentMatch(): Promise<void> {
		await this.updateComplete;
		const root = this.shadowRoot;
		if (!root) return;
		const highlights = root.querySelectorAll('.json-highlight');
		// Remove active from all
		for (const el of highlights) el.classList.remove('json-highlight-active');
		const target = highlights[this._currentMatchIndex];
		if (!target) return;
		target.classList.add('json-highlight-active');
		try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { try { target.scrollIntoView(true); } catch { /* ignore */ } }
	}

	private _copyValue(value: unknown): void {
		writeTextToClipboard(stringifyForSearch(value), this.copyCallback);
	}

	private _copyRaw(rawStr: string): void {
		writeTextToClipboard(rawStr, this.copyCallback);
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = styles;
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-object-viewer': KwObjectViewer;
	}
}
