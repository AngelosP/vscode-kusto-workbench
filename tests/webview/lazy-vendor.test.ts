import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WindowWithVendorGlobals = Window & typeof globalThis & {
	__kustoQueryEditorConfig?: { markedUrl?: string; purifyUrl?: string };
	define?: { amd?: unknown };
	module?: unknown;
	exports?: unknown;
	marked?: { parse(markdown: string): string };
	DOMPurify?: { sanitize(value: string): string };
};

const vendorWindow = window as WindowWithVendorGlobals;

beforeEach(() => {
	vi.resetModules();
	vendorWindow.__kustoQueryEditorConfig = {
		markedUrl: 'https://file+.vscode-resource.vscode-cdn.net/marked.js',
		purifyUrl: 'https://file+.vscode-resource.vscode-cdn.net/purify.js',
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	delete vendorWindow.__kustoQueryEditorConfig;
	delete vendorWindow.define;
	delete vendorWindow.module;
	delete vendorWindow.exports;
	delete vendorWindow.marked;
	delete vendorWindow.DOMPurify;
});

describe('lazy Markdown vendor loading', () => {
	it('serializes AMD-suppressed scripts and restores the original globals', async () => {
		const amd = { original: true };
		const moduleValue = { module: true };
		const exportsValue = { exports: true };
		vendorWindow.define = { amd };
		vendorWindow.module = moduleValue;
		vendorWindow.exports = exportsValue;
		const scripts: HTMLScriptElement[] = [];
		vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
			if (node instanceof HTMLScriptElement) scripts.push(node);
			return node;
		});
		const { ensureDomPurifyLoaded, ensureMarkedLoaded } = await import('../../src/webview/shared/lazy-vendor.js');

		const markedLoad = ensureMarkedLoaded();
		const purifyLoad = ensureDomPurifyLoaded();
		await vi.waitFor(() => expect(scripts).toHaveLength(1));
		expect(vendorWindow.define.amd).toBeUndefined();
		expect(vendorWindow.module).toBeUndefined();
		expect(vendorWindow.exports).toBeUndefined();

		vendorWindow.marked = { parse: markdown => markdown };
		scripts[0].onload?.(new Event('load'));
		await markedLoad;
		await vi.waitFor(() => expect(scripts).toHaveLength(2));
		expect(vendorWindow.define.amd).toBeUndefined();

		vendorWindow.DOMPurify = { sanitize: value => value };
		scripts[1].onload?.(new Event('load'));
		await purifyLoad;

		expect(vendorWindow.define.amd).toBe(amd);
		expect(vendorWindow.module).toBe(moduleValue);
		expect(vendorWindow.exports).toBe(exportsValue);
	});

	it('rejects a loaded script that did not register its expected global', async () => {
		vendorWindow.define = { amd: { original: true } };
		let script: HTMLScriptElement | undefined;
		vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
			if (node instanceof HTMLScriptElement) script = node;
			return node;
		});
		const { ensureMarkedLoaded } = await import('../../src/webview/shared/lazy-vendor.js');

		const loading = ensureMarkedLoaded();
		await vi.waitFor(() => expect(script).toBeDefined());
		script!.onload?.(new Event('load'));

		await expect(loading).rejects.toThrow('expected global was not registered');
		expect(vendorWindow.define.amd).toEqual({ original: true });
	});
});

