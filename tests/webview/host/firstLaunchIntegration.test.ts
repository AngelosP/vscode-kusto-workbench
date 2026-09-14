import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
	createKqlxOrMdxFileWithDefaultSection, parseKqlxText, stringifyKqlxFile,
} from '../../../src/host/kqlxFormat';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	activationEvents: string[];
	scripts: { package: string };
	dependencies: Record<string, string>;
	contributes: {
		commands: Array<{ command: string }>;
		configuration: { properties: Record<string, { scope?: string }> };
	};
};
const extensionSource = readFileSync(join(root, 'src', 'host', 'extension.ts'), 'utf8');
const remoteSource = readFileSync(join(root, 'src', 'host', 'remoteFileOpener.ts'), 'utf8');
const queryToolbarSource = readFileSync(join(root, 'src', 'webview', 'sections', 'kw-query-toolbar.ts'), 'utf8');
const testHelpersSource = readFileSync(join(root, 'src', 'webview', 'core', 'test-helpers.ts'), 'utf8');
const esbuildSource = readFileSync(join(root, 'esbuild.js'), 'utf8');
const sizeReportSource = readFileSync(join(root, 'scripts', 'bundle-size.mjs'), 'utf8');
const sizeGateSource = readFileSync(join(root, 'scripts', 'bundle-size-gate.mjs'), 'utf8');

const extensionGatedCommands = [
	'kusto.openQueryEditor',
	'kusto.openTutorials',
	'kusto.manageConnections',
	'kusto.deleteAllConnections',
	'kusto.openKqlxFile',
	'kusto.openMdxFile',
	'kusto.saveKqlxAs',
	'kusto.seeCachedValues',
	'kusto.showDevelopmentNotes',
	'kusto.resetCopilotModelSelection',
	'kusto.openCustomAgent',
	'kusto.exportSkill',
];

