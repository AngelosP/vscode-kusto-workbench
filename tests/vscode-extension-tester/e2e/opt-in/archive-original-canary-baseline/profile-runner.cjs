'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const SOURCE_ROOT = path.resolve(__dirname, '../../../../..');
const EXTENSION_ID = 'angelos-petropoulos.vscode-kusto-workbench';
const MAIN_SHA256 = '16e4a21e1580a9b4602a84b3d921a5c429bdf3df40359011c5089591fb4a3059';
const PROFILE_PREFIX = 'KW-Wave4-Starting-State-Isolated-';
const PHASE_TIMEOUT_MS = 180000;
const PROFILE_SLOT = '__archiveOriginalProfileConfig';
const connectionRecord = Object.freeze({
	id: 'conn_1765825441854_gi5ey0lar',
	name: 'Wave4 isolated starting state',
	clusterUrl: 'https://ddtelinsights.kusto.windows.net',
	database: 'DDTelInsights',
});
const SETTINGS = Object.freeze({
	'files.autoSave': 'afterDelay',
	'files.autoSaveDelay': 1000,
	'files.hotExit': 'off',
	'workbench.editor.enablePreview': false,
	'workbench.startupEditor': 'none',
	'window.restoreWindows': 'none',
	'kustoWorkbench.externalTools.enabled': false,
});
const DIRECTORY_NAMES = Object.freeze({
	userDataDir: 'user-data', extensionsDir: 'extensions', sharedDataDir: 'shared-data',
	workspaceDir: 'workspace', evidenceDir: 'profile-evidence',
});
const hash = value => createHash('sha256').update(value).digest('hex');
const samePath = (left, right) => {
	const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
	return typeof left === 'string' && typeof right === 'string' && normalize(left) === normalize(right);
};
const within = (parent, child) => {
	const relative = path.relative(parent, child);
	return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

function quoteArgumentValue(value, platform = process.platform) {
	assert.ok(typeof value === 'string' && value.length > 0 && !/[%&|<>^!\r\n"\x00]/.test(value), 'Unsafe CLI argument value');
	return platform === 'win32' ? '"' + value + '"' : value;
}

function assertCanonicalPath(target, file = false) {
	assert.ok(typeof target === 'string' && path.isAbsolute(target) && target === path.resolve(target), 'Canonical absolute path required');
	const stat = fs.lstatSync(target);
	assert.ok(!stat.isSymbolicLink() && (file ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()), 'Refusing a link, hardlink or wrong path type');
	for (let current = file ? path.dirname(target) : target; ; current = path.dirname(current)) {
		const parentStat = fs.lstatSync(current);
		assert.ok(parentStat.isDirectory() && !parentStat.isSymbolicLink(), 'Refusing an aliased ancestor');
		if (path.dirname(current) === current) break;
	}
	assert.ok(samePath(fs.realpathSync.native(target), target), 'Refusing a noncanonical path');
}

function assertPrivateLocation(parent, target) {
	assert.ok(typeof target === 'string' && path.isAbsolute(target) && target === path.resolve(target) && within(parent, target), 'Native storage escaped the owned directory');
	let existing = target;
	for (;;) {
		try { fs.lstatSync(existing); break; }
		catch (error) { if (error.code !== 'ENOENT') throw error; existing = path.dirname(existing); }
	}
	assertCanonicalPath(existing);
}

function assertStorageUri(uri, parent) {
	assert.ok(uri && ['file', 'vscode-userdata'].includes(uri.scheme), 'Local native storage URI required');
	assert.equal(uri.authority ?? '', '', 'Remote native storage is forbidden');
	assertPrivateLocation(parent, uri.fsPath);
	return uri.fsPath;
}

function sourceIdentity() {
	assertCanonicalPath(SOURCE_ROOT);
	assertCanonicalPath(__filename, true);
	const manifestFile = path.join(SOURCE_ROOT, 'package.json');
	assertCanonicalPath(manifestFile, true);
	const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
	assert.equal(manifest.publisher + '.' + manifest.name, EXTENSION_ID, 'Unexpected source extension manifest');
	assert.ok(typeof manifest.main === 'string' && typeof manifest.engines?.vscode === 'string', 'Source entry point and VS Code engine required');
	const mainFile = path.resolve(SOURCE_ROOT, manifest.main);
	assert.ok(within(SOURCE_ROOT, mainFile), 'Source main escaped the source root');
	assertCanonicalPath(mainFile, true);
	const mainSha256 = hash(fs.readFileSync(mainFile));
	assert.equal(mainSha256, MAIN_SHA256, 'Already-built source main differs; do not build or substitute it');
	return { mainFile, mainSha256 };
}

async function ownershipHelper() {
	const helperFile = path.join(SOURCE_ROOT, 'scripts/repro-published-notebook.mjs');
	assertCanonicalPath(helperFile, true);
	return import(pathToFileURL(helperFile).href);
}

async function validateConfig(configFile, expectedSha256) {
	assert.ok(typeof configFile === 'string' && path.isAbsolute(configFile) && configFile === path.resolve(configFile), 'Absolute private config path required');
	const root = path.dirname(configFile);
	assert.equal(path.basename(configFile), 'profile-config.json', 'Unexpected config filename');
	assert.ok(samePath(path.dirname(root), os.tmpdir()) && /^kw-acceptance-[A-Za-z0-9]+$/.test(path.basename(root)), 'Config must belong to a marked TEMP acceptance root');
	assertCanonicalPath(configFile, true);
	const bytes = fs.readFileSync(configFile);
	const configSha256 = hash(bytes);
	if (expectedSha256 !== undefined) {
		assert.match(expectedSha256, /^[0-9a-f]{64}$/, 'Expected config SHA-256 required');
		assert.equal(configSha256, expectedSha256, 'Private config changed');
	}
	const config = JSON.parse(bytes.toString('utf8'));
	assert.deepEqual(Object.keys(config).sort(), ['schemaVersion', 'owner', 'expectedSourceRoot', 'mainFile', 'mainSha256', 'profileName',
		...Object.keys(DIRECTORY_NAMES), 'vscodeExecutablePath', 'vscodeExecutableSha256'].sort(), 'Unexpected config fields');
	assert.equal(config.schemaVersion, 1, 'Unsupported config schema');
	assert.deepEqual(Object.keys(config.owner).sort(), ['schemaVersion', 'root', 'marker'].sort(), 'Unexpected owner fields');
	assert.equal(config.owner.schemaVersion, 1, 'Unsupported owner schema');
	assert.equal(config.owner.root, root, 'Config and ownership root differ');
	const helper = await ownershipHelper();
	assert.equal(helper.assertAcceptanceRoot(config.owner), root, 'Acceptance ownership failed');
	assert.ok(samePath(config.expectedSourceRoot, SOURCE_ROOT), 'Unexpected source root');
	const source = sourceIdentity();
	assert.ok(samePath(config.mainFile, source.mainFile), 'Unexpected source main');
	assert.equal(config.mainSha256, source.mainSha256, 'Source main changed');
	assert.equal(config.profileName, PROFILE_PREFIX + path.basename(root).slice('kw-acceptance-'.length), 'Unexpected isolated profile name');
	for (const [key, name] of Object.entries(DIRECTORY_NAMES)) {
		assert.equal(config[key], path.join(root, name), 'Unexpected owned directory');
		assertCanonicalPath(config[key]);
		quoteArgumentValue(config[key]);
	}
	assert.ok(typeof config.vscodeExecutablePath === 'string' && within(path.join(SOURCE_ROOT, '.vscode-test'), config.vscodeExecutablePath), 'Editor must come from the SDK source cache');
	quoteArgumentValue(config.vscodeExecutablePath);
	assertCanonicalPath(config.vscodeExecutablePath, true);
	assert.match(config.vscodeExecutableSha256, /^[0-9a-f]{64}$/, 'Editor SHA-256 required');
	assert.equal(hash(fs.readFileSync(config.vscodeExecutablePath)), config.vscodeExecutableSha256, 'Cached editor changed');
	return Object.freeze({ ...config, owner: Object.freeze(config.owner), configPath: configFile, configSha256 });
}

function deadline(pending, timeoutMs = PHASE_TIMEOUT_MS, label = 'Native phase') {
	assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Positive deadline required');
	let timer;
	const expired = new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(label + ' deadline exceeded; physical work is not cancelled and the SDK must finish the owned host');
			error.name = 'NativePhaseDeadlineError';
			reject(error);
		}, timeoutMs);
	});
	return Promise.race([Promise.resolve(pending), expired]).finally(() => clearTimeout(timer));
}

