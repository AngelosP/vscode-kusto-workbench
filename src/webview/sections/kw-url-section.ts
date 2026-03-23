import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styles } from './kw-url-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { DataTableColumn, DataTableOptions } from '../components/kw-data-table.js';
import '../components/kw-section-shell.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { schedulePersist } from '../core/persistence.js';
import { __kustoRefreshAllDataSourceDropdowns } from '../core/section-factory.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Image sizing strategy. */
export type ImageSizeMode = 'fill' | 'natural';
/** Image horizontal alignment (only used when sizeMode is 'natural'). */
export type ImageAlign = 'left' | 'center' | 'right';
/** How to handle images larger than the container (only used when sizeMode is 'natural'). */
export type ImageOverflow = 'shrink' | 'scroll';

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 url variant. */
export interface UrlSectionData {
	id: string;
	type: 'url';
	name: string;
	url: string;
	expanded: boolean;
	outputHeightPx?: number;
	imageSizeMode?: ImageSizeMode;
	imageAlign?: ImageAlign;
	imageOverflow?: ImageOverflow;
}

/** Internal URL fetch state. */
interface UrlFetchState {
	url: string;
	expanded: boolean;
	loading: boolean;
	loaded: boolean;
	content: string;
	error: string;
	kind: string;
	contentType: string;
	status: number | null;
	dataUri: string;
	body: string;
	truncated: boolean;
	__hasFetchedOnce?: boolean;
	__autoSizeImagePending?: boolean;
	__autoSizedImageOnce?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-url-section>` — Lit web component for a URL section in the
 * Kusto Workbench notebook. Fetches and renders URL content as images,
 * CSV tables (via `<kw-data-table>`), HTML (sandboxed iframe), or plain text.
 */
@customElement('kw-url-section')
export class KwUrlSection extends LitElement {

	// ── Public properties ─────────────────────────────────────────────────────

	/** Unique section identifier (e.g. "url_1709876543210"). */
	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	/** Output wrapper height in pixels (from persisted state). */
	@property({ type: Number, attribute: 'output-height-px' })
	outputHeightPx: number | undefined = undefined;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _name = '';
	@state() private _url = '';
	@state() private _fetchState: UrlFetchState = KwUrlSection._newFetchState();
	@state() private _csvColumns: DataTableColumn[] = [];
	@state() private _csvRows: string[][] = [];
	@state() private _csvActive = false;
	@state() private _csvTableHeight = 500;
	private _lastCsvVisibleRows: number | null = null;

	// Image display mode
	@state() private _imageSizeMode: ImageSizeMode = 'fill';
	@state() private _imageAlign: ImageAlign = 'left';
	@state() private _imageOverflow: ImageOverflow = 'shrink';
	@state() private _imageMenuOpen = false;

	private _userResized = false;
	private _autoFitPending = false;
	private _csvResizeObs: ResizeObserver | null = null;
	private _fetchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this._onMessage);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this._onMessage);
		this._csvResizeObs?.disconnect();
		this._csvResizeObs = null;
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);

		// Apply persisted height.
		if (this.outputHeightPx && this.outputHeightPx > 0) {
			const wrapper = this.shadowRoot?.getElementById('output-wrapper');
			if (wrapper) {
				const clamped = Math.max(120, Math.min(900, Math.round(this.outputHeightPx)));
				wrapper.style.height = clamped + 'px';
				this._userResized = true;
			}
		}

		this._updateToggleClasses();
		this._renderUrlContent();
		this._autoSizeNameInput();
	}

	override updated(changed: PropertyValues): void {
		super.updated(changed);
		if (changed.has('_fetchState')) {
			this._renderUrlContent();
			// Auto-fit after content finishes loading (non-image types).
			// Images already handle auto-size via __autoSizeImagePending in _renderImage.
			if (this._autoFitPending) {
				this._autoFitPending = false;
				// Wait for the full render cycle (e.g. <kw-data-table> for CSV)
				// then a layout frame so scrollHeight is correct.
				this.updateComplete.then(() =>
					requestAnimationFrame(() => this._fitToContents())
				);
			}
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		return html`
			<div class="section-root">
				<kw-section-shell
					.name=${this._name}
					.expanded=${this._fetchState.expanded}
					box-id=${this.boxId}
					name-placeholder="URL name (optional)"
					@name-change=${this._onShellNameChange}
					@toggle-visibility=${this._toggleVisibility}
					@fit-to-contents=${this._fitToContents}>
					${this._fetchState.expanded && this._isImageContent() ? html`
					<div slot="header-buttons" class="img-menu-anchor">
						<button class="unified-btn-secondary md-tab"
							type="button" @click=${this._toggleImageMenu}
							title="Image display" aria-label="Image display">
							${KwUrlSection._imageIcon}
						</button>
						${this._imageMenuOpen ? this._renderImageMenu() : nothing}
					</div>
					` : nothing}
					<input slot="header-extra" type="text" class="url-input"
						placeholder="Enter a URL to an image or .csv file that is publicly accessible."
						.value=${this._url}
						@input=${this._onUrlInput} />
					${this._fetchState.loading ? html`
						<div class="url-status-msg">Loading…</div>
					` : this._fetchState.error ? html`
						<div class="url-status-msg url-error-msg">${this._fetchState.error}</div>
					` : nothing}
					${this._url.trim() && this._fetchState.loaded ? html`
					<div class="output-wrapper" id="output-wrapper" data-kusto-no-editor-focus="true">
					<div class="url-output ${this._imageOutputClasses()}" id="url-content" aria-label="URL content"
						style="display:${this._csvActive ? 'none' : ''}"></div>
					${this._csvActive ? html`
						<kw-data-table
							style="height:${this._csvTableHeight}px"
							.columns=${this._csvColumns}
							.rows=${this._csvRows}
							.options=${{ label: 'CSV', showExecutionTime: false, compact: true } as DataTableOptions}
							@visible-row-count-change=${this._onCsvVisibleRowCountChange}
							@save=${(e: CustomEvent) => {
								const vscode = window.vscode;
								if (vscode && typeof vscode.postMessage === 'function') {
									vscode.postMessage({
										type: 'saveResultsCsv',
										csv: e.detail.csv,
										suggestedFileName: e.detail.suggestedFileName,
									});
								}
							}}
						></kw-data-table>
					` : nothing}
					<div class="resizer"
						title="Drag to resize"
						@mousedown=${this._onResizerMouseDown}
						@dblclick=${this._fitToContents}></div>
					</div>
					` : nothing}
				</kw-section-shell>
			</div>
		`;
	}

	// ── SVG Icons (static) ────────────────────────────────────────────────────

	private static _imageIcon = html`
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
			stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
			<rect x="2" y="3" width="12" height="10" rx="1.5"/>
			<circle cx="5.5" cy="6.5" r="1.2"/>
			<path d="M2 10.5l3-3 2.5 2.5 2-1.5L14 12"/>
		</svg>`;

	// ── URL Content Rendering ─────────────────────────────────────────────────

	/** Render URL content into the shadow DOM content element. */
	private _renderUrlContent(): void {
		const contentEl = this.shadowRoot?.getElementById('url-content');
		if (!contentEl) return;

		const st = this._fetchState;

		if (!st.expanded) return;

		// Clear previous content.
		while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);
		this._csvActive = false;
		this._lastCsvVisibleRows = null;
		this._csvResizeObs?.disconnect();
		this._csvResizeObs = null;

		// Reset styles.
		contentEl.style.whiteSpace = 'normal';
		contentEl.style.overflow = '';
		contentEl.style.display = '';
		contentEl.style.flexDirection = '';

		if (st.loading) {
			return;
		}

		if (st.error) {
			return;
		}

		if (st.loaded) {
			this._renderLoadedContent(contentEl, st);
			return;
		}

		contentEl.style.whiteSpace = 'pre-wrap';
		contentEl.textContent = st.url ? 'Ready to load.' : 'Enter a URL above.';
	}

	/** Render different content types (image, csv, html, text). */
	private _renderLoadedContent(contentEl: HTMLElement, st: UrlFetchState): void {
		const kind = st.kind.toLowerCase();

		if (kind === 'image' && st.dataUri) {
			this._renderImage(contentEl, st);
			return;
		}

		if (kind === 'csv' && typeof st.body === 'string') {
			this._renderCsv(contentEl, st);
			return;
		}

		if (kind === 'html' && typeof st.body === 'string') {
			this._renderHtml(contentEl, st);
			return;
		}

		// Default: show as text.
		contentEl.style.whiteSpace = 'pre-wrap';
		const pre = document.createElement('pre');
		pre.style.whiteSpace = 'pre-wrap';
		pre.style.margin = '0';
		pre.textContent = st.body || st.content || '';
		contentEl.appendChild(pre);
	}

	private _renderImage(contentEl: HTMLElement, st: UrlFetchState): void {
		const img = document.createElement('img');

		// Auto-size the wrapper to fit the image on first fetch.
		if (st.__autoSizeImagePending && !st.__autoSizedImageOnce) {
			img.addEventListener('load', () => {
				const wrapper = this.shadowRoot?.getElementById('output-wrapper');
				if (!wrapper) return;

				let currentH = 0;
				try { currentH = wrapper.getBoundingClientRect().height; } catch (e) { console.error('[kusto]', e); }
				const minH = 120;
				if (currentH && currentH > (minH + 1)) {
					st.__autoSizeImagePending = false;
					st.__autoSizedImageOnce = true;
					return;
				}

				setTimeout(() => {
					const resizer = this.shadowRoot?.querySelector('.resizer');
					const resizerH = resizer ? resizer.getBoundingClientRect().height : 1;
					const imgH = img.getBoundingClientRect().height;
					if (!imgH || !isFinite(imgH)) return;
					const maxH = 3000;
					const nextH = Math.max(minH, Math.min(maxH, Math.ceil(imgH + resizerH)));
					wrapper.style.height = nextH + 'px';
					this._userResized = true;
					st.__autoSizeImagePending = false;
					st.__autoSizedImageOnce = true;
					this._schedulePersist();
				}, 0);
			}, { once: true });
		}

		img.src = st.dataUri;
		img.alt = 'Image';
		img.style.display = 'block';
		contentEl.appendChild(img);
	}

	private _renderCsv(contentEl: HTMLElement, st: UrlFetchState): void {
		// Defensive: some endpoints return HTML even when URL ends with .csv.
		if (KwUrlSection._looksLikeHtmlText(st.body)) {
			contentEl.style.whiteSpace = 'pre-wrap';
			const pre = document.createElement('pre');
			pre.style.whiteSpace = 'pre-wrap';
			pre.style.margin = '0';
			pre.textContent = 'This URL returned HTML instead of CSV. Try using a raw download link.\n\n' + st.body.slice(0, 2000);
			contentEl.appendChild(pre);
			return;
		}

		const csvRows = KwUrlSection._parseCsv(st.body);
		const maxSaneCols = 2000;
		if (csvRows && csvRows[0] && csvRows[0].length > maxSaneCols) {
			contentEl.style.whiteSpace = 'pre-wrap';
			const pre = document.createElement('pre');
			pre.style.whiteSpace = 'pre-wrap';
			pre.style.margin = '0';
			pre.textContent = `This doesn't look like a normal CSV (detected ${csvRows[0].length} columns). Showing as text instead.\n\n` + st.body.slice(0, 2000);
			contentEl.appendChild(pre);
			return;
		}

		let columns: string[] = [];
		let dataRows: string[][] = [];
		if (csvRows.length > 0) {
			columns = csvRows[0].map((c: string) => String(c ?? ''));
			dataRows = csvRows.slice(1);
		}

		// Normalize ragged rows.
		let maxCols = columns.length;
		for (const r of dataRows) {
			if (r.length > maxCols) maxCols = r.length;
		}
		for (let i = columns.length; i < maxCols; i++) {
			columns.push('Column ' + (i + 1));
		}
		dataRows = dataRows.map((r: string[]) => {
			const out = new Array(maxCols);
			for (let i = 0; i < maxCols; i++) {
				out[i] = String(r[i] ?? '');
			}
			return out;
		});

		// Set CSV state — kw-data-table is rendered declaratively in the template.
		this._csvColumns = columns.map((name: string): DataTableColumn => ({ name }));
		this._csvRows = dataRows;
		this._lastCsvVisibleRows = dataRows.length;
		// Compute height from wrapper (default 120px minus 1px resizer).
		const wrapper = this.shadowRoot?.getElementById('output-wrapper');
		if (wrapper) {
			const wH = wrapper.clientHeight || wrapper.getBoundingClientRect().height || 120;
			this._csvTableHeight = Math.max(60, Math.floor(wH - 1));
		}
		this._csvActive = true;
		// Watch wrapper resizes to keep the table height in sync.
		this._startCsvResizeObserver();
	}

	private _onCsvVisibleRowCountChange = (e: CustomEvent): void => {
		if (!this._csvActive) return;
		const visibleRows = Number((e as CustomEvent)?.detail?.visibleRows);
		if (!Number.isFinite(visibleRows)) return;
		if (this._lastCsvVisibleRows === visibleRows) return;
		this._lastCsvVisibleRows = visibleRows;
		this._fitToContents();
	};

	/** Watch the output wrapper and update the kw-data-table height on resize. */
	private _startCsvResizeObserver(): void {
		this._csvResizeObs?.disconnect();
		const wrapper = this.shadowRoot?.getElementById('output-wrapper');
		if (!wrapper) return;
		this._csvResizeObs = new ResizeObserver(() => {
			const wH = wrapper.clientHeight || wrapper.getBoundingClientRect().height;
			const h = Math.max(60, Math.floor(wH - 1));
			if (h !== this._csvTableHeight) {
				this._csvTableHeight = h;
			}
		});
		this._csvResizeObs.observe(wrapper);
	}

	private _renderHtml(contentEl: HTMLElement, st: UrlFetchState): void {
		let htmlContent = st.body;
		// Inject <base> tag for relative URLs.
		if (st.url) {
			const escapedUrl = st.url.replace(/"/g, '&quot;');
			htmlContent = `<base href="${escapedUrl}">` + htmlContent;
		}
		// Sanitize with DOMPurify if available.
		const DOMPurify = window.DOMPurify;
		if (DOMPurify && typeof DOMPurify.sanitize === 'function') {
			htmlContent = DOMPurify.sanitize(htmlContent, {
				ADD_TAGS: ['base'],
				ADD_ATTR: ['href', 'target', 'rel']
			});
		}
		const iframe = document.createElement('iframe');
		iframe.style.width = '100%';
		iframe.style.height = '300px';
		iframe.style.border = 'none';
		iframe.setAttribute('sandbox', '');
		iframe.setAttribute('referrerpolicy', 'no-referrer');
		iframe.srcdoc = htmlContent;
		contentEl.appendChild(iframe);
	}

	// ── CSV Parser (minimal RFC 4180-ish) ─────────────────────────────────────

	static _parseCsv(text: string): string[][] {
		const rows: string[][] = [];
		let row: string[] = [];
		let field = '';
		let inQuotes = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			const next = text[i + 1];
			if (inQuotes) {
				if (ch === '"' && next === '"') {
					field += '"';
					i++;
					continue;
				}
				if (ch === '"') {
					inQuotes = false;
					continue;
				}
				field += ch;
				continue;
			}
			if (ch === '"') {
				inQuotes = true;
				continue;
			}
			if (ch === ',') {
				row.push(field);
				field = '';
				continue;
			}
			if (ch === '\r') {
				if (next === '\n') i++;
				row.push(field);
				rows.push(row);
				row = [];
				field = '';
				continue;
			}
			if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
				row.push(field);
				rows.push(row);
				row = [];
				field = '';
				continue;
			}
			field += ch;
		}
		row.push(field);
		rows.push(row);
		return rows;
	}

	static _looksLikeHtmlText(text: string): boolean {
		const s = (text || '').slice(0, 4096).trimStart().toLowerCase();
		return s.startsWith('<!doctype html') || s.startsWith('<html') || s.startsWith('<head') || s.startsWith('<body');
	}

	// ── Image display mode ────────────────────────────────────────────────────

	private _isImageContent(): boolean {
		return this._fetchState.loaded && this._fetchState.kind.toLowerCase() === 'image' && !!this._fetchState.dataUri;
	}

	private _imageOutputClasses(): string {
		if (!this._isImageContent()) return '';
		const parts: string[] = [];
		if (this._imageSizeMode === 'fill') {
			// Mode A: Original size — raw display
			parts.push('img-fill');
		} else {
			// Mode B: Fill section — with overflow + alignment sub-options
			parts.push('img-natural');
			parts.push(this._imageOverflow === 'scroll' ? 'img-scroll' : 'img-shrink');
			parts.push(`img-align-${this._imageAlign}`);
		}
		return parts.join(' ');
	}

	private _toggleImageMenu = (): void => {
		this._imageMenuOpen = !this._imageMenuOpen;
		if (this._imageMenuOpen) {
			requestAnimationFrame(() => document.addEventListener('mousedown', this._closeImageMenuOnOutside, true));
		} else {
			document.removeEventListener('mousedown', this._closeImageMenuOnOutside, true);
		}
	};

	private _closeImageMenuOnOutside = (e: MouseEvent): void => {
		const path = e.composedPath();
		const menu = this.shadowRoot?.querySelector('.img-menu');
		const anchor = this.shadowRoot?.querySelector('.img-menu-anchor');
		if (menu && (path.includes(menu) || (anchor && path.includes(anchor)))) return;
		this._imageMenuOpen = false;
		document.removeEventListener('mousedown', this._closeImageMenuOnOutside, true);
	};

	private _setImageSizeMode(mode: ImageSizeMode): void {
		this._imageSizeMode = mode;
		this._imageMenuOpen = true; // keep menu open so sub-options appear
		this._applyImageClasses();
		this._schedulePersist();
	}

	private _setImageAlign(align: ImageAlign): void {
		this._imageAlign = align;
		this._applyImageClasses();
		this._schedulePersist();
	}

	private _setImageOverflow(overflow: ImageOverflow): void {
		this._imageOverflow = overflow;
		this._applyImageClasses();
		this._schedulePersist();
	}

	private _applyImageClasses(): void {
		const el = this.shadowRoot?.getElementById('url-content');
		if (!el) return;
		// Strip all image mode classes and reapply.
		el.classList.remove('img-fill', 'img-natural', 'img-shrink', 'img-scroll', 'img-align-left', 'img-align-center', 'img-align-right');
		const cls = this._imageOutputClasses();
		if (cls) cls.split(' ').forEach(c => el.classList.add(c));
	}

	private _renderImageMenu(): TemplateResult {
		const check = '\u2713';
		return html`<div class="img-menu" @click=${(e: Event) => e.stopPropagation()}>
			<div class="img-menu-label">Sizing</div>
			<div class="img-menu-item" @click=${() => this._setImageSizeMode('fill')}>
				<span class="img-menu-check">${this._imageSizeMode === 'fill' ? check : ''}</span>
				Fill section
			</div>
			<div class="img-menu-item" @click=${() => this._setImageSizeMode('natural')}>
				<span class="img-menu-check">${this._imageSizeMode === 'natural' ? check : ''}</span>
				Original size
			</div>
			${this._imageSizeMode === 'natural' ? html`
				<div class="img-menu-sep"></div>
				<div class="img-menu-label">Overflow</div>
				<div class="img-menu-item" @click=${() => this._setImageOverflow('shrink')}>
					<span class="img-menu-check">${this._imageOverflow === 'shrink' ? check : ''}</span>
					Shrink to fit
				</div>
				<div class="img-menu-item" @click=${() => this._setImageOverflow('scroll')}>
					<span class="img-menu-check">${this._imageOverflow === 'scroll' ? check : ''}</span>
					Show scrollbar
				</div>
				<div class="img-menu-sep"></div>
				<div class="img-menu-label">Alignment</div>
				<div class="img-menu-item" @click=${() => this._setImageAlign('left')}>
					<span class="img-menu-check">${this._imageAlign === 'left' ? check : ''}</span>
					Left
				</div>
				<div class="img-menu-item" @click=${() => this._setImageAlign('center')}>
					<span class="img-menu-check">${this._imageAlign === 'center' ? check : ''}</span>
					Center
				</div>
				<div class="img-menu-item" @click=${() => this._setImageAlign('right')}>
					<span class="img-menu-check">${this._imageAlign === 'right' ? check : ''}</span>
					Right
				</div>
			` : nothing}
		</div>`;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._name = e.detail.name;
		this._autoSizeNameInput();
		this._schedulePersist();
		// Refresh Data dropdowns in Chart/Transformation sections.
		try {
			__kustoRefreshAllDataSourceDropdowns();
		} catch (e) { console.error('[kusto]', e); }
	}

	private _onUrlInput(e: Event): void {
		const input = e.target as HTMLInputElement;
		const url = input.value.trim();
		this._url = input.value; // Keep raw value for display
		const st = this._fetchState;
		st.url = url;
		st.loaded = false;
		st.content = '';
		st.error = '';
		st.kind = '';
		st.contentType = '';
		st.status = null;
		st.dataUri = '';
		st.body = '';
		st.truncated = false;
		st.__hasFetchedOnce = false;
		st.__autoSizeImagePending = false;
		st.__autoSizedImageOnce = false;
		this._fetchState = { ...st };
		this._renderUrlContent();
		// Debounce fetch to avoid firing on every keystroke.
		if (this._fetchDebounceTimer) clearTimeout(this._fetchDebounceTimer);
		if (st.expanded && url) {
			this._fetchDebounceTimer = setTimeout(() => {
				this._fetchDebounceTimer = null;
				this._requestFetch();
			}, 200);
		}
		this._schedulePersist();
	}

	private _toggleVisibility(): void {
		const st = { ...this._fetchState };
		st.expanded = !st.expanded;
		this._fetchState = st;
		this._updateToggleClasses();
		this._renderUrlContent();
		if (st.expanded && st.url) {
			this._requestFetch();
		}
		this._schedulePersist();
	}

	private _requestRemove(): void {
		this.dispatchEvent(new CustomEvent('section-remove', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true
		}));
	}

	private _onDragStart(e: DragEvent): void {
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', this.boxId);
			e.dataTransfer.effectAllowed = 'move';
		}
		this.dispatchEvent(new CustomEvent('section-drag-start', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true
		}));
	}

	private _updateToggleClasses(): void {
		this.classList.toggle('is-url-collapsed', !this._fetchState.expanded);
	}

	private _autoSizeNameInput(): void {
		const shell = this.shadowRoot?.querySelector('kw-section-shell');
		const input = shell?.shadowRoot?.querySelector('.query-name') as HTMLInputElement | null;
		if (!input) return;
		const v = this._name.trim();
		const minPx = v ? 25 : 140;
		input.style.width = '1px';
		const pad = 2;
		const w = Math.max(minPx, Math.min(250, (input.scrollWidth || 0) + pad));
		input.style.width = w + 'px';
	}

	// ── Fetch URL Content ─────────────────────────────────────────────────────

	private _requestFetch(): void {
		const st = this._fetchState;
		if (st.loading || st.loaded) return;
		const url = st.url.trim();
		if (!url) return;
		this._fetchState = { ...st, loading: true, error: '' };
		this._renderUrlContent();
		try {
			const vscode = window.vscode;
			if (vscode && typeof vscode.postMessage === 'function') {
				vscode.postMessage({ type: 'fetchUrl', boxId: this.boxId, url });
			}
		} catch {
			this._fetchState = { ...st, loading: false, error: 'Failed to request URL.' };
			this._renderUrlContent();
		}
	}

	// ── Message handling ──────────────────────────────────────────────────────

	private _onMessage = (e: MessageEvent): void => {
		const msg = e.data;
		if (!msg || typeof msg !== 'object') return;

		if (msg.type === 'urlContent' && msg.boxId === this.boxId) {
			const st = { ...this._fetchState };
			st.loading = false;
			st.loaded = true;
			st.error = '';
			st.url = String(msg.url || st.url || '');
			st.contentType = String(msg.contentType || st.contentType || '');
			st.status = (typeof msg.status === 'number') ? msg.status : (st.status ?? null);
			st.kind = String(msg.kind || '').toLowerCase();
			st.truncated = !!msg.truncated;
			st.dataUri = String(msg.dataUri || '');
			st.body = (typeof msg.body === 'string') ? msg.body : '';
			if (!st.__hasFetchedOnce) {
				st.__hasFetchedOnce = true;
				if (st.kind === 'image') {
					st.__autoSizeImagePending = true;
				}
			}
			st.content = st.body || '';
			// Schedule auto-fit for non-image content (images use __autoSizeImagePending).
			if (st.kind !== 'image') {
				this._autoFitPending = true;
			}
			this._fetchState = st;
		}

		if (msg.type === 'urlError' && msg.boxId === this.boxId) {
			const st = { ...this._fetchState };
			st.loading = false;
			st.loaded = false;
			st.content = '';
			st.error = String(msg.error || 'Failed to load URL.');
			this._fetchState = st;
		}
	};

	// ── Fit to contents ───────────────────────────────────────────────────────

	/**
	 * Compute the height needed to show all CSV content without a scrollbar.
	 * Used as the max-drag limit so users can manually expand to see every row.
	 */
	private _computeFullCsvHeight(): number {
		const RESIZER_HEIGHT = 1;
		if (!this._csvActive || this._csvRows.length === 0) return 0;
		const tableEl = this.shadowRoot?.querySelector('kw-data-table') as { getVisibleRowCount?: () => number } | null;
		const visibleRows = (tableEl && typeof tableEl.getVisibleRowCount === 'function')
			? Math.max(0, tableEl.getVisibleRowCount())
			: this._csvRows.length;
		const tableShadow = (tableEl as unknown as { shadowRoot?: ShadowRoot | null })?.shadowRoot ?? null;
		const hbarH = (tableShadow?.querySelector('.hbar') as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
		const headH = (tableShadow?.querySelector('.dtable-head-wrap') as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
		const rowSample = (tableShadow?.querySelector('#dt-body tbody tr td') as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
		const rowH = rowSample > 0 ? rowSample : 24;
		const EXTRA_PAD = 16;
		const contentH = hbarH + headH + (visibleRows * rowH) + RESIZER_HEIGHT;
		return Math.max(120, Math.ceil(contentH + EXTRA_PAD));
	}

	/** Compute the ideal wrapper height to show all content.
	 *  For CSV: auto-fit caps at ~10 visible rows. For images/text/html: natural height (cap at 3000px).
	 */
	private _computeFitToContentsHeight(): number {
		const RESIZER_HEIGHT = 1;

		// For CSV tables: compute from row count, capped to show at most 10 visible rows.
		if (this._csvActive && this._csvRows.length > 0) {
			const MAX_AUTO_ROWS = 10;
			const tableEl = this.shadowRoot?.querySelector('kw-data-table') as { getVisibleRowCount?: () => number } | null;
			const visibleRows = (tableEl && typeof tableEl.getVisibleRowCount === 'function')
				? Math.max(0, tableEl.getVisibleRowCount())
				: this._csvRows.length;
			const tableShadow = (tableEl as unknown as { shadowRoot?: ShadowRoot | null })?.shadowRoot ?? null;
			const hbarH = (tableShadow?.querySelector('.hbar') as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
			const headH = (tableShadow?.querySelector('.dtable-head-wrap') as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
			const rowSample = (tableShadow?.querySelector('#dt-body tbody tr td') as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
			const rowH = rowSample > 0 ? rowSample : 24;
			const EXTRA_PAD = 16;
			const TABLE_CHROME = 120;
			const MAX_AUTO_H = TABLE_CHROME + (MAX_AUTO_ROWS * rowH);
			const contentH = hbarH + headH + (visibleRows * rowH) + RESIZER_HEIGHT;
			const baseH = Math.max(120, Math.min(MAX_AUTO_H, Math.ceil(contentH)));
			return Math.min(MAX_AUTO_H, baseH + EXTRA_PAD);
		}

		// For other content (images, text, html): measure actual content, cap at 3000px.
		const contentEl = this.shadowRoot?.getElementById('url-content');
		if (!contentEl) return 120;

		let contentH = 0;
		const children = Array.from(contentEl.children);
		if (children.length) {
			for (const child of children) {
				try {
					const cs = getComputedStyle(child);
					if (cs.display === 'none') continue;
					const h = child.getBoundingClientRect().height || 0;
					const margin = (parseFloat(cs.marginTop || '0') || 0) + (parseFloat(cs.marginBottom || '0') || 0);
					contentH += Math.ceil(h + margin);
				} catch (e) { console.error('[kusto]', e); }
			}
		} else {
			contentH = contentEl.scrollHeight || 0;
		}

		return Math.max(120, Math.min(3000, Math.ceil(contentH + RESIZER_HEIGHT)));
	}

	private _fitToContents(): void {
		const wrapper = this.shadowRoot?.getElementById('output-wrapper');
		if (!wrapper) return;

		// In Mode B (Fill section), cap to image natural height so there's no blank space.
		if (this._imageSizeMode === 'natural' && this._isImageContent()) {
			const imgEl = this.shadowRoot?.querySelector('#url-content img') as HTMLImageElement | null;
			if (imgEl && imgEl.naturalHeight > 0) {
				const resizerH = this.shadowRoot?.querySelector('.resizer')?.getBoundingClientRect().height ?? 1;
				const maxH = Math.ceil(imgEl.naturalHeight + resizerH);
				wrapper.style.height = Math.max(120, maxH) + 'px';
				this._userResized = true;
				this._schedulePersist();
				return;
			}
		}

		const desiredPx = this._computeFitToContentsHeight();
		wrapper.style.height = desiredPx + 'px';
		wrapper.style.minHeight = '0';
		this._userResized = true;
		this._schedulePersist();
	}

	// ── Resize handle ─────────────────────────────────────────────────────────

	private _onResizerMouseDown(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();

		const wrapper = this.shadowRoot?.getElementById('output-wrapper');
		if (!wrapper) return;

		this._userResized = true;
		const resizer = e.currentTarget as HTMLElement;
		resizer.classList.add('is-dragging');

		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';

		const startPageY = e.clientY + getScrollY();
		const startHeight = wrapper.getBoundingClientRect().height;
		wrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px';

		const minH = 120;
		// For CSV tables, allow expanding to show all rows.
		// For images in Mode B, cap to natural image height (no blank space).
		// For everything else, use fit-to-contents as the max.
		let maxH = (this._csvActive && this._csvRows.length > 0)
			? (this._computeFullCsvHeight() || 20000)
			: (this._computeFitToContentsHeight() || 20000);

		// In Mode B (Fill section) for images, cap max height to image natural height
		// so there's no blank space below the image.
		if (this._imageSizeMode === 'natural' && this._isImageContent()) {
			const imgEl = this.shadowRoot?.querySelector('#url-content img') as HTMLImageElement | null;
			if (imgEl && imgEl.naturalHeight > 0) {
				const resizerH = this.shadowRoot?.querySelector('.resizer')?.getBoundingClientRect().height ?? 1;
				maxH = Math.max(minH, Math.ceil(imgEl.naturalHeight + resizerH));
			}
		}

		const onMove = (moveEvent: MouseEvent) => {
			try {
				maybeAutoScrollWhileDragging(moveEvent.clientY);
			} catch (e) { console.error('[kusto]', e); }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			const nextHeight = Math.max(minH, Math.min(maxH, startHeight + delta));
			wrapper.style.height = nextHeight + 'px';
		};

		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
			this._schedulePersist();
		};

		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			schedulePersist();
		} catch (e) { console.error('[kusto]', e); }
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 * Output is identical to the original persistence.js URL section shape.
	 */
	public serialize(): UrlSectionData {
		const data: UrlSectionData = {
			id: this.boxId,
			type: 'url',
			name: this._name,
			url: this._fetchState.url || this._url.trim(),
			expanded: this._fetchState.expanded,
		};

		const heightPx = this._getOutputHeightPx();
		if (heightPx !== undefined) {
			data.outputHeightPx = heightPx;
		}

		if (this._imageSizeMode !== 'fill') data.imageSizeMode = this._imageSizeMode;
		if (this._imageAlign !== 'left') data.imageAlign = this._imageAlign;
		if (this._imageOverflow !== 'shrink') data.imageOverflow = this._imageOverflow;

		return data;
	}

	/** Get the output wrapper height if user explicitly resized. */
	private _getOutputHeightPx(): number | undefined {
		const wrapper = this.shadowRoot?.getElementById('output-wrapper');
		if (!wrapper) return undefined;

		if (!this._userResized) return undefined;

		let inlineHeight = wrapper.style.height?.trim();
		if (!inlineHeight || inlineHeight === 'auto') return undefined;

		const m = inlineHeight.match(/^(\d+)px$/i);
		if (!m) return undefined;

		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? Math.max(0, px) : undefined;
	}

	// ── Public API (for legacy integration) ───────────────────────────────────

	public getName(): string {
		return this._name;
	}

	/** Set name programmatically (e.g. from restore). */
	public setName(name: string): void {
		this._name = name;
		this.updateComplete.then(() => this._autoSizeNameInput());
	}

	/** Set URL programmatically (e.g. from restore). */
	public setUrl(url: string): void {
		this._url = url;
		this._fetchState = { ...this._fetchState, url };
	}

	/** Set expanded state. */
	public setExpanded(expanded: boolean): void {
		this._fetchState = { ...this._fetchState, expanded };
		this._updateToggleClasses();
		this._renderUrlContent();
	}

	/** Set the output height. */
	public setOutputHeightPx(heightPx: number): void {
		const wrapper = this.shadowRoot?.getElementById('output-wrapper');
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		const clamped = Math.max(120, Math.min(900, Math.round(h)));
		wrapper.style.height = clamped + 'px';
		this._userResized = true;
	}

	/** Restore image display settings (from persistence). */
	public setImageDisplayMode(sizeMode?: ImageSizeMode, align?: ImageAlign, overflow?: ImageOverflow): void {
		if (sizeMode === 'fill' || sizeMode === 'natural') this._imageSizeMode = sizeMode;
		if (align === 'left' || align === 'center' || align === 'right') this._imageAlign = align;
		if (overflow === 'shrink' || overflow === 'scroll') this._imageOverflow = overflow;
	}

	/** Get the fetch state (for legacy code compatibility). */
	public getFetchState(): UrlFetchState {
		return this._fetchState;
	}

	/** Trigger a content fetch if expanded and URL is set. */
	public triggerFetch(): void {
		if (this._fetchState.expanded && this._fetchState.url) {
			this._requestFetch();
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private static _newFetchState(): UrlFetchState {
		return {
			url: '',
			expanded: true,
			loading: false,
			loaded: false,
			content: '',
			error: '',
			kind: '',
			contentType: '',
			status: null,
			dataUri: '',
			body: '',
			truncated: false,
		};
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-url-section': KwUrlSection;
	}
}
