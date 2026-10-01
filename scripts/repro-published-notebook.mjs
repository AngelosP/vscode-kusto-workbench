#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yauzl = createRequire(require.resolve('extract-zip'))('yauzl');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBENCH_ID = 'angelos-petropoulos.vscode-kusto-workbench';
const CONTROLLER_ID = 'vscode-extension-tester.vscode-extension-tester-controller';
const EXPECTED_CONTROLLER_VERSION = '0.3.1';
const DEFAULT_CLI = path.join(process.env.APPDATA ?? '', 'npm/node_modules/vscode-ext-test/bin/vscode-ext-test.js');
const PRIOR_DRIVER = 'out/published-corruption-driver-3d86f159/tests/vscode-extension-tester';
const DEFAULTS = {
	vscodeVersion: '1.139.1',
	repeats: 3,
	autosave: 'both',
	observation: 'diagnostic',
	outputParent: 'C:\\kwpc',
	seedProfile: path.join(REPO_ROOT, 'tests/vscode-extension-tester/profiles/kusto-auth'),
	seedAuth: path.join(REPO_ROOT, 'tests/vscode-extension-tester/auth-shared'),
	featureDir: path.join(REPO_ROOT, 'tests/vscode-extension-tester/e2e/default/published-notebook-corruption'),
	originalSettings: path.join(REPO_ROOT, PRIOR_DRIVER, 'profiles/release-5-1-0/user-data/User/settings.json'),
	baselineRun: path.join(REPO_ROOT, PRIOR_DRIVER, 'runs/release-5-1-0/published-notebook-corruption/20260928-223228'),
	cli: DEFAULT_CLI,
};
const PROFILE_NAME = 'probe';
const STEP_TIMEOUT_MS = 90000;
const CLI_HARD_LIMIT_MS = 45 * 60 * 1000;
const STALL_LIMIT_MS = 1000;
const PRIMARY_ORDER = ['HARNESS_BLOCKED_SETUP', 'CORRUPTION_OBSERVED', 'WORKFLOW_FAILED_SAVE', 'PRESERVATION_FAILED', 'WORKFLOW_FAILED', 'HARNESS_SUSPECT', 'HARNESS_BLOCKED'];

const HELP = `Usage: node scripts/repro-published-notebook.mjs --vsix <path> --expected-sha <sha256> [options]

Opt-in, sequential, bounded replay of the published-notebook corruption scenario.
Each attempt gets a fresh driver, profile, and shared-auth snapshot; nothing is retried or deleted.

Required:
  --vsix <path>              Workbench VSIX to install (hash-verified).
  --expected-sha <sha256>    Expected SHA-256 of the VSIX.

Options:
  --vscode-version <v>       Cached portable editor version (default ${DEFAULTS.vscodeVersion}).
  --repeats <1..3>           Repeats per arm (default ${DEFAULTS.repeats}).
  --autosave <mode>          both | afterDelay | off (default ${DEFAULTS.autosave}).
                             both alternates afterDelay/off, off/afterDelay, afterDelay/off.
  --observation <mode>       diagnostic | minimal | legacy (default ${DEFAULTS.observation}).
  --legacy-feature <path>    Legacy .feature file (only with --observation legacy).
  --output-parent <dir>      Short owned parent for campaigns (default ${DEFAULTS.outputParent}).
  --seed-profile <dir>       Prepared read-only seed profile (default tests/vscode-extension-tester/profiles/kusto-auth).
  --seed-auth <dir>          Read-only shared auth seed (default tests/vscode-extension-tester/auth-shared).
  --feature-dir <dir>        Feature + helper source (default tests/vscode-extension-tester/e2e/default/published-notebook-corruption).
  --original-settings <file> Known original settings.json to replay (default prior release-5-1-0 profile).
  --baseline-run <dir>       Prior run holding published-lifecycle-start.json (default prior 5.1.0 run).
  --cli <path>               vscode-ext-test bin script (default global 0.1.23 install).
	--prepare-only             Prepare isolated profiles without launching a test (never counts as a pass).
	--cdp-port <port>          Explicit isolated CDP port for native timed-input probes.
	--profile-host-cpu         Capture the isolated extension host CPU profile (diagnostic timing only).
  --help                     Show this help.

Outcomes: PASS_UNREVIEWED_VISUAL, CORRUPTION_OBSERVED, PRESERVATION_FAILED, WORKFLOW_FAILED,
HARNESS_SUSPECT, HARNESS_BLOCKED. Exit code 0 only when every attempt is PASS_UNREVIEWED_VISUAL;
1 when any attempt is not; 2 on usage or bootstrap setup failure.`;