function errorSummary(error) {
	const name = /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error?.name ?? '') ? error.name : 'Error';
	const message = String(error?.message ?? 'Native harness failed')
		.replace(/bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
		.replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED_JWT]')
		.replace(/((?:access_?token|refresh_?token|id_?token|password|secret|api[_-]?key|sig)\s*["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1[REDACTED]')
		.slice(0, 2000);
	return { name, message };
}

async function writeReceipt(config, name, receipt) {
	assert.match(name, /^(?:prepare-native|check-native(?:-[0-9a-f]{16})?)\.json$/, 'Unexpected receipt filename');
	const helper = await ownershipHelper();
	helper.assertAcceptanceRoot(config.owner);
	assertCanonicalPath(config.evidenceDir);
	fs.writeFileSync(path.join(config.evidenceDir, name), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
}

function readReceipt(config, name) {
	assert.match(name, /^(?:prepare-native|check-native(?:-[0-9a-f]{16})?)\.json$/, 'Unexpected receipt filename');
	const file = path.join(config.evidenceDir, name);
	assertCanonicalPath(file, true);
	const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.equal(receipt.schemaVersion, 1, 'Unexpected receipt schema');
	assert.equal(receipt.ownerMarker, config.owner.marker, 'Receipt ownership mismatch');
	assert.equal(receipt.configSha256, config.configSha256, 'Receipt config mismatch');
	return receipt;
}

function preparedReceipt(config) {
	const receipt = readReceipt(config, 'prepare-native.json');
	assert.equal(receipt.phase, 'prepare', 'PREPARE receipt required');
	assert.equal(receipt.status, 'PREPARED_MEMENTO_READBACK_ONLY', 'PREPARE did not complete');
	assert.deepEqual(receipt.connection, connectionRecord, 'Prepared connection differs');
	assert.equal(receipt.mementoReadbackVerified, true, 'Native Memento readback missing');
	assert.equal(receipt.runtimeManagerNotReloaded, true, 'PREPARE must not claim constructor restoration');
	assert.equal(receipt.native.extensionMode, 3, 'Actual Test context required');
	assert.equal(receipt.native.mainSha256, config.mainSha256, 'PREPARE source differs');
	return receipt;
}

function nativeOwner(vscode, config, extension) {
	assert.ok(extension?.isActive && samePath(extension.extensionPath, config.expectedSourceRoot), 'Actual source extension is not active');
	const workbenchRequire = createRequire(config.mainFile);
	const loaded = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, config.mainFile));
	const orchestrator = loaded?.exports?.toolOrchestrator;
	const context = orchestrator?.context;
	assert.ok(loaded?.loaded === true && context?.extensionMode === 3 && vscode.ExtensionMode.Test === 3, 'Actual source Test context/main missing');
	assert.ok(samePath(context.extensionPath, config.expectedSourceRoot), 'Actual context source differs');
	assert.equal(sourceIdentity().mainSha256, config.mainSha256, 'Loaded source changed');
	assertStorageUri(context.globalStorageUri, config.userDataDir);
	assert.equal(path.basename(context.globalStorageUri.fsPath).toLowerCase(), EXTENSION_ID, 'Unexpected native storage owner');
	assertStorageUri(context.logUri, path.join(config.userDataDir, 'logs'));
	assert.ok(typeof context.globalState?.get === 'function' && typeof context.globalState.update === 'function', 'Native Memento unavailable');
	const manager = orchestrator.connectionManager;
	assert.ok(typeof manager?.getConnections === 'function' && typeof manager.getConnectionIncarnation === 'function', 'Actual connection manager unavailable');
	return { context, manager, proof: {
		mainFile: loaded.filename, mainSha256: config.mainSha256, sourceRoot: context.extensionPath,
		extensionMode: context.extensionMode, globalStoragePath: context.globalStorageUri.fsPath, logPath: context.logUri.fsPath,
		vscodeVersion: vscode.version, processId: process.pid, executablePath: config.vscodeExecutablePath,
		executableSha256: config.vscodeExecutableSha256, qualification: 'TEST_MODE_PARTIAL_NOT_DEVELOPMENT_OR_PRODUCTION',
	} };
}

function featureExpressions() {
	const file = path.join(__dirname, 'archive-original-canary-baseline.feature');
	assertCanonicalPath(file, true);
	const bytes = fs.readFileSync(file);
	const source = bytes.toString('utf8');
	const blocks = [...source.matchAll(/from extension host expression:\s*\r?\n[\t ]*"""\r?\n([\s\S]*?)\r?\n[\t ]*"""/g)];
	const inline = [...source.matchAll(/from extension host expression "([^\r\n]*)"[\t ]*(?:\r?\n|$)/g)];
	assert.equal((source.match(/from extension host expression/g) ?? []).length, 2, 'Exactly two feature expressions required');
	assert.equal(blocks.length, 1, 'Exactly one feature doc string required');
	assert.equal(inline.length, 1, 'Exactly one feature assertion required');
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	return { sha256: hash(bytes), baseline: new AsyncFunction('vscode', 'return (' + blocks[0][1].trim() + ');'),
		assertion: new AsyncFunction('vscode', 'return (' + inline[0][1].trim() + ');') };
}

async function run() {
	const phase = process.env.KW_WAVE4_PROFILE_PHASE;
	assert.ok(phase === 'prepare' || phase === 'check', 'Explicit native phase required');
	assert.match(process.env.KW_WAVE4_PROFILE_CONFIG_SHA256 ?? '', /^[0-9a-f]{64}$/, 'Parent config digest required');
	const config = await validateConfig(process.env.KW_WAVE4_PROFILE_CONFIG, process.env.KW_WAVE4_PROFILE_CONFIG_SHA256);
	const receiptName = process.env.KW_WAVE4_PROFILE_RECEIPT;
	assert.match(receiptName ?? '', phase === 'prepare' ? /^prepare-native\.json$/ : /^check-native(?:-[0-9a-f]{16})?\.json$/, 'Phase receipt required');
	const vscode = require('vscode');
	const receipt = { schemaVersion: 1, phase, ownerMarker: config.owner.marker, configSha256: config.configSha256,
		profileName: config.profileName, status: 'FAILED', startedUtc: new Date().toISOString() };
	let extension, slot, failure, status, terminal = false;
	const active = () => assert.equal(terminal, false, 'Native phase ended; no follow-up work permitted');
	try {
		status = await deadline((async () => {
			assert.equal(process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH, undefined, 'First-launch bypass is forbidden');
			assert.equal(vscode.workspace.workspaceFolders?.length ?? 0, 0, 'Startup must have zero workspace folders');
			assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, 0, 'Startup must have zero tabs; do not reset');
			assert.equal(globalThis[PROFILE_SLOT], undefined, 'Native profile slot already used');
			assert.equal(globalThis.__archiveOriginalCanaryBaseline, undefined, 'Canary host already used');
			extension = vscode.extensions.getExtension(EXTENSION_ID);
			assert.ok(extension && samePath(extension.extensionPath, config.expectedSourceRoot), 'Expected source extension required');
			if (phase === 'check') {
				assert.equal(extension.isActive, false, 'CHECK must observe registrations before Workbench activation');
				const prepared = preparedReceipt(config);
				const expressions = featureExpressions();
				receipt.featureSha256 = expressions.sha256;
				slot = Object.freeze({ ...config, phase: 'check', expectedExtensionPath: config.expectedSourceRoot, globalStoragePath: prepared.native.globalStoragePath });
				globalThis[PROFILE_SLOT] = slot;
				receipt.baseline = await expressions.baseline(vscode);
				active();
				const { context, manager, proof } = nativeOwner(vscode, config, extension);
				receipt.native = proof;
				assert.notEqual(proof.processId, prepared.native.processId, 'CHECK requires a fresh extension host');
				assert.equal(proof.vscodeVersion, prepared.native.vscodeVersion, 'Editor version changed between phases');
				assert.ok(samePath(proof.globalStoragePath, prepared.native.globalStoragePath), 'Native global storage changed between phases');
				assert.deepEqual(context.globalState.get('kusto.connections'), [connectionRecord], 'Fresh Memento did not restore the record');
				assert.deepEqual(manager.getConnections(), [connectionRecord], 'Actual constructor did not restore the original ID');
				assert.equal(manager.getConnectionIncarnation(connectionRecord.id), 1, 'Restored original ID must have incarnation 1');
				receipt.connection = connectionRecord;
				receipt.restoredIncarnation = 1;
				receipt.assertion = await expressions.assertion(vscode);
				active();
				assert.equal(receipt.baseline?.classification, 'BASELINE_AVAILABLE', 'Original-copy baseline is unavailable');
				assert.equal(receipt.assertion?.passed, true, 'Feature assertion did not pass');
				return 'BASELINE_AVAILABLE';
			}
			if (!extension.isActive) await extension.activate();
			active();
			const { context, manager, proof } = nativeOwner(vscode, config, extension);
			receipt.native = proof;
			assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, 0, 'Activation opened an unexpected tab');
			if (phase === 'prepare') {
				const stored = context.globalState.get('kusto.connections');
				assert.ok(stored === undefined || Array.isArray(stored) && stored.length === 0, 'Refusing to overwrite existing connections');
				assert.deepEqual(manager.getConnections(), [], 'PREPARE manager is not fresh');
				assert.equal(manager.getConnectionIncarnation(connectionRecord.id), 0, 'Original ID already exists');
				await context.globalState.update('kusto.connections', [{ ...connectionRecord }]);
				active();
				assert.deepEqual(context.globalState.get('kusto.connections'), [connectionRecord], 'Native Memento write did not read back');
				assert.deepEqual(manager.getConnections(), [], 'PREPARE unexpectedly reloaded the manager');
				receipt.connection = connectionRecord;
				receipt.mementoReadbackVerified = true;
				receipt.runtimeManagerNotReloaded = true;
				return 'PREPARED_MEMENTO_READBACK_ONLY';
			}
		})(), PHASE_TIMEOUT_MS, 'Native ' + phase);
	} catch (error) { failure = error; }
	finally {
		terminal = true;
		if (slot && globalThis[PROFILE_SLOT] === slot) delete globalThis[PROFILE_SLOT];
		try {
			if (receipt.native) {
				receipt.nativeAfter = nativeOwner(vscode, config, extension).proof;
				assert.deepEqual(receipt.nativeAfter, receipt.native, 'Native source/storage identity changed');
			}
		} catch (error) { failure ??= error; receipt.identityError = errorSummary(error); }
		receipt.status = failure ? 'FAILED' : status;
		if (failure) receipt.error = errorSummary(failure);
		receipt.finishedUtc = new Date().toISOString();
		await writeReceipt(config, receiptName, receipt);
	}
	if (failure) throw failure;
}

