import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-publish-pbi-dialog.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { customElement, state } from 'lit/decorators.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';
import { postMessageToHost } from '../shared/webview-messages.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';
import type { PbiPublishInfo } from '../sections/kw-html-section.js';

type DialogState = 'idle' | 'loading-workspaces' | 'ready' | 'publishing' | 'success' | 'error';
type PublishMode = 'update' | 'new';

interface PbiWorkspace { id: string; name: string; isPersonal?: boolean }

const STORAGE_KEY_WORKSPACE_ID = 'kw.publishPbi.lastWorkspaceId';
const STORAGE_KEY_WORKSPACE_NAME = 'kw.publishPbi.lastWorkspaceName';



@customElement('kw-publish-pbi-dialog')
export class KwPublishPbiDialog extends LitElement {
	@state() private _state: DialogState = 'idle';
	@state() private _workspaces: PbiWorkspace[] = [];
	@state() private _selectedWorkspaceId = '';
	@state() private _workspaceFilter = '';
	@state() private _workspaceDropdownOpen = false;
	@state() private _reportName = '';
	@state() private _pageWidth = 1280;
	@state() private _pageHeight = 720;
	@state() private _errorMessage = '';
	@state() private _reportUrl = '';
	@state() private _scheduleConfigured = false;
	@state() private _visible = false;
	@state() private _publishMode: PublishMode = 'new';
	/** True when the existence check confirmed the report is still alive in the stored workspace. */
	@state() private _existingItemConfirmed = false;
	/** True while the existence check is in flight. */
	@state() private _checkingExistence = false;

