import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { KwMonacoToolbar, type MonacoToolbarItem } from '../components/kw-monaco-toolbar.js';
import { undoIcon, redoIcon, commentSqlIcon, prettifyIcon, searchIcon, replaceIcon, autocompleteIcon, ghostIcon } from '../shared/icon-registry.js';
import { toggleAutoTriggerAutocompleteEnabled, toggleCopilotInlineCompletionsEnabled } from './kw-query-toolbar.js';

@customElement('kw-sql-toolbar')
export class KwSqlToolbar extends KwMonacoToolbar {

	@property({ type: Boolean }) copilotChatActive = false;
	@property({ type: Boolean }) copilotChatEnabled = false;

	private _autoCompleteActive = false;
	private _copilotInlineActive = false;
	private _copilotLogoUri = '';

	override connectedCallback(): void {
		super.connectedCallback();
		try {
			const cfg = (window as any).__kustoQueryEditorConfig;
			this._copilotLogoUri = cfg?.copilotLogoUri ? String(cfg.copilotLogoUri) : '';
		} catch { /* ignore */ }
	}

	private _fireEditorAction(action: string): void {
		this.dispatchEvent(new CustomEvent('sql-editor-action', { detail: { action }, bubbles: true, composed: true }));
	}

	private _onCopilotToggle = (): void => {
		this.dispatchEvent(new CustomEvent('sql-copilot-toggle', { bubbles: true, composed: true }));
	};

	/** Copilot icon — uses either the logo URI or a fallback SVG. */
	private get _copilotIcon() {
		return this._copilotLogoUri
			? html`<img class="copilot-logo" src=${this._copilotLogoUri} alt="" aria-hidden="true" width="16" height="16" />`
			: html`<svg class="copilot-logo-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="10" height="9" rx="2" /><path d="M6 12v1" /><path d="M10 12v1" /><circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" /><circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" /><path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" /></svg>`;
	}

	protected override _getItems(): MonacoToolbarItem[] {
		return [
			{ type: 'button', label: 'Undo', title: 'Undo (Ctrl+Z)', action: () => this._fireEditorAction('undo'), icon: undoIcon },
			{ type: 'button', label: 'Redo', title: 'Redo (Ctrl+Y)', action: () => this._fireEditorAction('redo'), icon: redoIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Comment', title: 'Toggle comment (Ctrl+/)', action: () => this._fireEditorAction('toggleComment'), icon: commentSqlIcon },
			{ type: 'button', label: 'Prettify', title: 'Prettify SQL\nFormats the SQL query with proper indentation and keyword casing', action: () => this._fireEditorAction('prettify'), icon: prettifyIcon },
			{ type: 'separator' },
			{ type: 'button', label: 'Search', title: 'Search (Ctrl+F)', action: () => this._fireEditorAction('search'), icon: searchIcon },
			{ type: 'button', label: 'Replace', title: 'Search and replace (Ctrl+H)', action: () => this._fireEditorAction('replace'), icon: replaceIcon },
			{ type: 'separator' },
			{
				type: 'toggle', toggleKey: 'autoComplete',
				label: 'Auto-completions as you type',
				idSuffix: '_auto_autocomplete_toggle',
				title: 'Automatically trigger schema-based completions dropdown as you type\nShortcut for manual trigger: CTRL + SPACE',
				icon: autocompleteIcon,
				isActive: this._autoCompleteActive,
				extraClasses: 'qe-auto-autocomplete-toggle',
				action: () => toggleAutoTriggerAutocompleteEnabled(),
			},
			{
				type: 'toggle', toggleKey: 'copilotInline',
				label: 'Copilot inline suggestions',
				idSuffix: '_copilot_inline_toggle',
				title: 'Automatically trigger Copilot inline completions (ghost text) as you type\nShortcut for manual trigger: CTRL + SHIFT + SPACE',
				icon: ghostIcon,
				isActive: this._copilotInlineActive,
				extraClasses: 'qe-copilot-inline-toggle',
				action: () => toggleCopilotInlineCompletionsEnabled(),
			},
			{
				type: 'button', label: 'Copilot',
				title: 'Copilot chat\nGenerate and run a query with GitHub Copilot',
				icon: this._copilotIcon,
				isActive: this.copilotChatActive,
				disabled: !this.copilotChatEnabled,
				action: this._onCopilotToggle,
			},
		];
	}

	public setAutoCompleteActive(active: boolean): void { this._autoCompleteActive = active; this.requestUpdate(); }
	public setCopilotInlineActive(active: boolean): void { this._copilotInlineActive = active; this.requestUpdate(); }
	public setCopilotChatActive(active: boolean): void { this.copilotChatActive = active; }
	public setCopilotChatEnabled(enabled: boolean): void { this.copilotChatEnabled = enabled; }
}