class UsageError extends Error {}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const sha256File = file => sha256(fs.readFileSync(file));
const redact = text => String(text ?? '')
	.replace(/(bearer\s+)[\w.~+/-]+=*/gi, '$1[REDACTED]')
	.replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED_JWT]')
	.replace(/((?:access_?token|refresh_?token|id_?token|client_?secret|password|secret|api[_-]?key|sig)\s*["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1[REDACTED]');
const clip = (text, limit = 2000) => { const value = redact(text); return value.length > limit ? value.slice(0, limit) + '...' : value; };
const within = (parent, child) => {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJsonAtomic = (file, value) => {
	const temporary = file + '.tmp';
	fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
	fs.renameSync(temporary, file);
};

export function parseArgs(argv) {
	const names = new Set(['vsix', 'expected-sha', 'vscode-version', 'repeats', 'autosave', 'observation', 'legacy-feature', 'output-parent', 'seed-profile', 'seed-auth', 'feature-dir', 'original-settings', 'baseline-run', 'cli', 'cdp-port']);
	const values = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') return { help: true };
		if (arg === '--prepare-only') { values.prepareOnly = true; continue; }
		if (arg === '--profile-host-cpu') {
			if (values.profileHostCpu) throw new UsageError('Duplicate option: --profile-host-cpu');
			values.profileHostCpu = true;
			continue;
		}
		if (!arg.startsWith('--')) throw new UsageError('Unexpected argument: ' + arg);
		const separator = arg.indexOf('=');
		const name = arg.slice(2, separator > 0 ? separator : undefined);
		if (!names.has(name)) throw new UsageError('Unknown option: --' + name);
		const value = separator > 0 ? arg.slice(separator + 1) : argv[++index];
		if (value === undefined || value === '') throw new UsageError('Missing value for --' + name);
		if (Object.hasOwn(values, name)) throw new UsageError('Duplicate option: --' + name);
		values[name] = value;
	}
	if (!values.vsix) throw new UsageError('--vsix is required');
	if (!values['expected-sha']) throw new UsageError('--expected-sha is required');
	if (!/^[0-9a-f]{64}$/i.test(values['expected-sha'])) throw new UsageError('--expected-sha must be a 64-character hex SHA-256');
	const repeats = Number(values.repeats ?? DEFAULTS.repeats);
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new UsageError('--repeats must be an integer from 1 to 3');
	const autosave = values.autosave ?? DEFAULTS.autosave;
	if (!['both', 'afterDelay', 'off'].includes(autosave)) throw new UsageError('--autosave must be both, afterDelay, or off');
	const observation = values.observation ?? DEFAULTS.observation;
	if (!['diagnostic', 'minimal', 'legacy'].includes(observation)) throw new UsageError('--observation must be diagnostic, minimal, or legacy');
	if (observation === 'legacy' && !values['legacy-feature']) throw new UsageError('--legacy-feature is required with --observation legacy');
	if (observation !== 'legacy' && values['legacy-feature']) throw new UsageError('--legacy-feature is only valid with --observation legacy');
	if (observation === 'legacy' && values.profileHostCpu) throw new UsageError('--profile-host-cpu is unavailable with legacy observation');
	const vscodeVersion = values['vscode-version'] ?? DEFAULTS.vscodeVersion;
	if (!/^\d+\.\d+\.\d+$/.test(vscodeVersion)) throw new UsageError('--vscode-version must be an exact x.y.z version');
	const cdpPort = values['cdp-port'] === undefined ? null : Number(values['cdp-port']);
	if (cdpPort !== null && (!/^\d+$/.test(values['cdp-port']) || !Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535)) throw new UsageError('--cdp-port must be an integer from 1024 to 65535');
	const resolve = (name, fallback) => path.resolve(REPO_ROOT, values[name] ?? fallback);
	return {
		vsix: path.resolve(values.vsix),
		expectedSha: values['expected-sha'].toLowerCase(),
		vscodeVersion, repeats, autosave, observation, cdpPort, prepareOnly: values.prepareOnly === true, profileHostCpu: values.profileHostCpu === true,
		legacyFeature: values['legacy-feature'] ? path.resolve(values['legacy-feature']) : null,
		outputParent: resolve('output-parent', DEFAULTS.outputParent),
		seedProfile: resolve('seed-profile', DEFAULTS.seedProfile),
		seedAuth: resolve('seed-auth', DEFAULTS.seedAuth),
		featureDir: resolve('feature-dir', DEFAULTS.featureDir),
		originalSettings: resolve('original-settings', DEFAULTS.originalSettings),
		baselineRun: resolve('baseline-run', DEFAULTS.baselineRun),
		cli: resolve('cli', DEFAULTS.cli),
	};
}

async function openZip(file) {
	const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value)));
	const entries = new Map();
	try {
		await new Promise((resolve, reject) => {
			zip.on('error', reject);
			zip.on('entry', entry => { entries.set(entry.fileName, entry); zip.readEntry(); });
			zip.on('end', resolve);
			zip.readEntry();
		});
	} catch (error) { zip.close(); throw error; }
	const read = name => new Promise((resolve, reject) => {
		const entry = entries.get(name);
		if (!entry) { reject(new Error('ZIP entry missing: ' + name)); return; }
		zip.openReadStream(entry, (error, stream) => {
			if (error) { reject(error); return; }
			const chunks = [];
			stream.on('data', chunk => chunks.push(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve(Buffer.concat(chunks)));
		});
	});
	return { names: [...entries.keys()], read, close: () => zip.close() };
}

const treeHash = files => sha256(files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map(file => file.path + '\0' + file.sha256 + '\n').join(''));

export async function inspectVsix(file) {
	const zip = await openZip(file);
	try {
	const manifest = JSON.parse((await zip.read('extension/package.json')).toString('utf8'));
	const id = `${manifest.publisher}.${manifest.name}`;
	const main = manifest.main ? path.posix.normalize(String(manifest.main).replace(/^\.\//, '')) : null;
	const mainEntry = main ? 'extension/' + (path.posix.extname(main) ? main : main + '.js') : null;
	const topFolder = main && main.includes('/') ? main.split('/')[0] : null;
		const tree = [];
		for (const name of zip.names.filter(name => topFolder && name.startsWith(`extension/${topFolder}/`) && !name.endsWith('/'))) {
			tree.push({ path: name.slice('extension/'.length), sha256: sha256(await zip.read(name)) });
		}
	return {
		id, version: manifest.version, main, mainEntry, topFolder,
				mainSha256: mainEntry ? sha256(await zip.read(mainEntry)) : null,
		treeSha256: tree.length ? treeHash(tree) : null, treeFiles: tree.length,
	};
		} finally { zip.close(); }
}

function hashInstalledTree(root, folder) {
	const files = [];
	const walk = directory => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) files.push({ path: path.relative(root, full).split(path.sep).join('/'), sha256: sha256File(full) });
		}
	};
	walk(path.join(root, folder));
	return { treeSha256: treeHash(files), treeFiles: files.length };
}

function inspectEditor(version) {
	const root = path.join(REPO_ROOT, '.vscode-test', `vscode-win32-x64-archive-${version}`);
	const codeExe = path.join(root, 'Code.exe');
	if (!fs.existsSync(codeExe) || !fs.existsSync(path.join(root, 'is-complete'))) throw new Error('Cached portable editor missing or incomplete: ' + root);
	const commitDir = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
		.map(entry => path.join(root, entry.name)).find(directory => fs.existsSync(path.join(directory, 'resources/app/product.json')));
	if (!commitDir) throw new Error('Editor product.json not found under ' + root);
	const product = readJson(path.join(commitDir, 'resources/app/product.json'));
	const cliJs = path.join(commitDir, 'resources/app/out/cli.js');
	const packageJson = readJson(path.join(commitDir, 'resources/app/package.json'));
	if (packageJson.version !== version) throw new Error(`Cached editor version ${packageJson.version} differs from requested ${version}`);
	if (!fs.existsSync(cliJs)) throw new Error('Editor CLI entry missing: ' + cliJs);
	return { root, codeExe, cliJs, version: packageJson.version, productVersion: product.version ?? null, commit: product.commit, quality: product.quality ?? null, codeExeSha256: sha256File(codeExe) };
}

function childEnv() {
	const env = { ...process.env };
	const dropped = [];
	for (const key of Object.keys(env)) {
		if (/^(VSCODE_|ELECTRON_)/i.test(key) || /^KW_PUBLISHED_REPLAY_CONFIG$/i.test(key)) { delete env[key]; dropped.push(key); }
	}
	return { env, dropped: dropped.sort() };
}

