import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vm from 'vm';
import type * as vscode from 'vscode';

import {
	CompatSidecarPersistCoordinator,
	type CompatSidecarPersistMessage,
} from '../../../src/host/compatSidecarPersistCoordinator';
import {
	CompatSidecarProjectionCoordinator,
	createCompatSidecarProjectionReadiness,
	type CompatSidecarProjectionAttempt,
	type CompatSidecarProjectionCoordinatorContract,
} from '../../../src/host/compatSidecarProjectionCoordinator';
import { CompatSidecarSession } from '../../../src/host/compatSidecarSession';
import type { KqlxStateV1 } from '../../../src/host/kqlxFormat';
import { MainWebviewStartupGateway } from '../../../src/host/mainWebviewStartupGateway';

type RecordedProjectionAttempt = CompatSidecarProjectionAttempt & Readonly<{ reloadRequestId: string }>;

function recordProjectionAttempt(
	attempt: CompatSidecarProjectionAttempt,
	attempts: RecordedProjectionAttempt[],
): boolean {
	const reloadRequestId = attempt.reserveReload();
	if (!reloadRequestId) throw new Error('Expected the current projection to reserve a reload waiter.');
	attempts.push({ ...attempt, reloadRequestId });
	return true;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await vi.waitFor(() => expect(predicate()).toBe(true));
}

