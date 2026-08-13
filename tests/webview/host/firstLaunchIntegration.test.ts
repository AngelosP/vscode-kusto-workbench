import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

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
		for (const command of ['cleanupKustoIdentityChecklist', 'seedKustoIdentityChecklist']) {
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
		const setExplicitAccount = seed.indexOf('testAuthPreferences.setExplicitAccount(');
		const setTokenOverride = seed.indexOf('await testAuthPreferences.setTokenOverride(');
		const setDatabases = seed.indexOf('await testConnectionCache.setDatabases(');
		const setClipboardSentinel = seed.indexOf('await vscode.env.clipboard.writeText(identityClipboardSentinel)');
		for (const marker of [addConnection, addLeaveNoTrace, setExplicitAccount, setTokenOverride, setDatabases, setClipboardSentinel]) {
			expect(marker).toBeGreaterThanOrEqual(0);
		}
		expect(addConnection).toBeLessThan(addLeaveNoTrace);
		expect(addLeaveNoTrace).toBeLessThan(setExplicitAccount);
		expect(seed).toContain('await Promise.all(added.map(connection =>');
		expect(setExplicitAccount).toBeLessThan(setTokenOverride);
		expect(setTokenOverride).toBeLessThan(setDatabases);
		expect(seed).toContain('if (!schemaWritten)');
		expect(extensionSource).toContain('Clipboard assertion requires non-empty text.');
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

	it('registers the setup artifact in initial copy, watch copy, bundle, and both size tools', () => {
		const artifact = 'first-launch-setup.bundle.js';
		expect(esbuildSource.match(new RegExp(artifact.replaceAll('.', '\\.'), 'g'))?.length).toBeGreaterThanOrEqual(2);
		expect(esbuildSource.match(/first-launch-setup\.html/g)?.length).toBeGreaterThanOrEqual(4);
		expect(sizeReportSource).toContain(artifact);
		expect(sizeGateSource).toContain(artifact);
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