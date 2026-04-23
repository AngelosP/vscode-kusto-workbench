import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styles } from './kw-sql-connection-form.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { ICONS } from '../shared/icon-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SqlDialectInfo {
	id: string;
	displayName: string;
	defaultPort: number;
	authTypes: Array<{ id: string; displayName: string }>;
}

export interface SqlConnectionFormSubmitDetail {
	name: string;
	serverUrl: string;
	dialect: string;
	authType: string;
	database?: string;
	port?: number;
	username?: string;
	password?: string;
}

/** Default dialect list when no dialect info is provided by host. */
const DEFAULT_DIALECTS: SqlDialectInfo[] = [
	{
		id: 'mssql',
		displayName: 'Microsoft SQL Server',
		defaultPort: 1433,
		authTypes: [
			{ id: 'aad', displayName: 'Azure AD' },
			{ id: 'sql-login', displayName: 'SQL Login' },
		],
	},
];

// ── Component ─────────────────────────────────────────────────────────────────

@customElement('kw-sql-connection-form')
export class KwSqlConnectionForm extends LitElement {
	static override styles = [scrollbarSheet, styles];

	@property() mode: 'add' | 'edit' = 'add';
	@property() name = '';
	@property() serverUrl = '';
	@property() port = '';
	@property() dialect = 'mssql';
	@property() authType = 'aad';
	@property() username = '';
	@property() password = '';
	@property() database = '';
	@property({ type: Boolean }) showTestButton = false;
	@property() testResult = '';
	@property({ type: Array }) dialects: SqlDialectInfo[] = [];
	@property({ type: Boolean }) changePassword = false;

	// Internal form values
	@state() private _name = '';
	@state() private _serverUrl = '';
	@state() private _port = '';
	@state() private _dialect = 'mssql';
	@state() private _authType = 'aad';
	@state() private _username = '';
	@state() private _password = '';
	@state() private _database = '';
	@state() private _changePassword = false;
	@state() private _initialized = false;

	override willUpdate(changed: Map<string | number | symbol, unknown>): void {
		if (!this._initialized || changed.has('mode') || changed.has('name') || changed.has('serverUrl')
			|| changed.has('port') || changed.has('dialect') || changed.has('authType')
			|| changed.has('username') || changed.has('password') || changed.has('database')
			|| changed.has('changePassword')) {
			this._name = this.name;
			this._serverUrl = this.serverUrl;
			this._port = this.port;
			this._dialect = this.dialect;
			this._authType = this.authType;
			this._username = this.username;
			this._password = this.password;
			this._database = this.database;
			this._changePassword = this.changePassword;
			this._initialized = true;
		}
	}

	override firstUpdated(): void {
		const firstInput = this.shadowRoot?.querySelector('input') as HTMLInputElement | null;
		if (firstInput) {
			requestAnimationFrame(() => firstInput.focus());
		}
	}

	private get _effectiveDialects(): SqlDialectInfo[] {
		return this.dialects.length > 0 ? this.dialects : DEFAULT_DIALECTS;
	}