function providerPersistCallbacks(fileName: string, context: Record<string, unknown>): {
	applySourceText: (text: string) => Promise<boolean>;
	setKnownState: (state: KqlxStateV1) => void;
	persist: (message: CompatSidecarPersistMessage) => Promise<void>;
} {
	const source = fs.readFileSync(path.join(process.cwd(), 'src', 'host', fileName), 'utf8');
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let applySourceText: ts.Expression | undefined;
	let setKnownState: ts.Expression | undefined;
	let persistBody: ts.Block | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
			&& node.expression.name.text === 'persistCoordinatorFactory') {
			const options = node.arguments[0];
			if (options && ts.isObjectLiteralExpression(options)) {
				const adapter = options.properties.find(property => ts.isPropertyAssignment(property)
					&& property.name.getText(sourceFile) === 'adapter');
				if (adapter && ts.isPropertyAssignment(adapter) && ts.isObjectLiteralExpression(adapter.initializer)) {
					for (const property of adapter.initializer.properties) {
						if (!ts.isPropertyAssignment(property)) continue;
						if (property.name.getText(sourceFile) === 'applySourceText') applySourceText = property.initializer;
						if (property.name.getText(sourceFile) === 'setKnownState') setKnownState = property.initializer;
					}
				}
			}
		}
		if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'persistDocument') {
			const body = node.statements[0];
			if (body && ts.isBlock(body)) persistBody = body;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	if (!applySourceText || !setKnownState || !persistBody) throw new Error(`Missing actual persist callbacks in ${fileName}.`);
	const compiled = ts.transpileModule(`({
		applySourceText: ${applySourceText.getText(sourceFile)},
		setKnownState: ${setKnownState.getText(sourceFile)},
		persist: async (message) => ${persistBody.getText(sourceFile)},
	})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	return vm.runInNewContext(compiled, context);
}

describe('CompatSidecarProjectionCoordinator', () => {
	it('preserves readiness after actual owned source commits in both compatibility providers', async () => {
		for (const languageLabel of ['KQL', 'SQL'] as const) {
			for (const [initialText, eol] of [
				['', '\n'], [' \t\r\n ', '\n'], ['original source', '\n'],
				['', '\r\n'], [' \t\r\n ', '\r\n'], ['original source', '\r\n'],
			]) {
				let sourceText = initialText;
				let sourceVersion = 1;
				const requestedText = languageLabel === 'KQL' ? 'print Value=2\n' : 'SELECT 2 AS Value;\n';
				const nextText = requestedText.replace(/\n/g, eol);
				const session = new CompatSidecarSession(true, languageLabel);
				const attempts: RecordedProjectionAttempt[] = [];
				const projection = new CompatSidecarProjectionCoordinator({
					session, readSourceText: () => sourceText, isDisposed: () => false,
					postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
				});
				const initial = projection.requestDocument('owned-source-initial');
				projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
				await expect(initial).resolves.toBe(true);
				const adoption = vi.spyOn(projection, 'adoptOwnedSourceText');
				const context: Record<string, unknown> = {
					projectionCoordinator: projection, sidecarSession: session, outerDisposed: false,
					ownedSourceCommit: undefined, lastKnownSidecarState: undefined,
					document: {
						uri: 'owned-source', getText: () => sourceText,
						eol: eol === '\n' ? 1 : 2,
						get version() { return sourceVersion; },
						get lineCount() { return sourceText.split(/\r?\n/).length; },
						lineAt: (line: number) => ({ text: sourceText.split(/\r?\n/)[line] ?? '' }),
					},
					vscode: {
						EndOfLine: { LF: 1, CRLF: 2 },
						WorkspaceEdit: class { replace(): void {} },
						Range: class {},
					},
					applyOwnedSourceEdit: async () => {
						sourceText = nextText;
						sourceVersion++;
						expect(adoption).not.toHaveBeenCalled();
						await expect(projection.waitForCurrentProjection()).resolves.toBe(false);
						return true;
					},
				};
				const callbacks = providerPersistCallbacks(
					languageLabel === 'KQL' ? 'kqlCompatEditorProvider.ts' : 'sqlCompatEditorProvider.ts', context,
				);
				const acknowledgements: unknown[] = [];
				context.persistCoordinator = new CompatSidecarPersistCoordinator({
					session, projection, languageLabel, getLoadError: () => undefined,
					allowMissingSourceGeneration: false, allowTestOnlyNoop: false, isLive: () => true,
					postMessage: message => {
						expect(session.currentStateEditRevision).toBe(1);
						expect(adoption).not.toHaveBeenCalled();
						acknowledgements.push(message);
						return true;
					},
					warnUnavailable: vi.fn(),
					adapter: {
						captureState: state => state as KqlxStateV1, validateState: vi.fn(),
						sanitizeState: async state => state, prepareMaterializedDraft: () => undefined,
						materializeState: async () => undefined, serializeMaterialized: JSON.stringify,
						getLastWrittenMaterializedText: () => undefined,
						getPrimaryText: state => (state.sections[0] as { query: string }).query,
						readSourceText: () => sourceText, applySourceText: callbacks.applySourceText,
						requestSourceReload: vi.fn(), setKnownState: callbacks.setKnownState,
						setMaterializedSidecar: vi.fn(), publishChanges: vi.fn(), notifyPreparationFailure: vi.fn(),
					},
				});
				await callbacks.persist({
					protocolVersion: 1, channel: 'compatibility-persistence', viewSessionId: 'owned-source-session',
					type: 'persistDocument', snapshotId: 'owned-source-snapshot', editRevision: 1,
					sourceGeneration: attempts[0].generation,
					state: { sections: [{ id: languageLabel === 'KQL' ? 'compat_primary_query' : 'compat_primary_sql',
						type: languageLabel === 'KQL' ? 'query' : 'sql', query: requestedText }] },
				});
				expect(sourceText).toBe(nextText);
				expect(session.currentStateEditRevision).toBe(1);
				expect(acknowledgements).toEqual([{ type: 'persistDocumentAck', snapshotId: 'owned-source-snapshot', editRevision: 1 }]);
				expect(attempts).toHaveLength(1);
				expect(projection.activeSourceGeneration).toBe(attempts[0].generation);
				await expect(projection.waitForCurrentProjection()).resolves.toBe(true);
				expect(adoption).toHaveBeenCalledExactlyOnceWith(attempts[0].generation, initialText, nextText);
				sourceText = 'unowned external edit';
				sourceVersion++;
				await expect(projection.waitForCurrentProjection()).resolves.toBe(false);
			}
		}
	});

	it.each((['KQL', 'SQL'] as const).flatMap(languageLabel =>
		[['blank', ''], ['whitespace', ' \t\r\n '], ['opaque', 'original\r\n\tvalue\r ending']].flatMap(([shape, initialText]) =>
			['\n', '\r\n'].map(eol => ({ languageLabel, shape, initialText, eol, eolLabel: eol === '\n' ? 'LF' : 'CRLF' })),
		),
	))('composes overlapping owned source commits for $languageLabel $shape $eolLabel', async ({ languageLabel, initialText, eol }) => {
		let sourceText = initialText;
		let sourceVersion = 1;
		let releaseFirstWrite!: () => void;
		const firstWrite = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
		const writes: Array<{ previousText: string; nextText: string; version: number }> = [];
		const acknowledgements: unknown[] = [];
		const session = new CompatSidecarSession(true, languageLabel);
		const attempts: RecordedProjectionAttempt[] = [];
		const projection = new CompatSidecarProjectionCoordinator({
			session, readSourceText: () => sourceText, readSourceVersion: () => sourceVersion, isDisposed: () => false,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});
		const initial = projection.requestDocument('overlapping-owned-source-initial');
		projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
		await expect(initial).resolves.toBe(true);
		const adoption = vi.spyOn(projection, 'adoptOwnedSourceText');
		const context: Record<string, unknown> = {
			projectionCoordinator: projection, sidecarSession: session, outerDisposed: false,
			ownedSourceCommit: undefined, lastKnownSidecarState: undefined,
			document: {
				uri: 'overlapping-owned-source', getText: () => sourceText,
				eol: eol === '\n' ? 1 : 2, get version() { return sourceVersion; },
				get lineCount() { return sourceText.split(/\r?\n/).length; },
				lineAt: (line: number) => ({ text: sourceText.split(/\r?\n/)[line] ?? '' }),
			},
			vscode: { EndOfLine: { LF: 1, CRLF: 2 }, WorkspaceEdit: class { replace(): void {} }, Range: class {} },
			applyOwnedSourceEdit: async (_edit: unknown, text: string) => {
				const previousText = sourceText;
				sourceText = text.replace(/\r\n?|\n/g, eol);
				sourceVersion++;
				writes.push({ previousText, nextText: sourceText, version: sourceVersion });
				expect(adoption).not.toHaveBeenCalled();
				await expect(projection.waitForCurrentProjection()).resolves.toBe(false);
				if (writes.length === 1) await firstWrite;
				return true;
			},
		};
		const callbacks = providerPersistCallbacks(
			languageLabel === 'KQL' ? 'kqlCompatEditorProvider.ts' : 'sqlCompatEditorProvider.ts', context,
		);
		const requestSourceReload = vi.fn();
		context.persistCoordinator = new CompatSidecarPersistCoordinator({
			session, projection, languageLabel, getLoadError: () => undefined,
			allowMissingSourceGeneration: false, allowTestOnlyNoop: false, isLive: () => true,
			postMessage: message => { acknowledgements.push(message); return true; }, warnUnavailable: vi.fn(),
			adapter: {
				captureState: state => state as KqlxStateV1, validateState: vi.fn(),
				sanitizeState: async state => state, prepareMaterializedDraft: () => undefined,
				materializeState: async () => undefined, serializeMaterialized: JSON.stringify,
				getLastWrittenMaterializedText: () => undefined,
				getPrimaryText: state => (state.sections[0] as { query: string }).query,
				readSourceText: () => sourceText, applySourceText: callbacks.applySourceText, requestSourceReload,
				setKnownState: callbacks.setKnownState, setMaterializedSidecar: vi.fn(),
				publishChanges: vi.fn(), notifyPreparationFailure: vi.fn(),
			},
		});
		const nodeMetadata = { opaqueText: ' \t\r\n ', nested: { empty: '', enabled: false, items: [null, 0, 'value'] } };
		const requestedTexts = languageLabel === 'KQL' ? ['print Value=2\n', 'print Value=3\n'] : ['SELECT 2 AS Value;\n', 'SELECT 3 AS Value;\n'];
		const persist = (query: string, editRevision: number): Promise<void> => callbacks.persist({
			protocolVersion: 1, channel: 'compatibility-persistence', viewSessionId: 'overlapping-owned-source-session',
			type: 'persistDocument', snapshotId: `overlapping-owned-source-${editRevision}`, editRevision,
			sourceGeneration: attempts[0].generation,
			state: { sections: [{ id: languageLabel === 'KQL' ? 'compat_primary_query' : 'compat_primary_sql',
				type: languageLabel === 'KQL' ? 'query' : 'sql', query, nodeMetadata }] },
		});
		try {
			const firstPersist = persist(requestedTexts[0], 1);
			await waitFor(() => writes.length === 1);
			const firstGeneration = session.generation;
			const secondPersist = persist(requestedTexts[1], 2);
			await waitFor(() => session.generation > firstGeneration);
			expect(projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 1 })).toBe(false);
			expect(writes).toHaveLength(1);
			expect(adoption).not.toHaveBeenCalled();
			releaseFirstWrite();
			await Promise.all([firstPersist, secondPersist]);
			const nativeTexts = requestedTexts.map(text => text.replace(/\n/g, eol));
			expect(writes).toEqual([
				{ previousText: initialText, nextText: nativeTexts[0], version: 2 },
				{ previousText: nativeTexts[0], nextText: nativeTexts[1], version: 3 },
			]);
			expect(acknowledgements).toEqual([{ type: 'persistDocumentAck', snapshotId: 'overlapping-owned-source-2', editRevision: 2 }]);
			expect(session.currentStateEditRevision).toBe(2);
			expect((context.lastKnownSidecarState as KqlxStateV1).sections[0]).toMatchObject({ query: requestedTexts[1], nodeMetadata });
			expect(adoption).toHaveBeenCalledExactlyOnceWith(attempts[0].generation, initialText, nativeTexts[1]);
			expect(attempts).toHaveLength(1);
			expect(requestSourceReload).not.toHaveBeenCalled();
			await expect(projection.waitForCurrentProjection()).resolves.toBe(true);
		} finally {
			releaseFirstWrite();
		}
	});

	it.each(['unregistered-write', 'external-between-writes', 'same-text-external-version', 'rejected-write',
		'wrong-write-version', 'source-read-miss', 'version-read-miss', 'source-replacement', 'persist-replacement',
		'post-commit-source-drift', 'post-commit-version-drift'] as const)(
		'rejects overlapping owned source adoption after %s', async mode => {
			let sourceText = 'original';
			let sourceVersion = 1;
			let unreadableSource = false;
			let unreadableVersion = false;
			const session = new CompatSidecarSession(true, 'KQL');
			const attempts: RecordedProjectionAttempt[] = [];
			const projection = new CompatSidecarProjectionCoordinator({
				session, readSourceText: () => {
					if (unreadableSource) throw new Error('source read missed');
					return sourceText;
				},
				readSourceVersion: () => {
					if (unreadableVersion) throw new Error('source version read missed');
					return sourceVersion;
				},
				isDisposed: () => false, postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
			});
			const initial = projection.requestDocument('overlapping-owned-negative-initial');
			projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(initial).resolves.toBe(true);
			const generation = attempts[0].generation;
			await session.queuePersist(1, async () => {
				const first = projection.registerOwnedSourceEdit(generation, sourceText, 'A', sourceVersion)!;
				expect(first).toBeDefined();
				sourceText = 'A';
				sourceVersion++;
				expect(first.complete(sourceVersion)).toBe(true);
			});
			let replacement: Promise<boolean> | undefined;
			await session.queuePersist(2, async () => {
				if (mode === 'unregistered-write') {
					sourceText = 'B';
					sourceVersion++;
					return;
				}
				if (mode === 'external-between-writes' || mode === 'same-text-external-version') {
					if (mode === 'external-between-writes') sourceText = 'external E';
					sourceVersion++;
					expect(projection.registerOwnedSourceEdit(generation, sourceText, 'B', sourceVersion)).toBeUndefined();
					return;
				}
				const second = projection.registerOwnedSourceEdit(generation, sourceText, 'B', sourceVersion)!;
				expect(second).toBeDefined();
				expect(second.previousText).toBe('original');
				if (mode === 'rejected-write') {
					second.cancel();
					return;
				}
				if (mode === 'source-replacement') {
					sourceText = 'external E';
					sourceVersion++;
					replacement = projection.requestSourceReload();
					expect(second.complete(sourceVersion)).toBe(false);
					return;
				}
				sourceText = 'B';
				sourceVersion += mode === 'wrong-write-version' ? 2 : 1;
				unreadableSource = mode === 'source-read-miss';
				unreadableVersion = mode === 'version-read-miss';
				expect(second.complete(sourceVersion)).toBe(!['wrong-write-version', 'source-read-miss', 'version-read-miss'].includes(mode));
				unreadableSource = false;
				unreadableVersion = false;
				if (mode === 'persist-replacement') session.retirePersists();
				if (mode === 'post-commit-source-drift') sourceText = 'external E';
				if (mode === 'post-commit-source-drift' || mode === 'post-commit-version-drift') sourceVersion++;
			});
			await expect(projection.adoptOwnedSourceText(generation, 'original', sourceText)).resolves.toBe(false);
			if (replacement) {
				projection.completeReload({ requestId: attempts[1].reloadRequestId, applied: false, editRevision: 0 });
				await expect(replacement).resolves.toBe(false);
			}
			await expect(projection.waitForCurrentProjection()).resolves.toBe(false);
			if (mode === 'external-between-writes' || mode === 'source-replacement' || mode === 'post-commit-source-drift') {
				expect(sourceText).toBe('external E');
			}
		},
	);

	it.each(['late-complete', 'late-cancel', 'concurrent-registration'] as const)(
		'keeps the current owned write registered through %s', async mode => {
			let sourceText = 'original';
			let sourceVersion = 1;
			const session = new CompatSidecarSession(true, 'SQL');
			const attempts: RecordedProjectionAttempt[] = [];
			const projection = new CompatSidecarProjectionCoordinator({
				session, readSourceText: () => sourceText, readSourceVersion: () => sourceVersion, isDisposed: () => false,
				postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
			});
			const initial = projection.requestDocument('overlapping-owned-late-initial');
			projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(initial).resolves.toBe(true);
			const generation = attempts[0].generation;
			const first = projection.registerOwnedSourceEdit(generation, sourceText, 'A', sourceVersion)!;
			sourceText = 'A';
			sourceVersion++;
			expect(first.complete(sourceVersion)).toBe(true);
			await session.queuePersist(2, async () => {
				const second = projection.registerOwnedSourceEdit(generation, sourceText, 'B', sourceVersion)!;
				expect(second.previousText).toBe('original');
				if (mode === 'late-complete') expect(first.complete(sourceVersion)).toBe(false);
				if (mode === 'late-cancel') first.cancel();
				if (mode === 'concurrent-registration') {
					expect(projection.registerOwnedSourceEdit(generation, sourceText, 'C', sourceVersion)).toBeUndefined();
				}
				sourceText = 'B';
				sourceVersion++;
				expect(second.complete(sourceVersion)).toBe(true);
				await expect(projection.adoptOwnedSourceText(generation, 'original', 'B')).resolves.toBe(true);
			});
			expect(projection.activeSourceGeneration).toBe(generation);
			expect(attempts).toHaveLength(1);
			await expect(projection.waitForCurrentProjection()).resolves.toBe(true);
		},
	);

	it.each(['applied', 'stale-owner', 'uncommitted', 'wrong-revision', 'unregistered', 'version-drift', 'disposed'] as const)(
		'binds a metadata-only source handoff to the exact committed owner: %s', async mode => {
			let sourceText = 'original';
			let sourceVersion = 1;
			let disposed = false;
			const session = new CompatSidecarSession(true, 'SQL');
			const attempts: RecordedProjectionAttempt[] = [];
			const projection = new CompatSidecarProjectionCoordinator({
				session, readSourceText: () => sourceText, readSourceVersion: () => sourceVersion, isDisposed: () => disposed,
				postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
			});
			const initial = projection.requestDocument('metadata-only-handoff-initial');
			projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(initial).resolves.toBe(true);
			const generation = attempts[0].generation;
			let registration: ReturnType<CompatSidecarProjectionCoordinator['registerOwnedSourceEdit']>;
			await session.queuePersist(1, async () => {
				session.adoptRevision(1);
				registration = projection.registerOwnedSourceEdit(generation, sourceText, 'A', sourceVersion)!;
				sourceText = 'A';
				sourceVersion++;
				expect(registration.complete(sourceVersion)).toBe(true);
			});
			await session.queuePersist(2, async () => {
				session.adoptRevision(2);
				if (mode !== 'uncommitted') session.setStateRevision(2);
				if (mode === 'unregistered') registration!.cancel();
				if (mode === 'version-drift') sourceVersion++;
				if (mode === 'disposed') disposed = true;
				await expect(projection.adoptOwnedSourceText(generation, 'original', 'A', {
					persistGeneration: mode === 'stale-owner' ? session.generation - 1 : session.generation,
					editRevision: mode === 'wrong-revision' ? 1 : 2,
				})).resolves.toBe(mode === 'applied');
			});
			expect(sourceText).toBe('A');
			expect(attempts).toHaveLength(1);
			await expect(projection.waitForCurrentProjection()).resolves.toBe(mode === 'applied');
		},
	);

	it.each(['KQL', 'SQL'] as const)('retains the actual owned receipt when a delayed metadata B adoption is overtaken by C for %s', async languageLabel => {
		let sourceText = 'original';
		let sourceVersion = 1;
		let writeCount = 0;
		let releaseFirstWrite!: () => void;
		let releaseSecondAdoption!: () => void;
		const firstWrite = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
		const secondAdoption = new Promise<void>(resolve => { releaseSecondAdoption = resolve; });
		let secondAdoptionPending = false;
		const session = new CompatSidecarSession(true, languageLabel);
		const attempts: RecordedProjectionAttempt[] = [];
		const projection = new CompatSidecarProjectionCoordinator({
			session, readSourceText: () => sourceText, readSourceVersion: () => sourceVersion, isDisposed: () => false,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});
		const initial = projection.requestDocument('late-metadata-handoff-initial');
		projection.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
		await expect(initial).resolves.toBe(true);
		const adoptOwnedSourceText = projection.adoptOwnedSourceText.bind(projection);
		const adoption = vi.spyOn(projection, 'adoptOwnedSourceText').mockImplementation(async (...args) => {
			if (args[3]?.editRevision === 2) {
				secondAdoptionPending = true;
				await secondAdoption;
			}
			return adoptOwnedSourceText(...args);
		});
		const context: Record<string, unknown> = {
			projectionCoordinator: projection, sidecarSession: session, outerDisposed: false,
			ownedSourceCommit: undefined, lastKnownSidecarState: undefined,
			document: {
				uri: 'late-metadata-handoff', getText: () => sourceText, eol: 1, get version() { return sourceVersion; },
				get lineCount() { return sourceText.split('\n').length; },
				lineAt: (line: number) => ({ text: sourceText.split('\n')[line] ?? '' }),
			},
			vscode: { EndOfLine: { LF: 1, CRLF: 2 }, WorkspaceEdit: class { replace(): void {} }, Range: class {} },
			applyOwnedSourceEdit: async (_edit: unknown, text: string) => {
				sourceText = text;
				sourceVersion++;
				writeCount++;
				await firstWrite;
				return true;
			},
		};
		const callbacks = providerPersistCallbacks(
			languageLabel === 'KQL' ? 'kqlCompatEditorProvider.ts' : 'sqlCompatEditorProvider.ts', context,
		);
		const acknowledgements: unknown[] = [];
		context.persistCoordinator = new CompatSidecarPersistCoordinator({
			session, projection, languageLabel, getLoadError: () => undefined,
			allowMissingSourceGeneration: false, allowTestOnlyNoop: false, isLive: () => true,
			postMessage: message => { acknowledgements.push(message); return true; }, warnUnavailable: vi.fn(),
			adapter: {
				captureState: state => state as KqlxStateV1, validateState: vi.fn(),
				sanitizeState: async state => state, prepareMaterializedDraft: () => undefined,
				materializeState: async () => undefined, serializeMaterialized: JSON.stringify,
				getLastWrittenMaterializedText: () => undefined,
				getPrimaryText: state => (state.sections[0] as { query: string }).query,
				readSourceText: () => sourceText, applySourceText: callbacks.applySourceText, requestSourceReload: vi.fn(),
				setKnownState: callbacks.setKnownState, setMaterializedSidecar: vi.fn(),
				publishChanges: vi.fn(), notifyPreparationFailure: vi.fn(),
			},
		});
		const query = languageLabel === 'KQL' ? 'print Value=2\n' : 'SELECT 2 AS Value;\n';
		const persist = (editRevision: number): Promise<void> => callbacks.persist({
			protocolVersion: 1, channel: 'compatibility-persistence', viewSessionId: 'late-metadata-handoff-session',
			type: 'persistDocument', snapshotId: `late-metadata-${editRevision}`, editRevision, sourceGeneration: attempts[0].generation,
			state: { sections: [{ id: languageLabel === 'KQL' ? 'compat_primary_query' : 'compat_primary_sql',
				type: languageLabel === 'KQL' ? 'query' : 'sql', query, nodeMetadata: { revision: editRevision } }] },
		});
		try {
			const firstPersist = persist(1);
			await waitFor(() => writeCount === 1);
			const firstGeneration = session.generation;
			const secondPersist = persist(2);
			await waitFor(() => session.generation > firstGeneration);
			releaseFirstWrite();
			await waitFor(() => secondAdoptionPending);
			expect(context.ownedSourceCommit).toBeDefined();
			await persist(3);
			await expect(projection.waitForCurrentProjection()).resolves.toBe(true);
			releaseSecondAdoption();
			await Promise.all([firstPersist, secondPersist]);
			expect(writeCount).toBe(1);
			expect(sourceVersion).toBe(2);
			expect(session.currentStateEditRevision).toBe(3);
			expect((context.lastKnownSidecarState as KqlxStateV1).sections[0]).toMatchObject({ query, nodeMetadata: { revision: 3 } });
			expect(acknowledgements).toEqual([
				{ type: 'persistDocumentAck', snapshotId: 'late-metadata-2', editRevision: 2 },
				{ type: 'persistDocumentAck', snapshotId: 'late-metadata-3', editRevision: 3 },
			]);
			expect(adoption.mock.settledResults.map(result => result.value)).toEqual([false, true]);
			expect(projection.activeSourceGeneration).toBe(attempts[0].generation);
			expect(attempts).toHaveLength(1);
			await expect(projection.waitForCurrentProjection()).resolves.toBe(true);
		} finally {
			releaseFirstWrite();
			releaseSecondAdoption();
		}
	});

	it.each(['KQL', 'SQL'] as const)('leaves native verification and unreadable-source recovery with the persist owner for %s', async languageLabel => {
		const session = new CompatSidecarSession(true, languageLabel);
		const projection = new CompatSidecarProjectionCoordinator({
			session, readSourceText: () => 'original', isDisposed: () => false, postProjection: async () => false,
		});
		const adoption = vi.spyOn(projection, 'adoptOwnedSourceText');
		let applied = false;
		const context: Record<string, unknown> = {
			projectionCoordinator: projection, sidecarSession: session, outerDisposed: false,
			ownedSourceCommit: undefined, lastKnownSidecarState: undefined,
			document: {
				uri: 'unreadable-owned-source', version: 1, eol: 1, lineCount: 1,
				lineAt: () => ({ text: 'original' }),
				getText: () => {
					if (applied) throw new Error('native source unreadable after application');
					return 'original';
				},
			},
			vscode: { EndOfLine: { LF: 1, CRLF: 2 }, WorkspaceEdit: class { replace(): void {} }, Range: class {} },
			applyOwnedSourceEdit: async () => { applied = true; return true; },
		};
		const callbacks = providerPersistCallbacks(
			languageLabel === 'KQL' ? 'kqlCompatEditorProvider.ts' : 'sqlCompatEditorProvider.ts', context,
		);
		await expect(callbacks.applySourceText('edited')).resolves.toBe(true);
		expect(applied).toBe(true);
		expect(adoption).not.toHaveBeenCalled();
	});

	it.each(['stale-generation', 'wrong-previous', 'wrong-next', 'source-drift', 'eol-drift',
		'disposed', 'read-failure', 'pending-successor', 'rejected-successor', 'rollback-failure'] as const)(
		'rejects an owned source receipt after %s', async mode => {
			const session = new CompatSidecarSession(true, 'SQL');
			const attempts: RecordedProjectionAttempt[] = [];
			let sourceText = 'original\r\n';
			let disposed = false;
			let readFailure = false;
			const coordinator = new CompatSidecarProjectionCoordinator({
				session, readSourceText: () => {
					if (readFailure) throw new Error('source unavailable');
					return sourceText;
				},
				isDisposed: () => disposed, postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
			});
			const initial = coordinator.project({ retirePersists: true });
			coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(initial).resolves.toBe(true);
			let successor: Promise<boolean> | undefined;
			if (mode === 'pending-successor' || mode === 'rejected-successor') {
				successor = coordinator.project();
				if (mode === 'rejected-successor') {
					coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: false, editRevision: 0 });
					await expect(successor).resolves.toBe(false);
				}
			}
			sourceText = mode === 'source-drift' ? 'external' : mode === 'eol-drift' ? 'edited\n' : 'edited\r\n';
			if (mode === 'disposed') disposed = true;
			if (mode === 'read-failure') readFailure = true;
			if (mode === 'rollback-failure') {
				await expect(coordinator.rollbackSupersededSourceEdit(0, sourceText, async () => false)).resolves.toBe(false);
			}
			await expect(coordinator.adoptOwnedSourceText(
				mode === 'stale-generation' ? 0 : attempts[0].generation,
				mode === 'wrong-previous' ? 'another baseline' : 'original\r\n',
				mode === 'wrong-next' ? 'another commit' : 'edited\r\n',
			)).resolves.toBe(false);
			await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
			if (mode === 'pending-successor') {
				expect(coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: true, editRevision: 0 })).toBe(false);
				await expect(successor).resolves.toBe(false);
			}
		},
	);

	it('admits the established generation-zero baseline before the first projection', () => {
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async () => true,
		});

		expect(coordinator.activeSourceGeneration).toBe(0);
		expect(coordinator.admitPersist({
			sourceGeneration: 0,
			editRevision: 1,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(true);
		expect(coordinator.admitPersist({
			sourceGeneration: undefined,
			editRevision: 1,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(false);
	});

	it('keeps projection B authoritative after a late A acknowledgement and newer A persist', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		const attempts: RecordedProjectionAttempt[] = [];
		let sourceText = 'A';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const projectionA = coordinator.project({ forceReload: true, retirePersists: true });
		await waitFor(() => attempts.length === 1);
		const attemptA = attempts[0];

		sourceText = 'B';
		const projectionB = coordinator.project({ forceReload: true, retirePersists: true });
		await waitFor(() => attempts.length === 2);
		const attemptB = attempts[1];

		expect(coordinator.completeReload({
			requestId: attemptA.reloadRequestId,
			applied: true,
			editRevision: 50,
		})).toBe(false);
		expect(await projectionA).toBe(false);
		expect(session.currentEditRevision).toBe(0);
		expect(coordinator.admitPersist({
			sourceGeneration: attemptA.generation,
			editRevision: 51,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(false);

		expect(coordinator.completeReload({
			requestId: attemptB.reloadRequestId,
			applied: true,
			editRevision: 2,
		})).toBe(true);
		expect(await projectionB).toBe(true);
		expect(coordinator.activeSourceGeneration).toBe(attemptB.generation);
		expect(session.currentEditRevision).toBe(2);
	});

	it('settles owner candidates false for a superseded projection and true only for its accepted successor', async () => {
		const attempts: RecordedProjectionAttempt[] = [];
		const settled: Array<{ generation: number; applied: boolean }> = [];
		let sourceText = 'A';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			onProjectionSettled: (attempt, applied) => {
				settled.push({ generation: attempt.generation, applied });
			},
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const projectionA = coordinator.project();
		await waitFor(() => attempts.length === 1);
		sourceText = 'B';
		const projectionB = coordinator.project();
		await waitFor(() => attempts.length === 2);
		coordinator.completeReload({
			requestId: attempts[1].reloadRequestId, applied: true, editRevision: 1,
		});

		expect(await projectionA).toBe(false);
		expect(await projectionB).toBe(true);
		expect(settled).toEqual([
			{ generation: attempts[0].generation, applied: false },
			{ generation: attempts[1].generation, applied: true },
		]);
	});

	it('rejects activation when owner compare-and-commit conflicts', async () => {
		let attempt: RecordedProjectionAttempt | undefined;
		const settled: boolean[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => 'source',
			isDisposed: () => false,
			onProjectionSettled: (_attempt, applied) => {
				settled.push(applied);
				return applied ? false : true;
			},
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project();
		await waitFor(() => !!attempt);
		coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 1 });

		expect(await projection).toBe(false);
		expect(coordinator.activeSourceGeneration).toBe(0);
		expect(settled).toEqual([true]);
		expect(coordinator.admitPersist({
			sourceGeneration: 0, editRevision: 1,
			requireCurrentGeneration: true, allowMissingSourceGeneration: false,
		})).toBe(true);
	});

	it('does not commit owner state when source changes during awaited settlement', async () => {
		let sourceText = 'A';
		let attempt: RecordedProjectionAttempt | undefined;
		let markSettlementStarted!: () => void;
		let releaseSettlement!: () => void;
		const settlementStarted = new Promise<void>(resolve => { markSettlementStarted = resolve; });
		const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve; });
		let ownerCommits = 0;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			onProjectionSettled: async (candidate, applied) => {
				if (!applied) return true;
				markSettlementStarted();
				await settlementGate;
				if (!candidate.isCurrent()) return false;
				ownerCommits++;
				return candidate.commitActivation();
			},
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project();
		await waitFor(() => !!attempt);
		coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 1 });
		await settlementStarted;
		sourceText = 'B';
		releaseSettlement();

		expect(await projection).toBe(false);
		expect(ownerCommits).toBe(0);
		expect(coordinator.activeSourceGeneration).toBe(0);
	});

	it('waits for acknowledged projection authority before persistence admission', async () => {
		let attempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project();
		await waitFor(() => !!attempt);
		expect(coordinator.completeReload({
			requestId: attempt!.reloadRequestId,
			applied: true,
			editRevision: 2,
		})).toBe(true);
		await coordinator.waitForAcknowledgedProjection(attempt!.generation);

		expect(coordinator.activeSourceGeneration).toBe(attempt!.generation);
		expect(await projection).toBe(true);
	});

	describe('current projection readiness', () => {
		beforeEach(() => { vi.useFakeTimers(); });
		afterEach(() => { vi.useRealTimers(); });

		it.each(['before-activation', 'after-activation'] as const)(
			'waits for the full owner settlement held %s after the current ACK', async phase => {
				const attempts: RecordedProjectionAttempt[] = [];
				const ownerStarted = Promise.withResolvers<void>();
				const ownerCommit = Promise.withResolvers<void>();
				const coordinator = new CompatSidecarProjectionCoordinator({
					session: new CompatSidecarSession(true, 'KQL'),
					readSourceText: () => '',
					isDisposed: () => false,
					postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
					onProjectionSettled: async (attempt, applied) => {
						if (!applied) return true;
						if (phase === 'after-activation') expect(attempt.commitActivation()).toBe(true);
						ownerStarted.resolve();
						await ownerCommit.promise;
						return attempt.commitActivation();
					},
				});
				const projection = coordinator.project();
				const observed = vi.fn();
				const readiness = coordinator.waitForCurrentProjection().then(result => {
					observed(result);
					return result;
				});
				await vi.advanceTimersByTimeAsync(1);
				expect(observed).not.toHaveBeenCalled();
				expect(coordinator.completeReload({
					requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0,
				})).toBe(true);
				await ownerStarted.promise;
				await vi.advanceTimersByTimeAsync(250);
				expect(observed).not.toHaveBeenCalled();
				expect(coordinator.activeSourceGeneration).toBe(phase === 'after-activation' ? 1 : 0);
				ownerCommit.resolve();
				await expect(projection).resolves.toBe(true);
				await expect(readiness).resolves.toBe(true);
				expect(coordinator.isInitialized).toBe(false);
				await expect(coordinator.waitForCurrentProjection()).resolves.toBe(true);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it.each(['', ' \t\r\n '])('accepts the stable byte-exact blank source %j without initialization or auth', async sourceText => {
			const attempts: RecordedProjectionAttempt[] = [];
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => sourceText,
				isDisposed: () => false, postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
			});
			const projection = coordinator.project();
			coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(projection).resolves.toBe(true);
			expect(coordinator.isInitialized).toBe(false);
			await expect(coordinator.waitForCurrentProjection()).resolves.toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('rejects a generation-zero baseline with no projection candidate', async () => {
			const postProjection = vi.fn(async () => true);
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => '',
				isDisposed: () => false, postProjection,
			});
			await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
			expect(postProjection).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each(['accepted-B', 'expired-B'] as const)(
			'joins only the current same-source successor within the original allowance: %s', async mode => {
				const attempts: RecordedProjectionAttempt[] = [];
				const physicalA = Promise.withResolvers<boolean>();
				const physicalB = Promise.withResolvers<boolean>();
				const settledA = vi.fn();
				const settledB = vi.fn();
				const coordinator = new CompatSidecarProjectionCoordinator({
					session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'same source',
					isDisposed: () => false,
					postProjection: async attempt => {
						recordProjectionAttempt(attempt, attempts);
						return attempt.generation === 1 ? physicalA.promise : physicalB.promise;
					},
				});
				const projectionA = coordinator.project();
				void projectionA.then(settledA);
				coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
				const observed = vi.fn();
				const readiness = coordinator.waitForCurrentProjection().then(result => {
					observed(result);
					return result;
				});
				await vi.advanceTimersByTimeAsync(29_000);
				expect(observed).not.toHaveBeenCalled();
				const projectionB = coordinator.project();
				void projectionB.then(settledB);
				coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: true, editRevision: 0 });
				if (mode === 'accepted-B') {
					physicalB.resolve(true);
					await expect(projectionB).resolves.toBe(true);
					await vi.advanceTimersByTimeAsync(250);
					await expect(readiness).resolves.toBe(true);
				} else {
					await vi.advanceTimersByTimeAsync(999);
					expect(observed).not.toHaveBeenCalled();
					await vi.advanceTimersByTimeAsync(1);
					await expect(readiness).resolves.toBe(false);
					expect(settledB).not.toHaveBeenCalled();
					physicalB.resolve(true);
					await expect(projectionB).resolves.toBe(true);
				}
				expect(settledA).not.toHaveBeenCalled();
				expect(coordinator.activeSourceGeneration).toBe(attempts[1].generation);
				expect(attempts).toHaveLength(2);
				physicalA.resolve(true);
				await expect(projectionA).resolves.toBe(false);
				await expect(coordinator.waitForCurrentProjection()).resolves.toBe(true);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it.each(['rejected', 'missing'] as const)('settles a %s ACK without releasing a stalled physical post', async mode => {
			const attempts: RecordedProjectionAttempt[] = [];
			const physical = Promise.withResolvers<boolean>();
			const physicalSettled = vi.fn();
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'source',
				isDisposed: () => false,
				postProjection: async attempt => {
					recordProjectionAttempt(attempt, attempts);
					return physical.promise;
				},
			});
			const projection = coordinator.project();
			void projection.then(physicalSettled);
			const observed = vi.fn();
			const readiness = coordinator.waitForCurrentProjection().then(result => {
				observed(result);
				return result;
			});
			if (mode === 'rejected') {
				coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: false, editRevision: 0 });
				await vi.advanceTimersByTimeAsync(250);
			} else {
				await vi.advanceTimersByTimeAsync(4_999);
				expect(observed).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
			}
			await expect(readiness).resolves.toBe(false);
			expect(physicalSettled).not.toHaveBeenCalled();
			physical.resolve(true);
			await expect(projection).resolves.toBe(false);
			await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each(['resolved', 'rejected'] as const)('expires at exactly 30 seconds while the physical post remains pending and later %s', async mode => {
			const attempts: RecordedProjectionAttempt[] = [];
			const physical = Promise.withResolvers<boolean>();
			const physicalFollower = vi.fn();
			const projectionSettled = vi.fn();
			void physical.promise.then(physicalFollower, physicalFollower);
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'KQL'), readSourceText: () => 'source',
				isDisposed: () => false,
				postProjection: async attempt => {
					recordProjectionAttempt(attempt, attempts);
					return physical.promise;
				},
			});
			const projection = coordinator.project();
			const observedProjection = projection.then(projectionSettled, projectionSettled);
			coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			const observed = vi.fn();
			const readiness = coordinator.waitForCurrentProjection().then(result => {
				observed(result);
				return result;
			});
			await vi.advanceTimersByTimeAsync(29_999);
			expect(observed).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(readiness).resolves.toBe(false);
			expect(projectionSettled).not.toHaveBeenCalled();
			expect(physicalFollower).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			if (mode === 'resolved') {
				physical.resolve(true);
				await expect(projection).resolves.toBe(true);
				await expect(coordinator.waitForCurrentProjection()).resolves.toBe(true);
			} else {
				const error = new Error('late physical rejection');
				physical.reject(error);
				await expect(projection).rejects.toBe(error);
				await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
			}
			await observedProjection;
			expect(projectionSettled).toHaveBeenCalledOnce();
			expect(physicalFollower).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		});

		it('settles disposal immediately without releasing a held physical post', async () => {
			const attempts: RecordedProjectionAttempt[] = [];
			const physical = Promise.withResolvers<boolean>();
			const disposal = Promise.withResolvers<void>();
			const physicalSettled = vi.fn();
			let disposed = false;
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'source',
				isDisposed: () => disposed, disposalSignal: disposal.promise,
				postProjection: async attempt => {
					recordProjectionAttempt(attempt, attempts);
					return physical.promise;
				},
			});
			const projection = coordinator.project();
			void projection.then(physicalSettled);
			coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			const readiness = coordinator.waitForCurrentProjection();
			disposed = true;
			disposal.resolve();
			await expect(readiness).resolves.toBe(false);
			expect(physicalSettled).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			physical.resolve(true);
			await expect(projection).resolves.toBe(false);
			expect(coordinator.activeSourceGeneration).toBe(0);
		});

		it.each(['source-drift', 'read-failure', 'invalid-source', 'rollback-failure'] as const)(
			'rejects settled readiness on %s', async mode => {
				const attempts: RecordedProjectionAttempt[] = [];
				let sourceText = 'line 1\r\nline 2';
				let readFailure = false;
				let invalidSource = false;
				const coordinator = new CompatSidecarProjectionCoordinator({
					session: new CompatSidecarSession(true, 'KQL'),
					readSourceText: () => {
						if (readFailure) throw new Error('source unavailable');
						return invalidSource ? undefined as unknown as string : sourceText;
					},
					isDisposed: () => false, postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
				});
				const admissionEpoch = coordinator.captureSourceReloadEpoch();
				const projection = coordinator.project({ retirePersists: true });
				coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
				await expect(projection).resolves.toBe(true);
				if (mode === 'source-drift') sourceText = 'line 1\nline 2';
				if (mode === 'read-failure') readFailure = true;
				if (mode === 'invalid-source') invalidSource = true;
				if (mode === 'rollback-failure') {
					await expect(coordinator.rollbackSupersededSourceEdit(admissionEpoch, sourceText, async () => false)).resolves.toBe(false);
					expect(coordinator.sourceRollbackFailed).toBe(true);
				}
				await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it.each(['no-reload', 'post-rejection', 'owner-rejection', 'owner-failure-after-activation'] as const)(
			'never reports a failed full settlement ready: %s', async mode => {
				const attempts: RecordedProjectionAttempt[] = [];
				const coordinator = new CompatSidecarProjectionCoordinator({
					session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'source',
					isDisposed: () => false,
					postProjection: async attempt => {
						if (mode === 'no-reload') return true;
						recordProjectionAttempt(attempt, attempts);
						if (mode === 'post-rejection') throw new Error('post rejected');
						return true;
					},
					onProjectionSettled: (attempt, applied) => {
						if (!applied) return true;
						if (mode === 'owner-rejection') throw new Error('owner rejected');
						expect(attempt.commitActivation()).toBe(true);
						return false;
					},
				});
				const projection = coordinator.project().catch(() => false);
				const readiness = coordinator.waitForCurrentProjection();
				if (mode === 'owner-rejection' || mode === 'owner-failure-after-activation') {
					coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
				}
				await expect(projection).resolves.toBe(false);
				await expect(readiness).resolves.toBe(false);
				await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it('observes same-source N+1 immediately without advancing the active generation', async () => {
			const attempts: RecordedProjectionAttempt[] = [];
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'same source',
				isDisposed: () => false, postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
			});
			const initial = coordinator.project();
			coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(initial).resolves.toBe(true);
			expect(coordinator.currentProjectionGeneration).toBe(1);
			expect(coordinator.activeSourceGeneration).toBe(1);
			const successor = coordinator.project();
			expect(coordinator.currentProjectionGeneration).toBe(2);
			expect(coordinator.activeSourceGeneration).toBe(1);
			coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: false, editRevision: 0 });
			await expect(successor).resolves.toBe(false);
			await expect(coordinator.waitForCurrentProjection()).resolves.toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('waits for an obsolete physical delivery after local supersession and admits only current C', async () => {
			const physicalB = Promise.withResolvers<boolean>();
			const attempts: RecordedProjectionAttempt[] = [];
			const sdkCalls: Array<{ type: string; generation?: number }> = [];
			let receive: ((message: unknown) => unknown) | undefined;
			const panel = {
				webview: {
					onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
						receive = handler;
						return { dispose() {} };
					},
					postMessage: async (input: unknown) => {
						const message = input as { type: string; generation?: number };
						sdkCalls.push(message);
						return message.generation === 2 ? physicalB.promise : true;
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as unknown as vscode.WebviewPanel;
			const gateway = new MainWebviewStartupGateway({ panel, admitInbound: message => message });
			await receive!({ type: 'mainWebviewDispatcherReady', runtimeId: 'serialized-runtime' });
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'same', isDisposed: () => false,
				postProjection: async attempt => {
					recordProjectionAttempt(attempt, attempts);
					return gateway.postMessage({ type: 'changedSections', changes: [], generation: attempt.generation });
				},
			});
			try {
				const initial = coordinator.project();
				coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
				await expect(initial).resolves.toBe(true);
				const obsolete = coordinator.project({ expectedEditRevision: 0 });
				const obsoleteSettled = vi.fn();
				void obsolete.then(obsoleteSettled);
				await vi.advanceTimersByTimeAsync(0);
				expect(sdkCalls.map(message => message.generation)).toEqual([1, 2]);
				expect(coordinator.admitPersist({ sourceGeneration: 1, editRevision: 1,
					requireCurrentGeneration: true, allowMissingSourceGeneration: false })).toBe(true);
				expect(coordinator.currentProjectionGeneration).toBe(3);
				const survivingObserved = vi.fn();
				const survivingReadiness = coordinator.waitForCurrentProjection().then(value => {
					survivingObserved(value);
					return value;
				});
				const queuedSnapshot = survivingReadiness.then(ready => ready
					? gateway.postMessage({ type: 'requestToolState', requestId: 'serialized-snapshot' }) : false);
				expect(coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: true, editRevision: 99 })).toBe(false);
				await vi.advanceTimersByTimeAsync(250);
				expect(obsoleteSettled).not.toHaveBeenCalled();
				expect(survivingObserved).not.toHaveBeenCalled();
				expect(sdkCalls).toHaveLength(2);
				physicalB.resolve(true);
				await expect(obsolete).resolves.toBe(false);
				await expect(survivingReadiness).resolves.toBe(true);
				await expect(queuedSnapshot).resolves.toBe(true);
				expect(coordinator.activeSourceGeneration).toBe(1);
				const current = coordinator.project();
				const observed = vi.fn();
				const readiness = coordinator.waitForCurrentProjection().then(value => { observed(value); return value; });
				expect(coordinator.currentProjectionGeneration).toBe(4);
				expect(coordinator.activeSourceGeneration).toBe(1);
				await vi.advanceTimersByTimeAsync(250);
				expect(observed).not.toHaveBeenCalled();
				expect(sdkCalls.map(message => [message.type, message.generation])).toEqual([
					['changedSections', 1], ['changedSections', 2], ['requestToolState', undefined], ['changedSections', 4],
				]);
				expect(observed).not.toHaveBeenCalled();
				expect(coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: true, editRevision: 99 })).toBe(false);
				expect(coordinator.completeReload({ requestId: attempts[2].reloadRequestId, applied: true, editRevision: 1 })).toBe(true);
				await expect(current).resolves.toBe(true);
				await expect(readiness).resolves.toBe(true);
				await vi.advanceTimersByTimeAsync(0);
				expect([...((coordinator as unknown as { projectionSettlements: Map<number, Promise<boolean>> }).projectionSettlements).keys()]).toEqual([4]);
			} finally {
				physicalB.resolve(false);
				gateway.dispose();
			}
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each(['timeout', 'disposal'] as const)('bounds surviving-owner readiness on %s without settling obsolete physical work', async mode => {
			const attempts: RecordedProjectionAttempt[] = [];
			const physical = Promise.withResolvers<boolean>();
			const disposal = Promise.withResolvers<void>();
			const physicalSettled = vi.fn();
			let disposed = false;
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => 'same',
				isDisposed: () => disposed, disposalSignal: disposal.promise,
				postProjection: async attempt => {
					recordProjectionAttempt(attempt, attempts);
					return attempt.generation === 2 ? physical.promise : true;
				},
			});
			const initial = coordinator.project();
			coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
			await expect(initial).resolves.toBe(true);
			const obsolete = coordinator.project({ expectedEditRevision: 0 });
			void obsolete.then(physicalSettled);
			expect(coordinator.admitPersist({ sourceGeneration: 1, editRevision: 1,
				requireCurrentGeneration: true, allowMissingSourceGeneration: false })).toBe(true);
			const observed = vi.fn();
			const readiness = coordinator.waitForCurrentProjection().then(value => { observed(value); return value; });
			if (mode === 'timeout') {
				await vi.advanceTimersByTimeAsync(29_999);
				expect(observed).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
			} else {
				disposed = true;
				disposal.resolve();
			}
			await expect(readiness).resolves.toBe(false);
			expect(physicalSettled).not.toHaveBeenCalled();
			expect(coordinator.currentProjectionGeneration).toBe(3);
			expect(coordinator.activeSourceGeneration).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
			physical.resolve(true);
			await expect(obsolete).resolves.toBe(false);
			expect(coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: true, editRevision: 99 })).toBe(false);
			await expect(coordinator.waitForCurrentProjection()).resolves.toBe(mode === 'timeout');
			expect(observed).toHaveBeenCalledExactlyOnceWith(false);
			expect(vi.getTimerCount()).toBe(0);
		});

		for (const fileName of ['kqlCompatEditorProvider.ts', 'sqlCompatEditorProvider.ts']) {
			it(`${fileName} shares one allowance across construction and the actual projection join`, async () => {
				const construction = Promise.withResolvers<CompatSidecarProjectionCoordinatorContract | undefined>();
				const disposal = Promise.withResolvers<void>();
				const waitForReady = createCompatSidecarProjectionReadiness(construction.promise, disposal.promise, () => false);
				const observed = vi.fn();
				const readiness = waitForReady().then(result => {
					observed(result);
					return result;
				});
				await vi.advanceTimersByTimeAsync(20_000);
				expect(observed).not.toHaveBeenCalled();
				const attempts: RecordedProjectionAttempt[] = [];
				const physical = Promise.withResolvers<boolean>();
				const physicalSettled = vi.fn();
				const coordinator = new CompatSidecarProjectionCoordinator({
					session: new CompatSidecarSession(true, fileName.startsWith('kql') ? 'KQL' : 'SQL'), readSourceText: () => '',
					isDisposed: () => false, disposalSignal: disposal.promise,
					postProjection: async attempt => {
						recordProjectionAttempt(attempt, attempts);
						return physical.promise;
					},
				});
				const join = vi.spyOn(coordinator, 'waitForCurrentProjection');
				const projection = coordinator.project();
				void projection.then(physicalSettled);
				coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
				construction.resolve(coordinator);
				await vi.advanceTimersByTimeAsync(0);
				expect(join).toHaveBeenCalledExactlyOnceWith(10_000);
				await vi.advanceTimersByTimeAsync(9_999);
				expect(observed).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				await expect(readiness).resolves.toBe(false);
				expect(physicalSettled).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
				physical.resolve(true);
				await expect(projection).resolves.toBe(true);
			});

			it.each(['timeout', 'initialization-failure', 'disposal'] as const)(
				`${fileName} settles %s during construction and clears its local timer`, async mode => {
					const construction = Promise.withResolvers<CompatSidecarProjectionCoordinatorContract | undefined>();
					const disposal = Promise.withResolvers<void>();
					const waitForReady = createCompatSidecarProjectionReadiness(construction.promise, disposal.promise, () => false);
					const observed = vi.fn();
					const readiness = waitForReady().then(result => {
						observed(result);
						return result;
					});
					if (mode === 'timeout') {
						await vi.advanceTimersByTimeAsync(29_999);
						expect(observed).not.toHaveBeenCalled();
						await vi.advanceTimersByTimeAsync(1);
					} else if (mode === 'initialization-failure') {
						construction.resolve(undefined);
					} else {
						disposal.resolve();
					}
					await expect(readiness).resolves.toBe(false);
					expect(vi.getTimerCount()).toBe(0);
				},
			);
		}

		it('reuses one callback and one outer disposal subscription across readiness calls', async () => {
			const construction = Promise.withResolvers<CompatSidecarProjectionCoordinatorContract | undefined>();
			const disposal = Promise.withResolvers<void>();
			const subscribe = vi.spyOn(disposal.promise, 'then');
			const waitForReady = createCompatSidecarProjectionReadiness(construction.promise, disposal.promise, () => false);
			expect(subscribe).toHaveBeenCalledOnce();
			const first = waitForReady();
			const second = waitForReady();
			expect(subscribe).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(2);
			disposal.resolve();
			await expect(first).resolves.toBe(false);
			await expect(second).resolves.toBe(false);
			await expect(waitForReady()).resolves.toBe(false);
			expect(subscribe).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each(['before-call', 'after-construction'] as const)(
			'rechecks live disposal %s without joining the coordinator', async phase => {
				const construction = Promise.withResolvers<CompatSidecarProjectionCoordinatorContract | undefined>();
				const disposal = Promise.withResolvers<void>();
				let disposed = phase === 'before-call';
				const coordinator = new CompatSidecarProjectionCoordinator({
					session: new CompatSidecarSession(true, 'SQL'), readSourceText: () => '',
					isDisposed: () => disposed, postProjection: async () => true,
				});
				const join = vi.spyOn(coordinator, 'waitForCurrentProjection');
				const waitForReady = createCompatSidecarProjectionReadiness(construction.promise, disposal.promise, () => disposed);
				const readiness = waitForReady();
				if (phase === 'after-construction') {
					expect(vi.getTimerCount()).toBe(1);
					construction.resolve(coordinator);
					disposed = true;
				}
				await expect(readiness).resolves.toBe(false);
				expect(join).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			},
		);
	});

	it('settles no-reservation and thrown projections exactly once', async () => {
		for (const mode of ['no-reservation', 'throw'] as const) {
			const settled: boolean[] = [];
			const coordinator = new CompatSidecarProjectionCoordinator({
				session: new CompatSidecarSession(true, 'KQL'),
				readSourceText: () => 'source',
				isDisposed: () => false,
				onProjectionSettled: (_attempt, applied) => { settled.push(applied); },
				postProjection: async () => {
					if (mode === 'throw') throw new Error('projection failed');
					return true;
				},
			});

			if (mode === 'throw') await expect(coordinator.project()).rejects.toThrow('projection failed');
			else await expect(coordinator.project()).resolves.toBe(false);
			expect(settled).toEqual([false]);
		}
	});

	it('settles timeout and disposal terminals exactly once', async () => {
		for (const mode of ['timeout', 'disposal'] as const) {
			const session = new CompatSidecarSession(true, 'KQL');
			const reload = Promise.withResolvers<boolean>();
			vi.spyOn(session, 'createReloadRequest').mockReturnValueOnce({
				requestId: `${mode}-reload`, result: reload.promise,
			});
			let disposed = false;
			let attempt: CompatSidecarProjectionAttempt | undefined;
			const settled: boolean[] = [];
			const coordinator = new CompatSidecarProjectionCoordinator({
				session,
				readSourceText: () => 'source',
				isDisposed: () => disposed,
				onProjectionSettled: (_attempt, applied) => { settled.push(applied); },
				postProjection: async value => {
					attempt = value;
					return !!value.reserveReload();
				},
			});

			const projection = coordinator.project();
			await waitFor(() => !!attempt);
			if (mode === 'disposal') disposed = true;
			reload.resolve(false);
			expect(await projection).toBe(false);
			expect(settled).toEqual([false]);
		}
	});

	it('recovers after a current request reload fails without letting superseded A demote B', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const attempts: RecordedProjectionAttempt[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			initialProjectionMaxAttempts: 2,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const initial = coordinator.requestDocument('initial');
		await waitFor(() => attempts.length === 1);
		coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 0 });
		expect(await initial).toBe(true);

		const failed = coordinator.requestDocument('failed-current');
		await waitFor(() => attempts.length === 2);
		coordinator.completeReload({ requestId: attempts[1].reloadRequestId, applied: false, editRevision: 0 });
		expect(await failed).toBe(false);
		expect(coordinator.isInitialized).toBe(false);

		const recovery = coordinator.requestDocument('recovery');
		await waitFor(() => attempts.length === 3);
		coordinator.completeReload({ requestId: attempts[2].reloadRequestId, applied: false, editRevision: 0 });
		await waitFor(() => attempts.length === 4);
		coordinator.completeReload({ requestId: attempts[3].reloadRequestId, applied: true, editRevision: 1 });
		expect(await recovery).toBe(true);
		expect(coordinator.isInitialized).toBe(true);

		const requestA = coordinator.requestDocument('A');
		await waitFor(() => attempts.length === 5);
		const requestB = coordinator.requestDocument('B');
		await waitFor(() => attempts.length === 6);
		coordinator.completeReload({ requestId: attempts[5].reloadRequestId, applied: true, editRevision: 2 });
		expect(await requestB).toBe(true);
		expect(await requestA).toBe(false);
		expect(coordinator.isInitialized).toBe(true);
	});

	it('gives a fresh correlated runtime request one bounded retry after exhausted startup', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const attempts: RecordedProjectionAttempt[] = [];
		let available = false;
		const postProjection = vi.fn(async (attempt: CompatSidecarProjectionAttempt) =>
			available ? recordProjectionAttempt(attempt, attempts) : false);
		const coordinator = new CompatSidecarProjectionCoordinator({
			session, readSourceText: () => 'SELECT 1', isDisposed: () => false,
			initialProjectionMaxAttempts: 2, postProjection,
		});
		await expect(coordinator.requestDocument('bootstrap-request')).resolves.toBe(false);
		expect(postProjection).toHaveBeenCalledTimes(2);
		await expect(coordinator.requestDocument('bootstrap-request')).resolves.toBe(false);
		await expect(coordinator.ensureInitialProjection('automatic-repeat')).resolves.toBe(false);
		expect(postProjection).toHaveBeenCalledTimes(2);
		available = true;
		const recovered = coordinator.requestDocument('dispatcher-document-probe_2');
		await waitFor(() => attempts.length === 1);
		expect(attempts[0].requestId).toBe('dispatcher-document-probe_2');
		expect(coordinator.isInitialized).toBe(false);
		expect(coordinator.completeReload({ requestId: 'retired-projection', applied: true, editRevision: 99 })).toBe(false);
		expect(coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 1 })).toBe(true);
		await expect(recovered).resolves.toBe(true);
		expect(coordinator.isInitialized).toBe(true);
		expect(coordinator.activeSourceGeneration).toBeGreaterThan(2);
		expect(session.currentEditRevision).toBe(1);
	});

	it('does not repeat an exhausted runtime recovery for the same correlation', async () => {
		const postProjection = vi.fn(async () => false);
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'), readSourceText: () => 'print Value=1',
			isDisposed: () => false, initialProjectionMaxAttempts: 2, postProjection,
		});
		await expect(coordinator.requestDocument('bootstrap-request')).resolves.toBe(false);
		await expect(coordinator.requestDocument('dispatcher-document-probe_2')).resolves.toBe(false);
		expect(postProjection).toHaveBeenCalledTimes(4);
		await expect(coordinator.requestDocument('dispatcher-document-probe_2')).resolves.toBe(false);
		await expect(coordinator.ensureInitialProjection('automatic-repeat')).resolves.toBe(false);
		expect(postProjection).toHaveBeenCalledTimes(4);
	});

	it('allows a newer local edit to supersede only a pending same-source projection', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const attempts: RecordedProjectionAttempt[] = [];
		let sourceText = 'same';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async attempt => recordProjectionAttempt(attempt, attempts),
		});

		const initial = coordinator.project({ forceReload: true, retirePersists: true });
		await waitFor(() => attempts.length === 1);
		coordinator.completeReload({ requestId: attempts[0].reloadRequestId, applied: true, editRevision: 1 });
		expect(await initial).toBe(true);

		const pending = coordinator.project({ forceReload: true, expectedEditRevision: 2 });
		await waitFor(() => attempts.length === 2);
		expect(coordinator.admitPersist({
			sourceGeneration: attempts[0].generation,
			editRevision: 3,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(true);
		expect(await pending).toBe(false);
		let knownState: KqlxStateV1 | undefined;
		const persist = new CompatSidecarPersistCoordinator({
			session, projection: coordinator, languageLabel: 'SQL', getLoadError: () => undefined,
			allowMissingSourceGeneration: false, allowTestOnlyNoop: false, isLive: () => true,
			postMessage: () => true, warnUnavailable: vi.fn(),
			adapter: {
				captureState: state => state as KqlxStateV1, validateState: vi.fn(), sanitizeState: async state => state,
				prepareMaterializedDraft: () => undefined, materializeState: async () => undefined,
				serializeMaterialized: JSON.stringify, getLastWrittenMaterializedText: () => undefined,
				getPrimaryText: state => (state.sections[0] as { query: string }).query, readSourceText: () => sourceText,
				applySourceText: async text => { sourceText = text; return true; }, requestSourceReload: vi.fn(),
				setKnownState: state => { knownState = state; }, setMaterializedSidecar: vi.fn(),
				publishChanges: vi.fn(), notifyPreparationFailure: vi.fn(),
			},
		});
		await expect(persist.persist({
			protocolVersion: 1, channel: 'compatibility-persistence', viewSessionId: 'superseding-session',
			type: 'persistDocument', snapshotId: 'superseding-edit', sourceGeneration: attempts[0].generation, editRevision: 3,
			state: { sections: [{ id: 'compat_primary_sql', type: 'sql', query: 'same', name: 'current authored metadata' }] },
		})).resolves.toMatchObject({ terminal: 'applied' });
		expect(session.currentStateEditRevision).toBe(3);
		expect(knownState?.sections[0].name).toBe('current authored metadata');
		expect(coordinator.currentProjectionGeneration).toBe(3);
		expect(coordinator.activeSourceGeneration).toBe(attempts[0].generation);
		await expect(coordinator.waitForCurrentProjection()).resolves.toBe(true);

		sourceText = 'different';
		const external = coordinator.project({ forceReload: true, expectedEditRevision: 3, retirePersists: true });
		await waitFor(() => attempts.length === 3);
		expect(coordinator.admitPersist({
			sourceGeneration: attempts[0].generation,
			editRevision: 4,
			requireCurrentGeneration: true,
			allowMissingSourceGeneration: false,
		})).toBe(false);
		coordinator.completeReload({ requestId: attempts[2].reloadRequestId, applied: true, editRevision: 3 });
		expect(await external).toBe(true);
	});

	it('keeps projection currentness byte-exact while rollback remains EOL-normalized', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let sourceText = 'line 1\r\nline 2';
		let attempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const projection = coordinator.project({ forceReload: true });
		await waitFor(() => !!attempt);
		sourceText = 'line 1\nline 2';
		expect(coordinator.completeReload({
			requestId: attempt!.reloadRequestId,
			applied: true,
			editRevision: 1,
		})).toBe(false);
		expect(await projection).toBe(false);
	});

	it('starts the reload deadline only after projection preparation completes', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const createReloadRequest = vi.spyOn(session, 'createReloadRequest');
		const preparation = Promise.withResolvers<void>();
		let reloadRequestId = '';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async attempt => {
				await preparation.promise;
				reloadRequestId = attempt.reserveReload() ?? '';
				return !!reloadRequestId;
			},
		});

		const projection = coordinator.project({ forceReload: true });
		await Promise.resolve();
		expect(createReloadRequest).not.toHaveBeenCalled();
		preparation.resolve();
		await waitFor(() => !!reloadRequestId);
		expect(createReloadRequest).toHaveBeenCalledOnce();
		coordinator.completeReload({ requestId: reloadRequestId, applied: true, editRevision: 1 });
		expect(await projection).toBe(true);
	});

	it.each(['before', 'after'] as const)('cleans reload admission when projection preparation throws %s reservation', async phase => {
		const session = new CompatSidecarSession(true, 'KQL');
		let shouldThrow = true;
		let successfulAttempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async attempt => {
				if (shouldThrow && phase === 'before') throw new Error('preparation failed');
				const reloadRequestId = attempt.reserveReload();
				if (!reloadRequestId) return false;
				if (shouldThrow) throw new Error('transport preparation failed');
				successfulAttempt = { ...attempt, reloadRequestId };
				return true;
			},
		});

		await expect(coordinator.project()).rejects.toThrow(
			phase === 'before' ? 'preparation failed' : 'transport preparation failed',
		);
		shouldThrow = false;
		const recovery = coordinator.project();
		await waitFor(() => !!successfulAttempt);
		expect(session.hasPendingReloadRequest(successfulAttempt!.reloadRequestId)).toBe(true);
		coordinator.completeReload({ requestId: successfulAttempt!.reloadRequestId, applied: true, editRevision: 1 });
		expect(await recovery).toBe(true);
	});

	it('treats timeout and duplicate acknowledgements as non-current terminals', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const firstReload = Promise.withResolvers<boolean>();
		vi.spyOn(session, 'createReloadRequest').mockReturnValueOnce({
			requestId: 'timed-out-reload',
			result: firstReload.promise,
		});
		let attempt: RecordedProjectionAttempt | undefined;
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => false,
			postProjection: async value => {
				const reloadRequestId = value.reserveReload();
				if (!reloadRequestId) return false;
				attempt = { ...value, reloadRequestId };
				return true;
			},
		});

		const timedOut = coordinator.project();
		await waitFor(() => !!attempt);
		firstReload.resolve(false);
		expect(await timedOut).toBe(false);

		attempt = undefined;
		const current = coordinator.project();
		await waitFor(() => !!attempt);
		expect(coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 2 })).toBe(true);
		expect(coordinator.completeReload({ requestId: attempt!.reloadRequestId, applied: true, editRevision: 99 })).toBe(false);
		expect(await current).toBe(true);
		expect(session.currentEditRevision).toBe(2);
	});

	it('retires a waiter when disposal lands after reservation', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let disposed = false;
		let reloadRequestId = '';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => 'source',
			isDisposed: () => disposed,
			postProjection: async attempt => {
				reloadRequestId = attempt.reserveReload() ?? '';
				disposed = true;
				return true;
			},
		});

		expect(await coordinator.project()).toBe(false);
		expect(reloadRequestId).not.toBe('');
		expect(session.hasPendingReloadRequest(reloadRequestId)).toBe(false);
		expect(coordinator.completeReload({ requestId: reloadRequestId, applied: true, editRevision: 1 })).toBe(false);
	});

	it('bounds initial recovery per source and resets only after source changes', async () => {
		const session = new CompatSidecarSession(true, 'KQL');
		let sourceText = 'A';
		let attempts = 0;
		const firstAttempt = Promise.withResolvers<void>();
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			initialProjectionMaxAttempts: 2,
			postProjection: async () => {
				attempts++;
				if (attempts === 1) await firstAttempt.promise;
				return false;
			},
		});

		const first = coordinator.ensureInitialProjection('initial-request');
		await waitFor(() => attempts === 1);
		const sameSource = coordinator.ensureInitialProjection('same-source-request');
		sourceText = 'B';
		const changedSource = coordinator.ensureInitialProjection('changed-source-request');
		firstAttempt.resolve();
		expect(await first).toBe(false);
		expect(await sameSource).toBe(false);
		expect(await changedSource).toBe(false);
		await waitFor(() => attempts === 3);

		expect(await coordinator.ensureInitialProjection('duplicate-B')).toBe(false);
		expect(attempts).toBe(3);

		sourceText = 'C';
		expect(await coordinator.ensureInitialProjection('changed-to-C')).toBe(false);
		expect(attempts).toBe(5);
		expect(coordinator.isInitialized).toBe(false);
	});

	it('leaves unseen C eligible when A changes to B and then C during the follow-up', async () => {
		const gates = {
			A: Promise.withResolvers<void>(),
			B: Promise.withResolvers<void>(),
		};
		let sourceText = 'A';
		const attemptedSources: string[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			initialProjectionMaxAttempts: 1,
			postProjection: async attempt => {
				attemptedSources.push(attempt.sourceText);
				if (attempt.sourceText === 'A') await gates.A.promise;
				if (attempt.sourceText === 'B') await gates.B.promise;
				return false;
			},
		});

		const initial = coordinator.ensureInitialProjection('A-request');
		await waitFor(() => attemptedSources.includes('A'));
		sourceText = 'B';
		const coalesced = coordinator.ensureInitialProjection('B-request');
		gates.A.resolve();
		await initial;
		await coalesced;
		await waitFor(() => attemptedSources.includes('B'));
		sourceText = 'C';
		const cCoalesced = coordinator.ensureInitialProjection('C-coalesced');
		gates.B.resolve();
		await cCoalesced;

		await coordinator.ensureInitialProjection('C-explicit');
		expect(attemptedSources).toEqual(['A', 'B', 'C']);
		expect(await coordinator.ensureInitialProjection('C-duplicate')).toBe(false);
		expect(attemptedSources).toEqual(['A', 'B', 'C']);
	});

	it('treats CRLF and LF as distinct initial recovery bytes', async () => {
		let sourceText = 'line 1\r\nline 2';
		const attemptedSources: string[] = [];
		const coordinator = new CompatSidecarProjectionCoordinator({
			session: new CompatSidecarSession(true, 'KQL'),
			readSourceText: () => sourceText,
			isDisposed: () => false,
			initialProjectionMaxAttempts: 1,
			postProjection: async attempt => {
				attemptedSources.push(attempt.sourceText);
				return false;
			},
		});

		await coordinator.ensureInitialProjection('crlf');
		expect(await coordinator.ensureInitialProjection('crlf-duplicate')).toBe(false);
		sourceText = 'line 1\nline 2';
		await coordinator.ensureInitialProjection('lf');

		expect(attemptedSources).toEqual(['line 1\r\nline 2', 'line 1\nline 2']);
	});

	it('owns source rollback retries and keeps terminal failure fenced until source authority changes', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		let sourceText = 'A';
		const coordinator = new CompatSidecarProjectionCoordinator({
			session,
			readSourceText: () => sourceText,
			isDisposed: () => false,
			postProjection: async () => false,
		});
		const admissionEpoch = coordinator.captureSourceReloadEpoch();
		sourceText = 'B';
		await coordinator.project({ forceReload: true, retirePersists: true });
		sourceText = 'STALE';
		const restore = vi.fn(async () => false);

		await coordinator.rollbackSupersededSourceEdit(admissionEpoch, 'STALE', restore);
		expect(restore).toHaveBeenCalledTimes(3);
		expect(restore).toHaveBeenCalledWith('B');
		expect(coordinator.sourceRollbackFailed).toBe(true);

		await coordinator.project({ forceReload: true, retirePersists: true });
		expect(coordinator.sourceRollbackFailed).toBe(true);
		sourceText = 'C';
		await coordinator.project({ forceReload: true, retirePersists: true });
		expect(coordinator.sourceRollbackFailed).toBe(false);
	});

	it('keeps duplicated projection authority out of both compatibility providers', () => {
		for (const fileName of ['kqlCompatEditorProvider.ts', 'sqlCompatEditorProvider.ts']) {
			const source = fs.readFileSync(path.join(process.cwd(), 'src', 'host', fileName), 'utf8');
			expect(source).toContain('projectionCoordinatorFactory');
			expect(source).toContain('\tcreateCompatSidecarProjectionReadiness,');
			const readinessOffset = source.indexOf('queryEditor.setWorkbenchToolMutationReadiness(');
			const snapshotOffset = source.indexOf('queryEditor.setWorkbenchToolSnapshotIdentity(');
			const initializeOffset = source.indexOf('queryEditor.initializeWebviewPanel(');
			expect(readinessOffset).toBeGreaterThan(0);
			expect(snapshotOffset).toBeGreaterThan(0);
			expect(initializeOffset).toBeGreaterThan(0);
			expect(readinessOffset).toBeLessThan(initializeOffset);
			expect(snapshotOffset).toBeLessThan(initializeOffset);
			expect(source).toContain('projectionCoordinator?.currentProjectionGeneration');
			expect(source).toContain('projectionCoordinator.completeReload');
			expect(source).not.toContain('projectionCoordinator.admitPersist');
			const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			const readinessFactories: ts.CallExpression[] = [];
			const checkGenerationReference = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
					&& node.expression.getText(sourceFile) === 'queryEditor.setWorkbenchToolMutationReadiness') {
					expect(node.arguments).toHaveLength(1);
					const factory = node.arguments[0];
					expect(ts.isCallExpression(factory)).toBe(true);
					if (ts.isCallExpression(factory)) {
						readinessFactories.push(factory);
						expect(factory.expression.getText(sourceFile)).toBe('createCompatSidecarProjectionReadiness');
						expect(factory.arguments.map(argument => argument.getText(sourceFile))).toEqual([
							'projectionConstruction', 'outerDisposalSignal', '() => outerDisposed',
						]);
					}
				}
				if (ts.isIdentifier(node) && node.text === 'activeSourceGeneration') {
					const access = node.parent;
					const ownerRead = ts.isPropertyAccessExpression(access) && access.name === node
						&& ts.isIdentifier(access.expression) && access.expression.text === 'projectionCoordinator';
					const expression = access.parent;
					const assignment = ts.isBinaryExpression(expression) && expression.left === access
						&& expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
						&& expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
					const update = (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression))
						&& (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken);
					expect(ownerRead && !assignment && !update, 'generation references must only read the canonical coordinator').toBe(true);
				}
				ts.forEachChild(node, checkGenerationReference);
			};
			checkGenerationReference(sourceFile);
			expect(readinessFactories).toHaveLength(1);
			for (const displaced of [
				'postDocumentGeneration',
				'pendingSourceGeneration',
				'pendingProjectionEditRevision',
				'initialProjectionRecovery',
				'initialProjectionRestartRequested',
				'sourceReloadAuthority',
				'sourceRollbackFailedCandidate',
			]) {
				expect(source).not.toContain(displaced);
			}
		}
		const persistCoordinator = fs.readFileSync(path.join(
			process.cwd(), 'src', 'host', 'compatSidecarPersistCoordinator.ts',
		), 'utf8');
		expect(persistCoordinator).toContain('projection.admitPersist');
	});
});
