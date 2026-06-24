/**
 * Minimal vscode module mock for Vitest.
 *
 * Several host source files (kustoClient, connectionManager, queryEditorTypes,
 * queryEditorConnection) `import * as vscode from 'vscode'`. The tested
 * functions are pure and never call vscode APIs, but the module import must
 * resolve. This mock provides stubs so the import succeeds.
 *
 * Wired via `resolve.alias` in vitest.config.ts.
 */

export class EventEmitter {
	event = () => ({ dispose: () => {} });
	fire() {}
	dispose() {}
}

export interface Disposable {
	dispose(): void;
}

export interface StatusBarItem extends Disposable {
	name: string;
	text: string;
	tooltip: unknown;
	accessibilityInformation: unknown;
	show(): void;
	hide(): void;
}

export class Range {
	constructor(
		public startLine = 0, public startCharacter = 0,
		public endLine = 0, public endCharacter = 0
	) {}
}

export class Position {
	constructor(public line = 0, public character = 0) {}
}

export class Uri {
	static parse(value: string) {
		const u = new Uri(value);
		// Minimal URI parsing: detect scheme, authority, and path.
		const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):(?:\/\/([^/]*))?(.*)$/i);
		if (schemeMatch) {
			u.scheme = schemeMatch[1].toLowerCase();
			u.authority = schemeMatch[2] ?? '';
			if (u.scheme === 'file') {
				// Strip file:// (or file:///) prefix to get the path
				const raw = value.replace(/^file:\/\/\/?/i, '');
				// On Windows: file:///C:/foo → C:/foo (drive letter)
				// On Unix: file:///home/user → /home/user
				const hasWindowsDrive = /^[a-zA-Z]:/.test(raw);
				u.fsPath = hasWindowsDrive ? raw : '/' + raw;
				u.path = '/' + raw;
			} else {
				u.path = schemeMatch[3] || '';
				u.fsPath = u.path;
			}
		}
		return u;
	}
	static file(path: string) {
		const u = new Uri('file://' + path);
		u.scheme = 'file';
		u.fsPath = path;
		u.path = path;
		return u;
	}
	static joinPath(base: Uri, ...segments: string[]) {
		const basePath = base.fsPath || base.path || base.toString();
		const joined = [basePath, ...segments]
			.filter(Boolean)
			.join('/')
			.replace(/\\/g, '/')
			.replace(/\/+/g, '/');
		return Uri.file(joined);
	}
	scheme = 'file';
	authority = '';
	fsPath = '';
	path = '';
	constructor(private _value: string = '') {
		this.fsPath = _value;
		this.path = _value;
	}
	with(change: { scheme?: string; path?: string; authority?: string }): Uri {
		const scheme = change.scheme ?? this.scheme;
		const authority = change.authority ?? this.authority;
		const path = change.path ?? this.path;
		const value = authority
			? `${scheme}://${authority}${path}`
			: scheme === 'file'
				? `file://${path}`
				: `${scheme}:${path}`;
		const u = new Uri(value);
		u.scheme = scheme;
		u.authority = authority;
		u.path = path;
		u.fsPath = change.path ?? this.fsPath;
		u._value = value;
		return u;
	}
	toString() { return this._value; }
}

export class TabInputText {
	constructor(public readonly uri: Uri) {}
}

export class TabInputCustom {
	constructor(public readonly uri: Uri, public readonly viewType: string) {}
}

export const __mockStatusBarItems: any[] = [];
export const __mockCommandCalls: Array<{ command: string; args: unknown[] }> = [];

export enum StatusBarAlignment {
	Left = 1,
	Right = 2,
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3,
}

export enum ViewColumn {
	Active = -1,
	One = 1,
}