	override render(): TemplateResult {
		const dialects = this._effectiveDialects;
		const selectedDialect = dialects.find(d => d.id === this._dialect);
		const authTypes = selectedDialect?.authTypes ?? [{ id: 'aad', displayName: 'Azure AD' }];
		const isSqlLogin = this._authType === 'sql-login';
		const isEditing = this.mode === 'edit';

		return html`
			<div @keydown=${this._onKeydown}>
				<div class="form-group">
					<label>Connection Name${isEditing ? ' *' : ''}</label>
					<input type="text" data-testid="sql-conn-name" .value=${this._name}
						@input=${(e: Event) => this._name = (e.target as HTMLInputElement).value}
						placeholder=${isEditing ? 'My SQL Server' : '(optional — defaults to server URL)'} />
				</div>
				<div class="form-group">
					<label>Server URL *</label>
					<input type="text" data-testid="sql-conn-server" .value=${this._serverUrl}
						@input=${(e: Event) => this._serverUrl = (e.target as HTMLInputElement).value}
						placeholder="myserver.database.windows.net" />
				</div>
				<div class="form-row">
					<div class="form-group" style="flex:1">
						<label>Port</label>
						<input type="number" data-testid="sql-conn-port" .value=${this._port}
							@input=${(e: Event) => this._port = (e.target as HTMLInputElement).value}
							placeholder="${selectedDialect?.defaultPort ?? 1433}" />
					</div>
					${dialects.length > 1 ? html`
						<div class="form-group" style="flex:1">
							<label>Dialect</label>
							<select .value=${this._dialect}
								@change=${(e: Event) => this._dialect = (e.target as HTMLSelectElement).value}>
								${dialects.map(d => html`<option value=${d.id}>${d.displayName}</option>`)}
							</select>
						</div>
					` : nothing}
				</div>
				<div class="form-group">
					<label>Authentication</label>
					<select data-testid="sql-conn-auth" .value=${this._authType}
						@change=${(e: Event) => this._authType = (e.target as HTMLSelectElement).value}>
						${authTypes.map(a => html`<option value=${a.id}>${a.displayName}</option>`)}
					</select>
				</div>
				${isSqlLogin ? html`
					<div class="form-group">
						<label>Username *</label>
						<input type="text" .value=${this._username}
							@input=${(e: Event) => this._username = (e.target as HTMLInputElement).value}
							placeholder="sa" />
					</div>
					${isEditing ? html`
						<div class="form-group">
							<label>
								<input type="checkbox" .checked=${this._changePassword}
									@change=${(e: Event) => this._changePassword = (e.target as HTMLInputElement).checked} />
								Change password
							</label>
							${this._changePassword ? html`
								<input type="password" .value=${this._password}
									@input=${(e: Event) => this._password = (e.target as HTMLInputElement).value}
									placeholder="New password" style="margin-top: 4px" />
							` : nothing}
						</div>
					` : html`
						<div class="form-group">
							<label>Password *</label>
							<input type="password" .value=${this._password}
								@input=${(e: Event) => this._password = (e.target as HTMLInputElement).value}
								placeholder="Password" />
						</div>
					`}
				` : nothing}
				<div class="form-group">
					<label>Default Database</label>
					<input type="text" data-testid="sql-conn-database" .value=${this._database}
						@input=${(e: Event) => this._database = (e.target as HTMLInputElement).value}
						placeholder="(optional)" />
				</div>
				${this.showTestButton ? html`
					<button class="btn" @click=${this._onTest}>Test Connection</button>
					${this.testResult === 'loading'
						? html`<div class="test-result">${ICONS.spinner} Testing connection...</div>`
						: this.testResult
							? html`<div class="test-result">${this.testResult}</div>`
							: nothing}
				` : nothing}
			</div>
		`;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	submit(): void {
		const serverUrl = this._serverUrl.trim();
		if (!serverUrl) return;
		const name = this._name.trim() || serverUrl;
		const database = this._database.trim() || undefined;

		const payload: SqlConnectionFormSubmitDetail = {
			name,
			serverUrl,
			dialect: this._dialect,
			authType: this._authType,
			database,
		};
		if (this._port.trim()) {
			const parsed = parseInt(this._port.trim(), 10);
			if (!isNaN(parsed) && parsed > 0) payload.port = parsed;
		}
		if (this._authType === 'sql-login') {
			payload.username = this._username.trim();
			if (this.mode === 'add' || this._changePassword) {
				payload.password = this._password;
			}
		}
		this.dispatchEvent(new CustomEvent<SqlConnectionFormSubmitDetail>('sql-connection-form-submit', {
			detail: payload,
			bubbles: true, composed: true,
		}));
	}

	cancel(): void {
		this.dispatchEvent(new CustomEvent('sql-connection-form-cancel', {
			bubbles: true, composed: true,
		}));
	}

	private _onTest(): void {
		this.dispatchEvent(new CustomEvent('sql-connection-form-test', {
			bubbles: true, composed: true,
		}));
	}

	private _onKeydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			this.submit();
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			this.cancel();
		}
	};
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-sql-connection-form': KwSqlConnectionForm;
	}
}