function listProcesses() {
	const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
	{ encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 60000 });
	const parsed = JSON.parse(output || '[]');
	return Array.isArray(parsed) ? parsed : [parsed];
}

function assertSeedsInactive(seeds) {
	let processes;
	try { processes = listProcesses(); } catch (error) {
		throw new Error('Refusing to snapshot seeds: process inspection failed (' + clip(error.message, 300) + ')');
	}
	const matches = [];
	for (const process_ of processes) {
		const commandLine = String(process_.CommandLine ?? '').toLowerCase().replace(/\//g, '\\');
		if (!commandLine || process_.ProcessId === process.pid) continue;
		for (const [label, seed] of Object.entries(seeds)) {
			if (commandLine.includes(path.resolve(seed).toLowerCase())) matches.push({ pid: process_.ProcessId, name: process_.Name, seed: label });
		}
	}
	if (matches.length) throw new Error('Refusing to snapshot active seed storage; processes reference it: ' + JSON.stringify(matches));
	return { inspectedProcesses: processes.length, activeReferences: 0 };
}

function copyExclusive(source, target, record) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
	record.push({ target, bytes: fs.statSync(target).size, sha256: sha256File(target) });
}

function snapshotSeeds(options, userData, authShared) {
	const copied = [];
	const seedUserData = path.join(options.seedProfile, 'user-data');
	copyExclusive(path.join(seedUserData, 'Local State'), path.join(userData, 'Local State'), copied);
	for (const suffix of ['', '-wal', '-shm']) {
		const source = path.join(seedUserData, 'User/globalStorage/state.vscdb' + suffix);
		if (suffix === '' || fs.existsSync(source)) copyExclusive(source, path.join(userData, 'User/globalStorage/state.vscdb' + suffix), copied);
	}
	copyExclusive(path.join(options.seedAuth, 'Local State'), path.join(authShared, 'Local State'), copied);
	const sharedRoot = path.join(options.seedAuth, 'shared-data');
	const walk = directory => {
		if (!fs.existsSync(directory)) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && /^state\.vscdb(-wal|-shm)?$/.test(entry.name)) copyExclusive(full, path.join(authShared, 'shared-data', path.relative(sharedRoot, full)), copied);
		}
	};
	walk(sharedRoot);
	return copied;
}

function buildSettings(original, autoSave) {
	const safe = {};
	const dropped = [];
	for (const [key, value] of Object.entries(original)) {
		if (/token|secret|password|credential|api[._-]?key|auth/i.test(key)) dropped.push(key);
		else safe[key] = value;
	}
	return {
		settings: {
			...safe,
			'files.autoSave': autoSave, 'files.autoSaveDelay': 1000, 'files.hotExit': 'off',
			'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
			'extensions.autoUpdate': 'off', 'extensions.autoCheckUpdates': false,
		},
		droppedKeys: dropped,
	};
}

function runEditorCli(editor, args, logFile, env) {
	const started = Date.now();
	let status = 0;
	let output = '';
	try {
		output = execFileSync(editor.codeExe, [editor.cliJs, ...args], { cwd: REPO_ROOT, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, windowsHide: true });
	} catch (error) {
		status = error.status ?? -1;
		output = String(error.stdout ?? '') + String(error.stderr ?? '') + String(error.message ?? '');
	}
	fs.writeFileSync(logFile, redact(output), { flag: 'wx' });
	if (status !== 0) throw new Error(`Editor CLI failed (${status}); see ${logFile}`);
	return { args: ['<Code.exe>', '<cli.js>', ...args], status, durationMs: Date.now() - started, log: logFile };
}

function findFiles(root, predicate, found = []) {
	if (!fs.existsSync(root)) return found;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) findFiles(full, predicate, found);
		else if (entry.isFile() && predicate(entry.name, full)) found.push(full);
	}
	return found;
}

function recoverBaselineHash(runDir) {
	const [artifact] = findFiles(runDir, name => name === 'published-lifecycle-start.json');
	if (!artifact) return { initialHash: null, source: null, reason: 'artifact not found' };
	const value = readJson(artifact);
	return /^[0-9a-f]{64}$/.test(value.initialHash ?? '')
		? { initialHash: value.initialHash, initialBytes: value.initialBytes ?? null, version: value.version ?? null, source: artifact }
		: { initialHash: null, source: artifact, reason: 'initialHash missing' };
}

function gitInfo() {
	const git = args => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
	try {
		return { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean) };
	} catch (error) {
		return { head: null, dirty: null, error: clip(error.message, 300) };
	}
}

function prepareOutputParent(parent) {
	if (!path.isAbsolute(parent) || path.parse(parent).root === parent) throw new Error('Output parent must be an absolute, non-root directory: ' + parent);
	if (within(parent, REPO_ROOT)) throw new Error('Output parent must not contain the repository: ' + parent);
	try { fs.mkdirSync(parent, { recursive: true }); } catch (error) {
		throw new Error(`Cannot create output parent ${parent} (${error.code ?? error.message}); choose another --output-parent (no elevation attempted)`);
	}
	const stat = fs.lstatSync(parent);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Output parent is not a plain directory: ' + parent);
	return fs.realpathSync(parent);
}