describe('Monaco AMD publication during lazy vendor loading', () => {
	it.each([false, true])('retains the editor API when Markdown masks AMD: %s', async (maskAmd) => {
		const scripts: HTMLScriptElement[] = [];
		vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
			if (node instanceof HTMLScriptElement) scripts.push(node);
			return node;
		});
		const reachedKustoContribution = new Error('Reached the Kusto contribution after editor initialization');
		let editorLoaded: ((api: unknown) => void) | undefined;
		const requireAmd = Object.assign(vi.fn((dependencies: string[], onload: (api: unknown) => void) => {
			if (dependencies[0] === 'vs/editor/editor.main') {
				editorLoaded = onload;
				return;
			}
			throw reachedKustoContribution;
		}), { config: vi.fn() });
		const workerEnvironment = { getWorker: vi.fn(), getWorkerUrl: vi.fn() };
		const sandbox = createContext({
			document,
			console: { error: vi.fn() },
			exports: {},
			Promise,
			setTimeout,
			require: requireAmd,
			define: Object.assign(vi.fn(), { amd: true }),
			MonacoEnvironment: workerEnvironment,
			__kustoQueryEditorConfig: { ...vendorWindow.__kustoQueryEditorConfig, monacoVsUri: 'https://example.test/vs' },
			monacoReadyPromise: null,
			setMonacoReadyPromise: (promise: Promise<void>) => { sandbox.monacoReadyPromise = promise; },
			traceFileOpen: vi.fn(),
		});
		sandbox.window = sandbox;
		const lazyVendorSource = readFileSync('src/webview/shared/lazy-vendor.ts', 'utf8');
		runInContext(ts.transpileModule(lazyVendorSource, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
		}).outputText, sandbox);
		const monacoSource = ts.createSourceFile('monaco.ts',
			readFileSync('src/webview/monaco/monaco.ts', 'utf8'),
			ts.ScriptTarget.ES2022, true);
		const ensureMonaco = monacoSource.statements.find(statement =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === 'ensureMonaco');
		expect(ensureMonaco).toBeDefined();
		runInContext(ts.transpileModule(ensureMonaco!.getText(monacoSource), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		}).outputText, sandbox);
		const amdSource = ts.createSourceFile('editor.main.js',
			readFileSync('node_modules/monaco-editor/min/vs/editor/editor.main.js', 'utf8'),
			ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
		let apiFactory: ts.FunctionExpression | undefined;
		let mainFactory: ts.FunctionExpression | undefined;
		const findFactories = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && node.expression.getText(amdSource) === 'define') {
				const factory = node.arguments[2];
				if (factory && ts.isFunctionExpression(factory)) {
					if (factory.body.getText(amdSource).includes('globalAPI')) apiFactory = factory;
					const name = node.arguments[0];
					if (name && ts.isStringLiteral(name) && name.text === 'vs/editor/editor.main') mainFactory = factory;
				}
			}
			ts.forEachChild(node, findFactories);
		};
		findFactories(amdSource);
		expect(apiFactory).toBeDefined();
		expect(mainFactory).toBeDefined();

		const editor = { setModelMarkers: vi.fn(), getModels: () => [] };
		const languages = {};
		const apiExports: Record<string, unknown> = {};
		const ready = runInContext('ensureMonaco()', sandbox) as Promise<void>;
		const outcome = ready.catch(error => error);
		await Promise.resolve();
		expect(editorLoaded).toBeTypeOf('function');
		let markedLoad: Promise<void> | undefined;
		if (maskAmd) {
			markedLoad = (sandbox.exports as { ensureMarkedLoaded(): Promise<void> }).ensureMarkedLoaded();
			await vi.waitFor(() => expect(scripts).toHaveLength(1));
			expect(sandbox.define.amd).toBeUndefined();
		}
		runInContext(`(${apiFactory!.getText(amdSource)})`, sandbox)(
			requireAmd,
			apiExports,
			{ EditorOptions: { wrappingIndent: {}, glyphMargin: {}, autoIndent: {}, overviewRulerLanes: {} } },
			{ createMonacoBaseAPI: () => ({}) },
			{ createMonacoEditorAPI: () => editor },
			{ createMonacoLanguagesAPI: () => languages },
			{ FormattingConflicts: { setFormatterSelector: vi.fn() } },
		);
		expect(apiExports.editor).toBe(editor);
		if (markedLoad) {
			sandbox.marked = { parse: (markdown: string) => markdown };
			scripts[0].onload?.(new Event('load'));
			await markedLoad;
			expect(sandbox.define.amd).toBe(true);
		}
		editorLoaded!(runInContext(`(${mainFactory!.getText(amdSource)})`, sandbox)(apiExports));

		expect(await outcome).toBe(reachedKustoContribution);
		expect(sandbox.monaco.editor).toBe(editor);
		expect(sandbox.monaco.languages).toBe(languages);
		expect(sandbox.MonacoEnvironment).toBe(workerEnvironment);
	});
});