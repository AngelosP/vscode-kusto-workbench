import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../components/kw-dropdown.js';
import '../components/kw-search-bar.js';
import type { DropdownItem } from '../components/kw-dropdown.js';
import { buildSearchRegex, navigateMatch, type SearchMode } from '../components/search-utils.js';
import { OverlayScrollbarsController } from '../components/overlay-scrollbars.controller.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';
import { osLibrarySheet } from '../shared/os-library-styles.js';
import { osThemeSheet } from '../shared/os-theme-styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import {
	searchTutorials,
	TUTORIAL_CONNECTION_REQUIRED_MESSAGE,
	type TutorialCategoryPreference,
	type TutorialNotificationCadence,
	type TutorialNotificationChannel,
	type TutorialSummary,
	type TutorialViewerMode,
	type TutorialViewerSnapshot,
} from '../../shared/tutorials/tutorialCatalog.js';
import { tutorialViewerStyles } from './kw-tutorial-viewer.styles.js';

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };

interface TutorialContentMessage {
	tutorialId: string;
	markdown: string;
	source: 'remote' | 'cache' | 'localDevelopment' | 'unavailable';
	errors: string[];
}

interface TutorialSearchMatch {
	tutorialId: string;
	field: 'displayName' | 'contentText';
	fieldMatchIndex: number;
}