function stageAssets(options, assetsDir) {
	const assets = { files: {} };
	const copy = (source, name) => {
		const target = path.join(assetsDir, 'features', name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
		const sourceHash = sha256File(source);
		const targetHash = sha256File(target);
		if (sourceHash !== targetHash) throw new Error('Asset copy is not byte-identical: ' + name);
		assets.files[name] = { source, path: target, sha256: targetHash };
		return target;
	};
	const featureDir = path.join(assetsDir, 'features');
	if (options.observation === 'legacy') {
		const source = fs.statSync(options.legacyFeature).isDirectory()
			? findFiles(options.legacyFeature, name => name.endsWith('.feature')) : [options.legacyFeature];
		if (source.length !== 1 || !source[0].endsWith('.feature')) throw new Error('Legacy feature path must resolve to exactly one .feature file');
		assets.feature = copy(source[0], path.basename(source[0]));
		const settings = path.join(path.dirname(source[0]), 'e2e.settings.json');
		if (fs.existsSync(settings)) copy(settings, 'e2e.settings.json');
		assets.helper = null;
	} else {
		const features = fs.readdirSync(options.featureDir).filter(name => name.endsWith('.feature'));
		if (features.length !== 1) throw new Error('Feature directory must contain exactly one .feature file: ' + options.featureDir);
		assets.feature = copy(path.join(options.featureDir, features[0]), features[0]);
		const localHelper = path.join(options.featureDir, 'lifecycle-journal.cjs');
		const helper = fs.existsSync(localHelper) ? localHelper : path.join(DEFAULTS.featureDir, 'lifecycle-journal.cjs');
		if (!fs.existsSync(helper)) throw new Error('Helper missing: ' + helper);
		assets.helper = copy(helper, 'lifecycle-journal.cjs');
		const settings = path.join(options.featureDir, 'e2e.settings.json');
		if (fs.existsSync(settings)) copy(settings, 'e2e.settings.json');
	}
	assets.featureDir = featureDir;
	assets.featureSha256 = sha256File(assets.feature);
	assets.helperSha256 = assets.helper ? sha256File(assets.helper) : null;
	return assets;
}

function verifyAssets(assets, vsixCopy, vsixSha) {
	for (const [name, file] of Object.entries(assets.files)) {
		if (sha256File(file.path) !== file.sha256) throw new Error('Campaign asset changed: ' + name);
	}
	if (fs.readdirSync(assets.featureDir).filter(name => name.endsWith('.feature')).length !== 1) throw new Error('Campaign feature directory changed');
	if (sha256File(vsixCopy) !== vsixSha) throw new Error('Campaign VSIX copy changed');
}

export function armsFor(options) {
	const arms = [];
	for (let repeat = 1; repeat <= options.repeats; repeat++) {
		const order = options.autosave === 'both' ? (repeat % 2 ? ['afterDelay', 'off'] : ['off', 'afterDelay']) : [options.autosave];
		for (const autoSave of order) arms.push({ repeat, autoSave });
	}
	return arms;
}

function runVscodeExtTest(cliArgs, cwd, env, stdoutFile, stderrFile) {
	return new Promise(resolve => {
		const out = fs.openSync(stdoutFile, 'wx');
		const err = fs.openSync(stderrFile, 'wx');
		const started = Date.now();
		let timedOut = false;
			let finished = false;
		const child = spawn(process.execPath, cliArgs, { cwd, env, stdio: ['ignore', out, err], windowsHide: false });
		const timer = setTimeout(() => {
			timedOut = true;
			try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* process may have exited */ }
		}, CLI_HARD_LIMIT_MS);
		const finish = (code, error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			fs.closeSync(out);
			fs.closeSync(err);
			resolve({ exitCode: code, timedOut, spawnError: error ? clip(error.message, 300) : null, durationMs: Date.now() - started });
		};
		child.once('error', error => finish(null, error));
		child.once('exit', code => finish(code, null));
	});
}

function readRevisions(file) {
 const result = { present: fs.existsSync(file), total: 0, texts: 0, invalid: [], invalidDiskReads: [], preservation: [], rawChanges: [], malformedLines: 0 };
	if (!result.present) return result;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { result.malformedLines++; continue; }
		result.total++;
		if (typeof entry.sha256 === 'string') result.texts++;
		if (entry.valid === false) {
		 const target = entry.invalidOrigin === 'disk-read' || String(entry.phase).startsWith('disk:') ? result.invalidDiskReads : result.invalid;
		 target.push({ sequence: entry.sequence ?? null, phase: entry.phase ?? null, sha256: entry.sha256 ?? null, error: clip(entry.error, 300) });
		}
		if (Array.isArray(entry.preservation) && entry.preservation.length) result.preservation.push({ sequence: entry.sequence ?? null, phase: entry.phase ?? null, violations: entry.preservation });
		if (entry.rawChanges?.length) result.rawChanges.push({ sequence: entry.sequence, sections: entry.rawChanges });
	}
	return result;
}

export function scanSaveLogs(files) {
	const errors = new Set();
	const warnings = new Set();
	for (const file of files) {
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
		for (const line of text.split(/\r?\n/)) {
			if (!/onWillSaveTextDocument|onDidSaveTextDocument|pending Markdown commands|save.{0,20}(participant|listener)|cannot save|Final snapshot unavailable/i.test(line)) continue;
			const clipped = clip(line.trim(), 400);
			if (/IGNORED|blocklist|block-listed|threw|Cannot save|Aborted|timed?\s*out|timeout|Final snapshot unavailable/i.test(line) || /\[error\]/i.test(line)) errors.add(clipped);
			else if (/\[(warning|error)\]/i.test(line)) warnings.add(clipped);
		}
	}
	return { errors: [...errors].slice(0, 50), warnings: [...warnings].slice(0, 50) };
}

const verdictPasses = verdict => verdict === 'PASS_UNREVIEWED_VISUAL';