export const window = {
	activeTextEditor: undefined as any,
	visibleTextEditors: [] as any[],
	onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
	tabGroups: {
		activeTabGroup: { activeTab: undefined as any, tabs: [] as any[], isActive: true },
		all: [] as any[],
		onDidChangeTabs: () => ({ dispose: () => {} }),
		onDidChangeTabGroups: () => ({ dispose: () => {} }),
	},
	createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
	showInputBox: () => Promise.resolve(undefined),
	showSaveDialog: () => Promise.resolve(undefined),
	showInformationMessage: () => Promise.resolve(undefined),
	showErrorMessage: () => Promise.resolve(undefined),
	showWarningMessage: () => Promise.resolve(undefined),
	setStatusBarMessage: () => ({ dispose: () => {} }),
	createWebviewPanel: () => ({}),
	createStatusBarItem: (id?: string, alignment?: StatusBarAlignment, priority?: number) => {
		const item = {
			id,
			alignment,
			priority,
			name: '',
			text: '',
			tooltip: undefined as unknown,
			accessibilityInformation: undefined as unknown,
			shown: false,
			disposed: false,
			show() { this.shown = true; },
			hide() { this.shown = false; },
			dispose() { this.disposed = true; },
		};
		__mockStatusBarItems.push(item);
		return item;
	},
};

export const env = {
	openExternal: () => Promise.resolve(true),
};

export const commands = {
	registerCommand: () => ({ dispose: () => {} }),
	executeCommand: (command: string, ...args: unknown[]) => {
		__mockCommandCalls.push({ command, args });
		return Promise.resolve();
	},
};

const fileSystemStore = new Map<string, Uint8Array>();

export const __mockFileSystem = {
	clear: () => fileSystemStore.clear(),
	readText: (uri: Uri) => {
		const bytes = fileSystemStore.get(uri.toString()) ?? fileSystemStore.get(uri.fsPath);
		return bytes ? new TextDecoder().decode(bytes) : undefined;
	},
};

export const workspace = {
	textDocuments: [] as any[],
	workspaceFolders: [] as any[],
	getConfiguration: () => ({
		get: () => undefined,
		inspect: () => undefined,
		update: () => Promise.resolve(),
	}),
	fs: {
		createDirectory: () => Promise.resolve(),
		readFile: async (uri: Uri) => {
			const bytes = fileSystemStore.get(uri.toString()) ?? fileSystemStore.get(uri.fsPath);
			if (!bytes) {
				throw new Error(`ENOENT: ${uri.toString()}`);
			}
			return bytes;
		},
		writeFile: async (uri: Uri, bytes: Uint8Array) => {
			fileSystemStore.set(uri.toString(), bytes);
			fileSystemStore.set(uri.fsPath, bytes);
		},
	},
	openTextDocument: async (uri: Uri) => ({ uri }),
	onDidOpenTextDocument: () => ({ dispose: () => {} }),
	onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const authentication = {
	getSession: () => Promise.resolve(undefined),
};

export const lm = {
	selectChatModels: () => Promise.resolve([]),
};

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
}

export class LanguageModelTextPart {
	constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
	constructor(
		public readonly callId: string,
		public readonly name: string,
		public readonly input: unknown,
	) {}
}

export class LanguageModelToolResultPart {
	constructor(
		public readonly callId: string,
		public readonly content: LanguageModelTextPart[],
	) {}
}

export class LanguageModelChatMessage {
	constructor(
		public readonly role: LanguageModelChatMessageRole,
		public readonly content: Array<LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart>,
	) {}

	static User(content: string | Array<LanguageModelTextPart | LanguageModelToolResultPart>) {
		return new LanguageModelChatMessage(
			LanguageModelChatMessageRole.User,
			typeof content === 'string' ? [new LanguageModelTextPart(content)] : content,
		);
	}

	static Assistant(content: string | Array<LanguageModelTextPart | LanguageModelToolCallPart>) {
		return new LanguageModelChatMessage(
			LanguageModelChatMessageRole.Assistant,
			typeof content === 'string' ? [new LanguageModelTextPart(content)] : content,
		);
	}
}

export const languages = {
	createDiagnosticCollection: () => ({ set: () => {}, dispose: () => {} }),
};

export enum ExtensionMode {
	Production = 1,
	Development = 2,
	Test = 3,
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}
