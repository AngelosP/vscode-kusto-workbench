import * as vscode from 'vscode';
import { normalizeWorkbenchUriKey } from '../../src/host/workbenchFileTypes';

type WorkspaceApi = typeof vscode.workspace;
type OpenTextDocumentFn = (...args: any[]) => any;

/**
 * Suite-scoped facade that lets fixture fake documents appear in `workspace.textDocuments`
 * so production live-document guards treat them like open ExtHost documents.
 */
export class LiveTextDocumentTestFacade {
	private readonly registered = new Set<vscode.TextDocument>();
	private readonly realDocuments = new WeakSet<object>();
	private readonly wrapperByInner = new WeakMap<OpenTextDocumentFn, OpenTextDocumentFn>();
	private readonly innerByWrapper = new WeakMap<OpenTextDocumentFn, OpenTextDocumentFn>();
	private savedTextDocuments: PropertyDescriptor | undefined;
	private savedOpenTextDocument: PropertyDescriptor | undefined;
	private realGetTextDocuments: (() => readonly vscode.TextDocument[]) | undefined;
	private realOpenTextDocument: OpenTextDocumentFn | undefined;
	private currentOpenTextDocument: OpenTextDocumentFn | undefined;

	constructor(private readonly workspace: WorkspaceApi = vscode.workspace) {}

	install(): void {
		if (this.savedTextDocuments) throw new Error('Live text document facade is already installed.');
		const textDocuments = Object.getOwnPropertyDescriptor(this.workspace, 'textDocuments');
		const openTextDocument = Object.getOwnPropertyDescriptor(this.workspace, 'openTextDocument');
		if (!textDocuments?.get || !textDocuments.configurable) {
			throw new Error('workspace.textDocuments is not a configurable getter; cannot install live text document facade.');
		}
		if (typeof openTextDocument?.value !== 'function' || !openTextDocument.configurable) {
			throw new Error('workspace.openTextDocument is not a configurable function; cannot install live text document facade.');
		}
		const workspace = this.workspace;
		const realGet = textDocuments.get;
		this.savedTextDocuments = textDocuments;
		this.savedOpenTextDocument = openTextDocument;
		this.realGetTextDocuments = () => realGet.call(workspace);
		this.realOpenTextDocument = openTextDocument.value;
		this.currentOpenTextDocument = openTextDocument.value;
		Object.defineProperty(workspace, 'textDocuments', {
			configurable: true,
			enumerable: textDocuments.enumerable,
			get: () => this.readTextDocuments(),
		});
		Object.defineProperty(workspace, 'openTextDocument', {
			configurable: true,
			enumerable: openTextDocument.enumerable,
			get: () => this.readOpenTextDocument(),
			set: (next: OpenTextDocumentFn) => { this.currentOpenTextDocument = this.innerByWrapper.get(next) ?? next; },
		});
	}

	/** Registers a fixture fake as live. Real ExtHost documents (open or closed) are never registered. */
	register(document: vscode.TextDocument | undefined): boolean {
		if (!this.savedTextDocuments) throw new Error('Live text document facade is not installed.');
		if (!document || typeof document !== 'object' || !document.uri) return false;
		if (this.registered.has(document)) return true;
		if (this.isRealDocument(document)) return false;
		const key = normalizeWorkbenchUriKey(document.uri);
		for (const existing of this.registered) {
			if (normalizeWorkbenchUriKey(existing.uri) === key) {
				throw new Error(`A different fake document is already live for ${document.uri.toString()}; retire it before registering a successor.`);
			}
		}
		this.applyFakeDefaults(document);
		this.registered.add(document);
		return true;
	}

	retire(document: vscode.TextDocument): void {
		this.registered.delete(document);
	}

	clear(): void {
		this.registered.clear();
		this.currentOpenTextDocument = this.realOpenTextDocument;
	}

	dispose(): void {
		this.registered.clear();
		if (this.savedTextDocuments) Object.defineProperty(this.workspace, 'textDocuments', this.savedTextDocuments);
		if (this.savedOpenTextDocument) Object.defineProperty(this.workspace, 'openTextDocument', this.savedOpenTextDocument);
		this.savedTextDocuments = undefined;
		this.savedOpenTextDocument = undefined;
		this.realGetTextDocuments = undefined;
		this.realOpenTextDocument = undefined;
		this.currentOpenTextDocument = undefined;
	}

	private readRealTextDocuments(): readonly vscode.TextDocument[] {
		const real = this.realGetTextDocuments!();
		for (const document of real) this.realDocuments.add(document);
		return real;
	}

	private readTextDocuments(): vscode.TextDocument[] {
		const real = this.readRealTextDocuments();
		const fakes = [...this.registered].filter(document => !real.includes(document));
		return [...real, ...fakes];
	}

	private isRealDocument(document: vscode.TextDocument): boolean {
		return this.readRealTextDocuments().includes(document)
			|| this.realDocuments.has(document)
			|| Object.isFrozen(document);
	}

	private applyFakeDefaults(document: vscode.TextDocument): void {
		const fake: object = document;
		if (!('isClosed' in fake)) {
			Object.defineProperty(document, 'isClosed', {
				configurable: true,
				get: () => !this.registered.has(document),
			});
		}
		if (!('version' in fake)) {
			const state = { text: undefined as string | undefined, version: 1 };
			Object.defineProperty(document, 'version', {
				configurable: true,
				get: () => {
					const text = document.getText();
					if (state.text !== undefined && state.text !== text) state.version++;
					state.text = text;
					return state.version;
				},
			});
		}
	}

	private readOpenTextDocument(): OpenTextDocumentFn {
		const current = this.currentOpenTextDocument!;
		if (current === this.realOpenTextDocument) return current;
		let wrapper = this.wrapperByInner.get(current);
		if (!wrapper) {
			const facade = this;
			wrapper = async function (this: unknown, ...args: any[]) {
				const document = await current.apply(this, args);
				facade.register(document);
				return document;
			};
			this.wrapperByInner.set(current, wrapper);
			this.innerByWrapper.set(wrapper, current);
		}
		return wrapper;
	}
}

export function createLiveTextDocumentTestFacade(
	workspace: WorkspaceApi = vscode.workspace,
): LiveTextDocumentTestFacade {
	return new LiveTextDocumentTestFacade(workspace);
}