function collectEvidence(context) {
	const { attemptDir, driverDir, evidenceRoot, fixtureParent, legacy, cli } = context;
	const collected = path.join(attemptDir, 'collected');
	fs.mkdirSync(collected);
	const evidence = { cli };
	const runsRoot = path.join(driverDir, 'tests/vscode-extension-tester/runs');
	const resultFiles = findFiles(runsRoot, name => name === 'results.json').sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
	evidence.runDir = resultFiles[0] ? path.dirname(resultFiles[0]) : null;
	evidence.results = null;
	if (resultFiles[0]) {
		try {
			const results = readJson(resultFiles[0]);
			const scenarios = (results.features ?? []).flatMap(feature => feature.scenarios ?? []);
			evidence.results = {
				totalPassed: results.totalPassed, totalFailed: results.totalFailed, totalSkipped: results.totalSkipped,
				scenarios: scenarios.map(scenario => ({ name: scenario.name, status: scenario.status })),
				completed: scenarios.length > 0 && scenarios.every(scenario => scenario.status === 'passed') && results.totalFailed === 0,
				failedSteps: scenarios.flatMap(scenario => (scenario.steps ?? []).filter(step => step.status === 'failed')
					.map(step => ({ text: clip(step.text, 200), error: clip(step.error?.message ?? step.error ?? '', 2000) }))),
			};
		} catch (error) { evidence.resultsError = clip(error.message, 300); }
	}
	const artifact = name => evidence.runDir ? findFiles(path.join(evidence.runDir, 'json-artifacts'), file => file === name + '.json')[0] : undefined;
	const userDataLogs = path.join(driverDir, 'tests/vscode-extension-tester/profiles', PROFILE_NAME, 'user-data/logs');
	if (fs.existsSync(userDataLogs)) {
		try { fs.cpSync(userDataLogs, path.join(collected, 'profile-logs'), { recursive: true, errorOnExist: true }); } catch (error) { evidence.profileLogCopyError = clip(error.message, 300); }
	}
	const copyReadOnly = (source, name) => {
		if (!source || !fs.existsSync(source)) return null;
		const target = path.join(collected, name);
		fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
		return { source, path: target, bytes: fs.statSync(target).size, sha256: sha256File(target) };
	};
	if (legacy) {
		const startArtifact = artifact('published-lifecycle-start');
		evidence.legacy = { startArtifact: startArtifact ?? null, fixture: null, trace: null };
		if (startArtifact) {
			const start = readJson(startArtifact);
			evidence.legacy.initialHash = start.initialHash ?? null;
			evidence.legacy.extensionPath = start.extensionPath ?? null;
			try {
				const fixtureFile = fileURLToPath(start.uri);
				const fixtureRoot = path.dirname(fixtureFile);
				evidence.legacy.fixtureUri = start.uri;
				if (!path.basename(fixtureRoot).startsWith('kw-published-lifecycle-')) throw new Error('Unexpected legacy fixture root: ' + fixtureRoot);
				evidence.legacy.fixture = copyReadOnly(fixtureFile, 'legacy-synthetic-final.kqlx');
				evidence.legacy.fixtureTrace = copyReadOnly(path.join(fixtureRoot, 'lifecycle-trace.json'), 'legacy-lifecycle-trace.json');
				evidence.legacy.firstInvalidCopy = copyReadOnly(path.join(fixtureRoot, 'first-invalid.kqlx'), 'legacy-first-invalid.kqlx');
			} catch (error) { evidence.legacy.fixtureError = clip(error.message, 300); }
		}
		const traceArtifact = artifact('published-lifecycle-trace');
		const traceFile = traceArtifact ?? evidence.legacy.fixtureTrace?.path;
		if (traceFile) {
			try {
				const trace = readJson(traceFile);
				evidence.legacy.trace = { source: traceFile, events: trace.events?.length ?? null, operations: trace.operations ?? [], firstInvalid: trace.firstInvalid ?? null };
			} catch (error) { evidence.legacy.traceError = clip(error.message, 300); }
		}
	} else {
		const summaryFile = path.join(evidenceRoot, 'lifecycle-summary.json');
		evidence.summary = null;
		if (fs.existsSync(summaryFile)) {
			try {
				const summary = readJson(summaryFile);
				evidence.summary = { verdict: summary.verdict ?? null, failure: summary.failure ?? null, provenance: summary.provenance ?? null, fixtureUri: summary.fixtureUri ?? null, operations: Array.isArray(summary.operations) ? summary.operations : [], journal: summary.journal ?? null };
			} catch (error) { evidence.summaryError = clip(error.message, 300); }
		}
		const journalFile = path.join(evidenceRoot, 'journal-summary.json');
		const journal = evidence.summary?.journal ?? (fs.existsSync(journalFile) ? (() => { try { return readJson(journalFile); } catch { return null; } })() : null);
		evidence.journal = journal ? { mode: journal.mode ?? null, harnessFailures: (journal.harnessFailures ?? []).map(entry => clip(entry, 300)), metrics: journal.metrics ?? null } : null;
		evidence.revisions = readRevisions(path.join(evidenceRoot, 'revisions.jsonl'));
		evidence.relatedRevisions = findFiles(evidenceRoot, (name, full) => name === 'revisions.jsonl' && path.dirname(full) !== evidenceRoot)
			.map(file => ({ file, ...readRevisions(file) }));
		evidence.firstInvalid = fs.existsSync(path.join(evidenceRoot, 'first-invalid.kqlx'));
		if (evidence.summary?.fixtureUri) {
			try {
				const fixtureFile = fileURLToPath(evidence.summary.fixtureUri);
				if (!within(fixtureParent, fixtureFile)) throw new Error('Fixture outside fixtureParent: ' + fixtureFile);
				evidence.fixtureFinal = copyReadOnly(fixtureFile, 'fixture-final.kqlx');
			} catch (error) { evidence.fixtureError = clip(error.message, 300); }
		}
	}
	const logFiles = [
		...(evidence.runDir ? findFiles(path.join(evidence.runDir, 'output-channels'), name => name.endsWith('.log')) : []),
		...findFiles(path.join(collected, 'profile-logs'), name => name.endsWith('.log')),
	];
	evidence.saveLogs = scanSaveLogs(logFiles);
	evidence.scannedLogs = logFiles.length;
	return evidence;
}

