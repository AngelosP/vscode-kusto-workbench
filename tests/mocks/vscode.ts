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
	static parse(value: string) { return new Uri(value); }
	static file(path: string) { return new Uri(path); }
	static joinPath(..._args: any[]) { return new Uri(''); }
	scheme = 'file';
	fsPath = '';
	path = '';
	constructor(private _value: string = '') {
		this.fsPath = _value;
		this.path = _value;
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

export const workspace = {
	getConfiguration: () => ({
		get: () => undefined,
		update: () => Promise.resolve(),
	}),
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

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}
