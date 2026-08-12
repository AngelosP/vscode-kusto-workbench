import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shimPath = resolve('browser-ext/vscode-shim.js');
const shimSource = buildSync({
	entryPoints: [shimPath],
	bundle: true,
	platform: 'browser',
	target: 'es2022',
	format: 'iife',
	write: false,
}).outputFiles[0].text;

describe('browser CSV host shim', () => {
	let postedHostMessages: unknown[];
	let appendedElements: HTMLElement[];
	let postMessageSpy: ReturnType<typeof vi.spyOn>;
	let clickSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		document.body.replaceChildren();
		postedHostMessages = [];
		appendedElements = [];
		postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
			postedHostMessages.push(message);
		});
		vi.spyOn(document.body, 'appendChild').mockImplementation(((element: HTMLElement) => {
			appendedElements.push(element);
			return HTMLElement.prototype.appendChild.call(document.body, element);
		}) as typeof document.body.appendChild);
		clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:csv') });
		Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
		new Function(shimSource)();
	});

	afterEach(() => {
		delete (window as any).vscode;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('downloads governed CSV only after the matching nonce response', () => {
		window.vscode.postMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1',
			artifactId: 'artifact-1', suggestedFileName: 'Filtered Results.csv',
		});
		const challenge = postedHostMessages[0] as any;
		expect(challenge).toMatchObject({
			type: 'requestArtifactCsvSaveData', exportId: 'export-1',
			boxId: 'query-1', artifactId: 'artifact-1',
		});

		window.vscode.postMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'wrong-artifact', accepted: true, csv: 'wrong',
		});
		expect(clickSpy).not.toHaveBeenCalled();
		window.vscode.postMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: ['query-1'], artifactId: 'artifact-1', accepted: true, csv: 'forged',
		});
		expect(clickSpy).not.toHaveBeenCalled();

		const response = {
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'Name\nalpha',
		};
		window.vscode.postMessage(response);
		window.vscode.postMessage({ ...response, csv: 'replay' });
		expect(clickSpy).toHaveBeenCalledOnce();
		const anchor = appendedElements.find(element => element instanceof HTMLAnchorElement) as HTMLAnchorElement;
		expect(anchor.download).toBe('Filtered Results.csv');
	});

	it('rejects malformed governed intents without invoking accessors or creating challenges', () => {
		let getterCalls = 0;
		const malformed = {
			type: 'requestArtifactCsvSave', requestId: 'export-malformed',
			artifactId: 'artifact-1',
		};
		Object.defineProperty(malformed, 'boxId', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});

		window.vscode.postMessage(malformed);

		expect(getterCalls).toBe(0);
		expect(postedHostMessages).toEqual([]);
		expect(clickSpy).not.toHaveBeenCalled();
	});

	it('downloads imported CSV without artifact governance', () => {
		window.vscode.postMessage({
			type: 'saveImportedCsv', csv: 'Name\nalpha', suggestedFileName: 'Imported',
		});
		expect(clickSpy).toHaveBeenCalledOnce();
		const anchor = appendedElements.find(element => element instanceof HTMLAnchorElement) as HTMLAnchorElement;
		expect(anchor.download).toBe('Imported.csv');
		expect(postMessageSpy).not.toHaveBeenCalled();
	});

	it('drops a governed response after its export intent is canceled', () => {
		window.vscode.postMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-cancel',
			boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = postedHostMessages[0] as any;
		window.vscode.postMessage({ type: 'cancelArtifactCsvSaveIntent', requestId: 'export-cancel' });
		window.vscode.postMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'must-not-download',
		});
		expect(clickSpy).not.toHaveBeenCalled();
	});

	it('ignores replayed governed intents before and after settlement', () => {
		const intent = {
			type: 'requestArtifactCsvSave', requestId: 'export-replay',
			boxId: 'query-1', artifactId: 'artifact-1',
		};
		window.vscode.postMessage(intent);
		window.vscode.postMessage(intent);
		expect(postedHostMessages).toHaveLength(1);
		const challenge = postedHostMessages[0] as any;
		window.vscode.postMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'once',
		});
		window.vscode.postMessage(intent);
		expect(postedHostMessages).toHaveLength(1);
		expect(clickSpy).toHaveBeenCalledOnce();
	});

	it('caps active intents and cancels timed-out browser projections', () => {
		for (let index = 0; index < 9; index++) {
			window.vscode.postMessage({
				type: 'requestArtifactCsvSave', requestId: `browser-active-${index}`,
				boxId: `query-${index}`, artifactId: `artifact-${index}`,
			});
		}
		expect(postedHostMessages.filter((message: any) => message.type === 'requestArtifactCsvSaveData')).toHaveLength(8);
		expect(postedHostMessages).toContainEqual({
			type: 'cancelArtifactCsvSave', exportId: 'browser-active-8',
		});

		vi.advanceTimersByTime(60_000);
		for (let index = 0; index < 8; index++) {
			expect(postedHostMessages).toContainEqual({
				type: 'cancelArtifactCsvSave', exportId: `browser-active-${index}`,
			});
		}
	});
});