export function classify(evidence, legacy) {
	const flags = new Set();
	const reasons = [];
	const add = (flag, reason) => { flags.add(flag); reasons.push(flag + ': ' + reason); };
	const { cli, results } = evidence;
	if (cli.spawnError) add('HARNESS_BLOCKED', 'CLI spawn failed');
	if (cli.timedOut) add('HARNESS_BLOCKED', 'CLI exceeded hard limit and was terminated');
	if (!results) add('HARNESS_BLOCKED', 'results.json missing or unreadable');
	if (legacy) {
		if (evidence.legacy?.trace?.firstInvalid || evidence.legacy?.firstInvalidCopy) add('CORRUPTION_OBSERVED', 'legacy trace recorded invalid root JSON');
		for (const operation of evidence.legacy?.trace?.operations ?? []) if (operation.error) add('WORKFLOW_FAILED', 'tool rejected: ' + clip(operation.name, 80));
	} else {
		if (['WORKFLOW_FAILED', 'PRESERVATION_FAILED', 'CORRUPTION_OBSERVED', 'HARNESS_BLOCKED', 'HARNESS_SUSPECT'].includes(evidence.summary?.verdict)) add(evidence.summary.verdict, evidence.summary.failure ?? 'scenario reported a failed contract');
		for (const related of evidence.relatedRevisions ?? []) {
			if (related.invalid.length) add('CORRUPTION_OBSERVED', 'invalid related notebook buffer: ' + related.file);
			if (related.preservation.length || related.rawChanges.length) add('PRESERVATION_FAILED', 'related notebook payload changed: ' + related.file);
			if (related.invalidDiskReads.length || related.malformedLines) add('HARNESS_SUSPECT', 'incomplete related notebook observation: ' + related.file);
		}
		if (evidence.revisions?.invalid.length || evidence.firstInvalid) add('CORRUPTION_OBSERVED', `root JSON invalid in ${evidence.revisions?.invalid.length ?? 0} revision(s)`);
		if (evidence.revisions?.invalidDiskReads?.length) add('HARNESS_SUSPECT', 'invalid disk checkpoint may overlap a native write; retained separately from buffer corruption');
		if (evidence.revisions?.preservation.length) add('PRESERVATION_FAILED', `${evidence.revisions.preservation.length} revision(s) violated result/attachment/order preservation`);
		if (evidence.revisions?.rawChanges?.length) add('PRESERVATION_FAILED', 'original serialized results changed (canonical content tracked separately)');
		if (evidence.revisions?.malformedLines) add('HARNESS_SUSPECT', `${evidence.revisions.malformedLines} malformed journal line(s)`);
		for (const operation of evidence.summary?.operations ?? []) if (operation?.success === false || operation?.error) add('WORKFLOW_FAILED', 'tool rejected: ' + clip(operation.name ?? 'unknown', 80));
		const journal = evidence.journal;
		for (const failure of journal?.harnessFailures ?? []) add('HARNESS_SUSPECT', /overflow/i.test(failure) ? 'journal overflow' : /worker/i.test(failure) ? 'journal worker failure' : 'journal harness failure');
		if ((journal?.metrics?.callbackMaximumMs ?? 0) > STALL_LIMIT_MS) add('HARNESS_SUSPECT', `observer callback stall ${Math.round(journal.metrics.callbackMaximumMs)}ms`);
		if ((journal?.metrics?.transportMaximumMs ?? 0) > STALL_LIMIT_MS) add('HARNESS_SUSPECT', 'journal transport exceeded one second');
		if ((journal?.metrics?.eventLoopMaximumMs ?? 0) > STALL_LIMIT_MS) add('HARNESS_SUSPECT', 'extension-host event loop exceeded one second (cause unproven)');
	}
	if (evidence.saveLogs.errors.length) add('WORKFLOW_FAILED_SAVE', `${evidence.saveLogs.errors.length} native Save listener error/ignored/blocklisted log line(s)`);
	if (evidence.summary?.verdict === 'FAULT_SCENARIO_BEHAVIOR_CONFIRMED' && results?.completed && cli.exitCode === 0
		&& flags.has('WORKFLOW_FAILED_SAVE') && [...flags].every(flag => flag === 'WORKFLOW_FAILED_SAVE')
		&& evidence.revisions?.texts > 0) {
		return { primary: 'EXPECTED_FAULT_CONFIRMED', flags: ['EXPECTED_SAVE_TIMEOUT'], nativeSaveError: true, reasons: ['fault-injected early-commit behavior confirmed; not a clean Save-health pass'] };
	}
	for (const step of results?.failedSteps ?? []) {
		if (/"success"\s*:\s*false|kusto-workbench_[\w-]+:\s*(Error|\{)/.test(step.error)) add('WORKFLOW_FAILED', 'registered tool rejection in failed step');
		else if (/First malformed notebook/i.test(step.error)) add('CORRUPTION_OBSERVED', 'failed step reported malformed notebook');
		else if (/tim(e|ed)[ -]?out/i.test(step.error)) add('HARNESS_BLOCKED', 'UI timeout blocker (label only, not causal): ' + clip(step.text, 120));
	}
	const explained = ['CORRUPTION_OBSERVED', 'PRESERVATION_FAILED', 'WORKFLOW_FAILED', 'WORKFLOW_FAILED_SAVE', 'HARNESS_BLOCKED'].some(flag => flags.has(flag));
	if (results && !results.completed && !explained) add('HARNESS_BLOCKED', 'unidentified test error');
	if (results?.completed && cli.exitCode !== 0 && !flags.size) add('HARNESS_BLOCKED', `CLI exit ${cli.exitCode} despite passing scenarios`);
	if (!flags.size) {
		if (legacy && results?.completed && cli.exitCode === 0 && evidence.legacy?.trace) return { primary: 'LEGACY_OBSERVATION_ONLY', flags: ['PRESERVATION_UNVERIFIED'], reasons: ['old workflow completed without exact per-section preservation assertions'] };
		const validated = legacy
			? Boolean(evidence.legacy?.trace && !evidence.legacy.trace.firstInvalid)
			: Boolean(verdictPasses(evidence.summary?.verdict) && evidence.revisions?.present && evidence.revisions.texts > 0);
		if (results?.completed && cli.exitCode === 0 && validated) return { primary: 'PASS_UNREVIEWED_VISUAL', flags: [], reasons: ['scenario completed, exact state validated, no Save errors; visuals not reviewed'] };
		add('HARNESS_BLOCKED', legacy ? 'legacy trace unavailable for exact-state validation' : 'lifecycle-summary verdict/revisions missing or not passing');
	}
	const primaryKey = PRIMARY_ORDER.find(flag => flags.has(flag));
	const primary = primaryKey.startsWith('WORKFLOW_FAILED') ? 'WORKFLOW_FAILED' : primaryKey.replace('_SETUP', '');
	const publicFlags = [...new Set([...flags].map(flag => flag === 'WORKFLOW_FAILED_SAVE' ? 'WORKFLOW_FAILED' : flag.replace('_SETUP', '')))];
	return { primary, flags: publicFlags, nativeSaveError: flags.has('WORKFLOW_FAILED_SAVE'), reasons };
}

	export function finalizeAttemptEvidence(context, collect = collectEvidence) {
		const record = { evidence: { cli: context.cli } };
		try {
			record.evidence = collect(context);
			return { ...record, ...classify(record.evidence, context.legacy) };
		} catch (error) {
			return {
				...record, analysisError: clip(error.message, 1000), primary: 'HARNESS_SUSPECT',
				flags: ['HARNESS_SUSPECT'], reasons: ['Evidence collection or classification failed after CLI execution'],
			};
		}
	}

async function runAttempt(campaign, arm, index) {
	const { options, editor, vsixInfo, controllerInfo, assets, vsixCopy, env, baseline } = campaign;
	const attemptId = `${campaign.id}-r${arm.repeat}-${arm.autoSave}`;
	const attemptDir = path.join(campaign.dir, 'a' + index);
	const record = { attemptId, index, repeat: arm.repeat, autoSave: arm.autoSave, observation: options.observation, dir: attemptDir, startedAt: new Date().toISOString(), setup: {} };
	fs.mkdirSync(attemptDir);
	try {
		verifyAssets(assets, vsixCopy, vsixInfo.sha256);
		record.setup.seedCheck = assertSeedsInactive({ seedProfile: options.seedProfile, seedAuth: options.seedAuth });
		const driverDir = path.join(attemptDir, options.observation === 'legacy' ? 'published-corruption-driver-' + randomBytes(2).toString('hex') : 'd');
		fs.mkdirSync(driverDir);
		fs.writeFileSync(path.join(driverDir, 'package.json'), JSON.stringify({ name: 'published-corruption-driver', publisher: 'workbench-test', version: '0.0.0', engines: { vscode: '^1.107.0' }, main: './extension.js', activationEvents: [], contributes: {} }, null, 2), { flag: 'wx' });
		fs.writeFileSync(path.join(driverDir, 'extension.js'), 'exports.activate = () => {};\n', { flag: 'wx' });
		const testerRoot = path.join(driverDir, 'tests/vscode-extension-tester');
		const profileDir = path.join(testerRoot, 'profiles', PROFILE_NAME);
		const userData = path.join(profileDir, 'user-data');
		const extensionsDir = path.join(profileDir, 'extensions');
		const authShared = path.join(testerRoot, 'auth-shared');
		const sharedData = path.join(authShared, 'shared-data');
		for (const directory of [userData, extensionsDir, sharedData]) fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({ name: PROFILE_NAME, created: new Date().toISOString() }, null, 2), { flag: 'wx' });
		record.driverDir = driverDir;
		record.setup.seedSnapshot = snapshotSeeds(options, userData, authShared);
		const settingsFile = path.join(userData, 'User/settings.json');
		const { settings, droppedKeys } = buildSettings(campaign.originalSettings, arm.autoSave);
		fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { flag: 'wx' });
		record.setup.settings = { path: settingsFile, sha256: sha256File(settingsFile), values: settings, droppedKeys };
		const common = [`--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`, `--shared-data-dir=${sharedData}`];
		record.setup.installs = [
			runEditorCli(editor, [...common, '--install-extension', campaign.controllerVsix], path.join(attemptDir, 'install-controller.log'), env.env),
			runEditorCli(editor, [...common, '--install-extension', vsixCopy], path.join(attemptDir, 'install-workbench.log'), env.env),
		];
		const registry = readJson(path.join(extensionsDir, 'extensions.json'));
		const registered = id => registry.find(entry => entry.identifier?.id?.toLowerCase() === id.toLowerCase());
		const workbench = registered(WORKBENCH_ID);
		const controller = registered(CONTROLLER_ID);
		if (!workbench || workbench.version !== vsixInfo.version) throw new Error('Workbench not registered at VSIX version in extensions.json');
		if (!controller || controller.version !== controllerInfo.version) throw new Error('Controller not registered at bundled version in extensions.json');
		const installedPath = path.join(extensionsDir, workbench.relativeLocation);
		const installedManifest = readJson(path.join(installedPath, 'package.json'));
		const installedMain = path.join(installedPath, vsixInfo.mainEntry.slice('extension/'.length));
		const installedMainSha = sha256File(installedMain);
		if (installedManifest.version !== vsixInfo.version || installedMainSha !== vsixInfo.mainSha256) throw new Error('Installed Workbench entry does not match VSIX entry');
		const installedTree = hashInstalledTree(installedPath, vsixInfo.topFolder);
		if (installedTree.treeSha256 !== vsixInfo.treeSha256) throw new Error(`Installed ${vsixInfo.topFolder} tree does not match VSIX`);
		record.setup.installed = {
			workbench: { path: installedPath, version: installedManifest.version, main: installedMain, mainSha256: installedMainSha, ...installedTree },
			controller: { path: path.join(extensionsDir, controller.relativeLocation), version: controller.version },
		};
		const evidenceRoot = path.join(attemptDir, 'evidence');
		const fixtureParent = path.join(attemptDir, 'fixtures');
		fs.mkdirSync(evidenceRoot);
		fs.mkdirSync(fixtureParent);
		const legacy = options.observation === 'legacy';
		const cliArgs = [options.cli, 'run', '--features', assets.featureDir, '--extension-path', driverDir, '--reuse-named-profile', PROFILE_NAME, '--vscode-version', options.vscodeVersion, '--no-build', '--timeout', String(STEP_TIMEOUT_MS)];
		if (options.cdpPort !== null) cliArgs.push('--cdp-port', String(options.cdpPort));
		if (!legacy) {
			const configFile = path.join(attemptDir, 'replay-config.json');
			const config = {
				schemaVersion: 1, attemptId, cdpPort: options.cdpPort, frameworkRunsRoot: path.join(testerRoot, 'runs'), profileHostCpu: options.profileHostCpu,
				evidenceRoot: fs.realpathSync(evidenceRoot), fixtureParent: fs.realpathSync(fixtureParent),
				mode: options.observation,
				expectedExtensionVersion: vsixInfo.version, expectedExtensionPath: fs.realpathSync(installedPath), expectedExtensionSha256: installedMainSha,
				expectedEditorVersion: options.vscodeVersion,
				helperPath: assets.helper, helperSha256: assets.helperSha256, featureSha256: assets.featureSha256,
				autoSave: arm.autoSave, autoSaveDelay: 1000,
				baselineInitialHash: baseline.initialHash,
				packageIdentity: campaign.packageIdentity,
			};
			fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
			record.setup.config = { path: configFile, sha256: sha256File(configFile) };
			cliArgs.push('--env', `KW_PUBLISHED_REPLAY_CONFIG=${configFile}`);
		}
		record.command = { executable: process.execPath, args: cliArgs, cwd: REPO_ROOT, droppedEnvKeys: env.dropped };
		writeJsonAtomic(path.join(attemptDir, 'attempt.json'), record);
		if (options.prepareOnly) {
		 Object.assign(record, { primary: 'PREPARED', flags: [], reasons: ['Isolated profile prepared; no lifecycle executed'], finishedAt: new Date().toISOString() });
		 writeJsonAtomic(path.join(attemptDir, 'attempt.json'), record);
		 return record;
		}
		const cli = await runVscodeExtTest(cliArgs, REPO_ROOT, env.env, path.join(attemptDir, 'cli-stdout.log'), path.join(attemptDir, 'cli-stderr.log'));
		Object.assign(record, finalizeAttemptEvidence({ attemptDir, driverDir, evidenceRoot, fixtureParent, legacy, cli }));
		if (options.profileHostCpu) {
			const file = path.join(evidenceRoot, 'extension-host.cpuprofile');
			record.profile = { requested: true, instrumented: true, complete: fs.existsSync(file), admissibleTiming: false, file, scope: 'entire isolated extension-host process, including test controller' };
		}
	} catch (error) {
		record.setupError = clip(error.message, 1000);
		Object.assign(record, { primary: 'HARNESS_BLOCKED', flags: ['HARNESS_BLOCKED'], reasons: ['HARNESS_BLOCKED: setup failed: ' + record.setupError] });
	}
	record.finishedAt = new Date().toISOString();
	writeJsonAtomic(path.join(attemptDir, 'attempt.json'), record);
	return record;
}