describe('first-launch integration inventory', () => {
	it('activates for every supported cold-open language and extension URI', () => {
		for (const event of ['onLanguage:kql', 'onLanguage:kqlx', 'onLanguage:sqlx', 'onLanguage:sql', 'onLanguage:markdown', 'onUri']) {
			expect(packageJson.activationEvents).toContain(event);
		}
	});

	it('activates identity fixture setup before opening an editor', () => {
		for (const command of [
			'cleanupKustoIdentityChecklist',
			'prepareKustoIdentitySelectionBaseline',
			'seedKustoIdentityChecklist',
		]) {
			expect(packageJson.activationEvents).toContain(`onCommand:kustoWorkbench.test.${command}`);
		}
	});

	it('settles identity cleanup and structure before assigning fixture principals', () => {
		const cleanup = extensionSource.slice(
			extensionSource.indexOf('const cleanupIdentityChecklistState'),
			extensionSource.indexOf('context.subscriptions.push(', extensionSource.indexOf('const cleanupIdentityChecklistState')),
		);
		const removeConnection = cleanup.indexOf('await connectionManager.removeConnection(connection.id)');
		const removePreference = cleanup.indexOf('await testAuthPreferences.removeConnection(connection.id)');
		expect(removeConnection).toBeGreaterThanOrEqual(0);
		expect(removePreference).toBeGreaterThanOrEqual(0);
		expect(removeConnection).toBeLessThan(removePreference);

		const seed = extensionSource.slice(
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.seedKustoIdentityChecklist'"),
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.assertClipboardContains'"),
		);
		const addConnection = seed.indexOf('await connectionManager.addConnection(');
		const addLeaveNoTrace = seed.indexOf('await connectionManager.addLeaveNoTrace(');
		const setExplicitAccount = seed.indexOf('testAuthPreferences.setExplicitAccounts(');
		const persistFavorites = seed.indexOf('await context.globalState.update(STORAGE_KEYS.favorites, favorites)');
		const setTokenOverride = seed.indexOf('await testAuthPreferences.setTokenOverride(');
		const setDatabases = seed.indexOf('await testConnectionCache.setDatabases(');
		const setClipboardSentinel = seed.indexOf('await vscode.env.clipboard.writeText(identityClipboardSentinel)');
		for (const marker of [addConnection, addLeaveNoTrace, setExplicitAccount, persistFavorites, setTokenOverride, setDatabases, setClipboardSentinel]) {
			expect(marker).toBeGreaterThanOrEqual(0);
		}
		expect(addConnection).toBeLessThan(addLeaveNoTrace);
		expect(addLeaveNoTrace).toBeLessThan(setExplicitAccount);
		expect(seed).toContain('added.map(connection => connection.id)');
		expect(setExplicitAccount).toBeLessThan(persistFavorites);
		expect(persistFavorites).toBeLessThan(setTokenOverride);
		expect(setTokenOverride).toBeLessThan(setDatabases);
		expect(seed).toContain('if (!schemaWritten)');
		expect(extensionSource).toContain('Clipboard assertion requires non-empty text.');
		expect(extensionSource).toContain('selection.lastConnectionIdPresent');
		expect(extensionSource).toContain('selection.lastDatabasePresent');
		expect(extensionSource).toContain('identityChecklistPreviousSelection = captureIdentitySelection();');
		expect(extensionSource).toContain("registerCommand('kustoWorkbench.test.assertAndCleanupKustoIdentitySelectionBaseline'");
		expect(extensionSource).toContain('if (previousSelection) await restoreIdentitySelection(previousSelection)');
		const baseline = extensionSource.slice(
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.prepareKustoIdentitySelectionBaseline'"),
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.assertAndCleanupKustoIdentitySelectionBaseline'"),
		);
		expect(baseline.indexOf('await supplementalStartupCleanup'))
			.toBeLessThan(baseline.indexOf('await cleanupIdentityChecklistState()'));
		expect(baseline.indexOf('await cleanupIdentityChecklistState()'))
			.toBeLessThan(baseline.indexOf('identitySelectionBaselinePreviousSelection = captureIdentitySelection()'));
		expect(extensionSource).toContain("rawSchemaJson: {");
		expect(extensionSource).toContain('setExplicitAccounts(');
		expect(testHelpersSource).toContain('admitKustoPublicationHostMessage(event.data)');
		expect(testHelpersSource).toContain("message.payload.policyRequestId === policyRequestId");
		expect(testHelpersSource).toContain("message.type !== 'kustoPublicationCommit'");
		expect(testHelpersSource).toContain("const shortConnection = { ...regional, clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey }");
		expect(testHelpersSource).toContain('shortSectionClusterUrl: shortConfigured.clusterUrl');
	});

	it('keeps the text-diagnostics seed selected after deferred supplemental startup cleanup', async () => {
		const deferred = () => {
			let resolve!: () => void;
			const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise; });
			return { promise, resolve };
		};
		const cleanupWriteStarted = deferred();
		const releaseCleanup = deferred();
		const startupAwaited = deferred();
		const storageKeys = {
			lastConnectionId: 'kusto.lastConnectionId',
			lastDatabase: 'kusto.lastDatabase',
			cachedDatabases: 'kusto.cachedDatabases',
		};
		const previousSelectionKey = 'kusto.test.supplementalPreviousSelection';
		const state = new Map<string, unknown>([
			[storageKeys.lastConnectionId, 'user-connection'],
			[storageKeys.lastDatabase, 'UserDb'],
			[storageKeys.cachedDatabases, {}],
			['kusto.fileConnectionCache', {}],
		]);
		type FixtureConnection = { id: string; name: string; clusterUrl: string; database: string; authorityId: string };
		type SeedResult = { connectionId: string; clusterUrl: string; database: string };
		type SeedSchema = {
			connectionId: string;
			database: string;
			accountPartition: string;
			schema: { tables: string[]; columnTypesByTable: Record<string, Record<string, string>> };
		};
		const userConnection: FixtureConnection = {
			id: 'user-connection', name: 'User Connection', clusterUrl: 'https://user.kusto.windows.net',
			database: 'UserDb', authorityId: 'organizations',
		};
		const connections = new Map<string, FixtureConnection>([
			[userConnection.id, userConnection],
			['supplemental-connection', {
				id: 'supplemental-connection', name: 'E2E Supplemental Schema Interrupted',
				clusterUrl: 'https://supplemental-remote.westus.kusto.windows.net',
				database: 'TelemetryDb', authorityId: 'organizations',
			}],
		]);
		const preferences = new Map<string, { id: string; label: string }>();
		const databases = new Map<string, { accountPartition: string; databases: string[] }>();
		const schemas = new Map<string, SeedSchema>();
		const commands = new Map<string, () => Promise<SeedResult>>();
		const getConnections = vi.fn(() => [...connections.values()]);
		const warn = vi.fn();
		const schemaCacheKey = (clusterUrl: string, database: string, connectionId: string, accountPartition: string) =>
			JSON.stringify([clusterUrl, database, connectionId, accountPartition]);
		const seedCommandId = 'kustoWorkbench.test.seedKustoTextDiagnosticsState';
		const declarationNames = [
			'textDiagnosticsTestName', 'textDiagnosticsTestCluster', 'textDiagnosticsTestDatabase',
			'supplementalTestPrefix', 'supplementalCurrentCluster', 'supplementalRemoteCluster',
			'supplementalDatabase', 'supplementalPreviousSelectionKey', 'supplementalClusterKeys', 'testAuthAccount',
			'isSupplementalConnection', 'cleanupSupplementalSchemaDiagnosticsState',
			'hasSupplementalStartupResidue', 'supplementalStartupCleanup',
		];
		const declarations = new Map<string, string>();
		let seedRegistration: string | undefined;
		const sourceFile = ts.createSourceFile('extension.ts', extensionSource, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && declarationNames.includes(node.name.text)) {
				declarations.set(node.name.text, `const ${node.getText(sourceFile)};`);
			}
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
				&& node.expression.name.text === 'registerCommand'
				&& node.arguments[0] && ts.isStringLiteral(node.arguments[0])
				&& node.arguments[0].text === seedCommandId) {
				seedRegistration = node.getText(sourceFile);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		for (const name of declarationNames) expect(declarations.has(name), name).toBe(true);
		expect(seedRegistration).toBeDefined();
		const fixtureSource = ts.transpileModule(`
			${declarationNames.map(name => declarations.get(name)).join('\n')}
			((supplementalStartupCleanup) => {
				${seedRegistration};
			})(observeStartupCleanup(supplementalStartupCleanup));
			supplementalStartupCleanup;
		`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
		const startupCleanup = runInNewContext(fixtureSource, {
			STORAGE_KEYS: storageKeys,
			SCHEMA_CACHE_VERSION: 1,
			context: {
				globalStorageUri: 'fixture-storage',
				globalState: {
					keys: () => [...state.keys()],
					get: (key: string) => state.get(key),
					update: async (key: string, value: unknown) => {
						if (value === undefined) state.delete(key);
						else state.set(key, value);
						if (key === previousSelectionKey && value !== undefined) {
							cleanupWriteStarted.resolve();
							await releaseCleanup.promise;
						}
					},
				},
			},
			connectionManager: {
				getConnections,
				removeConnection: async (connectionId: string) => { connections.delete(connectionId); },
				addConnection: async (configuration: Omit<FixtureConnection, 'id' | 'authorityId'>) => {
					const connection = { ...configuration, id: 'seed-connection', authorityId: 'organizations' };
					connections.set(connection.id, connection);
					return connection;
				},
			},
			testAuthPreferences: {
				removeConnection: async (connectionId: string) => { preferences.delete(connectionId); },
				setExplicitAccount: async (connectionId: string, account: { id: string; label: string }) => {
					preferences.set(connectionId, account);
				},
				getAccountPartition: (authorityId: string, accountId: string) => `${authorityId}/${accountId}`,
			},
			testConnectionCache: {
				clearConnection: async (connectionId: string) => { databases.delete(connectionId); },
				setDatabases: async (connectionId: string, accountPartition: string, values: string[]) => {
					databases.set(connectionId, { accountPartition, databases: values });
				},
			},
			kustoClusterKey: (clusterUrl: string) => new URL(clusterUrl).hostname,
			schemaCacheKey,
			getSchemaCacheFileUri: (_storage: string, cacheKey: string) => cacheKey,
			writeCachedSchemaToDisk: async (_storage: string, cacheKey: string, schema: SeedSchema) => {
				schemas.set(cacheKey, schema);
				return true;
			},
			vscode: {
				commands: {
					registerCommand: (command: string, handler: () => Promise<SeedResult>) => { commands.set(command, handler); },
				},
				workspace: { fs: { delete: async (cacheKey: string) => { schemas.delete(cacheKey); } } },
			},
			getWorkbenchLogger: () => ({ warn }),
			observeStartupCleanup: (pending: Promise<unknown>): PromiseLike<unknown> => ({
				then(onfulfilled, onrejected) {
					startupAwaited.resolve();
					return pending.then(onfulfilled, onrejected);
				},
			}),
		}) as Promise<unknown>;
		await cleanupWriteStarted.promise;
		expect(state.get(previousSelectionKey)).toMatchObject({
			lastConnectionId: 'user-connection', lastConnectionIdPresent: true,
			lastDatabase: 'UserDb', lastDatabasePresent: true,
		});
		const readsBeforeSeed = getConnections.mock.calls.length;
		const seedPromise = commands.get(seedCommandId)!();
		let readsWhileCleanupHeld = 0;
		try {
			await Promise.race([seedPromise, startupAwaited.promise]);
			readsWhileCleanupHeld = getConnections.mock.calls.length - readsBeforeSeed;
		} finally {
			releaseCleanup.resolve();
			await Promise.all([startupCleanup, seedPromise]);
		}
		expect(warn).not.toHaveBeenCalled();
		expect(await startupCleanup).toEqual({ verified: true, restoredFilePinCount: 0, restoredCachedDatabaseCount: 0 });
		const seeded = await seedPromise;
		expect(seeded).toEqual({
			connectionId: 'seed-connection', clusterUrl: 'https://kw-diagnostics-seed.kusto.windows.net', database: 'SeedDb',
		});
		const accountPartition = 'organizations/kusto-workbench-test-account';
		const seedCacheKey = schemaCacheKey(seeded.clusterUrl, seeded.database, seeded.connectionId, accountPartition);
		const cachedDatabases = databases.get(seeded.connectionId);
		expect({
			lastConnectionId: state.get(storageKeys.lastConnectionId),
			lastDatabase: state.get(storageKeys.lastDatabase),
			authPartition: preferences.get(seeded.connectionId)?.id === 'kusto-workbench-test-account'
				&& cachedDatabases?.accountPartition === accountPartition,
			databases: cachedDatabases?.databases,
			schemaExists: schemas.has(seedCacheKey),
		}).toEqual({
			lastConnectionId: 'seed-connection', lastDatabase: 'SeedDb',
			authPartition: true, databases: ['SeedDb'], schemaExists: true,
		});
		expect(readsWhileCleanupHeld).toBe(0);
		expect(schemas.get(seedCacheKey)).toMatchObject({
			connectionId: seeded.connectionId, database: 'SeedDb', accountPartition,
			schema: { tables: ['KnownOnly'], columnTypesByTable: { KnownOnly: { Timestamp: 'datetime', Value: 'long' } } },
		});
		expect(connections.get(userConnection.id)).toEqual(userConnection);
		expect(connections.has('supplemental-connection')).toBe(false);
		expect(state.has(previousSelectionKey)).toBe(false);
	});

	it.each([
		['isolated reset', true, 'populated'],
		['isolated fresh session', true, 'missing'],
		['ordinary existing empty session', false, 'empty'],
		['ordinary missing session', false, 'missing'],
	] as const)('opens %s with canonical creation and locked writes before reveal', async (_scenario, isolated, initial) => {
		const sourceFile = ts.createSourceFile('extension.ts', extensionSource, ts.ScriptTarget.Latest, true);
		let callbackSource: string | undefined;
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
				&& node.expression.name.text === 'registerCommand'
				&& node.arguments[0] && ts.isStringLiteral(node.arguments[0])
				&& node.arguments[0].text === 'kusto.openQueryEditor') {
				callbackSource = node.arguments[1]?.getText(sourceFile);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		expect(callbackSource).toBeDefined();
		const savedSession = stringifyKqlxFile({
			kind: 'kqlx', version: 1, state: { sections: [{
				type: 'query', query: 'print Old=1', clusterUrl: 'https://old.kusto.windows.net',
				database: 'OldDb', resultJson: '{"rows":[[1]]}',
			}] },
		});
		let bytes = initial === 'missing' ? undefined : new TextEncoder().encode(initial === 'empty' ? '' : savedSession);
		const originalBytes = bytes?.slice();
		const sessionUri = join('fixture-storage', 'session.kqlx');
		const shouldWrite = isolated || initial === 'missing';
		let releaseWrite!: () => void;
		let markWriteStarted!: () => void;
		const writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
		const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
		const events: string[] = [];
		let locked = false;
		const createFresh = vi.fn(createKqlxOrMdxFileWithDefaultSection);
		const writeFile = vi.fn(async (uri: string, content: Uint8Array) => {
			expect(uri).toBe(sessionUri);
			expect(locked).toBe(true);
			markWriteStarted();
			await writeHeld;
			bytes = content.slice();
			events.push('write');
		});
		const reveal = vi.fn(async (uri: string) => {
			expect(uri).toBe(sessionUri);
			expect(locked).toBe(false);
			events.push('reveal');
		});
		const open = runInNewContext(ts.transpileModule(`(${callbackSource});`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText, {
			TextEncoder, stringifyKqlxFile, testIsolateKustoConnections: isolated,
			createKqlxOrMdxFileWithDefaultSection: createFresh,
			afterFirstLaunch: (handler: () => Promise<void>) => handler,
			context: { globalStorageUri: 'fixture-storage' },
			vscode: { Uri: { joinPath: join }, workspace: { fs: {
				createDirectory: vi.fn().mockResolvedValue(undefined), writeFile,
				stat: async (uri: string) => {
					expect(uri).toBe(sessionUri);
					expect(locked).toBe(true);
					if (bytes === undefined) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
					return { size: bytes.length };
				},
			} } },
			withKqlxDocumentWriteLock: async (uri: string, writer: () => Promise<void>) => {
				expect(uri).toBe(sessionUri);
				locked = true;
				events.push('lock');
				try { await writer(); } finally { locked = false; events.push('unlock'); }
			},
			revealOrOpenQueryEditorSession: reveal,
		}) as () => Promise<void>;
		const opening = open();
		try {
			await Promise.race([writeStarted, opening]);
			expect(bytes).toEqual(originalBytes);
			expect(writeFile).toHaveBeenCalledTimes(shouldWrite ? 1 : 0);
			expect(reveal).toHaveBeenCalledTimes(shouldWrite ? 0 : 1);
		} finally {
			releaseWrite();
			await opening;
		}
		expect(createFresh.mock.calls).toEqual(shouldWrite ? [['kqlx']] : []);
		expect(events).toEqual(shouldWrite ? ['lock', 'write', 'unlock', 'reveal'] : ['lock', 'unlock', 'reveal']);
		if (shouldWrite) {
			expect(bytes).toEqual(new TextEncoder().encode(stringifyKqlxFile(createKqlxOrMdxFileWithDefaultSection('kqlx'))));
			expect(parseKqlxText(new TextDecoder().decode(bytes))).toEqual({
				ok: true, file: { kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', expanded: true, query: '' }] } },
			});
		} else {
			expect(bytes).toEqual(originalBytes);
		}
	});

	it('declares file-opening choices as profile-only application settings', () => {
		for (const key of ['openKqlFiles', 'openCslFiles', 'openMdFiles', 'openSqlFiles']) {
			expect(packageJson.contributes.configuration.properties[`kustoWorkbench.${key}`]?.scope, key).toBe('application');
		}
	});

	it('declares editing defaults as application settings for cross-window propagation', () => {
		for (const key of ['autoTriggerAutocompleteEnabled', 'copilotInlineCompletionsEnabled', 'caretDocsEnabled']) {
			expect(packageJson.contributes.configuration.properties[`kustoWorkbench.editing.${key}`]?.scope, key).toBe('application');
		}
	});

	it('gates every contributed production command except the configure command', () => {
		const contributed = packageJson.contributes.commands.map(command => command.command);
		const expected = [...extensionGatedCommands, 'kusto.openRemoteFile', 'kusto.configureFirstLaunchSetup'].sort();
		expect(contributed.sort()).toEqual(expected);
		for (const command of extensionGatedCommands) {
			const registration = extensionSource.slice(extensionSource.indexOf(`registerCommand('${command}'`));
			expect(registration.slice(0, 180), command).toContain('afterFirstLaunch(');
		}
		expect(remoteSource).toMatch(/registerCommand\('kusto\.openRemoteFile', async \(\) => \{\s+await beforeOpen\(\);/);
		expect(extensionSource).toContain("registerCommand('kusto.configureFirstLaunchSetup', () => firstLaunchCoordinator.openConfiguration())");
	});

	it('validates remote URI input before consuming first use', () => {
		const uriHandler = remoteSource.slice(remoteSource.indexOf('async handleUri(uri: vscode.Uri)'));
		expect(uriHandler.indexOf('const validationError = validateRemoteUrl(fileUrl);')).toBeGreaterThan(-1);
		expect(uriHandler.indexOf('const validationError = validateRemoteUrl(fileUrl);'))
			.toBeLessThan(uriHandler.indexOf('await beforeOpen();'));
	});

	it('does not persist application editing toggles into notebook documents', () => {
		for (const functionName of [
			'toggleAutoTriggerAutocompleteEnabled',
			'toggleCopilotInlineCompletionsEnabled',
			'toggleCaretDocsEnabled',
		]) {
			const start = queryToolbarSource.indexOf(`export function ${functionName}`);
			const body = queryToolbarSource.slice(start, queryToolbarSource.indexOf('\n}', start) + 2);
			expect(body, functionName).not.toContain('schedulePersist()');
		}
	});

	it('awaits first-launch bootstrap and rethrows failure before other infrastructure starts', () => {
		const bootstrap = extensionSource.slice(extensionSource.indexOf('const firstLaunchCoordinator = new FirstLaunchCoordinator'));
		expect(bootstrap.indexOf('await firstLaunchCoordinator.initialize();')).toBeGreaterThan(-1);
		expect(bootstrap.indexOf('throw error;')).toBeGreaterThan(bootstrap.indexOf('await firstLaunchCoordinator.initialize();'));
		expect(bootstrap).toContain("process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH === '1'");
		expect(bootstrap.indexOf('const editorCursorStatusBar = new EditorCursorStatusBar();'))
			.toBeGreaterThan(bootstrap.indexOf('throw error;'));
	});

	it('drains accepted Kusto selection writes during extension deactivation', () => {
		expect(extensionSource).toMatch(/export async function deactivate\(\) \{\s+await ConnectionService\.waitForLastSelectionSettlement\(\);/);
	});

	it('registers the setup artifact in initial copy, watch copy, bundle, and both size tools', () => {
		const artifact = 'first-launch-setup.bundle.js';
		expect(esbuildSource.match(new RegExp(artifact.replaceAll('.', '\\.'), 'g'))?.length).toBeGreaterThanOrEqual(2);
		expect(esbuildSource.match(/first-launch-setup\.html/g)?.length).toBeGreaterThanOrEqual(4);
		expect(sizeReportSource).toContain(artifact);
		expect(sizeGateSource).toContain(artifact);
	});

	it('loads Markdown UMD globals before Monaco establishes AMD in the query editor', () => {
		const queryEditorTemplate = readFileSync(join(process.cwd(), 'src', 'webview', 'queryEditor.html'), 'utf8');
		expect(queryEditorTemplate.indexOf('<script src="{{markedUrl}}"></script>')).toBeGreaterThan(-1);
		expect(queryEditorTemplate.indexOf('<script src="{{purifyUrl}}"></script>'))
			.toBeGreaterThan(queryEditorTemplate.indexOf('<script src="{{markedUrl}}"></script>'));
		expect(queryEditorTemplate.indexOf('<script src="{{monacoLoaderUri}}"></script>'))
			.toBeGreaterThan(queryEditorTemplate.indexOf('<script src="{{purifyUrl}}"></script>'));
	});

	it('cleans production output and makes first-launch bundle failures fatal', () => {
		expect(packageJson.scripts.package).toContain("rmSync('dist'");
		const firstLaunchCatch = esbuildSource.slice(esbuildSource.indexOf("console.warn('[watch] failed to bundle first-launch setup" ) - 100);
		expect(firstLaunchCatch.slice(0, 180)).toContain('if (production)');
		expect(firstLaunchCatch.slice(0, 180)).toContain('throw e;');
		const assetCopyCatch = esbuildSource.slice(esbuildSource.indexOf("console.warn('[watch] failed to copy webview runtime assets") - 100);
		expect(assetCopyCatch.slice(0, 180)).toContain('if (production)');
		expect(assetCopyCatch.slice(0, 180)).toContain('throw e;');
		expect(esbuildSource).toContain("'webview/first-launch-setup.html'");
		expect(esbuildSource).toContain('Missing required production artifact');
		expect(packageJson.dependencies['proper-lockfile']).toBeTruthy();
	});
});