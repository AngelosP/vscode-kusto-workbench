import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
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

	static styles = css`
		*, *::before, *::after { box-sizing: border-box; }
		:host { display: contents; }

		.modal-backdrop {
			position: fixed; top: 0; left: 0; right: 0; bottom: 0;
			background: rgba(0, 0, 0, 0.6); z-index: 10000;
			display: flex; align-items: center; justify-content: center;
		}
		.modal-content {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px; width: 80%; max-width: 1200px; max-height: 80%;
			display: flex; flex-direction: column;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		}
		.modal-header {
			padding: 12px 16px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex; justify-content: space-between; align-items: center;
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.modal-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
		.modal-body { flex: 1; overflow: auto; padding: 16px; }

		/* Search */
		.search-area { display: flex; gap: 8px; align-items: center; flex: 1; margin: 0 16px; }
		.search-results { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
		.search-control {
			position: relative; display: inline-flex; align-items: center;
			flex: 1 1 auto; min-width: 0; width: 100%; max-width: 350px;
		}
		.search-icon {
			position: absolute; left: 6px; top: 50%; transform: translateY(-50%);
			pointer-events: none; color: var(--vscode-input-placeholderForeground); opacity: 0.7;
			display: inline-flex; align-items: center; z-index: 1;
		}
		.search-input {
			flex: 1 1 auto; min-width: 0;
			padding: 4px 8px 4px 26px; padding-right: 98px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px; font-family: inherit;
		}
		.search-input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
		.mode-toggle {
			position: absolute; right: 49px; top: 50%; transform: translateY(-50%);
			width: 20px; height: 18px; padding: 0; border: none;
			background: transparent; color: var(--vscode-input-foreground); opacity: 0.7;
			cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 2px;
		}
		.mode-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.nav-divider {
			position: absolute; right: 48px; top: 50%; transform: translateY(-50%);
			width: 1px; height: 14px; background: var(--vscode-input-foreground); opacity: 0.25; pointer-events: none;
		}
		.nav-btn {
			position: absolute; top: 50%; transform: translateY(-50%);
			width: 20px; height: 18px; padding: 0; border: none;
			background: transparent; color: var(--vscode-input-foreground); opacity: 0.7;
			cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 2px;
		}
		.nav-btn:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.nav-btn:disabled { opacity: 0.35; cursor: default; }
		.nav-btn svg { display: block; }
		.nav-prev { right: 26px; }
		.nav-next { right: 4px; }

		/* Buttons */
		.close-btn {
			background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
			display: flex; align-items: center; justify-content: center;
			width: 28px; height: 28px; border-radius: 4px; padding: 0;
		}
		.close-btn:hover { background: var(--vscode-list-hoverBackground); }

		.back-btn {
			padding: 4px 8px; min-width: 28px; height: 28px;
			background: var(--vscode-button-background); color: var(--vscode-button-foreground);
			border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
		}
		.back-btn:hover { background: var(--vscode-button-hoverBackground); }

		.view-btn {
			margin: 0; padding: 2px 6px; font-size: 11px;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer;
			display: inline-flex; align-items: center; vertical-align: baseline;
		}
		.view-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

		.tool-btn {
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
			padding: 4px 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;
		}
		.tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.tool-btn.is-active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

		.copy-btn {
			background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
			min-width: 22px; width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px;
		}
		.copy-btn:hover { background: var(--vscode-list-hoverBackground); }

		/* Sections */
		.section {
			border: 1px solid var(--vscode-panel-border); border-radius: 4px;
			background: var(--vscode-editor-background); margin-bottom: 12px;
		}
		.section-header {
			display: flex; align-items: center; justify-content: space-between; gap: 8px;
			padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.props-section .section-header { justify-content: flex-start; }
		.props-section .section-title { flex: 1; }
		.section-title { font-size: 12px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.props-section .section-title { white-space: normal; overflow: visible; text-overflow: clip; }

		/* Breadcrumbs */
		.crumb {
			background: transparent; border: none; padding: 0; margin: 0;
			font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none;
		}
		.crumb:hover { text-decoration: underline; }
		.crumb:disabled { color: var(--vscode-foreground); cursor: default; text-decoration: none; opacity: 0.9; }
		.crumb-sep { color: var(--vscode-descriptionForeground); padding: 0 6px; user-select: none; }

		/* Properties table */
		.props-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--vscode-font-family); user-select: text; }
		.props-table td { padding: 6px 10px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; word-break: break-word; user-select: text; }
		.props-table td:first-child { width: 35%; max-width: 360px; font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
		.props-table td:last-child { font-family: var(--vscode-editor-font-family); vertical-align: middle; }
		.prop-key-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
		.prop-key-text { flex: 1; min-width: 0; word-break: break-word; }
		.prop-copy-btn { opacity: 0; pointer-events: none; }
		.props-table tr:hover .prop-copy-btn { opacity: 1; pointer-events: auto; }
		.props-table tr.search-match td { background: var(--vscode-editor-findMatchHighlightBackground); outline: 1px solid var(--vscode-editor-findMatchHighlightBorder); outline-offset: -1px; }

		/* Raw JSON */
		.raw-actions { display: inline-flex; gap: 4px; align-items: center; }
		.raw-body { padding: 10px 12px; }
		.json-wrap { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; word-break: break-word; overflow-x: hidden; line-height: 1.6; }
		.json-key { color: var(--vscode-symbolIcon-propertyForeground); }
		.json-string { color: var(--vscode-symbolIcon-stringForeground); }
		.json-number { color: var(--vscode-symbolIcon-numberForeground); }
		.json-boolean { color: var(--vscode-symbolIcon-booleanForeground); }
		.json-null { color: var(--vscode-symbolIcon-nullForeground); }
		.json-highlight { background: var(--vscode-editor-findMatchHighlightBackground); border-radius: 2px; }
		.json-highlight-active { background: var(--vscode-editor-findMatchBackground); outline: 1px solid var(--vscode-editor-findMatchBorder); }
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-object-viewer': KwObjectViewer;
	}
}