function escapeSearchRegex(value: string): string {
	return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

@customElement('kw-tutorial-viewer')
export class KwTutorialViewer extends LitElement {
	static styles = [iconRegistryStyles, scrollbarSheet, osLibrarySheet, osThemeSheet, tutorialViewerStyles];

	@state() private snapshot: TutorialViewerSnapshot | null = null;
	@state() private mode: TutorialViewerMode = 'standard';
	@state() private query = '';
	@state() private selectedCategoryId: string | null = null;
	@state() private selectedTutorialId: string | null = null;
	@state() private loadingTutorialId: string | null = null;
	@state() private renderedMarkdown = '';
	@state() private contentErrors: string[] = [];
	@state() private hostError = '';
	@state() private searchMode: SearchMode = 'wildcard';
	@state() private showAlreadySeen = true;
	@state() private currentSearchMatchIndex = 0;
	@state() private muteMenuOpen = false;
	@state() private muteCategorySubmenuOpen = false;
	@state() private categoryMuteOverrides: Record<string, boolean> = {};
	@state() private contentTitles: Record<string, string> = {};

	private readonly _osCtrl = new OverlayScrollbarsController(this);
	private readonly vscode = acquireVsCodeApi();
	private modeInitialized = false;
	private latestSnapshotRevision = 0;
	private loadedTutorialId: string | null = null;
	private compactSessionTutorialIds: string[] | null = null;

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this.onHostMessage);
		this.vscode.postMessage({ type: 'requestSnapshot' });
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener('message', this.onHostMessage);
	}

	render(): TemplateResult {
		const snapshot = this.snapshot;
		if (!snapshot) {
			return html`<div class="viewer-shell"><div class="viewer-frame loading-frame"><div class="loading" role="status">Loading...</div></div></div>`;
		}

		const selectedTutorial = this.currentTutorial();
		if (this.isUnavailableSnapshot(snapshot)) {
			return html`
				<div class="viewer-shell mode-standard" data-testid="tutorial-viewer-mode-unavailable">
					${this.renderUnavailable()}
				</div>
			`;
		}
		this.ensureTutorialLoaded(selectedTutorial);

		const renderedMode = this.isCompactMode() ? 'compact' : 'standard';
		return html`
			<div class="viewer-shell mode-${renderedMode}" data-testid="tutorial-viewer-mode-${renderedMode}">
				${renderedMode === 'compact'
					? this.renderCompactMode(selectedTutorial)
					: this.renderStandardMode(selectedTutorial)}
			</div>
		`;
	}

	private renderUnavailable(): TemplateResult {
		const detail = this.snapshot?.status.errors.find(Boolean) ?? this.hostError;
		return html`
			<div class="viewer-frame unavailable-frame" role="dialog" aria-label="Did you know? unavailable">
				<div class="unavailable-content" role="status">
					<span class="eyebrow">Kusto Workbench</span>
					<h1 data-testid="tutorial-viewer-title">Did you know?</h1>
					<p data-testid="tutorial-unavailable-message">${TUTORIAL_CONNECTION_REQUIRED_MESSAGE}</p>
					${detail && detail !== TUTORIAL_CONNECTION_REQUIRED_MESSAGE ? html`<p class="unavailable-detail">${detail}</p>` : nothing}
					<button class="action-btn" title="Refresh catalog" aria-label="Refresh catalog" @click=${this.refreshCatalog}>${ICONS.refresh} Refresh</button>
				</div>
			</div>
		`;
	}

	private renderStandardMode(selectedTutorial: TutorialSummary | null): TemplateResult {
		const snapshot = this.snapshot!;
		const tutorials = this.filteredTutorials();
		const emptyMessage = this.standardEmptyMessage();
		const searchMatches = this.tutorialSearchMatches(tutorials);
		const currentSearchMatchIndex = this.normalizedSearchMatchIndex(searchMatches.length);
		const currentSearchMatch = searchMatches[currentSearchMatchIndex] ?? null;
		const muteCategoryId = this.standardMuteCategoryId(selectedTutorial);
		const mutePreference = muteCategoryId ? this.preference(muteCategoryId) : undefined;
		const selectedTutorialIndex = selectedTutorial ? tutorials.findIndex(tutorial => tutorial.id === selectedTutorial.id) : -1;
		const currentTutorialPosition = selectedTutorialIndex >= 0 ? selectedTutorialIndex + 1 : 0;
		const previousTutorial = selectedTutorialIndex > 0 ? tutorials[selectedTutorialIndex - 1] : null;
		const nextTutorial = selectedTutorialIndex >= 0 && selectedTutorialIndex < tutorials.length - 1 ? tutorials[selectedTutorialIndex + 1] : null;
		return html`
			<div class="viewer-frame standard-frame" role="dialog" aria-label="Did you know? library">
				<button class="icon-btn standard-close" title="Close" aria-label="Close Did you know?" data-testid="tutorial-standard-dismiss" @click=${this.dismissViewer}>${ICONS.close}</button>
				<aside class="sidebar" aria-label="Did you know? navigation">
					<div class="header">
						<div class="title-row">
							<div class="title-copy standard-title-copy">
								<div class="standard-brand-row">
									<h1 class="standard-brand" data-testid="tutorial-viewer-title">Did you know?</h1>
									${this.renderStatusInfo()}
								</div>
							</div>
							<div class="toolbar-actions">
								<button class="icon-btn" title="Refresh catalog" aria-label="Refresh catalog" @click=${this.refreshCatalog}>${ICONS.refresh}</button>
							</div>
						</div>
						<kw-search-bar
							.query=${this.query}
							.mode=${this.searchMode}
							.matchCount=${searchMatches.length}
							.currentMatch=${currentSearchMatchIndex}
							@search-input=${this.onSearchInput}
							@search-mode-change=${this.onSearchModeChange}
							@search-next=${() => this.navigateSearch('next')}
							@search-prev=${() => this.navigateSearch('prev')}
						></kw-search-bar>
						<div class="standard-filter-row">
							<kw-dropdown
								class="category-dropdown"
								data-testid="tutorial-category-select"
								.items=${this.categoryDropdownItems(snapshot)}
								.selectedId=${this.selectedCategoryId ?? 'all'}
								.placeholder=${'All'}
								.emptyText=${'No categories.'}
								@dropdown-select=${this.onCategorySelect}
							></kw-dropdown>
							<label class="standard-seen-toggle" data-testid="tutorial-show-seen-toggle">
								<input type="checkbox" .checked=${this.showAlreadySeen} @change=${this.onShowAlreadySeenChange}>
								<span>Show already seen</span>
							</label>
						</div>
					</div>
					<div
						class="tutorial-list"
						data-testid="tutorial-list"
						data-overlay-scroll="x:hidden y:scroll"
						aria-label="Did you know? content"
						@keydown=${this.onTutorialListKeydown}
					>
						${tutorials.length ? tutorials.map(tutorial => this.renderTutorialItem(tutorial, currentSearchMatch)) : this.renderEmptyState(emptyMessage)}
					</div>
				</aside>
				<main class="detail" aria-label="Did you know? content">
					${selectedTutorial ? this.renderStandardDetail(selectedTutorial) : this.renderEmptyState(emptyMessage, 'content-empty')}
					<footer class="standard-footer" aria-label="Did you know? actions">
						<div class="compact-nav standard-nav" aria-label="Did you know? navigation">
							<button class="icon-btn previous" data-testid="tutorial-standard-prev" title="Previous" aria-label="Previous" ?disabled=${!previousTutorial} @click=${() => previousTutorial ? this.openTutorial(previousTutorial.id, { markSeen: true }) : undefined}>${ICONS.chevron}</button>
							<span class="position" aria-label=${`Tutorial ${currentTutorialPosition} of ${tutorials.length}`}>${currentTutorialPosition} of ${tutorials.length}</span>
							<button class="icon-btn" data-testid="tutorial-standard-next" title="Next" aria-label="Next" ?disabled=${!nextTutorial} @click=${() => nextTutorial ? this.openTutorial(nextTutorial.id, { markSeen: true }) : undefined}>${ICONS.chevron}</button>
						</div>
						<div class="standard-footer-actions">
							${muteCategoryId ? html`
								<div class="mute-wrap standard-mute-wrap">
									<button class="link-btn standard-footer-link" data-testid="tutorial-standard-mute" aria-expanded=${this.muteMenuOpen ? 'true' : 'false'} @click=${this.toggleMuteMenu}>Mute...</button>
									${this.muteMenuOpen ? html`<div class="mute-menu" role="menu" aria-label="Mute Did you know?">${this.renderMuteMenu(muteCategoryId, mutePreference)}</div>` : nothing}
								</div>
							` : nothing}
							<button class="link-btn standard-footer-link" data-testid="tutorial-mode-compact" @click=${() => this.setMode('compact')}>Compact</button>
						</div>
					</footer>
				</main>
			</div>
		`;
	}

	private renderCompactMode(selectedTutorial: TutorialSummary | null): TemplateResult {
		if (!selectedTutorial) {
			return this.renderCompactEmptyMode();
		}

		const title = this.tutorialDisplayName(selectedTutorial);
		const sequence = this.compactTutorials();
		const index = Math.max(0, sequence.findIndex(tutorial => tutorial.id === selectedTutorial.id));
		const previousTutorial = index > 0 ? sequence[index - 1] : null;
		const nextTutorial = index >= 0 && index < sequence.length - 1 ? sequence[index + 1] : null;
		const isLoading = this.loadingTutorialId === selectedTutorial.id;
		const preference = this.preference(selectedTutorial.categoryId);
		const previousAvailable = !!previousTutorial || this.hasPendingCompactQueueNavigation(selectedTutorial.id, -1);
		const nextAvailable = !!nextTutorial || this.hasPendingCompactQueueNavigation(selectedTutorial.id, 1);

		return html`
			<div class="compact-backdrop">
				<div class="viewer-frame compact-frame" role="dialog" aria-modal="true" aria-label=${`Did you know? ${title}`} tabindex="-1" @keydown=${this.onCompactKeydown}>
					<header class="compact-header">
						<div class="compact-kicker-row">
							<span class="compact-brand">Did you know?</span>
						</div>
						<button class="icon-btn compact-close" title="Dismiss" aria-label="Dismiss Did you know?" data-testid="tutorial-dismiss" @click=${this.dismissViewer}>${ICONS.close}</button>
						<h1 data-testid="tutorial-viewer-title">${title}</h1>
					</header>
					<section class="compact-content" data-overlay-scroll="x:hidden y:scroll" aria-label="Did you know? content">
						${this.contentErrors.length ? html`<div class="error-list" role="status">${this.contentErrors[0]}</div>` : nothing}
						${isLoading ? html`<div class="loading" role="status">Loading...</div>` : html`<article class="markdown compact-markdown" @click=${this.onMarkdownClick}>${this.renderCompactMarkdown(selectedTutorial)}</article>`}
					</section>
					<footer class="compact-footer" aria-label="Did you know? actions">
						<div class="compact-nav" aria-label="Did you know? navigation">
							<button class="icon-btn previous" data-testid="tutorial-prev" title="Previous" aria-label="Previous" ?disabled=${!previousAvailable} @click=${() => this.navigateCompact(-1, { markSeen: true })}>${ICONS.chevron}</button>
							<span class="position" aria-label=${`Tutorial ${index + 1} of ${sequence.length}`}>${index + 1} of ${sequence.length}</span>
							<button class="icon-btn" data-testid="tutorial-next" title="Next" aria-label="Next" ?disabled=${!nextAvailable} @click=${() => this.navigateCompact(1, { markSeen: true })}>${ICONS.chevron}</button>
						</div>
						<div class="compact-utility-strip">
							<div class="mute-wrap">
								<button class="link-btn compact-link" data-testid="tutorial-compact-mute" aria-expanded=${this.muteMenuOpen ? 'true' : 'false'} @click=${this.toggleMuteMenu}>Mute...</button>
								${this.muteMenuOpen ? html`<div class="mute-menu" role="menu" aria-label="Mute Did you know?">${this.renderMuteMenu(selectedTutorial.categoryId, preference)}</div>` : nothing}
							</div>
							<button class="link-btn compact-link" data-testid="tutorial-mode-standard" @click=${() => this.setMode('standard')}>Browse all</button>
						</div>
					</footer>
				</div>
			</div>
		`;
	}

	private renderCompactEmptyMode(): TemplateResult {
		const muteCategoryId = this.standardMuteCategoryId(null);
		const mutePreference = muteCategoryId ? this.preference(muteCategoryId) : undefined;
		const message = "There is nothing new to show you. In compact mode only content that you have not seen before is displayed. If you want to see everything, please use 'Browse all'";
		return html`
			<div class="compact-backdrop">
				<div class="viewer-frame compact-frame compact-empty-frame" role="dialog" aria-modal="true" aria-label="Did you know?" tabindex="-1" @keydown=${this.onCompactKeydown}>
					<header class="compact-header">
						<div class="compact-kicker-row">
							<span class="compact-brand">Did you know?</span>
						</div>
						<button class="icon-btn compact-close" title="Dismiss" aria-label="Dismiss Did you know?" data-testid="tutorial-dismiss" @click=${this.dismissViewer}>${ICONS.close}</button>
						<h1 data-testid="tutorial-viewer-title">Nothing to show right now</h1>
					</header>
					<section class="compact-content" data-overlay-scroll="x:hidden y:scroll" aria-label="Did you know? content">
						${this.renderEmptyState(message)}
					</section>
					<footer class="compact-footer" aria-label="Did you know? actions">
						<div class="compact-utility-strip">
							${muteCategoryId ? html`
								<div class="mute-wrap">
									<button class="link-btn compact-link" data-testid="tutorial-compact-mute" aria-expanded=${this.muteMenuOpen ? 'true' : 'false'} @click=${this.toggleMuteMenu}>Mute...</button>
									${this.muteMenuOpen ? html`<div class="mute-menu" role="menu" aria-label="Mute Did you know?">${this.renderMuteMenu(muteCategoryId, mutePreference)}</div>` : nothing}
								</div>
							` : nothing}
							<button class="link-btn compact-link" data-testid="tutorial-mode-standard" @click=${() => this.setMode('standard')}>Browse all</button>
						</div>
					</footer>
				</div>
			</div>
		`;
	}

	private renderEmptyState(message: string, className = ''): TemplateResult {
		return html`<div class=${`empty ${className}`.trim()} role="status">${message}</div>`;
	}

	private renderStatusInfo(): TemplateResult | typeof nothing {
		const statusText = this.statusText();
		if (!statusText) return nothing;
		return html`
			<span class="status-info ${this.statusHasWarnings() ? 'warning' : ''}" tabindex="0" role="img" aria-label=${statusText} title=${statusText}>${ICONS.info}</span>
		`;
	}

	private statusText(): string {
		if (!this.snapshot) return '';
		const status = this.snapshot.status;
		if (status.source === 'unavailable') return '';
		const parts = [`Catalog: ${status.source}${status.stale ? ' (stale)' : ''}`];
		if (status.lastUpdated) {
			parts.push(`Updated ${new Date(status.lastUpdated).toLocaleDateString()}`);
		}
		const warnings = [...status.errors, ...status.warnings, this.hostError].filter(Boolean);
		return `${parts.join(' - ')}${warnings.length ? `\n${warnings[0]}` : ''}`;
	}

	private statusHasWarnings(): boolean {
		return !!this.snapshot && [...this.snapshot.status.errors, ...this.snapshot.status.warnings, this.hostError].filter(Boolean).length > 0;
	}

	private renderSearchHighlightedText(text: string, tutorialId: string, field: TutorialSearchMatch['field'], currentSearchMatch: TutorialSearchMatch | null, fieldMatchIndexOffset = 0): TemplateResult {
		const regex = this.currentSearchRegex();
		if (!regex) return html`${text}`;
		regex.lastIndex = 0;
		const parts: TemplateResult[] = [];
		let lastIndex = 0;
		let fieldMatchIndex = fieldMatchIndexOffset;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (!match[0]) {
				regex.lastIndex++;
				continue;
			}
			if (match.index > lastIndex) {
				parts.push(html`${text.slice(lastIndex, match.index)}`);
			}
			const active = currentSearchMatch?.tutorialId === tutorialId
				&& currentSearchMatch.field === field
				&& currentSearchMatch.fieldMatchIndex === fieldMatchIndex;
			parts.push(html`<mark class=${active ? 'search-hit current' : 'search-hit'}>${match[0]}</mark>`);
			lastIndex = match.index + match[0].length;
			fieldMatchIndex++;
		}
		if (lastIndex < text.length) {
			parts.push(html`${text.slice(lastIndex)}`);
		}
		return parts.length ? html`${parts}` : html`${text}`;
	}

	private renderContentSearchSnippet(tutorial: TutorialSummary, currentSearchMatch: TutorialSearchMatch | null): TemplateResult | typeof nothing {
		const regex = this.currentSearchRegex();
		const contentText = this.tutorialContentText(tutorial);
		if (!regex || !contentText) return nothing;
		const targetOccurrence = currentSearchMatch?.tutorialId === tutorial.id && currentSearchMatch.field === 'contentText'
			? currentSearchMatch.fieldMatchIndex
			: 0;
		const targetMatch = this.regexMatchAtOccurrence(regex, contentText, targetOccurrence);
		if (!targetMatch) return nothing;
		const snippetStart = Math.max(0, targetMatch.index - 56);
		const snippetEnd = Math.min(contentText.length, targetMatch.index + targetMatch.text.length + 76);
		const prefix = snippetStart > 0 ? '... ' : '';
		const suffix = snippetEnd < contentText.length ? ' ...' : '';
		const snippet = `${prefix}${contentText.slice(snippetStart, snippetEnd).trim()}${suffix}`;
		const fieldMatchIndexOffset = this.countRegexMatchesBefore(regex, contentText, snippetStart);
		return html`<span class="item-summary">${this.renderSearchHighlightedText(snippet, tutorial.id, 'contentText', currentSearchMatch, fieldMatchIndexOffset)}</span>`;
	}

	private regexMatchAtOccurrence(regex: RegExp, text: string, occurrence: number): { index: number; text: string } | null {
		regex.lastIndex = 0;
		let fieldMatchIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (!match[0]) {
				regex.lastIndex++;
				continue;
			}
			if (fieldMatchIndex === occurrence) {
				return { index: match.index, text: match[0] };
			}
			fieldMatchIndex++;
		}
		return null;
	}

	private countRegexMatchesBefore(regex: RegExp, text: string, endIndex: number): number {
		regex.lastIndex = 0;
		let count = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (!match[0]) {
				regex.lastIndex++;
				continue;
			}
			if (match.index >= endIndex) {
				break;
			}
			count++;
		}
		return count;
	}

	private renderTutorialItem(tutorial: TutorialSummary, currentSearchMatch: TutorialSearchMatch | null = null): TemplateResult {
		const active = this.selectedTutorialId === tutorial.id;
		const title = this.tutorialDisplayName(tutorial);
		return html`
			<button
				class="tutorial-item ${active ? 'active' : ''} ${tutorial.compatible ? '' : 'incompatible'}"
				data-testid="tutorial-item"
				data-tutorial-id=${tutorial.id}
				aria-current=${active ? 'true' : 'false'}
				aria-label=${title}
				@click=${() => this.openTutorial(tutorial.id, { markSeen: true })}
			>
				<span class="item-title">${this.renderSearchHighlightedText(title, tutorial.id, 'displayName', currentSearchMatch)}</span>
				${this.renderContentSearchSnippet(tutorial, currentSearchMatch)}
				${tutorial.compatible ? nothing : html`<span class="item-meta"><span>Requires ${tutorial.minExtensionVersion}</span></span>`}
			</button>
		`;
	}

	private renderStandardDetail(tutorial: TutorialSummary): TemplateResult {
		const isLoading = this.loadingTutorialId === tutorial.id;
		return html`
			<section class="content standard-content" data-overlay-scroll="x:hidden y:scroll">
				${this.contentErrors.length ? html`<div class="error-list" role="status">${this.contentErrors[0]}</div>` : nothing}
				${isLoading ? html`<div class="loading" role="status">Loading...</div>` : html`<article class="markdown" @click=${this.onMarkdownClick}>${this.renderMarkdown()}</article>`}
			</section>
		`;
	}

	private renderMarkdown(): TemplateResult {
		return html`${this.renderedMarkdown ? html`<div .innerHTML=${this.renderedMarkdown}></div>` : html`<div class="empty">Select an item to load its content.</div>`}`;
	}

	private renderMuteMenu(categoryId: string, preference: TutorialCategoryPreference | undefined): TemplateResult {
		const tutorialsEnabled = this.snapshot?.tutorialsEnabled !== false;
		const muteOptionsDisabled = !tutorialsEnabled;
		const effectiveDeliveryChannel = this.effectiveDeliveryChannel(categoryId, preference);
		return html`
			${this.renderCadenceMenuItem(categoryId, preference?.notificationCadence, 'daily', 'Notify max once a day', muteOptionsDisabled)}
			${this.renderCadenceMenuItem(categoryId, preference?.notificationCadence, 'weekly', 'Notify max once a week', muteOptionsDisabled)}
			${this.renderCadenceMenuItem(categoryId, preference?.notificationCadence, 'monthly', 'Notify max once a month', muteOptionsDisabled)}
			<div class="mute-menu-divider" role="separator"></div>
			${this.renderDeliveryMenuItem(categoryId, effectiveDeliveryChannel, 'nextFileOpenPopup', 'Pop up this dialog', muteOptionsDisabled)}
			${this.renderDeliveryMenuItem(categoryId, effectiveDeliveryChannel, 'vscodeNotification', 'Pop up VS Code notification', muteOptionsDisabled)}
			<div class="mute-menu-divider" role="separator"></div>
			${this.renderCategoryMuteSubmenu(muteOptionsDisabled)}
			${tutorialsEnabled
				? html`<button class="mute-menu-item" role="menuitem" data-testid="tutorial-compact-mute-all" @click=${() => this.setTutorialsEnabled(false, true)}>${this.menuCheck(false)}<span>Mute everything <span class="menu-subline">(turn this feature off)</span></span></button>`
				: html`<button class="mute-menu-item" role="menuitem" data-testid="tutorial-compact-unmute-all" @click=${() => this.setTutorialsEnabled(true)}>${this.menuCheck(false)}<span>Unmute everything <span class="menu-subline">(turn this feature on)</span></span></button>`}
		`;
	}

	private renderCadenceMenuItem(categoryId: string, currentCadence: TutorialNotificationCadence | undefined, notificationCadence: TutorialNotificationCadence, label: string, disabled = false): TemplateResult {
		const checked = (currentCadence ?? 'daily') === notificationCadence;
		return html`
			<button
				class="mute-menu-item"
				role="menuitemradio"
				aria-checked=${checked ? 'true' : 'false'}
				aria-disabled=${disabled ? 'true' : 'false'}
				?disabled=${disabled}
				data-testid=${`tutorial-compact-cadence-${notificationCadence}`}
				@click=${() => this.setNotificationCadence(categoryId, notificationCadence)}
			>
				${this.menuCheck(checked)}<span>${label}</span>
			</button>
		`;
	}

	private renderDeliveryMenuItem(categoryId: string, currentChannel: TutorialNotificationChannel | undefined, channel: TutorialNotificationChannel, label: string, disabled = false): TemplateResult {
		const checked = (currentChannel ?? 'nextFileOpenPopup') === channel;
		return html`
			<button
				class="mute-menu-item"
				role="menuitemradio"
				aria-checked=${checked ? 'true' : 'false'}
				aria-disabled=${disabled ? 'true' : 'false'}
				?disabled=${disabled}
				data-testid=${channel === 'nextFileOpenPopup' ? 'tutorial-compact-popup-channel' : 'tutorial-compact-notification-channel'}
				@click=${() => this.setNotificationChannel(categoryId, channel)}
			>
				${this.menuCheck(checked)}<span>${label}</span>
			</button>
		`;
	}

	private renderCategoryMuteSubmenu(disabled: boolean): TemplateResult {
		const categories = this.snapshot?.catalog.categories ?? [];
		return html`
			<div class="mute-submenu-parent" @mouseenter=${() => this.openMuteCategorySubmenu()}>
				<button
					class="mute-menu-item mute-submenu-trigger"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded=${this.muteCategorySubmenuOpen ? 'true' : 'false'}
					aria-disabled=${disabled ? 'true' : 'false'}
					?disabled=${disabled}
					data-testid="tutorial-compact-mute-categories"
					@click=${() => this.toggleMuteCategorySubmenu()}
				>
					${this.menuCheck(false)}<span>Mute</span><span class="submenu-chevron" aria-hidden="true">${ICONS.chevron}</span>
				</button>
				${this.muteCategorySubmenuOpen && !disabled ? html`
					<div class="mute-flyout" role="menu" aria-label="Mute categories">
						${categories.map(category => {
							const checked = this.isCategoryMuted(category.id);
							return html`
								<button
									class="mute-menu-item"
									role="menuitemcheckbox"
									aria-checked=${checked ? 'true' : 'false'}
									data-testid=${`tutorial-compact-mute-category-${category.id}`}
									@click=${() => this.toggleCategoryMute(category.id)}
								>
									${this.menuCheck(checked)}<span>${category.title}</span>
								</button>
							`;
						})}
					</div>
				` : nothing}
			</div>
		`;
	}

	private menuCheck(checked: boolean): TemplateResult {
		return checked
			? html`<svg class="menu-check" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>`
			: html`<span class="menu-check" aria-hidden="true"></span>`;
	}

	private renderCompactMarkdown(tutorial: TutorialSummary): TemplateResult {
		const compactHtml = this.compactMarkdownHtml(tutorial);
		return html`${compactHtml ? html`<div .innerHTML=${compactHtml}></div>` : html`<div class="empty">Select an item to load its content.</div>`}`;
	}

	private compactMarkdownHtml(tutorial: TutorialSummary): string {
		if (!this.renderedMarkdown) return '';
		const template = document.createElement('template');
		template.innerHTML = this.renderedMarkdown;
		const firstElement = Array.from(template.content.children)[0];
		if (firstElement?.tagName === 'H1' && this.normalizeText(firstElement.textContent) === this.normalizeText(this.tutorialDisplayName(tutorial))) {
			firstElement.remove();
		}
		return template.innerHTML;
	}

	private normalizeText(value: string | null | undefined): string {
		return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
	}

	private onHostMessage = (event: MessageEvent) => {
		const message = event.data;
		if (!message || typeof message !== 'object') return;
		if (message.type === 'snapshot') {
			const revision = typeof message.revision === 'number' ? message.revision : 0;
			if (revision > 0 && revision < this.latestSnapshotRevision) {
				return;
			}
			this.latestSnapshotRevision = Math.max(this.latestSnapshotRevision, revision);
			const snapshot = message.snapshot as TutorialViewerSnapshot;
			this.snapshot = snapshot;
			this.reconcileLocalMuteState(snapshot);
			this.hostError = '';
			if (!this.modeInitialized) {
				this.mode = this.normalizeMode(snapshot.preferredMode);
				this.modeInitialized = true;
			}
			this.applyHostSelection(snapshot);
		} else if (message.type === 'tutorialContent') {
			void this.showTutorialContent(message.content as TutorialContentMessage);
		} else if (message.type === 'error') {
			this.hostError = String(message.message || 'Unknown tutorial error.');
			this.loadingTutorialId = null;
		}
	};

	private applyHostSelection(snapshot: TutorialViewerSnapshot): void {
		if (snapshot.selectedTutorialId) {
			const hostTutorial = snapshot.catalog.content.find(tutorial => tutorial.id === snapshot.selectedTutorialId);
			const hostCategoryId = snapshot.selectedCategoryId ?? hostTutorial?.categoryId;
			const shouldAcceptTutorial = this.loadingTutorialId === snapshot.selectedTutorialId
				|| (!this.selectedTutorialId && (!this.selectedCategoryId || this.selectedCategoryId === hostCategoryId));
			if (!shouldAcceptTutorial) {
				return;
			}
			const shouldTrackHostCategory = this.isCompactMode() || !!snapshot.selectedCategoryId || (this.selectedCategoryId !== null && this.selectedCategoryId !== undefined);
			if (hostCategoryId && shouldTrackHostCategory && hostCategoryId !== this.selectedCategoryId) {
				this.selectedCategoryId = hostCategoryId;
			}
			if (snapshot.selectedTutorialId !== this.selectedTutorialId) {
				this.selectedTutorialId = snapshot.selectedTutorialId;
				this.clearTutorialContent();
			}
			return;
		}

		if (snapshot.selectedCategoryId && snapshot.selectedCategoryId !== this.selectedCategoryId) {
			this.selectedCategoryId = snapshot.selectedCategoryId;
			this.selectedTutorialId = null;
			this.clearTutorialContent();
		}
	}

	private async showTutorialContent(content: TutorialContentMessage): Promise<void> {
		if (content.tutorialId !== this.selectedTutorialId) {
			return;
		}
		this.selectedTutorialId = content.tutorialId;
		this.loadedTutorialId = content.tutorialId;
		this.loadingTutorialId = null;
		this.contentErrors = content.errors ?? [];
		this.rememberContentTitle(content.tutorialId, content.markdown || '');
		this.renderedMarkdown = await this.sanitizeMarkdown(content.markdown || '');
	}

	private rememberContentTitle(tutorialId: string, markdown: string): void {
		const title = this.firstMarkdownHeading(markdown);
		const titles = { ...this.contentTitles };
		if (title) {
			titles[tutorialId] = title;
		} else {
			delete titles[tutorialId];
		}
		this.contentTitles = titles;
	}

	private firstMarkdownHeading(markdown: string): string {
		const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
		return match?.[1]?.trim() ?? '';
	}

	private async sanitizeMarkdown(markdown: string): Promise<string> {
		const marked = window.marked as { parse(markdown: string): string | Promise<string> } | undefined;
		const purify = window.DOMPurify as { sanitize(value: string, options?: Record<string, unknown>): string } | undefined;
		if (!purify) {
			return this.escapeHtml(markdown).replace(/\n/g, '<br>');
		}
		const parsed = marked ? await marked.parse(markdown) : this.escapeHtml(markdown).replace(/\n/g, '<br>');
		const sanitized = purify.sanitize(String(parsed), {
			ADD_ATTR: ['target', 'rel'],
			FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
		});
		const template = document.createElement('template');
		template.innerHTML = sanitized;
		template.content.querySelectorAll('a').forEach(anchor => {
			const href = anchor.getAttribute('href') ?? '';
			if (!/^(https?:|mailto:)/i.test(href)) {
				anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''));
				return;
			}
			anchor.setAttribute('target', '_blank');
			anchor.setAttribute('rel', 'noopener noreferrer');
		});
		template.content.querySelectorAll('img').forEach(image => {
			const src = image.getAttribute('src') ?? '';
			if (!this.isAllowedRenderedImageSource(src)) {
				image.remove();
			}
		});
		return template.innerHTML;
	}

	private isAllowedRenderedImageSource(src: string): boolean {
		try {
			const parsed = new URL(src);
			if (parsed.protocol !== 'https:') {
				return false;
			}
			const host = parsed.hostname.toLowerCase();
			return host === 'file+.vscode-resource.vscode-cdn.net' || host.endsWith('.vscode-cdn.net');
		} catch {
			return false;
		}
	}

	private onMarkdownClick(event: Event): void {
		const target = event.composedPath().find(item => item instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
		if (!target) return;
		const href = target.getAttribute('href') ?? '';
		if (!/^(https?:|mailto:)/i.test(href)) {
			event.preventDefault();
		}
	}

	private onSearchInput(event: CustomEvent<{ query: string }>): void {
		this.query = event.detail.query;
		this.currentSearchMatchIndex = 0;
		this.selectedTutorialId = null;
		this.clearTutorialContent();
	}

	private onSearchModeChange(event: CustomEvent<{ mode: SearchMode }>): void {
		this.searchMode = event.detail.mode;
		this.currentSearchMatchIndex = 0;
		this.selectedTutorialId = null;
		this.clearTutorialContent();
	}

	private onShowAlreadySeenChange = (event: Event): void => {
		this.showAlreadySeen = (event.target as HTMLInputElement | null)?.checked !== false;
		this.currentSearchMatchIndex = 0;
		if (this.selectedTutorialId && !this.filteredTutorials().some(tutorial => tutorial.id === this.selectedTutorialId)) {
			this.selectedTutorialId = null;
			this.loadingTutorialId = null;
			this.loadedTutorialId = null;
			this.renderedMarkdown = '';
			this.contentErrors = [];
		}
	};

	private navigateSearch(direction: 'next' | 'prev'): void {
		const matches = this.tutorialSearchMatches(this.filteredTutorials());
		if (!matches.length) return;
		this.currentSearchMatchIndex = navigateMatch(this.normalizedSearchMatchIndex(matches.length), matches.length, direction);
		const target = matches[this.currentSearchMatchIndex];
		if (!target) return;
		if (target.tutorialId !== this.selectedTutorialId) {
			this.openTutorial(target.tutorialId);
		} else {
			this.requestUpdate();
		}
		this.revealCurrentSearchMatch(target.tutorialId);
	}

	private revealCurrentSearchMatch(tutorialId: string): void {
		void this.updateComplete.then(() => {
			this.focusTutorial(tutorialId);
			const hit = this.shadowRoot?.querySelector('.search-hit.current') as HTMLElement | null;
			hit?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
	}

	private onCategorySelect = (event: CustomEvent<{ id: string }>): void => {
		this.selectCategory(event.detail.id === 'all' ? null : event.detail.id);
	};

	private categoryDropdownItems(snapshot: TutorialViewerSnapshot): DropdownItem[] {
		return [
			{ id: 'all', label: 'All' },
			...snapshot.catalog.categories.map(category => ({ id: category.id, label: category.title })),
		];
	}

	private selectCategory(categoryId: string | null): void {
		this.selectedCategoryId = categoryId;
		this.selectedTutorialId = null;
		this.currentSearchMatchIndex = 0;
		this.clearTutorialContent();
	}

	private refreshCatalog(): void {
		this.vscode.postMessage({ type: 'refreshCatalog' });
	}

	private setMode(mode: TutorialViewerMode): void {
		const normalizedMode = this.normalizeMode(mode);
		if (normalizedMode === 'compact' && !this.isCompactMode()) {
			this.compactSessionTutorialIds = null;
		}
		this.mode = normalizedMode;
		this.muteMenuOpen = false;
		this.muteCategorySubmenuOpen = false;
		this.vscode.postMessage({ type: 'setPreferredMode', mode: normalizedMode });
	}

	private openTutorial(tutorialId: string, options: { preserveMuteMenu?: boolean; markSeen?: boolean } = {}): void {
		if (this.selectedTutorialId === tutorialId && (this.loadingTutorialId === tutorialId || this.loadedTutorialId === tutorialId)) return;
		if (!options.preserveMuteMenu) {
			this.muteMenuOpen = false;
			this.muteCategorySubmenuOpen = false;
		}
		const tutorial = this.snapshot?.catalog.content.find(candidate => candidate.id === tutorialId);
		if (tutorial && (this.isCompactMode() || (this.selectedCategoryId !== null && this.selectedCategoryId !== undefined))) {
			this.selectedCategoryId = tutorial.categoryId;
		}
		this.selectedTutorialId = tutorialId;
		this.loadingTutorialId = tutorialId;
		this.loadedTutorialId = null;
		this.renderedMarkdown = '';
		this.contentErrors = [];
		this.vscode.postMessage(options.markSeen ? { type: 'openTutorial', tutorialId, markSeen: true } : { type: 'openTutorial', tutorialId });
	}

	private setNotificationChannel(categoryId: string, channel: TutorialNotificationChannel): void {
		this.muteMenuOpen = false;
		this.muteCategorySubmenuOpen = false;
		if (channel !== 'off') {
			const nextOverrides = { ...this.categoryMuteOverrides };
			delete nextOverrides[categoryId];
			this.categoryMuteOverrides = nextOverrides;
			this.compactSessionTutorialIds = null;
		}
		this.vscode.postMessage({ type: 'setNotificationChannel', categoryId, channel });
	}

	private toggleCategoryMute(categoryId: string): void {
		const muted = !this.isCategoryMuted(categoryId);
		this.categoryMuteOverrides = { ...this.categoryMuteOverrides, [categoryId]: muted };
		this.compactSessionTutorialIds = this.projectCompactSessionTutorialIds(this.compactSessionTutorialIds ?? this.createCompactSessionTutorialIds());
		this.currentSearchMatchIndex = 0;
		if (muted) {
			this.vscode.postMessage({ type: 'setCategoryMuted', categoryId, muted: true });
			return;
		}
		this.vscode.postMessage({ type: 'setCategoryMuted', categoryId, muted: false });
	}

	private setNotificationCadence(categoryId: string, notificationCadence: TutorialNotificationCadence): void {
		this.muteMenuOpen = false;
		this.muteCategorySubmenuOpen = false;
		this.vscode.postMessage({ type: 'setNotificationCadence', categoryId, notificationCadence });
	}

	private setTutorialsEnabled(enabled: boolean, dismissAfterUpdate = false): void {
		this.muteMenuOpen = false;
		this.muteCategorySubmenuOpen = false;
		this.vscode.postMessage(dismissAfterUpdate
			? { type: 'setTutorialsEnabled', enabled, dismissAfterUpdate }
			: { type: 'setTutorialsEnabled', enabled });
	}

	private toggleMuteMenu = (event: Event): void => {
		event.stopPropagation();
		this.muteMenuOpen = !this.muteMenuOpen;
		if (!this.muteMenuOpen) {
			this.muteCategorySubmenuOpen = false;
		}
	};

	private openMuteCategorySubmenu(): void {
		this.muteCategorySubmenuOpen = true;
	}

	private toggleMuteCategorySubmenu(): void {
		this.muteCategorySubmenuOpen = !this.muteCategorySubmenuOpen;
	}

	private dismissViewer = (): void => {
		this.vscode.postMessage({ type: 'dismiss' });
	};

	private onCompactKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			this.dismissViewer();
		}
	};

	private onTutorialListKeydown(event: KeyboardEvent): void {
		const tutorials = this.filteredTutorials();
		if (!tutorials.length) return;
		const currentIndex = Math.max(0, tutorials.findIndex(tutorial => tutorial.id === this.selectedTutorialId));
		let nextIndex = currentIndex;
		if (event.key === 'ArrowDown') nextIndex = Math.min(tutorials.length - 1, currentIndex + 1);
		else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = tutorials.length - 1;
		else if (event.key === 'Enter' || event.key === ' ') nextIndex = currentIndex;
		else return;
		event.preventDefault();
		this.openTutorial(tutorials[nextIndex].id, { markSeen: event.key === 'Enter' || event.key === ' ' });
		this.focusTutorial(tutorials[nextIndex].id);
	}

	private focusTutorial(tutorialId: string): void {
		queueMicrotask(() => {
			const buttons = Array.from(this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tutorial-item') ?? []);
			buttons.find(button => button.dataset.tutorialId === tutorialId)?.focus();
		});
	}

	private currentTutorial(): TutorialSummary | null {
		const tutorials = this.isCompactMode() ? this.compactTutorials() : this.filteredTutorials();
		return this.selectedTutorial(tutorials) ?? tutorials[0] ?? null;
	}

	private standardMuteCategoryId(selectedTutorial: TutorialSummary | null): string | null {
		return this.selectedCategoryId ?? selectedTutorial?.categoryId ?? this.snapshot?.catalog.categories[0]?.id ?? null;
	}

	private isUnavailableSnapshot(snapshot: TutorialViewerSnapshot): boolean {
		return snapshot.status.source === 'unavailable';
	}

	private ensureTutorialLoaded(tutorial: TutorialSummary | null): void {
		if (!tutorial || this.loadingTutorialId === tutorial.id || this.loadedTutorialId === tutorial.id) {
			return;
		}
		queueMicrotask(() => this.openTutorial(tutorial.id, { preserveMuteMenu: true }));
	}

	private filteredTutorials(): TutorialSummary[] {
		if (!this.snapshot) return [];
		const categoryFiltered = searchTutorials(this.standardSettingsTutorials(), this.snapshot.catalog.categories, '', this.selectedCategoryId);
		if (!this.query.trim()) return categoryFiltered;
		if (this.searchMode === 'wildcard' && !this.query.includes('*')) {
			return searchTutorials(this.standardSettingsTutorials(), this.snapshot.catalog.categories, this.query, this.selectedCategoryId);
		}
		const regex = this.currentSearchRegex();
		if (!regex) return [];
		return categoryFiltered.filter(tutorial => this.regexMatches(regex, this.tutorialSearchText(tutorial)));
	}

	private currentSearchRegex(): RegExp | null {
		const query = this.query.trim();
		if (this.searchMode === 'wildcard' && query && !query.includes('*')) {
			const tokens = query.split(/\s+/).filter(Boolean).map(escapeSearchRegex);
			return tokens.length ? new RegExp(tokens.join('|'), 'gi') : null;
		}
		return buildSearchRegex(this.query, this.searchMode).regex;
	}

	private tutorialSearchMatches(tutorials: readonly TutorialSummary[]): TutorialSearchMatch[] {
		const regex = this.currentSearchRegex();
		if (!regex) return [];
		const matches: TutorialSearchMatch[] = [];
		for (const tutorial of tutorials) {
			this.collectFieldSearchMatches(matches, regex, tutorial, 'displayName', this.tutorialDisplayName(tutorial));
			this.collectFieldSearchMatches(matches, regex, tutorial, 'contentText', this.tutorialContentText(tutorial));
		}
		return matches;
	}

	private collectFieldSearchMatches(matches: TutorialSearchMatch[], regex: RegExp, tutorial: TutorialSummary, field: TutorialSearchMatch['field'], text: string): void {
		regex.lastIndex = 0;
		let fieldMatchIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (!match[0]) {
				regex.lastIndex++;
				continue;
			}
			matches.push({ tutorialId: tutorial.id, field, fieldMatchIndex });
			fieldMatchIndex++;
		}
	}

	private normalizedSearchMatchIndex(matchCount: number): number {
		if (matchCount <= 0) return 0;
		return Math.min(Math.max(0, this.currentSearchMatchIndex), matchCount - 1);
	}

	private tutorialSearchText(tutorial: TutorialSummary): string {
		const categoryTitle = this.snapshot?.catalog.categories.find(category => category.id === tutorial.categoryId)?.title ?? '';
		return [this.tutorialDisplayName(tutorial), this.tutorialContentText(tutorial), tutorial.id, categoryTitle].join(' ');
	}

	private tutorialDisplayName(tutorial: TutorialSummary): string {
		return this.contentTitles[tutorial.id] ?? tutorial.displayName;
	}

	private tutorialContentText(tutorial: TutorialSummary): string {
		return tutorial.contentText ?? '';
	}

	private regexMatches(regex: RegExp, text: string): boolean {
		regex.lastIndex = 0;
		return regex.test(text);
	}

	private standardSettingsTutorials(): TutorialSummary[] {
		return (this.snapshot?.catalog.content ?? [])
			.filter(tutorial => !this.isCategoryMuted(tutorial.categoryId))
			.filter(tutorial => this.showAlreadySeen || tutorial.unseen);
	}

	private standardEmptyMessage(): string {
		if (!this.query.trim()) {
			return this.settingsEmptyMessage();
		}
		return this.standardSettingsTutorials().length ? 'No content matches your filters.' : this.settingsEmptyMessage();
	}

	private settingsEmptyMessage(): string {
		return 'Based on the current settings, there is no content to show at the moment.';
	}

	private compactAvailableTutorials(): TutorialSummary[] {
		return (this.snapshot?.catalog.content ?? [])
			.filter(tutorial => tutorial.compatible && tutorial.unseen && !this.isCategoryMuted(tutorial.categoryId));
	}

	private compactRetainedTutorials(): TutorialSummary[] {
		return (this.snapshot?.catalog.content ?? [])
			.filter(tutorial => tutorial.compatible && !this.isCategoryMuted(tutorial.categoryId));
	}

	private compactTutorials(): TutorialSummary[] {
		if (!this.snapshot) return [];
		this.compactSessionTutorialIds = this.projectCompactSessionTutorialIds(this.compactSessionTutorialIds ?? this.createCompactSessionTutorialIds());
		const byId = new Map(this.snapshot.catalog.content.map(tutorial => [tutorial.id, tutorial]));
		return this.compactSessionTutorialIds
			.map(tutorialId => byId.get(tutorialId))
			.filter((tutorial): tutorial is TutorialSummary => !!tutorial);
	}

	private navigateCompact(direction: -1 | 1, options: { markSeen?: boolean } = {}): void {
		const currentTutorialId = this.selectedTutorialId ?? this.currentTutorial()?.id ?? null;
		const currentIds = this.compactSessionTutorialIds ?? this.createCompactSessionTutorialIds();
		const refreshedIds = this.projectCompactSessionTutorialIds(currentIds);
		const changed = !this.sameTutorialIds(currentIds, refreshedIds);
		this.compactSessionTutorialIds = refreshedIds;

		if (refreshedIds.length === 0) {
			this.requestUpdate();
			return;
		}

		const currentIndex = currentTutorialId ? refreshedIds.indexOf(currentTutorialId) : -1;
		let targetIndex = -1;
		if (currentIndex < 0) {
			targetIndex = direction > 0 ? 0 : refreshedIds.length - 1;
		} else if (direction > 0) {
			targetIndex = currentIndex < refreshedIds.length - 1 ? currentIndex + 1 : changed && refreshedIds.length > 1 ? 0 : -1;
		} else {
			targetIndex = currentIndex > 0 ? currentIndex - 1 : changed && refreshedIds.length > 1 ? refreshedIds.length - 1 : -1;
		}

		const targetTutorialId = targetIndex >= 0 ? refreshedIds[targetIndex] : undefined;
		if (targetTutorialId && targetTutorialId !== currentTutorialId) {
			this.openTutorial(targetTutorialId, { markSeen: options.markSeen });
		} else {
			this.requestUpdate();
		}
	}

	private hasPendingCompactQueueNavigation(currentTutorialId: string, direction: -1 | 1): boolean {
		const currentIds = this.compactSessionTutorialIds ?? this.createCompactSessionTutorialIds();
		const refreshedIds = this.projectCompactSessionTutorialIds(currentIds);
		const changed = !this.sameTutorialIds(currentIds, refreshedIds);
		if (!changed || refreshedIds.length === 0) return false;
		const currentIndex = refreshedIds.indexOf(currentTutorialId);
		if (currentIndex < 0) return true;
		if (direction > 0) return currentIndex < refreshedIds.length - 1 || refreshedIds.length > 1;
		return currentIndex > 0 || refreshedIds.length > 1;
	}

	private projectCompactSessionTutorialIds(currentIds: readonly string[]): string[] {
		if (!this.snapshot) return [];
		const tutorials = this.compactRetainedTutorials();
		const byId = new Map(tutorials.map(tutorial => [tutorial.id, tutorial]));
		const keptIds = currentIds.filter(tutorialId => byId.has(tutorialId));
		const kept = new Set(keptIds);
		const addedUnreadIds = this.compactAvailableTutorials()
			.filter(tutorial => !kept.has(tutorial.id))
			.map(tutorial => tutorial.id);
		return [...keptIds, ...addedUnreadIds];
	}

	private createCompactSessionTutorialIds(): string[] {
		const sourceTutorials = this.compactAvailableTutorials();
		const startIndex = this.compactSessionStartIndex(sourceTutorials);
		const orderedTutorials = startIndex > 0
			? [...sourceTutorials.slice(startIndex), ...sourceTutorials.slice(0, startIndex)]
			: sourceTutorials;
		return orderedTutorials.map(tutorial => tutorial.id);
	}

	private compactSessionStartIndex(tutorials: readonly TutorialSummary[]): number {
		const selectedIndex = tutorials.findIndex(tutorial => tutorial.id === this.selectedTutorialId);
		if (selectedIndex >= 0) return selectedIndex;
		if (this.selectedCategoryId) {
			const categoryIndex = tutorials.findIndex(tutorial => tutorial.categoryId === this.selectedCategoryId);
			if (categoryIndex >= 0) return categoryIndex;
		}
		return 0;
	}

	private isCategoryMuted(categoryId: string): boolean {
		return this.categoryMuteOverrides[categoryId] ?? this.preference(categoryId)?.muted === true;
	}

	private sameTutorialIds(left: readonly string[], right: readonly string[]): boolean {
		return left.length === right.length && left.every((tutorialId, index) => tutorialId === right[index]);
	}

	private effectiveDeliveryChannel(categoryId: string, preference: TutorialCategoryPreference | undefined): TutorialNotificationChannel {
		if (this.isCategoryMuted(categoryId)) {
			return 'nextFileOpenPopup';
		}
		return preference?.channel === 'vscodeNotification' ? 'vscodeNotification' : 'nextFileOpenPopup';
	}

	private reconcileLocalMuteState(snapshot: TutorialViewerSnapshot): void {
		if (Object.keys(this.categoryMuteOverrides).length === 0) return;
		const nextOverrides: Record<string, boolean> = {};
		for (const [categoryId, muted] of Object.entries(this.categoryMuteOverrides)) {
			const snapshotMuted = snapshot.preferences.some(preference => preference.categoryId === categoryId && preference.muted === true);
			if (snapshotMuted !== muted) {
				nextOverrides[categoryId] = muted;
			}
		}
		this.categoryMuteOverrides = nextOverrides;
	}

	private selectedTutorial(tutorials: readonly TutorialSummary[]): TutorialSummary | undefined {
		return tutorials.find(tutorial => tutorial.id === this.selectedTutorialId);
	}

	private preference(categoryId: string): TutorialCategoryPreference | undefined {
		return this.snapshot?.preferences.find(preference => preference.categoryId === categoryId);
	}

	private clearTutorialContent(): void {
		this.loadingTutorialId = null;
		this.loadedTutorialId = null;
		this.renderedMarkdown = '';
		this.contentErrors = [];
		this.muteMenuOpen = false;
		this.muteCategorySubmenuOpen = false;
	}

	private isCompactMode(): boolean {
		return this.mode === 'compact' || this.mode === 'focused';
	}

	private normalizeMode(mode: TutorialViewerMode): TutorialViewerMode {
		return mode === 'focused' ? 'compact' : mode;
	}

	private escapeHtml(value: string): string {
		return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
	}
}