async function createConfig(sdk) {
	const source = sourceIdentity();
	quoteArgumentValue(SOURCE_ROOT);
	quoteArgumentValue(__filename);
	const helper = await ownershipHelper();
	const owner = helper.createAcceptanceRoot();
	const directories = Object.fromEntries(Object.entries(DIRECTORY_NAMES).map(([key, name]) => [key, path.join(owner.root, name)]));
	for (const directory of Object.values(directories)) { helper.assertAcceptanceRoot(owner); fs.mkdirSync(directory); assertCanonicalPath(directory); }
	const user = path.join(directories.userDataDir, 'User');
	fs.mkdirSync(user);
	assertCanonicalPath(user);
	fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify(SETTINGS, null, 2), { flag: 'wx', mode: 0o600 });
	const vscodeExecutablePath = await sdk.downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(SOURCE_ROOT, '.vscode-test') });
	assertCanonicalPath(vscodeExecutablePath, true);
	const config = { schemaVersion: 1, owner, expectedSourceRoot: SOURCE_ROOT, ...source, ...directories,
		profileName: PROFILE_PREFIX + path.basename(owner.root).slice('kw-acceptance-'.length), vscodeExecutablePath,
		vscodeExecutableSha256: hash(fs.readFileSync(vscodeExecutablePath)) };
	helper.assertAcceptanceRoot(owner);
	const file = path.join(owner.root, 'profile-config.json');
	const bytes = Buffer.from(JSON.stringify(config, null, 2));
	fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
	return validateConfig(file, hash(bytes));
}

