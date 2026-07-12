import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
	FirstLaunchEditingPreferences,
	FirstLaunchFilePreferences,
	FirstLaunchSetupHostMessage,
	FirstLaunchSetupSnapshot,
	FirstLaunchSetupWebviewMessage,
} from '../../shared/firstLaunchSetup.js';
import {
	ICONS,
	autocompleteIcon,
	caretDocsIcon,
	ghostIcon,
	iconRegistryStyles,
} from '../shared/icon-registry.js';
import { firstLaunchSetupStyles } from './kw-first-launch-setup.styles.js';

type VsCodeApi = { postMessage(message: FirstLaunchSetupWebviewMessage): void };
declare const acquireVsCodeApi: () => VsCodeApi;

function getVsCodeApi(): VsCodeApi {
	const existing = (window as unknown as { vscode?: VsCodeApi }).vscode;
	return existing?.postMessage ? existing : acquireVsCodeApi();
}

@customElement('kw-first-launch-setup')
export class KwFirstLaunchSetup extends LitElement {
	static styles = [iconRegistryStyles, firstLaunchSetupStyles];

	@property({ attribute: 'logo-uri' }) logoUri = '';

	@state() private snapshot: FirstLaunchSetupSnapshot | null = null;
	@state() private filePreferences: FirstLaunchFilePreferences | null = null;
	@state() private editingPreferences: FirstLaunchEditingPreferences | null = null;
	@state() private working = false;
	@state() private error = '';
	@state() private retryOnly = false;

