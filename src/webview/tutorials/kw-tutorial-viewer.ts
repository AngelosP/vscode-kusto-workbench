import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../components/kw-search-bar.js';
import { OverlayScrollbarsController } from '../components/overlay-scrollbars.controller.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';
import { osLibrarySheet } from '../shared/os-library-styles.js';
import { osThemeSheet } from '../shared/os-theme-styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import {
	searchTutorials,
	type TutorialCategory,
	type TutorialCategoryPreference,
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
	source: 'remote' | 'cache' | 'builtIn';
	errors: string[];
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

	private readonly _osCtrl = new OverlayScrollbarsController(this);
	private readonly vscode = acquireVsCodeApi();
	private modeInitialized = false;
	private latestSnapshotRevision = 0;
	private loadedTutorialId: string | null = null;

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
			return html`<div class="viewer-shell"><div class="viewer-frame loading-frame"><div class="loading" role="status">Loading tutorials...</div></div></div>`;
		}

		const selectedTutorial = this.currentTutorial();
		this.ensureTutorialLoaded(selectedTutorial);

		return html`
			<div class="viewer-shell mode-${this.mode}" data-testid="tutorial-viewer-mode-${this.mode}">
				${this.mode === 'focused'
					? this.renderFocusedMode(selectedTutorial)
					: this.renderStandardMode(selectedTutorial)}
			</div>
		`;
	}

	private renderStandardMode(selectedTutorial: TutorialSummary | null): TemplateResult {
		const snapshot = this.snapshot!;
		const tutorials = this.filteredTutorials();
		return html`
			<div class="viewer-frame standard-frame" role="dialog" aria-label="Kusto Workbench tutorials">
				<aside class="sidebar" aria-label="Tutorial navigation">
					<div class="header">
						<div class="title-row">
							<div class="title-copy">
								<span class="eyebrow">Kusto Workbench</span>
								<h1 data-testid="tutorial-viewer-title">Tutorials</h1>
							</div>
							<div class="toolbar-actions">
								<button class="icon-btn" title="Focused mode" aria-label="Focused mode" data-testid="tutorial-mode-focused" @click=${() => this.setMode('focused')}>${ICONS.sidebar}</button>
								<button class="icon-btn" title="Refresh tutorials" aria-label="Refresh tutorials" @click=${this.refreshCatalog}>${ICONS.refresh}</button>
							</div>
						</div>
						<kw-search-bar
							.query=${this.query}
							.showStatus=${false}
							@search-input=${this.onSearchInput}
						></kw-search-bar>
						${this.renderStatus()}
					</div>
					<nav class="categories" aria-label="Tutorial categories">
						<div class="section-label">Categories</div>
						${this.renderAllTutorialsCategory(snapshot.catalog.tutorials.length)}
						${snapshot.catalog.categories.map(category => this.renderCategoryRow(category))}
					</nav>
					<div
						class="tutorial-list"
						data-testid="tutorial-list"
						data-overlay-scroll="x:hidden y:scroll"
						aria-label="Tutorials"
						@keydown=${this.onTutorialListKeydown}
					>
						<div class="section-label">Tutorials</div>
						${tutorials.length ? tutorials.map(tutorial => this.renderTutorialItem(tutorial)) : html`<div class="empty">No tutorials match your filters.</div>`}
					</div>
				</aside>
				<main class="detail" aria-label="Tutorial content">
					${selectedTutorial ? this.renderStandardDetail(selectedTutorial) : html`<div class="empty">Pick a tutorial to get started.</div>`}
				</main>
			</div>
		`;
	}

	private renderFocusedMode(selectedTutorial: TutorialSummary | null): TemplateResult {
		if (!selectedTutorial) {
			return html`<div class="viewer-frame focused-frame" role="dialog" aria-label="Kusto Workbench tutorials"><div class="empty">Pick a tutorial to get started.</div></div>`;
		}

		const category = this.categoryFor(selectedTutorial.categoryId);
		const sequence = this.focusedTutorials();
		const index = Math.max(0, sequence.findIndex(tutorial => tutorial.id === selectedTutorial.id));
		const previousTutorial = index > 0 ? sequence[index - 1] : null;
		const nextTutorial = index >= 0 && index < sequence.length - 1 ? sequence[index + 1] : null;
		const isLoading = this.loadingTutorialId === selectedTutorial.id;

		return html`
			<div class="viewer-frame focused-frame" role="dialog" aria-label=${`${selectedTutorial.title} tutorial`}>
				<header class="focused-toolbar">
					<div class="focused-heading">
						<div class="focused-category-row">
							<span class="eyebrow">${category?.title ?? 'Tutorial'}</span>
							${category ? this.renderCategoryNotificationControls(category.id, this.preference(category.id), true) : nothing}
						</div>
						<h1 data-testid="tutorial-viewer-title">${selectedTutorial.title}</h1>
					</div>
					<div class="focused-actions">
						<button class="action-btn" data-testid="tutorial-mode-standard" @click=${() => this.setMode('standard')}>${ICONS.sidebar} Standard</button>
					</div>
				</header>
				<section class="focused-content" data-overlay-scroll="x:hidden y:scroll" aria-label="Tutorial body">
					${this.contentErrors.length ? html`<div class="error-list" role="status">${this.contentErrors[0]}</div>` : nothing}
					${isLoading ? html`<div class="loading" role="status">Loading tutorial...</div>` : html`<article class="markdown focused-markdown" @click=${this.onMarkdownClick}>${this.renderMarkdown()}</article>`}
				</section>
				<footer class="focused-nav" aria-label="Tutorial navigation">
					<button class="nav-btn previous" data-testid="tutorial-prev" ?disabled=${!previousTutorial} @click=${() => previousTutorial ? this.openTutorial(previousTutorial.id) : undefined}>${ICONS.chevron} Previous</button>
					<span class="position" aria-label=${`Tutorial ${index + 1} of ${sequence.length}`}>${index + 1} of ${sequence.length}</span>
					<button class="nav-btn" data-testid="tutorial-next" ?disabled=${!nextTutorial} @click=${() => nextTutorial ? this.openTutorial(nextTutorial.id) : undefined}>Next ${ICONS.chevron}</button>
				</footer>
			</div>
		`;
	}

	private renderStatus(): TemplateResult | typeof nothing {
		if (!this.snapshot) return nothing;
		const status = this.snapshot.status;
		const parts = [`Catalog: ${status.source}${status.stale ? ' (stale)' : ''}`];
		if (status.lastUpdated) {
			parts.push(`Updated ${new Date(status.lastUpdated).toLocaleDateString()}`);
		}
		const warnings = [...status.errors, ...status.warnings, this.hostError].filter(Boolean);
		return html`
			<div class="status ${warnings.length ? 'warning' : ''}" role="status">
				${parts.join(' - ')}${warnings.length ? html`<br>${warnings[0]}` : nothing}
			</div>
		`;
	}

	private renderAllTutorialsCategory(count: number): TemplateResult {
		const active = this.selectedCategoryId === null;
		return html`
			<div class="category-row all ${active ? 'active' : ''}" data-testid="tutorial-category-row" data-category-id="all">
				<button class="category-main" aria-pressed=${active ? 'true' : 'false'} @click=${() => this.selectCategory(null)}>
					<span class="category-copy">
						<span class="category-title">All tutorials</span>
						<span class="category-subline">${count} total</span>
					</span>
					<span class="badge" aria-label=${`${count} tutorials`}>${count}</span>
				</button>
			</div>
		`;
	}

	private renderCategoryRow(category: TutorialCategory): TemplateResult {
		const active = this.selectedCategoryId === category.id;
		const count = this.categoryCount(category.id);
		const preference = this.preference(category.id);
		return html`
			<div class="category-row ${active ? 'active' : ''} ${preference?.subscribed ? 'subscribed' : ''}" data-testid="tutorial-category-row" data-category-id=${category.id}>
				<button class="category-main" aria-pressed=${active ? 'true' : 'false'} @click=${() => this.selectCategory(category.id)}>
					<span class="category-copy">
						<span class="category-title">${category.title}</span>
						<span class="category-subline">${count} tutorial${count === 1 ? '' : 's'}${preference?.unseenCount ? ` - ${preference.unseenCount} unseen` : ''}</span>
					</span>
					<span class="badge" aria-label=${`${count} tutorials${preference?.unseenCount ? `, ${preference.unseenCount} unseen` : ''}`}>${preference?.unseenCount || count}</span>
				</button>
				${this.renderCategoryNotificationControls(category.id, preference)}
			</div>
		`;
	}

	private renderCategoryNotificationControls(categoryId: string, preference: TutorialCategoryPreference | undefined, compact = false): TemplateResult {
		const subscribed = preference?.subscribed === true;
		const categoryTitle = this.categoryFor(categoryId)?.title ?? categoryId;
		const bellLabel = subscribed ? `Unsubscribe from ${categoryTitle} category updates` : `Subscribe to ${categoryTitle} category updates`;
		const channelTitle = this.notificationChannelTitle(preference?.channel);
		return html`
			<div class="category-controls ${compact ? 'compact' : ''}">
				<button
					class="bell-toggle ${subscribed ? 'active' : ''}"
					data-testid="tutorial-category-subscribe"
					data-category-id=${categoryId}
					title=${bellLabel}
					aria-label=${bellLabel}
					aria-pressed=${subscribed ? 'true' : 'false'}
					@click=${(event: Event) => {
						event.stopPropagation();
						this.toggleSubscription(categoryId, !subscribed);
					}}
				>
					${subscribed ? ICONS.bell : ICONS.bellSlash}
				</button>
				${subscribed ? html`
					<button
						class="channel-pill"
						data-testid="tutorial-category-channel"
						data-category-id=${categoryId}
						title=${channelTitle}
						aria-label=${`${categoryTitle} updates: ${channelTitle}`}
						@click=${(event: Event) => {
							event.stopPropagation();
							this.toggleNotificationChannel(categoryId, preference?.channel);
						}}
					>
						${this.notificationChannelLabel(preference?.channel)}
					</button>
				` : nothing}
			</div>
		`;
	}

	private renderTutorialItem(tutorial: TutorialSummary): TemplateResult {
		const active = this.selectedTutorialId === tutorial.id;
		return html`
			<button
				class="tutorial-item ${active ? 'active' : ''} ${tutorial.compatible ? '' : 'incompatible'}"
				data-testid="tutorial-item"
				data-tutorial-id=${tutorial.id}
				aria-current=${active ? 'true' : 'false'}
				aria-label=${`${tutorial.title}. ${tutorial.summary}`}
				@click=${() => this.openTutorial(tutorial.id)}
			>
				<span class="item-title">${tutorial.title}</span>
				<span class="item-summary">${tutorial.summary}</span>
				<span class="item-meta">
					${tutorial.durationMinutes ? html`<span>${tutorial.durationMinutes} min</span>` : nothing}
					${tutorial.tags.slice(0, 3).map(tag => html`<span>#${tag}</span>`)}
					${tutorial.compatible ? nothing : html`<span>Requires ${tutorial.minExtensionVersion}</span>`}
				</span>
			</button>
		`;
	}

	private renderStandardDetail(tutorial: TutorialSummary): TemplateResult {
		const category = this.categoryFor(tutorial.categoryId);
		const isLoading = this.loadingTutorialId === tutorial.id;
		return html`
			<header class="detail-header">
				<div class="detail-title-row">
					<div>
						${category ? html`<span class="eyebrow">${category.title}</span>` : nothing}
						<h2>${tutorial.title}</h2>
						<p class="detail-summary">${tutorial.summary}</p>
					</div>
				</div>
				<div class="detail-actions">
					${tutorial.actions.map(action => html`<button class="action-btn" @click=${() => this.runAction(action.command)}>${action.title}</button>`)}
					${tutorial.nativeWalkthroughId ? html`<button class="link-btn" @click=${() => this.openNativeWalkthrough(tutorial.nativeWalkthroughId!)}>Open native walkthrough</button>` : nothing}
					<button class="link-btn" @click=${() => this.markCategorySeen(tutorial.categoryId)}>Mark category seen</button>
				</div>
			</header>
			<section class="content" data-overlay-scroll="x:hidden y:scroll">
				${this.contentErrors.length ? html`<div class="error-list" role="status">${this.contentErrors[0]}</div>` : nothing}
				${isLoading ? html`<div class="loading" role="status">Loading tutorial...</div>` : html`<article class="markdown" @click=${this.onMarkdownClick}>${this.renderMarkdown()}</article>`}
			</section>
		`;
	}

	private renderMarkdown(): TemplateResult {
		return html`${this.renderedMarkdown ? html`<div .innerHTML=${this.renderedMarkdown}></div>` : html`<div class="empty">Select a tutorial to load its content.</div>`}`;
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
			this.hostError = '';
			if (!this.modeInitialized) {
				this.mode = snapshot.preferredMode;
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
			const hostTutorial = snapshot.catalog.tutorials.find(tutorial => tutorial.id === snapshot.selectedTutorialId);
			const hostCategoryId = snapshot.selectedCategoryId ?? hostTutorial?.categoryId;
			const shouldAcceptTutorial = this.loadingTutorialId === snapshot.selectedTutorialId
				|| (!this.selectedTutorialId && (!this.selectedCategoryId || this.selectedCategoryId === hostCategoryId));
			if (!shouldAcceptTutorial) {
				return;
			}
			if (hostCategoryId && hostCategoryId !== this.selectedCategoryId) {
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
		this.renderedMarkdown = await this.sanitizeMarkdown(content.markdown || '');
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
		this.selectedTutorialId = null;
		this.clearTutorialContent();
	}

	private selectCategory(categoryId: string | null): void {
		this.selectedCategoryId = categoryId;
		this.selectedTutorialId = null;
		this.clearTutorialContent();
	}

	private refreshCatalog(): void {
		this.vscode.postMessage({ type: 'refreshCatalog' });
	}

	private setMode(mode: TutorialViewerMode): void {
		this.mode = mode;
		this.vscode.postMessage({ type: 'setPreferredMode', mode });
	}

	private openTutorial(tutorialId: string): void {
		if (this.selectedTutorialId === tutorialId && (this.loadingTutorialId === tutorialId || this.loadedTutorialId === tutorialId)) return;
		const tutorial = this.snapshot?.catalog.tutorials.find(candidate => candidate.id === tutorialId);
		if (tutorial) {
			this.selectedCategoryId = tutorial.categoryId;
		}
		this.selectedTutorialId = tutorialId;
		this.loadingTutorialId = tutorialId;
		this.loadedTutorialId = null;
		this.renderedMarkdown = '';
		this.contentErrors = [];
		this.vscode.postMessage({ type: 'openTutorial', tutorialId });
	}

	private toggleSubscription(categoryId: string, subscribed: boolean): void {
		this.vscode.postMessage({ type: 'setCategorySubscription', categoryId, subscribed });
	}

	private toggleNotificationChannel(categoryId: string, currentChannel: TutorialNotificationChannel | undefined): void {
		const channel: TutorialNotificationChannel = currentChannel === 'nextFileOpenPopup' ? 'vscodeNotification' : 'nextFileOpenPopup';
		this.vscode.postMessage({ type: 'setNotificationChannel', categoryId, channel });
	}

	private notificationChannelLabel(channel: TutorialNotificationChannel | undefined): string {
		return channel === 'vscodeNotification' ? 'notification' : 'pop-up';
	}

	private notificationChannelTitle(channel: TutorialNotificationChannel | undefined): string {
		return channel === 'vscodeNotification'
			? 'notification will show a VS Code style notification instead.'
			: 'pop-up will automatically fire up the tutorial UI on the next file open.';
	}

	private markCategorySeen(categoryId: string): void {
		this.vscode.postMessage({ type: 'markCategorySeen', categoryId });
	}

	private runAction(command: string): void {
		this.vscode.postMessage({ type: 'runAction', command });
	}

	private openNativeWalkthrough(walkthroughId: string): void {
		this.vscode.postMessage({ type: 'openNativeWalkthrough', walkthroughId });
	}

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
		this.openTutorial(tutorials[nextIndex].id);
		this.focusTutorial(tutorials[nextIndex].id);
	}

	private focusTutorial(tutorialId: string): void {
		queueMicrotask(() => {
			const buttons = Array.from(this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tutorial-item') ?? []);
			buttons.find(button => button.dataset.tutorialId === tutorialId)?.focus();
		});
	}

	private currentTutorial(): TutorialSummary | null {
		const tutorials = this.mode === 'focused' ? this.focusedTutorials() : this.filteredTutorials();
		return this.selectedTutorial(tutorials) ?? tutorials[0] ?? null;
	}

	private ensureTutorialLoaded(tutorial: TutorialSummary | null): void {
		if (!tutorial || this.loadingTutorialId === tutorial.id || this.loadedTutorialId === tutorial.id) {
			return;
		}
		queueMicrotask(() => this.openTutorial(tutorial.id));
	}

	private filteredTutorials(): TutorialSummary[] {
		if (!this.snapshot) return [];
		return searchTutorials(this.snapshot.catalog.tutorials, this.snapshot.catalog.categories, this.query, this.selectedCategoryId);
	}

	private focusedTutorials(): TutorialSummary[] {
		const allTutorials = this.snapshot?.catalog.tutorials ?? [];
		const seed = this.selectedTutorial(allTutorials)
			?? (this.selectedCategoryId ? allTutorials.find(tutorial => tutorial.categoryId === this.selectedCategoryId) : undefined)
			?? allTutorials[0];
		return seed ? allTutorials.filter(tutorial => tutorial.categoryId === seed.categoryId) : allTutorials;
	}

	private selectedTutorial(tutorials: readonly TutorialSummary[]): TutorialSummary | undefined {
		return tutorials.find(tutorial => tutorial.id === this.selectedTutorialId);
	}

	private categoryFor(categoryId: string): TutorialCategory | undefined {
		return this.snapshot?.catalog.categories.find(candidate => candidate.id === categoryId);
	}

	private categoryCount(categoryId: string): number {
		return this.snapshot?.catalog.tutorials.filter(tutorial => tutorial.categoryId === categoryId).length ?? 0;
	}

	private preference(categoryId: string): TutorialCategoryPreference | undefined {
		return this.snapshot?.preferences.find(preference => preference.categoryId === categoryId);
	}

	private clearTutorialContent(): void {
		this.loadingTutorialId = null;
		this.loadedTutorialId = null;
		this.renderedMarkdown = '';
		this.contentErrors = [];
	}

	private escapeHtml(value: string): string {
		return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
	}
}