async function launchPhase(sdk, config, phase, receiptName) {
	await validateConfig(config.configPath, config.configSha256);
	const extensionTestsEnv = {};
	for (const name of Object.keys(process.env)) {
		if (/^(?:VSCODE_|ELECTRON_|KUSTO_WORKBENCH_|KW_WAVE4_|COPILOT_|GITHUB_|GH_|AZURE_|MSAL_)/i.test(name)
			|| /TOKEN|SECRET|PASSWORD|API_KEY/i.test(name) || name === 'NODE_OPTIONS' || name === 'NODE_PATH') extensionTestsEnv[name] = undefined;
	}
	Object.assign(extensionTestsEnv, { KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH: undefined, KW_WAVE4_PROFILE_PHASE: phase,
		KW_WAVE4_PROFILE_CONFIG: config.configPath, KW_WAVE4_PROFILE_CONFIG_SHA256: config.configSha256, KW_WAVE4_PROFILE_RECEIPT: receiptName });
	await sdk.runTests({ vscodeExecutablePath: config.vscodeExecutablePath,
		extensionDevelopmentPath: quoteArgumentValue(config.expectedSourceRoot), extensionTestsPath: quoteArgumentValue(__filename),
		reuseMachineInstall: false, extensionTestsEnv, launchArgs: [
			'--user-data-dir=' + quoteArgumentValue(config.userDataDir), '--extensions-dir=' + quoteArgumentValue(config.extensionsDir),
			'--shared-data-dir=' + quoteArgumentValue(config.sharedDataDir), '--profile=' + quoteArgumentValue(config.profileName),
			'--new-window', '--sync=off',
		] });
	const receipt = readReceipt(config, receiptName);
	assert.equal(receipt.phase, phase, 'Native phase receipt differs');
	assert.equal(receipt.status, phase === 'prepare' ? 'PREPARED_MEMENTO_READBACK_ONLY' : 'BASELINE_AVAILABLE', 'Native phase failed');
}

async function main(argv) {
	const checkOnly = argv.length === 2 && argv[0] === '--check-only';
	assert.ok(argv.length === 0 || checkOnly, 'Usage: node profile-runner.cjs [--check-only <owned profile-config.json>]');
	sourceIdentity();
	const sdk = createRequire(path.join(SOURCE_ROOT, 'package.json'))('@vscode/test-electron');
	const config = checkOnly ? await validateConfig(argv[1]) : await createConfig(sdk);
	console.log('Private profile config: ' + config.configPath);
	if (!checkOnly) await launchPhase(sdk, config, 'prepare', 'prepare-native.json');
	preparedReceipt(config);
	const receiptName = checkOnly ? 'check-native-' + randomBytes(8).toString('hex') + '.json' : 'check-native.json';
	await launchPhase(sdk, config, 'check', receiptName);
	console.log('Test-mode partial baseline receipt: ' + path.join(config.evidenceDir, receiptName));
}

module.exports = { run, validateConfig, quoteArgumentValue, deadline, connectionRecord, assertStorageUri };

if (require.main === module) {
	main(process.argv.slice(2)).catch(error => {
		const summary = errorSummary(error);
		console.error(summary.name + ': ' + summary.message);
		process.exitCode = 1;
	});
}