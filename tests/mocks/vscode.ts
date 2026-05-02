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
		// Minimal URI parsing: detect scheme and extract fsPath for file URIs.
		const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):/i);
		if (schemeMatch) {
			u.scheme = schemeMatch[1].toLowerCase();
			if (u.scheme === 'file') {
				// Strip file:// (or file:///) prefix to get the path
				const raw = value.replace(/^file:\/\/\/?/i, '');
				// On Windows: file:///C:/foo → C:/foo (drive letter)
				// On Unix: file:///home/user → /home/user
				const hasWindowsDrive = /^[a-zA-Z]:/.test(raw);
				u.fsPath = hasWindowsDrive ? raw : '/' + raw;
				u.path = '/' + raw;
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
	fsPath = '';
	path = '';
	constructor(private _value: string = '') {
		this.fsPath = _value;
		this.path = _value;
	}
	with(change: { scheme?: string; path?: string }): Uri {
		const u = new Uri(this._value);
		u.scheme = change.scheme ?? this.scheme;
		u.path = change.path ?? this.path;
		u.fsPath = change.path ?? this.fsPath;
		u._value = change.path ?? this._value;
		return u;
	}
	toString() { return this._value; }
}

export const window = {
	createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
	showInformationMessage: () => Promise.resolve(undefined),
	showErrorMessage: () => Promise.resolve(undefined),
	showWarningMessage: () => Promise.resolve(undefined),
	createWebviewPanel: () => ({}),
};

export const commands = {
	registerCommand: () => ({ dispose: () => {} }),
	executeCommand: () => Promise.resolve(),
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
	getConfiguration: () => ({
		get: () => undefined,
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
	onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const authentication = {
	getSession: () => Promise.resolve(undefined),
};

export const lm = {
	selectChatModels: () => Promise.resolve([]),
};

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