	private _htmlCode = '';
	private _boxId = '';
	private _pbiPublishInfo: PbiPublishInfo | undefined;
	private _dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }> = [];
	private _dismiss = () => this._cancel();

	show(
		dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>,
		htmlCode: string,
		suggestedName: string,
		previewHeight?: number,
		boxId?: string,
		pbiPublishInfo?: PbiPublishInfo,
	): void {
		if (this._visible) this.hide();
		this._dataSources = dataSources;
		this._htmlCode = htmlCode;
		this._boxId = boxId || '';
		this._pbiPublishInfo = pbiPublishInfo;
		this._reportName = pbiPublishInfo?.reportName || suggestedName || 'KustoHtmlDashboard';
		this._pageWidth = 1280;
		this._pageHeight = previewHeight || 720;
		this._errorMessage = '';
		this._reportUrl = '';
		this._scheduleConfigured = false;
		this._workspaces = [];
		this._selectedWorkspaceId = '';
		this._workspaceFilter = '';
		this._workspaceDropdownOpen = false;
		this._publishMode = 'new';
		this._existingItemConfirmed = false;
		this._checkingExistence = false;
		this._state = 'loading-workspaces';
		this._visible = true;
		pushDismissable(this._dismiss);

		postMessageToHost({ type: 'getPbiWorkspaces', boxId: this._boxId });

		// Fire existence check in parallel if we have stored publish info
		if (pbiPublishInfo?.reportId && pbiPublishInfo?.workspaceId) {
			this._checkingExistence = true;
			postMessageToHost({ type: 'checkPbiItemExists', boxId: this._boxId, workspaceId: pbiPublishInfo.workspaceId, reportId: pbiPublishInfo.reportId });
		}
	}

	hide(): void {
		this._visible = false;
		this._state = 'idle';
		removeDismissable(this._dismiss);
	}

	/** Called by the parent HTML section to forward host→webview messages. */
	handleHostMessage(message: any): void {
		if (message.type === 'pbiWorkspacesResult') {
			if (message.ok && message.workspaces) {
				this._workspaces = message.workspaces;
				// If we have stored PBI info, select that workspace; otherwise restore last-used
				if (this._pbiPublishInfo?.workspaceId) {
					const storedMatch = message.workspaces.find((w: PbiWorkspace) => w.id === this._pbiPublishInfo!.workspaceId);
					if (storedMatch) {
						this._selectedWorkspaceId = storedMatch.id;
						this._workspaceFilter = storedMatch.name;
					}
				}
				if (!this._selectedWorkspaceId) {
					const lastId = this._readLastWorkspace();
					const lastMatch = lastId ? message.workspaces.find((w: PbiWorkspace) => w.id === lastId.id) : null;
					if (lastMatch) {
						this._selectedWorkspaceId = lastMatch.id;
						this._workspaceFilter = lastMatch.name;
					}
				}
				this._state = 'ready';
			} else {
				this._errorMessage = message.error || 'Failed to load workspaces.';
				this._state = 'error';
			}
		} else if (message.type === 'pbiItemExistsResult') {
			this._checkingExistence = false;
			if (message.exists) {
				this._existingItemConfirmed = true;
				this._publishMode = 'update'; // Default to update when item exists
			} else {
				this._existingItemConfirmed = false;
				this._publishMode = 'new';
			}
		} else if (message.type === 'publishToPowerBIResult') {
			if (message.ok && message.reportUrl) {
				this._reportUrl = message.reportUrl;
				this._scheduleConfigured = !!message.scheduleConfigured;
				this._state = 'success';
			} else {
				this._errorMessage = message.error || 'Failed to publish report.';
				this._state = 'error';
			}
		}
	}

	private _cancel(): void {
		this.hide();
	}

	/** Whether the "Update existing / Publish as new" toggle should be visible. */
	private get _showUpdateToggle(): boolean {
		if (!this._pbiPublishInfo) return false;
		if (this._checkingExistence) return false; // Still checking
		if (!this._existingItemConfirmed) return false; // Item doesn't exist
		// Only show when workspace matches the stored workspace
		return this._selectedWorkspaceId === this._pbiPublishInfo.workspaceId;
	}

	/** Whether the user changed the report name from the stored name (only relevant in update mode). */
	private get _isRenaming(): boolean {
		if (!this._pbiPublishInfo) return false;
		return this._publishMode === 'update' && this._reportName.trim() !== this._pbiPublishInfo.reportName;
	}

	private _publish(): void {
		if (!this._selectedWorkspaceId || !this._reportName.trim()) return;
		this._state = 'publishing';
		this._errorMessage = '';

		const isUpdate = this._showUpdateToggle && this._publishMode === 'update' && this._pbiPublishInfo;
		const selectedWorkspace = this._workspaces.find(w => w.id === this._selectedWorkspaceId);

		postMessageToHost({
			type: 'publishToPowerBI',
			boxId: this._boxId,
			workspaceId: this._selectedWorkspaceId,
			reportName: this._reportName.trim(),
			pageWidth: this._pageWidth,
			pageHeight: this._pageHeight,
			htmlCode: this._htmlCode,
			dataSources: this._dataSources,
			workspaceName: selectedWorkspace?.name,
			isPersonalWorkspace: selectedWorkspace?.isPersonal,
			...(isUpdate ? {
				semanticModelId: this._pbiPublishInfo!.semanticModelId,
				reportId: this._pbiPublishInfo!.reportId,
				existingReportName: this._pbiPublishInfo!.reportName,
			} : {}),
		});

		// Remember selected workspace
		if (selectedWorkspace) this._saveLastWorkspace(selectedWorkspace);
	}

	private _onWorkspaceFilterInput(e: Event): void {
		this._workspaceFilter = (e.target as HTMLInputElement).value;
		this._workspaceDropdownOpen = true;
		// Clear selection if text no longer matches
		const match = this._workspaces.find(w => w.name === this._workspaceFilter);
		this._selectedWorkspaceId = match ? match.id : '';
	}

	private _onWorkspaceFocus(): void {
		this._workspaceDropdownOpen = true;
	}

	private _onWorkspaceBlur(): void {
		// Delay to allow click on list item to fire first
		setTimeout(() => { this._workspaceDropdownOpen = false; }, 150);
	}

	private _onWorkspacePick(w: PbiWorkspace): void {
		this._selectedWorkspaceId = w.id;
		this._workspaceFilter = w.name;
		this._workspaceDropdownOpen = false;
		this._saveLastWorkspace(w);
	}

	private _saveLastWorkspace(w: PbiWorkspace): void {
		try {
			localStorage.setItem(STORAGE_KEY_WORKSPACE_ID, w.id);
			localStorage.setItem(STORAGE_KEY_WORKSPACE_NAME, w.name);
		} catch { /* quota or disabled */ }
	}

	private _readLastWorkspace(): { id: string; name: string } | null {
		try {
			const id = localStorage.getItem(STORAGE_KEY_WORKSPACE_ID);
			const name = localStorage.getItem(STORAGE_KEY_WORKSPACE_NAME);
			if (id && name) return { id, name };
		} catch { /* disabled */ }
		return null;
	}

	private get _filteredWorkspaces(): PbiWorkspace[] {
		const q = this._workspaceFilter.toLowerCase();
		if (!q) return this._workspaces;
		return this._workspaces.filter(w => w.name.toLowerCase().includes(q));
	}

	private _onNameInput(e: Event): void {
		this._reportName = (e.target as HTMLInputElement).value;
	}

	private _onWidthInput(e: Event): void {
		this._pageWidth = Number((e.target as HTMLInputElement).value) || 1280;
	}

	private _onHeightInput(e: Event): void {
		this._pageHeight = Number((e.target as HTMLInputElement).value) || 720;
	}

	private _onPublishModeChange(mode: PublishMode): void {
		this._publishMode = mode;
	}

	// ── Update / Publish-as-new toggle ────────────────────────────────────────

	private _renderUpdateToggle(): TemplateResult | typeof nothing {
		if (!this._showUpdateToggle) return nothing;

		return html`
			<div class="ppd-section">
				<div class="ppd-section-label">Publish mode</div>
				<div class="ppd-toggle-group">
					<button class="ppd-toggle-btn ${this._publishMode === 'update' ? 'is-active' : ''}"
						@click=${() => this._onPublishModeChange('update')}>Update existing</button>
					<button class="ppd-toggle-btn ${this._publishMode === 'new' ? 'is-active' : ''}"
						@click=${() => this._onPublishModeChange('new')}>Publish as new</button>
				</div>
				${this._publishMode === 'new' ? html`
					<div class="ppd-info-note">This will create a new report and semantic model. The previously published report will remain unchanged.</div>
				` : nothing}
				${this._isRenaming ? html`
					<div class="ppd-info-note">Renaming will also rename the semantic model in Power BI. If another item in the workspace already has this name, the publish will fail — just pick a different name and try again. Nothing is lost.</div>
				` : nothing}
			</div>
		`;
	}

	// ── Validation ────────────────────────────────────────────────────────────

	/** Detect hard-coded numbers or dates in the visible HTML text (outside script/style/provenance). */
	private _detectHardcodedValues(): string[] {
		const warnings: string[] = [];
		if (!this._htmlCode) return warnings;

		// Strip <script>, <style>, and HTML tags to get visible text content
		const visibleText = this._htmlCode
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<[^>]+>/g, ' ');

		// Check for date-like patterns (YYYY-MM-DD, MM/DD/YYYY, DD.MM.YYYY, Month DD YYYY, etc.)
		const datePatterns = /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b|\b\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi;
		const dateMatches = visibleText.match(datePatterns);
		if (dateMatches && dateMatches.length > 0) {
			const unique = [...new Set(dateMatches.map(d => d.trim()))].slice(0, 3);
			warnings.push(`Hard-coded date${unique.length > 1 ? 's' : ''} found: ${unique.join(', ')}${dateMatches.length > 3 ? ' …' : ''}`);
		}

		// Check for large numbers that look like metrics (1,234 or 12345+, not years or small counts)
		const numberPatterns = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{5,}(?:\.\d+)?\b/g;
		const numberMatches = visibleText.match(numberPatterns);
		if (numberMatches && numberMatches.length > 0) {
			// Filter out likely years (1900-2099)
			const filtered = numberMatches.filter(n => {
				const v = Number(n.replace(/,/g, ''));
				return !(v >= 1900 && v <= 2099 && !n.includes(','));
			});
			if (filtered.length > 0) {
				const unique = [...new Set(filtered)].slice(0, 3);
				warnings.push(`Hard-coded number${unique.length > 1 ? 's' : ''} found: ${unique.join(', ')}${filtered.length > 3 ? ' …' : ''}`);
			}
		}

		return warnings;
	}

	private _renderValidationWarnings(): TemplateResult | typeof nothing {
		const warnings = this._detectHardcodedValues();
		if (warnings.length === 0) return nothing;
		return html`
			<div class="ppd-validation">
				<div class="ppd-validation-header">⚠ Validation</div>
				${warnings.map(w => html`<div class="ppd-validation-item">${w}</div>`)}
				<div class="ppd-validation-hint">Hard-coded values won't refresh automatically after deployment. Consider using data bindings so values update with each query refresh.</div>
			</div>
		`;
	}

	protected override render(): TemplateResult | typeof nothing {
		if (!this._visible) return html``;

		const isLoading = this._state === 'loading-workspaces';
		const isPublishing = this._state === 'publishing';
		const isSuccess = this._state === 'success';
		const isError = this._state === 'error' && this._errorMessage;
		const canPublish = this._state === 'ready' && this._selectedWorkspaceId && this._reportName.trim();
		const isUpdate = this._showUpdateToggle && this._publishMode === 'update';
		const publishLabel = isUpdate ? 'Update Report' : 'Publish';

		return html`<div class="sd-bg" @mousedown=${this._cancel}><div class="sd" @mousedown=${(e: Event) => e.stopPropagation()}>
			<div class="sd-h">
				<div class="sd-h-title">
					<svg class="sd-h-icon" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="10" width="3" height="4"/><rect x="6" y="6" width="3" height="8"/><rect x="10" y="3" width="3" height="11"/></svg>
					<strong>${isUpdate ? 'Update Power BI Report' : 'Publish to Power BI'}</strong>
				</div>
				<button class="nb sd-x" title="Close" @click=${this._cancel}>${ICONS.close}</button>
			</div>
			<div class="sd-b">
				<div class="ppd-section">
					<div class="ppd-section-label">Destination</div>
					<div class="ppd-row">
						<label class="ppd-label">Workspace</label>
						${isLoading
							? html`<span style="font-size:12px;color:var(--vscode-descriptionForeground)"><span class="ppd-spinner"></span> Loading workspaces…</span>`
							: html`<div class="ppd-combo">
								<input class="ppd-input" type="text"
									.value=${this._workspaceFilter}
									@input=${this._onWorkspaceFilterInput}
									@focus=${this._onWorkspaceFocus}
									@blur=${this._onWorkspaceBlur}
									placeholder="Search workspaces…"
									autocomplete="off">
								${this._workspaceDropdownOpen && this._filteredWorkspaces.length > 0 ? html`
									<ul class="ppd-combo-list">
										${this._filteredWorkspaces.map(w => html`
											<li class="ppd-combo-item ${w.id === this._selectedWorkspaceId ? 'is-selected' : ''}"
												@mousedown=${() => this._onWorkspacePick(w)}>${w.name}</li>
										`)}
									</ul>
								` : nothing}
							</div>`
						}
					</div>
					<div class="ppd-row">
						<label class="ppd-label">Report name</label>
						<input class="ppd-input" type="text" .value=${this._reportName}
							@input=${this._onNameInput} placeholder="Report name">
					</div>
				</div>
				${this._renderUpdateToggle()}
				<div class="ppd-section">
					<div class="ppd-section-label">Layout</div>
					<div class="ppd-dims">
						<div class="ppd-row">
							<label class="ppd-label">Page width</label>
							<input class="ppd-input" type="number" .value=${String(this._pageWidth)}
								@input=${this._onWidthInput} min="320" max="3840">
						</div>
						<div class="ppd-row">
							<label class="ppd-label">Page height</label>
							<input class="ppd-input" type="number" .value=${String(this._pageHeight)}
								@input=${this._onHeightInput} min="200" max="14400">
						</div>
					</div>
				</div>
			</div>

			${isError ? html`<div class="ppd-status ppd-status-error">${this._errorMessage}</div>` : nothing}
			${isSuccess ? html`<div class="ppd-status-success">
				<div class="ppd-success-main">
					<svg class="ppd-success-check" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.354 4.646a.5.5 0 0 0-.708 0L7 9.293 5.354 7.646a.5.5 0 1 0-.708.708l2 2a.5.5 0 0 0 .708 0l4-4a.5.5 0 0 0 0-.708z"/></svg>
					${isUpdate ? 'Updated successfully' : 'Published successfully'}
				</div>
				<a class="ppd-success-link" href=${this._reportUrl} target="_blank">View report ↗</a>
				${this._scheduleConfigured ? html`
					<div class="ppd-success-divider"></div>
					<div class="ppd-success-schedule">⏰ Daily refresh scheduled at 1:00 AM UTC</div>
				` : nothing}
			</div>` : nothing}

			<div class="sd-f">
				${isSuccess
					? html`<button class="sd-btn sd-btn-primary" @click=${this._cancel}>Close</button>`
					: html`
						<button class="sd-btn" @click=${this._cancel}>Cancel</button>
						<button class="sd-btn sd-btn-primary" @click=${this._publish}
							?disabled=${!canPublish || isPublishing || isLoading}>
							${isPublishing ? html`<span class="ppd-spinner"></span> ${isUpdate ? 'Updating…' : 'Publishing…'}` : publishLabel}
						</button>
					`}
			</div>
		</div></div>`;
	}

	static override styles = [scrollbarSheet, iconRegistryStyles, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-publish-pbi-dialog': KwPublishPbiDialog;
	}
}