	private readonly vscode = getVsCodeApi();
	private readonly onWindowMessage = (event: MessageEvent<FirstLaunchSetupHostMessage>): void => {
		const message = event.data;
		if (!message || typeof message.type !== 'string') return;
		if (message.type === 'snapshot') {
			this.snapshot = message.snapshot;
			this.filePreferences = { ...message.snapshot.filePreferences };
			this.editingPreferences = { ...message.snapshot.editingPreferences };
			this.retryOnly = !!message.snapshot.retryOnly;
			this.error = message.snapshot.retryOnly
				? `Retry the pending ${message.snapshot.pendingOperation === 'skip' ? 'Skip' : 'Save'} operation.`
				: '';
			return;
		}
		if (message.type === 'working') {
			this.working = message.working;
			return;
		}
		if (message.type === 'error') {
			this.error = message.message;
			this.retryOnly = !!message.retryOnly;
		}
	};

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener('message', this.onWindowMessage as EventListener);
		this.vscode.postMessage({ type: 'ready' });
		this.vscode.postMessage({ type: 'requestSnapshot' });
	}

	override disconnectedCallback(): void {
		window.removeEventListener('message', this.onWindowMessage as EventListener);
		super.disconnectedCallback();
	}

	protected override updated(changed: PropertyValues): void {
		if (changed.has('snapshot')
			|| changed.has('filePreferences')
			|| changed.has('editingPreferences')
			|| changed.has('working')
			|| changed.has('error')) {
			this.dispatchEvent(new CustomEvent('first-launch-layout-change', {
				bubbles: true,
				composed: true,
			}));
		}
	}

	private setFilePreference(key: keyof FirstLaunchFilePreferences, checked: boolean): void {
		if (!this.filePreferences || this.working || this.retryOnly) return;
		this.filePreferences = { ...this.filePreferences, [key]: checked };
	}

	private setEditingPreference(key: keyof FirstLaunchEditingPreferences, checked: boolean): void {
		if (!this.editingPreferences || this.working || this.retryOnly) return;
		this.editingPreferences = { ...this.editingPreferences, [key]: checked };
	}

	private save(): void {
		if (!this.filePreferences || !this.editingPreferences || this.working) return;
		this.error = '';
		this.vscode.postMessage({
			type: 'save',
			filePreferences: this.filePreferences,
			editingPreferences: this.editingPreferences,
		});
	}

	private secondaryAction(): void {
		if (this.working || this.retryOnly || !this.snapshot) return;
		this.vscode.postMessage({ type: this.snapshot.mode === 'automatic' ? 'skip' : 'cancel' });
	}

	private renderFileOption(
		key: keyof FirstLaunchFilePreferences,
		extension: string,
		title: string,
		description: string,
		icon: unknown,
	) {
		const inputId = `file-${key}`;
		return html`
			<label class="option-row" for=${inputId}>
				<span class="option-icon" aria-hidden="true">${icon}</span>
				<span class="option-copy">
					<span class="option-title"><span>${title}</span><span class="extension">${extension}</span></span>
					<span class="option-description">${description}</span>
				</span>
				<input id=${inputId} type="checkbox" .checked=${!!this.filePreferences?.[key]} ?disabled=${this.working || this.retryOnly}
					@change=${(event: Event) => this.setFilePreference(key, (event.target as HTMLInputElement).checked)} />
			</label>`;
	}

	private renderEditingOption(
		key: keyof FirstLaunchEditingPreferences,
		title: string,
		description: string,
		icon: unknown,
		shortcut?: string,
	) {
		const inputId = `editing-${key}`;
		return html`
			<label class="option-row" for=${inputId}>
				<span class="option-icon" aria-hidden="true">${icon}</span>
				<span class="option-copy">
					<span class="option-title"><span>${title}</span>${shortcut ? html`<kbd>${shortcut}</kbd>` : nothing}</span>
					<span class="option-description">${description}</span>
				</span>
				<input id=${inputId} type="checkbox" .checked=${!!this.editingPreferences?.[key]} ?disabled=${this.working || this.retryOnly}
					@change=${(event: Event) => this.setEditingPreference(key, (event.target as HTMLInputElement).checked)} />
			</label>`;
	}

	override render() {
		if (!this.snapshot || !this.filePreferences || !this.editingPreferences) {
			return html`<div class="loading" role="status">Loading Kusto Workbench setup...</div>`;
		}
		return html`
			<main aria-busy=${this.working ? 'true' : 'false'}>
				<header>
					<span class="brand-mark" aria-hidden="true"><img src=${this.logoUri} alt="" /></span>
					<div>
						<h1>${this.snapshot.mode === 'automatic' ? 'Welcome to Kusto Workbench' : 'Configure Kusto Workbench'}</h1>
						<p class="intro">Choose the defaults that make the editor feel right from the first query.</p>
					</div>
				</header>

				<fieldset ?disabled=${this.working}>
					<legend>Files opened by Workbench</legend>
					<p class="section-description">Choose which common file types use the Workbench editor by default. You can change these choices at any time in the Kusto Workbench extension settings.</p>
					${this.renderFileOption('openKqlFiles', '.kql', 'Kusto queries', 'Open KQL query files with schema-aware editing, results, and charts.', ICONS.sectionQuery)}
					${this.renderFileOption('openCslFiles', '.csl', 'Kusto scripts', 'Open CSL scripts with the same Kusto editing experience.', ICONS.code)}
					${this.renderFileOption('openSqlFiles', '.sql', 'SQL queries', 'Open SQL files with connections, schema completion, and query results.', ICONS.sectionSql)}
					${this.renderFileOption('openMdFiles', '.md', 'Markdown', 'Open Markdown files in the Workbench documentation editor.', ICONS.sectionMarkdown)}
					<div class="always-supported"><span>Always opened by Workbench:</span><span class="extension">.kqlx</span><span class="extension">.mdx</span><span class="extension">.sqlx</span></div>
				</fieldset>

				<fieldset ?disabled=${this.working}>
					<legend>Editing assistance</legend>
					<p class="section-description">Choose what happens automatically while you type. The manual shortcuts always remain enabled, whether these boxes are checked or not. Automatic assistance is invaluable to some people and distracting to others, so pick what feels right for you.</p>
					<p class="section-description toolbar-guidance">You can change any option later with one click: look for the same icon in each Kusto section toolbar (and in SQL toolbars where the feature is available).</p>
					${this.renderEditingOption('autoTriggerAutocompleteEnabled', 'Automatic schema completions', 'Ctrl+Space always opens schema-aware completions manually. Check this to open them automatically as you type, without pressing the shortcut. Change it any time from the matching toolbar icon.', autocompleteIcon, 'Ctrl+Space')}
					${this.renderEditingOption('copilotInlineCompletionsEnabled', 'Copilot inline suggestions', 'When GitHub Copilot is available, Ctrl+Shift+Space always requests ghost text manually. Check this to request suggestions automatically as you type. Change it any time from the matching toolbar icon.', ghostIcon, 'Ctrl+Shift+Space')}
					${this.renderEditingOption('caretDocsEnabled', 'Smart documentation (Kusto)', 'Check this to show relevant Kusto documentation automatically as the cursor moves. There is no shortcut to remember; use the matching toolbar icon whenever you want to turn it on or off.', caretDocsIcon)}
					${!this.snapshot.inlineSuggestEnabled ? html`<p class="notice" role="note">VS Code inline suggestions are currently disabled. Copilot ghost text will take effect when <span class="extension">editor.inlineSuggest.enabled</span> is enabled.</p>` : nothing}
				</fieldset>

				${this.error ? html`<div class="error" role="alert" aria-live="assertive">${this.error}</div>` : nothing}
				<footer>
					<button class="secondary" data-testid="first-launch-secondary" ?disabled=${this.working || this.retryOnly} @click=${this.secondaryAction}>
						${this.snapshot.mode === 'automatic' ? 'Skip setup' : 'Cancel'}
					</button>
					<button class="primary" data-testid="first-launch-save" ?disabled=${this.working} @click=${this.save}>
						${this.working ? 'Saving...' : this.retryOnly ? 'Retry setup' : 'Save and continue'}
					</button>
				</footer>
			</main>`;
	}
}