async function main() {
	let options;
	try { options = parseArgs(process.argv.slice(2)); } catch (error) {
		if (error instanceof UsageError) { console.error(error.message + '\n\n' + HELP); process.exitCode = 2; return; }
		throw error;
	}
	if (options.help) { console.log(HELP); return; }
	if (process.platform !== 'win32') throw new Error('This runner targets the cached Windows portable editor only');

	if (!fs.existsSync(options.vsix)) throw new Error('VSIX not found: ' + options.vsix);
	const vsixSha = sha256File(options.vsix);
	if (vsixSha !== options.expectedSha) throw new Error(`VSIX SHA-256 ${vsixSha} does not match --expected-sha ${options.expectedSha}`);
	 const vsixInfo = { path: options.vsix, sha256: vsixSha, ...await inspectVsix(options.vsix) };
	if (vsixInfo.id.toLowerCase() !== WORKBENCH_ID || !vsixInfo.mainEntry || !vsixInfo.treeSha256) throw new Error('VSIX is not an installable Workbench package: ' + vsixInfo.id);

	if (!fs.existsSync(options.cli)) throw new Error('vscode-ext-test CLI not found: ' + options.cli);
	const cliRoot = path.dirname(path.dirname(options.cli));
	const cliPackage = readJson(path.join(cliRoot, 'package.json'));
	const controllerVsix = path.join(cliRoot, 'assets/controller-extension.vsix');
	 const controllerInfo = { path: controllerVsix, sha256: sha256File(controllerVsix), ...await inspectVsix(controllerVsix) };
	if (controllerInfo.id.toLowerCase() !== CONTROLLER_ID || controllerInfo.version !== EXPECTED_CONTROLLER_VERSION) throw new Error(`Bundled controller is ${controllerInfo.id}@${controllerInfo.version}; expected ${CONTROLLER_ID}@${EXPECTED_CONTROLLER_VERSION}`);

	const editor = inspectEditor(options.vscodeVersion);
	for (const required of [path.join(options.seedProfile, 'user-data/Local State'), path.join(options.seedProfile, 'user-data/User/globalStorage/state.vscdb'), path.join(options.seedAuth, 'Local State')]) {
		if (!fs.existsSync(required)) throw new Error('Seed file missing: ' + required);
	}
	const originalSettings = readJson(options.originalSettings);
	if (!originalSettings || typeof originalSettings !== 'object' || Array.isArray(originalSettings)) throw new Error('Original settings must be a JSON object');
	const baseline = fs.existsSync(options.baselineRun) ? recoverBaselineHash(options.baselineRun) : { initialHash: null, source: null, reason: 'baseline run not found' };
	const outputParent = prepareOutputParent(options.outputParent);
	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
	const id = `c${stamp}${randomBytes(2).toString('hex')}`;
	const dir = path.join(outputParent, id);
	fs.mkdirSync(dir);
	const assetsDir = path.join(dir, 'assets');
	fs.mkdirSync(assetsDir);
	const vsixCopy = path.join(assetsDir, path.basename(options.vsix));
	fs.copyFileSync(options.vsix, vsixCopy, fs.constants.COPYFILE_EXCL);
	if (sha256File(vsixCopy) !== vsixSha) throw new Error('Campaign VSIX copy hash mismatch');
	const controllerCopy = path.join(assetsDir, 'controller-extension.vsix');
	fs.copyFileSync(controllerVsix, controllerCopy, fs.constants.COPYFILE_EXCL);
	const assets = stageAssets(options, assetsDir);
	const env = childEnv();
	const packageIdentity = {
		vsixSha256: vsixSha, vsixVersion: vsixInfo.version, vsixMainEntry: vsixInfo.mainEntry, vsixMainSha256: vsixInfo.mainSha256, vsixTreeSha256: vsixInfo.treeSha256,
		controllerVsixSha256: controllerInfo.sha256, controllerVersion: controllerInfo.version,
		cliVersion: cliPackage.version, cliPath: options.cli,
		editorVersion: editor.version, editorCommit: editor.commit,
	};
	const manifestFile = path.join(dir, 'manifest.json');
	const manifest = {
		schemaVersion: 1, campaignId: id, createdAt: new Date().toISOString(), dir,
		options,
		toolchain: { node: process.version, cli: { path: options.cli, version: cliPackage.version, binSha256: sha256File(options.cli) }, editor, controller: controllerInfo },
		source: gitInfo(),
		vsix: { ...vsixInfo, campaignCopy: vsixCopy },
		assets: { files: assets.files, featureSha256: assets.featureSha256, helperSha256: assets.helperSha256, legacyKnownCeb1477a: options.observation === 'legacy' ? assets.featureSha256.startsWith('ceb1477a') : null },
		baseline, originalSettings: { path: options.originalSettings, sha256: sha256File(options.originalSettings) },
		packageIdentity, droppedEnvKeys: env.dropped, attempts: [],
	};
	writeJsonAtomic(manifestFile, manifest);
	console.log(`Campaign ${id}: ${options.observation}, autosave ${options.autosave}, repeats ${options.repeats}, VSIX ${vsixInfo.version} (${vsixSha.slice(0, 12)}), editor ${editor.version}/${editor.commit.slice(0, 10)}`);

	const campaign = { id, dir, options, editor, vsixInfo, controllerInfo, controllerVsix: controllerCopy, assets, vsixCopy, env, baseline, originalSettings, packageIdentity };
	const arms = armsFor(options);
	let index = 0;
	for (const arm of arms) {
		index++;
		const record = await runAttempt(campaign, arm, index);
		manifest.attempts.push({ attemptId: record.attemptId, dir: record.dir, repeat: arm.repeat, autoSave: arm.autoSave, primary: record.primary, flags: record.flags, exitCode: record.evidence?.cli?.exitCode ?? null });
		writeJsonAtomic(manifestFile, manifest);
		const duration = record.evidence?.cli?.durationMs ? `${Math.round(record.evidence.cli.durationMs / 1000)}s` : '-';
		console.log(`[${index}/${arms.length}] r${arm.repeat} ${arm.autoSave.padEnd(10)} ${record.primary.padEnd(22)} flags=${record.flags.join(',') || '-'} exit=${record.evidence?.cli?.exitCode ?? '-'} ${duration} ${record.dir}`);
		if (record.setupError) { console.log('    setup: ' + record.setupError); break; }
		if (record.primary === 'HARNESS_BLOCKED') break;
	}
	manifest.finishedAt = new Date().toISOString();
	manifest.allPassed = manifest.attempts.every(attempt => attempt.primary === 'PASS_UNREVIEWED_VISUAL');
	writeJsonAtomic(manifestFile, manifest);
	console.log('Manifest: ' + manifestFile);
	 process.exitCode = manifest.allPassed || options.prepareOnly && manifest.attempts.every(attempt => attempt.primary === 'PREPARED') ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
	console.error('BOOTSTRAP ERROR: ' + clip(error.message, 1000));
	process.exitCode = 2;
});
