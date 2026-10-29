#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, types } from 'node:util';

const require = createRequire(import.meta.url);
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
const ACCEPTANCE_FEATURE_DIR = path.join(REPO_ROOT, 'tests/vscode-extension-tester/e2e/default/workbench-tool-session-activation-sweep');
const ACCEPTANCE_MARKER = '.kw-acceptance-owner.json';
const GROWTH_BEFORE_SHA = '331e3286dfd174915b2242b0bbd3f0a3d15446ec4d9091c68280aee6b5e3d309';
const CURRENT_BEFORE_SHA = 'c5d02675d4702277a1769ec7f4fca0bd6948174ef9a4b37e72e2f9f0a89bc52f';
const CURRENT_ORDER_SHA = 'beb28ac6c192b8b8daf9f8e777ee1d0ebe0c702bc84ed8f68350e8f88d9ef60a';
const CANARY_PATH = 'extension-regression-2026-10-07.kqlx';
const CANARY_SHA = 'eeafb29fdb57398dbb6e2a83a7aec0fd5b2cc658f12e156f671fdfee144f51e0';
const ACCEPTANCE_CONTROL_PHASES = ['cold-controls', 'cold-menu', 'cold-escape', 'historical-83', 'historical-88', 'historical-109', 'reopened-controls', 'second-interaction'];
const PRIMARY_ORDER = ['CORRUPTION_OBSERVED', 'WORKFLOW_FAILED_SAVE', 'PRESERVATION_FAILED', 'HARNESS_BLOCKED_SETUP', 'WORKFLOW_FAILED', 'HARNESS_SUSPECT', 'HARNESS_BLOCKED'];

const HELP = `Usage: node scripts/repro-published-notebook.mjs --vsix <path> --expected-sha <sha256> [options]

Opt-in, sequential, bounded replay of the published-notebook corruption scenario.
Each attempt gets a fresh driver/profile. Acceptance never reads auth/profile seeds, retries notebook operations, or deletes notebook files.
Journal replacement alone retries transient Windows errors with bounded backoff.

Required:
  --vsix <path>              Workbench VSIX to install (hash-verified).
  --expected-sha <sha256>    Expected SHA-256 of the VSIX.

Options:
	--acceptance <mode>         original109: old131 strict native/full gate; current133-api: Wave3 readonly API gate.
	--before-archive <zip>      Immutable old131 or exact Wave3 current133 before-images + baseline.json.
	--order-archive <zip>       Private October 7 recorded original109 order; acceptance only.
														 Acceptance defaults: cached 1.141.0, repeats 1, Auto Save afterDelay.
														 No setup Save, archive rebaseline, or mutation/Save retries.
														 original109 is cold-first; current133-api explicitly starts the archived warm report.
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
	                           Required for original109 native proof, not current133-api. Neither mode reads profile/auth seeds.
	--profile-host-cpu         Capture the isolated extension host CPU profile (diagnostic timing only).
  --help                     Show this help.

Outcomes: API_PRESERVATION_VERIFIED_NOT_RELEASE (no pixels/native authoring/release qualification),
PASS_UNREVIEWED_VISUAL, CORRUPTION_OBSERVED, PRESERVATION_FAILED, WORKFLOW_FAILED, HARNESS_SUSPECT, HARNESS_BLOCKED.
Exit code 0 for complete API preservation or when every full attempt is PASS_UNREVIEWED_VISUAL;
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
	for (let attempt = 0; attempt <= 3; attempt++) {
		try {
			fs.renameSync(temporary, file);
			return;
		} catch (error) {
			if (process.platform !== 'win32' || attempt === 3 || !error || typeof error !== 'object'
				|| (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
		}
	}
};

export function parseArgs(argv) {
	const names = new Set(['vsix', 'expected-sha', 'vscode-version', 'repeats', 'autosave', 'observation', 'legacy-feature', 'output-parent', 'seed-profile', 'seed-auth', 'feature-dir', 'original-settings', 'baseline-run', 'cli', 'cdp-port', 'acceptance', 'before-archive', 'order-archive']);
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
	const acceptance = values.acceptance ?? null;
	if (acceptance !== null && !['original109', 'current133-api'].includes(acceptance)) throw new UsageError('--acceptance must be original109 or current133-api');
	if (acceptance && (!values['before-archive'] || !values['order-archive'])) throw new UsageError(acceptance + ' acceptance requires --before-archive and --order-archive');
	if (!acceptance && (values['before-archive'] || values['order-archive'])) throw new UsageError('Private archives require explicit --acceptance original109 or current133-api');
	const repeats = Number(values.repeats ?? (acceptance ? 1 : DEFAULTS.repeats));
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new UsageError('--repeats must be an integer from 1 to 3');
	const autosave = values.autosave ?? (acceptance ? 'afterDelay' : DEFAULTS.autosave);
	if (!['both', 'afterDelay', 'off'].includes(autosave)) throw new UsageError('--autosave must be both, afterDelay, or off');
	const observation = values.observation ?? DEFAULTS.observation;
	if (!['diagnostic', 'minimal', 'legacy'].includes(observation)) throw new UsageError('--observation must be diagnostic, minimal, or legacy');
	if (observation === 'legacy' && !values['legacy-feature']) throw new UsageError('--legacy-feature is required with --observation legacy');
	if (observation !== 'legacy' && values['legacy-feature']) throw new UsageError('--legacy-feature is only valid with --observation legacy');
	if (observation === 'legacy' && values.profileHostCpu) throw new UsageError('--profile-host-cpu is unavailable with legacy observation');
	if (acceptance && (autosave !== 'afterDelay' || observation !== 'diagnostic' || values.profileHostCpu)) throw new UsageError('original109 acceptance requires Auto Save afterDelay and diagnostic observation without CPU profiling');
	if (acceptance && repeats !== 1) throw new UsageError('original109 acceptance runs one fresh attempt; repeats cannot disguise earlier failures');
	const vscodeVersion = values['vscode-version'] ?? (acceptance ? '1.141.0' : DEFAULTS.vscodeVersion);
	if (!/^\d+\.\d+\.\d+$/.test(vscodeVersion)) throw new UsageError('--vscode-version must be an exact x.y.z version');
	const cdpPort = values['cdp-port'] === undefined ? null : Number(values['cdp-port']);
	if (cdpPort !== null && (!/^\d+$/.test(values['cdp-port']) || !Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535)) throw new UsageError('--cdp-port must be an integer from 1024 to 65535');
	const resolve = (name, fallback) => path.resolve(REPO_ROOT, values[name] ?? fallback);
	return {
		acceptance, beforeArchive: values['before-archive'] ? path.resolve(values['before-archive']) : null,
		orderArchive: values['order-archive'] ? path.resolve(values['order-archive']) : null,
		vsix: path.resolve(values.vsix),
		expectedSha: values['expected-sha'].toLowerCase(),
		vscodeVersion, repeats, autosave, observation, cdpPort, prepareOnly: values.prepareOnly === true, profileHostCpu: values.profileHostCpu === true,
		legacyFeature: values['legacy-feature'] ? path.resolve(values['legacy-feature']) : null,
		outputParent: resolve('output-parent', acceptance ? os.tmpdir() : DEFAULTS.outputParent),
		seedProfile: resolve('seed-profile', DEFAULTS.seedProfile),
		seedAuth: resolve('seed-auth', DEFAULTS.seedAuth),
		featureDir: resolve('feature-dir', acceptance ? ACCEPTANCE_FEATURE_DIR : DEFAULTS.featureDir),
		originalSettings: resolve('original-settings', DEFAULTS.originalSettings),
		baselineRun: resolve('baseline-run', DEFAULTS.baselineRun),
		cli: resolve('cli', DEFAULTS.cli),
	};
}

function archiveRelativePath(value) {
	if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes(':') || /[\x00-\x1f<>"|?*]/.test(value)
		|| path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Unsafe archive path: ' + value);
	const segments = value.split('/');
	if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
		|| /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Windows alias or traversal archive path: ' + value);
	return value;
}

export function validateActivationOrder(order) {
	if (!Array.isArray(order) || order.length !== 109) throw new Error('Recorded activation order must contain exactly 109 primary targets');
	const validated = order.map(archiveRelativePath);
	if (new Set(validated.map(value => value.toLowerCase())).size !== 109) throw new Error('Recorded order contains duplicate / Windows alias paths');
	if (validated.some(value => !/\.(kqlx|sqlx|mdx|kql|csl|sql|md)$/i.test(value))) throw new Error('Recorded order contains a sidecar or unsupported primary path');
	if (validated[82] !== 'past/azure-mcp-growth-analysis.kqlx' || validated[87] !== 'past/azure-mcp-vs-tool-calls-investigation.kqlx'
		|| validated[108] !== 'upgraded-kql-files/historical_success_rate copy.kql') throw new Error('Recorded original109 sentinel order differs at target 83, 88, or 109');
	return validated;
}

function assertCanonicalDirectory(directory) {
	const resolved = path.resolve(directory);
	const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
	for (let current = resolved; ; current = path.dirname(current)) {
		const stat = fs.lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing link/junction or non-directory root: ' + current);
		if (path.dirname(current) === current) break;
	}
	const canonical = fs.realpathSync.native(resolved);
	if (compare(canonical) !== compare(resolved)) throw new Error('Refusing noncanonical / alias root: ' + directory);
	return canonical;
}

export function createAcceptanceRoot(parent = os.tmpdir()) {
	const temp = assertCanonicalDirectory(os.tmpdir());
	if (path.resolve(parent).toLowerCase() !== temp.toLowerCase()) throw new Error('Acceptance roots require the canonical TEMP parent, not an existing campaign root');
	const root = assertCanonicalDirectory(fs.mkdtempSync(path.join(temp, 'kw-acceptance-')));
	const owner = { schemaVersion: 1, root, marker: randomBytes(24).toString('hex') };
	fs.writeFileSync(path.join(root, ACCEPTANCE_MARKER), JSON.stringify(owner), { flag: 'wx' });
	return owner;
}

export function assertAcceptanceRoot(owner) {
	if (!owner || typeof owner.root !== 'string') throw new Error('Acceptance root owner missing');
	const root = assertCanonicalDirectory(owner.root);
	const temp = assertCanonicalDirectory(os.tmpdir());
	if (path.dirname(root).toLowerCase() !== temp.toLowerCase() || !/^kw-acceptance-[A-Za-z0-9]+$/.test(path.basename(root))) throw new Error('Acceptance root is not a fresh canonical TEMP child');
	const markerFile = path.join(root, ACCEPTANCE_MARKER);
	const stat = fs.lstatSync(markerFile);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Acceptance ownership marker is aliased');
	const marker = readJson(markerFile);
	if (marker.schemaVersion !== 1 || marker.root !== owner.root || marker.marker !== owner.marker || !/^[0-9a-f]{48}$/.test(owner.marker ?? '')) throw new Error('Acceptance ownership marker mismatch');
	return root;
}

function validateArchivedLinks(files, images) {
	const inventory = new Map(files.map(file => [file.path.toLowerCase(), file.path]));
	const linkedTargets = [];
	for (const file of files) {
		if (!/\.(kqlx|sqlx|mdx|(?:kql|csl|sql)\.json)$/i.test(file.path)) continue;
		const text = images.get(file.path).toString('utf8').replace(/^\uFEFF/, '');
		if (!text.trim()) continue;
		const sections = JSON.parse(text).state?.sections;
		if (!Array.isArray(sections)) continue;
		for (const [sectionIndex, section] of sections.entries()) {
			if (!section || !Object.hasOwn(section, 'linkedQueryPath')) continue;
			if (typeof section.linkedQueryPath !== 'string') throw new Error('Invalid archived linkedQueryPath: ' + file.path);
			const linkedPath = section.linkedQueryPath.trim();
			if (!linkedPath) continue;
			if (linkedPath.includes(':') || /[\x00-\x1f<>"|?*]/.test(linkedPath)
				|| path.posix.isAbsolute(linkedPath) || path.win32.isAbsolute(linkedPath)
				|| linkedPath.split(/[\\/]/).some(segment => segment === '..' || segment === '')) throw new Error('Unsafe archived linked query relative path / traversal: ' + file.path);
			const nativePath = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), linkedPath));
			const resolved = path.win32.normalize(nativePath).split('\\').join('/');
			let target;
			try { target = inventory.get(archiveRelativePath(resolved).toLowerCase()); }
			catch { throw new Error('Unsafe archived linked query target path: ' + file.path); }
			if (!target || !/\.(kql|csl|sql)$/i.test(target) || target.toLowerCase() === file.path.toLowerCase()) throw new Error('Archived linked query target is not a separately archived plain-query inventory file: ' + file.path);
			linkedTargets.push({ source: file.path, sectionIndex, linkedQueryPath: section.linkedQueryPath, target });
		}
	}
	return linkedTargets;
}

export function validateBeforeImages(baseline, images, activationOrder, mode = 'original109') {
	const order = validateActivationOrder(activationOrder);
	if (!['original109', 'current133-api'].includes(mode)) throw new Error('Unsupported immutable archive mode');
	const sourceCount = mode === 'current133-api' ? 133 : 131;
	if (!Array.isArray(baseline?.files) || baseline.files.length !== sourceCount || !(images instanceof Map) || images.size !== sourceCount) throw new Error('Before-image baseline / archive must contain all ' + sourceCount + ' sources');
	const paths = new Set();
	const files = baseline.files.map(record => {
		const relative = archiveRelativePath(record.path);
		if (paths.has(relative.toLowerCase())) throw new Error('Duplicate / Windows alias before-image path: ' + relative);
		paths.add(relative.toLowerCase());
		const bytes = images.get(relative);
		if (!Buffer.isBuffer(bytes)) throw new Error('Before-image missing: ' + relative);
		if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || bytes.length !== record.bytes
			|| !/^[0-9a-f]{64}$/i.test(record.sha256 ?? '') || sha256(bytes) !== record.sha256.toLowerCase()) throw new Error('Before-image byte/hash mismatch: ' + relative);
		return { path: relative, bytes: record.bytes, sha256: record.sha256.toLowerCase() };
	});
	for (const relative of order) if (!images.has(relative)) throw new Error('Recorded original109 target missing from before-images: ' + relative);
	const sidecars = files.filter(file => /\.(kql|csl|sql)\.json$/i.test(file.path));
	const primaries = files.filter(file => /\.(kqlx|sqlx|mdx|kql|csl|sql|md)$/i.test(file.path));
	for (const file of sidecars) if (!images.has(file.path.slice(0, -5))) throw new Error('Before-image sidecar has no separate primary: ' + file.path);
	return { mode, files, primaries, sidecars, activationOrder: order, linkedTargets: validateArchivedLinks(files, images) };
}

export function stageBeforeImages(owner, plan, images) {
	const root = assertAcceptanceRoot(owner);
	const validated = validateBeforeImages({ files: plan.files }, images, plan.activationOrder, plan.mode);
	const legacyPath = archiveRelativePath(plan.legacyPath ?? 'extension-fix-validation-empty-legacy-2026-09-12.kqlx');
	const legacy = validated.files.find(file => file.path === legacyPath);
	const sections = JSON.parse(images.get(legacyPath)?.toString('utf8') ?? 'null')?.state?.sections;
	if (legacy?.bytes !== 498 || sections?.length !== 1 || sections[0].type !== 'query' || sections[0].query !== ''
		|| sections[0].expanded !== true || sections[0].favoritesMode !== true || typeof sections[0].id !== 'string' || !sections[0].id) throw new Error('Cold canary requires the exact 498-byte archived legacy Query identity');
	const historyRoot = path.join(root, 'history');
	fs.mkdirSync(historyRoot);
	for (const file of plan.files) {
		const target = path.join(historyRoot, file.path);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, images.get(file.path), { flag: 'wx' });
		if (sha256File(target) !== file.sha256) throw new Error('Staged before-image is not byte-identical: ' + file.path);
	}
	const coldRoot = path.join(root, 'cold-canary');
	fs.mkdirSync(coldRoot);
	assertCanonicalDirectory(coldRoot);
	const filePath = path.join(coldRoot, path.basename(legacyPath));
	const sourceUri = pathToFileURL(path.join(historyRoot, legacyPath)).href;
	fs.copyFileSync(fileURLToPath(sourceUri), filePath, fs.constants.COPYFILE_EXCL);
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== legacy.bytes || sha256File(filePath) !== legacy.sha256) throw new Error('Cold canary copy is aliased or not byte-identical');
	assertAcceptanceRoot(owner);
	const coldCanary = { count: 1, root: coldRoot, rootMarker: owner.marker, filePath, path: path.relative(root, filePath).split(path.sep).join('/'),
		uri: pathToFileURL(filePath).href, sourcePath: legacyPath, sourceUri, bytes: legacy.bytes, sha256: legacy.sha256, sectionId: sections[0].id };
	return { historyRoot, coldCanary, files: validated.files, primaries: validated.primaries, sidecars: validated.sidecars, activationOrder: validated.activationOrder, linkedTargets: validated.linkedTargets };
}

export function inspectAcceptanceColdCanary(owner, historyRoot, canary, files) {
	const root = assertAcceptanceRoot(owner);
	const source = files.find(file => file.path === canary?.sourcePath);
	if (!source || canary.count !== 1 || canary.rootMarker !== owner.marker || canary.bytes !== 498
		|| source.bytes !== canary.bytes || source.sha256 !== canary.sha256) throw new Error('Cold canary source/count/hash/ownership contract mismatch');
	const coldRoot = path.join(root, 'cold-canary');
	const filePath = path.join(coldRoot, path.basename(archiveRelativePath(source.path)));
	const sourcePath = path.join(historyRoot, source.path);
	if (path.resolve(historyRoot) !== path.join(root, 'history') || canary.root !== coldRoot || canary.filePath !== filePath
		|| canary.path !== path.relative(root, filePath).split(path.sep).join('/')) throw new Error('Cold canary must use its exclusive private root outside history');
	for (const [uri, expected] of [[canary.uri, filePath], [canary.sourceUri, sourcePath]]) {
		const url = new URL(uri);
		if (url.search || url.hash || path.resolve(fileURLToPath(url)).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Cold canary URI/source path linkage mismatch');
	}
	for (const target of [filePath, sourcePath]) {
		assertCanonicalDirectory(path.dirname(target));
		const stat = fs.lstatSync(target);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== source.bytes || sha256File(target) !== source.sha256) throw new Error('Cold canary or archived source became aliased or changed exact bytes');
	}
	const sections = JSON.parse(fs.readFileSync(filePath, 'utf8')).state?.sections;
	if (sections?.length !== 1 || sections[0].id !== canary.sectionId || sections[0].type !== 'query' || sections[0].query !== ''
		|| sections[0].expanded !== true || sections[0].favoritesMode !== true) throw new Error('Cold canary lost the exact archived Query identity');
	return { ...canary, verified: true, markerVerified: true, aliasFree: true, sourceSha256: source.sha256 };
}

export async function inspectAcceptanceArchives(beforeArchive, orderArchive, mode = 'original109') {
	const beforeSha256 = sha256File(beforeArchive);
	const orderSha256 = sha256File(orderArchive);
	if (mode === 'current133-api' && beforeSha256 !== CURRENT_BEFORE_SHA) throw new Error('Current133 requires the immutable Wave3 archive, never modified local files');
	const before = await openZip(beforeArchive);
	let recorded;
	try {
		recorded = await openZip(orderArchive);
		const baseline = JSON.parse((await before.read('baseline.json')).toString('utf8'));
		const outcomes = JSON.parse((await recorded.read('evidence/run-outcomes.json')).toString('utf8'));
		const activationOrder = validateActivationOrder(outcomes.activationOrder);
		if (mode === 'current133-api') {
			const checkpoint = JSON.parse((await before.read('evidence/full-load-checkpoint.json')).toString('utf8'));
			if (sha256(JSON.stringify(activationOrder)) !== CURRENT_ORDER_SHA || !isDeepStrictEqual(checkpoint.activationOrder, activationOrder)) throw new Error('Wave3 checkpoint and immutable October7 original109 order differ');
		}
		const images = new Map();
		for (const name of before.names.filter(name => name.startsWith('before/') && !name.endsWith('/'))) {
			const relative = archiveRelativePath(name.slice('before/'.length));
			const entry = before.entry(name);
			const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
			if (unixType !== 0 && unixType !== 0x8000 || entry.uncompressedSize > 64 * 1024 * 1024) throw new Error('Linked or oversized before-image ZIP entry: ' + relative);
			images.set(relative, await before.read(name));
		}
		const plan = validateBeforeImages(baseline, images, activationOrder, mode);
		const growth = images.get(activationOrder[82]);
		if (mode === 'original109' && sha256(growth) !== GROWTH_BEFORE_SHA) throw new Error('Growth before-image differs from the incident SHA; never substitute the current after-image');
		const legacyPath = 'extension-fix-validation-empty-legacy-2026-09-12.kqlx';
		const legacy = images.get(legacyPath);
		if (legacy?.length !== 498) throw new Error('Cold-first legacy before-image must be exactly 498 bytes');
		const sections = JSON.parse(legacy.toString('utf8')).state?.sections;
		if (sections?.length !== 1 || sections[0].type !== 'query' || sections[0].query !== '' || sections[0].expanded !== true || sections[0].favoritesMode !== true) throw new Error('Cold-first legacy before-image is not one expanded blank Query/Favorites');
		const structuredCount = plan.files.filter(file => /\.(kqlx|sqlx|mdx|(?:kql|csl|sql)\.json)$/i.test(file.path)).length;
		let archivedCanary;
		if (mode === 'current133-api') {
			const bytes = images.get(CANARY_PATH);
			if (structuredCount !== 101 || bytes?.length !== 28864 || sha256(bytes) !== CANARY_SHA) throw new Error('Immutable structured101 / archived canary28864 identity mismatch');
			const canarySections = JSON.parse(bytes.toString('utf8')).state.sections;
			const html = canarySections.find(section => section.type === 'html');
			const provenance = JSON.parse(html.code.match(/<script[^>]*type=["']application\/kw-provenance["'][^>]*>([\s\S]*?)<\/script>/i)[1]);
			const fact = canarySections.find(section => section.id === provenance.model.fact.sectionId);
			archivedCanary = { path: CANARY_PATH, count: 1, bytes: bytes.length, sha256: CANARY_SHA,
				sectionIds: canarySections.map(section => section.id), note: canarySections.find(section => section.type === 'devnotes').entries[0],
				factSectionId: fact.id, htmlSectionId: html.id, factColumns: JSON.parse(fact.resultJson).columns, bindingIds: Object.keys(provenance.bindings),
				resultGraphSha256: sha256(JSON.stringify(canarySections)),
				protectedResults: canarySections.filter(section => typeof section.resultJson === 'string').map(section => ({ sectionId: section.id, rawSha256: sha256(section.resultJson) })) };
		}
		if (sha256File(beforeArchive) !== beforeSha256 || sha256File(orderArchive) !== orderSha256) throw new Error('Read-only acceptance archives changed while reading');
		return { ...plan, images, legacyPath, legacySectionId: sections[0].id, ...(archivedCanary ? { archivedCanary } : {}), archive: { verified: true, immutableBeforeImages: true,
			beforeSha256, orderSha256, baselineCount: baseline.files.length, sourceCount: plan.files.length, structuredCount, sidecarsSeparate: true, orderKey: 'activationOrder', linksConfined: true, linkedTargetCount: plan.linkedTargets.length } };
	} finally { before.close(); recorded?.close(); }
}

export function readLoadedBuildIdentity({ extension, cache, expected, vscodeVersion, source, driverExtensionMode }) {
	const installedPath = assertCanonicalDirectory(extension.extensionPath);
	const requestedMain = path.resolve(installedPath, extension.packageJSON.main);
	assertCanonicalDirectory(path.dirname(requestedMain));
	const mainStat = fs.lstatSync(requestedMain);
	if (!mainStat.isFile() || mainStat.isSymbolicLink() || mainStat.nlink !== 1) throw new Error('Refusing aliased executing main module');
	const mainPath = fs.realpathSync.native(requestedMain);
	if (!within(installedPath, mainPath)) throw new Error('Executing main module is outside the installed package');
	const samePath = (left, right) => typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
	const loaded = Object.values(cache).find(module => samePath(module?.filename, mainPath));
	const context = loaded?.loaded === true ? loaded.exports?.toolOrchestrator?.context : null;
	const contextObserved = !!context && Number.isInteger(context.extensionMode) && samePath(context.extensionPath, installedPath);
	const folder = path.relative(installedPath, mainPath).split(path.sep)[0];
	const mainSource = fs.readFileSync(mainPath, 'utf8');
	const owner = loaded?.loaded === true ? loaded.exports?.toolOrchestrator : null;
	return Object.freeze({
		installedPath, mainPath, mainSha256: sha256File(mainPath), ...hashInstalledTree(installedPath, folder),
		vsixSha256: expected.vsixPath ? sha256File(expected.vsixPath) : expected.vsixSha256,
		vscodeVersion, sourceHead: source.head, sourcePatchSha256: source.patchSha256, dependenciesSha256: source.dependenciesSha256 ?? null,
		extensionMode: contextObserved ? context.extensionMode : null, contextObserved,
		contextPath: contextObserved ? fs.realpathSync.native(context.extensionPath) : null,
		moduleCacheLoaded: loaded?.loaded === true, moduleCachePath: loaded?.filename ? fs.realpathSync.native(loaded.filename) : null,
		runtime: { source: 'executing-require-cache', methods: ['constructor', 'collectOpenWorkbenchFiles', 'listSections', 'manageDevelopmentNotes', 'validateHtmlDashboard', 'activateWorkbenchFile']
			.map(name => fingerprintMethod(name, owner?.[name], mainSource)) },
		driverExtensionMode,
	});
}

function fingerprintMethod(name, method, mainSource) {
	const source = typeof method === 'function' ? Function.prototype.toString.call(method) : '';
	const offset = source ? mainSource.indexOf(source) : -1;
	return { name, sha256: sha256(source), offset, length: source.length, matchesPackage: offset >= 0 && source.length > 0 };
}

export function parseAcceptanceToolResult(name, result) {
	const text = result?.content?.find(part => typeof part?.value === 'string')?.value;
	if (!text || text.startsWith('Error:')) throw new Error('Exact registered tool rejected: ' + name + ': ' + clip(text ?? 'Missing JSON result'));
	let value;
	try { value = JSON.parse(text); } catch { throw new Error('Exact registered tool returned invalid JSON: ' + name); }
	const shaped = name === 'kusto-workbench_list-connections' ? Array.isArray(value?.connections)
		: name === 'kusto-workbench_list-sections' ? Array.isArray(value?.sections) && (value.openFiles === undefined || Array.isArray(value.openFiles)) : value?.success === true;
	if (!value || Array.isArray(value) || value.success === false || !shaped) throw new Error('Exact registered tool failed; no replay: ' + name + ': ' + clip(value?.error ?? 'Invalid result shape'));
	return value;
}

export function correlateControlRegions(probe, target, capture, geometry) {
	const panel = target?.panel;
	if (!target?.uri || panel?.uri !== target.uri || panel.active !== true || panel.visible !== true) throw new Error('Exact URI/panel is not active and visible');
	if (!target.sectionId || probe?.sectionId !== target.sectionId || probe.ready !== true || probe.phase !== capture.phase
		|| !ACCEPTANCE_CONTROL_PHASES.includes(probe.phase) || typeof probe.token !== 'string' || !probe.token) throw new Error('Exact Query section/frame probe missing or mismatched');
	admitSynchronizedContext(capture.webviewSynchronization, capture.resolvedContext);
	const guest = new URL(probe.frameUrl);
	const resolved = new URL(capture.resolvedContext.targetUrl);
	const handleMatches = address => !!panel.handle && (address.hostname === String(panel.handle).toLowerCase() || address.searchParams.get('id') === panel.handle);
	let cspHost;
	if (typeof panel.cspSource === 'string' && !panel.cspSource.includes('*')) { try { cspHost = new URL(panel.cspSource).hostname; } catch {} }
	const resolvedMatches = handleMatches(resolved) || !!cspHost && resolved.hostname === cspHost;
	const guestMatches = handleMatches(guest) || !!cspHost && guest.hostname === cspHost
		|| resolvedMatches && resolved.searchParams.get('origin') === guest.hostname;
	if (!resolvedMatches || !guestMatches) throw new Error('BLOCKED: exact URI-to-native-panel-to-CDP-frame identity unavailable');
	const viewport = probe.viewport;
	if (!viewport || ![viewport.width, viewport.height, viewport.dpr].every(value => Number.isFinite(value) && value > 0)) throw new Error('Frame viewport geometry missing');
	const owner = geometry?.frameOwner;
	if (!owner || owner.targetId !== capture.resolvedContext.targetId || owner.frameUrl !== capture.resolvedContext.targetUrl
		|| typeof owner.frameId !== 'string' || !owner.frameId || !Number.isSafeInteger(owner.backendNodeId) || owner.backendNodeId <= 0) throw new Error('BLOCKED: exact CDP frame-owner identity / native geometry unavailable');
	const shell = owner.shell;
	if (shell?.visibilityState !== 'visible' || ![shell?.viewport?.width, shell?.viewport?.height, shell?.viewport?.dpr].every(value => Number.isFinite(value) && value > 0)) throw new Error('BLOCKED: frame-owner shell viewport geometry unavailable');
	const candidates = Array.isArray(geometry.nativeDocuments) ? geometry.nativeDocuments.filter(document => document.controlType === 'Document' && document.name === shell.documentTitle && document.isVisible === true) : [];
	if (candidates.length !== 1) throw new Error('BLOCKED: native frame document geometry unavailable or ambiguous');
	const document = candidates[0];
	const root = document.bounds;
	if (!root || ![root.x, root.y, root.width, root.height].every(Number.isFinite)
		|| Math.abs(root.width - shell.viewport.width * shell.viewport.dpr) > 2 || Math.abs(root.height - shell.viewport.height * shell.viewport.dpr) > 2) throw new Error('BLOCKED: native shell/frame viewport geometry does not agree');
	const quad = owner.quad;
	if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)
		|| quad[0] !== quad[6] || quad[2] !== quad[4] || quad[1] !== quad[3] || quad[5] !== quad[7]
		|| quad[2] <= quad[0] || quad[7] <= quad[1] || quad[0] < 0 || quad[1] < 0
		|| quad[2] > shell.viewport.width || quad[7] > shell.viewport.height) throw new Error('BLOCKED: CDP frame-owner box-model geometry unsupported');
	const rootScale = { x: root.width / shell.viewport.width, y: root.height / shell.viewport.height };
	const bounds = { x: root.x + quad[0] * rootScale.x, y: root.y + quad[1] * rootScale.y,
		width: (quad[2] - quad[0]) * rootScale.x, height: (quad[7] - quad[1]) * rootScale.y };
	if (Math.abs(bounds.width - viewport.width * viewport.dpr) > 2 || Math.abs(bounds.height - viewport.height * viewport.dpr) > 2) throw new Error('BLOCKED: exact guest frame/native geometry does not agree');
	const scale = { x: bounds.width / viewport.width, y: bounds.height / viewport.height };
	const menuVisible = probe.phase === 'cold-menu';
	if (probe.menuOpen !== menuVisible) throw new Error('Expected visible-menu/Escape frame state mismatch');
	const requiredRegions = ['query-controls', 'query-toggle', ...(['cold-menu', 'cold-escape'].includes(probe.phase) ? ['query-menu'] : [])];
	if (!Array.isArray(probe.regions) || probe.regions.length !== requiredRegions.length || new Set(probe.regions.map(region => region.name)).size !== requiredRegions.length) throw new Error('Intended main/toggle/menu region geometry missing');
	const suffixes = { 'query-controls': '_run_btn', 'query-toggle': '_run_toggle', 'query-menu': '_run_menu' };
	const regions = requiredRegions.map(name => {
		const region = probe.regions.find(value => value.name === name);
		if (!region || region.elementId !== target.sectionId + suffixes[name]
			|| ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0
			|| region.x < 0 || region.y < 0 || region.x + region.width > viewport.width || region.y + region.height > viewport.height) throw new Error('Intended section/control region geometry invalid: ' + name);
		const x = Math.floor(bounds.x - capture.bounds.x + region.x * scale.x);
		const y = Math.floor(bounds.y - capture.bounds.y + region.y * scale.y);
		const width = Math.ceil(bounds.x - capture.bounds.x + (region.x + region.width) * scale.x) - x;
		const height = Math.ceil(bounds.y - capture.bounds.y + (region.y + region.height) * scale.y) - y;
		if (x < 0 || y < 0 || x + width > capture.bounds.width || y + height > capture.bounds.height) throw new Error('Intended region outside the captured frame');
		return { name, elementId: region.elementId, x, y, width, height, disabled: region.disabled === true };
	});
	return Object.freeze({ uri: target.uri, sectionId: target.sectionId, panelGeneration: panel.generation, panelHandle: panel.handle,
		frameUrl: probe.frameUrl, token: probe.token, menuVisible, nativeDocumentId: document.id, frameOwner: owner, viewport, scale, requiredRegions, regions });
}

export async function readAcceptanceFrameOwner(cdp, resolved) {
	const client = cdp?.client;
	if (typeof client?.DOM?.getFrameOwner !== 'function' || typeof client?.DOM?.getBoxModel !== 'function'
		|| typeof client?.Runtime?.evaluate !== 'function' || typeof cdp.withWebviewClient !== 'function' || typeof cdp.withProtocolTimeout !== 'function') throw new Error('BLOCKED: actual CDP frame-owner / box-model capability unavailable');
	try {
		const tree = await cdp.withWebviewClient(resolved.targetId, guest => {
			if (typeof guest.Page?.getFrameTree !== 'function') throw new Error('Resolved target has no Page.getFrameTree');
			return cdp.withProtocolTimeout(guest.Page.getFrameTree(), 'exact guest frame tree');
		}, { retries: 1, retryOperationTimeouts: false });
		const frame = tree?.frameTree?.frame;
		if (!frame?.id || frame.url !== resolved.targetUrl) throw new Error('Resolved target/frame-tree identity changed');
		const node = await cdp.withProtocolTimeout(client.DOM.getFrameOwner({ frameId: frame.id }), 'exact CDP frame-owner node');
		if (!Number.isSafeInteger(node?.backendNodeId) || node.backendNodeId <= 0) throw new Error('Frame-owner backend node missing');
		const box = await cdp.withProtocolTimeout(client.DOM.getBoxModel({ backendNodeId: node.backendNodeId }), 'exact frame-owner box model');
		const shell = await cdp.withProtocolTimeout(client.Runtime.evaluate({ expression: '({ documentTitle: document.title, visibilityState: document.visibilityState, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } })', returnByValue: true }), 'native shell viewport identity');
		if (shell.exceptionDetails || !shell.result?.value) throw new Error('Shell viewport identity unavailable');
		return Object.freeze({ targetId: resolved.targetId, frameId: frame.id, frameUrl: frame.url, backendNodeId: node.backendNodeId, quad: box?.model?.content, shell: shell.result.value });
	} catch (error) { throw new Error('BLOCKED: exact CDP frame-owner geometry cannot be supplied: ' + clip(error.message, 300)); }
}

export function assertStableNativeGeometry(before, after) {
	if (!before?.frameOwner || !after?.frameOwner || !Array.isArray(before.nativeDocuments) || !Array.isArray(after.nativeDocuments)) throw new Error('BLOCKED: independent before/after native geometry unavailable');
	const footprint = documents => documents.map(({ id, ...document }) => document);
	if (!isDeepStrictEqual(before.frameOwner, after.frameOwner) || !isDeepStrictEqual(footprint(before.nativeDocuments), footprint(after.nativeDocuments))) throw new Error('Exact native frame geometry/footprint changed during capture');
}

export function assessControlPixels(capture, decoded) {
	const regions = decoded?.regions ?? [];
	const trustworthy = capture.native === true && capture.fallback === false && capture.currentFrame === true
		&& capture.foregroundHwnd === capture.hwnd && capture.pid > 0 && capture.dpi > 0
		&& decoded?.width === capture.bounds?.width && decoded?.height === capture.bounds?.height;
	const expected = capture.controlProof?.regions ?? [];
	const required = capture.controlProof?.requiredRegions ?? [];
	const controlsNonblank = trustworthy && required.includes('query-controls') && required.includes('query-toggle')
		&& (!['cold-menu', 'cold-escape'].includes(capture.phase) || required.includes('query-menu'))
		&& regions.length === required.length && expected.length === required.length && required.every(name => {
			const statistics = regions.filter(region => region.name === name);
			const intended = expected.find(region => region.name === name);
			if (statistics.length !== 1 || !intended) return false;
			const region = statistics[0];
			if (!['elementId', 'x', 'y', 'width', 'height'].every(field => region[field] === intended[field])
				|| region.samples < 100 || !/^[0-9a-f]{64}$/i.test(region.sha256 ?? '')) return false;
			if (name === 'query-menu' && capture.phase === 'cold-escape') return true;
			return region.uniqueColors >= (name === 'query-toggle' ? 3 : 12) && region.luminanceRange >= 30 && region.edgePixels / region.samples >= 0.02
				&& (name !== 'query-controls' || intended.disabled === true || region.chromaticPixels / region.samples >= 0.005);
		});
	return { ...capture, decoded: !!decoded, controlsNonblank, regions, visualReview: 'human-unreviewed' };
}

export function verifyMenuEscapeFrames(menu, escape) {
	const before = menu?.controlProof;
	const after = escape?.controlProof;
	const first = menu?.regions?.find(region => region.name === 'query-menu');
	const second = escape?.regions?.find(region => region.name === 'query-menu');
	return !!before && !!after && before.menuVisible === true && after.menuVisible === false
		&& before.uri === after.uri && before.sectionId === after.sectionId && before.panelGeneration === after.panelGeneration
		&& typeof before.token === 'string' && typeof after.token === 'string' && before.token !== after.token
		&& menu.pid === escape.pid && menu.hwnd === escape.hwnd && menu.resolvedContext?.targetId === escape.resolvedContext?.targetId
		&& menu.resolvedContext?.contextId === escape.resolvedContext?.contextId && menu.resolvedContext?.uniqueContextId === escape.resolvedContext?.uniqueContextId
		&& Number.isSafeInteger(menu.resolvedContext?.resolutionId) && Number.isSafeInteger(escape.resolvedContext?.resolutionId)
		&& menu.resolvedContext.resolutionId < escape.resolvedContext.resolutionId
		&& !!first && !!second && ['elementId', 'x', 'y', 'width', 'height'].every(field => first[field] === second[field])
		&& /^[0-9a-f]{64}$/i.test(first.sha256 ?? '') && /^[0-9a-f]{64}$/i.test(second.sha256 ?? '') && first.sha256 !== second.sha256;
}

function admitSynchronizedContext(synchronization, resolved) {
	if (!resolved || !Number.isSafeInteger(resolved.resolutionId) || resolved.resolutionId <= 0
		|| typeof resolved.targetId !== 'string' || !resolved.targetId || typeof resolved.targetUrl !== 'string' || !resolved.targetUrl
		|| !Number.isSafeInteger(resolved.contextId) || resolved.contextId < 0 || typeof resolved.captureMarker !== 'string' || !resolved.captureMarker
		|| !['page', 'iframe'].includes(resolved.targetType) || synchronization?.visibilityState !== 'visible') throw new Error('BLOCKED: actual resolved CDP synchronization/context proof missing');
	for (const field of ['resolutionId', 'targetId', 'targetType', 'targetTitle', 'targetUrl', 'contextId', 'uniqueContextId']) {
		if (synchronization[field] !== resolved[field]) throw new Error('CDP synchronized target/context mismatch: ' + field);
	}
	const barrier = resolved.targetType === 'page' ? 'animation-frame+Page.captureScreenshot' : 'animation-frame';
	if (synchronization.barrier !== barrier) throw new Error('CDP synchronized compositor frame barrier missing');
}

export function admitNativeCapture(result, expected, synchronization, resolved) {
	const metadata = result?.metadata;
	if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 0 || typeof expected.hwnd !== 'string' || !expected.hwnd) throw new Error('BLOCKED: native capture exact PID/HWND identity unavailable');
	const matches = value => value?.processId === expected.pid && value?.hwnd === expected.hwnd;
	if (result?.success !== true || result.strategy !== 'CopyFromScreen' || result.warnings?.length
		|| result.attempts?.length !== 1 || result.attempts[0].success !== true || result.attempts[0].strategy !== 'CopyFromScreen'
		|| !matches(metadata?.expected) || !matches(metadata?.target) || !matches(metadata?.foregroundBefore)
		|| !matches(metadata?.foregroundAtCapture) || !matches(metadata?.foregroundAfter)) throw new Error('Native capture PID/HWND/foreground/fallback proof rejected');
	if (metadata.validation?.targetMatchesForegroundAtCapture !== true) throw new Error('Native capture foreground validation missing');
	admitSynchronizedContext(synchronization, resolved);
	if (!Number.isFinite(metadata.dpi) || metadata.dpi <= 0) throw new Error('Native capture DPI missing');
	const bounds = metadata.bounds;
	if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger)
		|| bounds.width <= 0 || bounds.height <= 0 || bounds.width !== result.width || bounds.height !== result.height) throw new Error('Native capture bounds mismatch');
	return { native: true, pid: expected.pid, hwnd: expected.hwnd, foregroundHwnd: metadata.foregroundAtCapture.hwnd,
		bounds, dpi: metadata.dpi, currentFrame: true, fallback: false, nativeMetadata: metadata,
		webviewSynchronization: Object.freeze({ ...synchronization }), resolvedContext: Object.freeze({ ...resolved }) };
}

export async function captureSynchronizedNativeFrame(nativeUI, cdp, file, expectedContext) {
	if (typeof nativeUI?.prepareDevHostScreenshot !== 'function' || typeof nativeUI?.capturePreparedDevHostScreenshot !== 'function'
		|| typeof cdp?.synchronizeResolvedWebviewForNativeCapture !== 'function' || typeof cdp.completeResolvedWebviewNativeCapture !== 'function'
		|| cdp.hasResolvedWebviewForNativeCapture !== true) throw new Error('BLOCKED: actual tester synchronized native capture capability unavailable');
	const window = await nativeUI.prepareDevHostScreenshot();
	const resolved = Object.freeze({ ...cdp.resolvedWebviewContext });
	if (!isDeepStrictEqual(resolved, expectedContext)) throw new Error('Resolved capture context changed before compositor synchronization');
	if (nativeUI.targetPid !== undefined && nativeUI.targetPid !== window.processId) throw new Error('Native capture prepared another process');
	const synchronization = await cdp.synchronizeResolvedWebviewForNativeCapture();
	admitSynchronizedContext(synchronization, resolved);
	if (!isDeepStrictEqual(cdp.resolvedWebviewContext, resolved)) throw new Error('Resolved capture context changed during compositor synchronization');
	const synchronizedAt = Date.now();
	const result = await nativeUI.capturePreparedDevHostScreenshot(file, window);
	const capturedAt = Date.now();
	const expectedWindow = { pid: window.processId, hwnd: window.nativeHandle };
	const capture = admitNativeCapture(result, expectedWindow, synchronization, resolved);
	cdp.completeResolvedWebviewNativeCapture(synchronization);
	return { ...capture, file, result, expectedWindow, synchronizedAt, capturedAt };
}

export function decodePngControlRegions(file, regions) {
	const bytes = fs.readFileSync(file);
	if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('CPU decoder accepts bounded PNG files only');
	if (!Array.isArray(regions) || regions.length < 1 || regions.length > 8 || regions.some(region => !['query-controls', 'query-toggle', 'query-menu'].includes(region.name)
		|| ![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1)) throw new Error('Invalid control region bounds');
	if (process.platform !== 'win32') throw new Error('CPU PNG decoding requires Windows System.Drawing; no fallback image viewer');
	const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Bitmap]::new($env:KW_ACCEPTANCE_CPU_PNG)
try {
  $regions = @($env:KW_ACCEPTANCE_CPU_REGIONS | ConvertFrom-Json)
  $statistics = @()
  foreach ($region in $regions) {
    if ($region.x + $region.width -gt $image.Width -or $region.y + $region.height -gt $image.Height) { throw 'Control region outside PNG bounds' }
    $colors = [System.Collections.Generic.HashSet[int]]::new()
    $samples = 0; $edges = 0; $chromatic = 0; $minimum = 255.0; $maximum = 0.0
    $stride = [Math]::Max(1, [int][Math]::Ceiling([Math]::Sqrt($region.width * $region.height / 50000.0)))
	$pixelBytes = [byte[]]::new(4 * [int][Math]::Ceiling($region.width / $stride) * [int][Math]::Ceiling($region.height / $stride))
    for ($row = $region.y; $row -lt $region.y + $region.height; $row += $stride) {
      $previous = $null
      for ($column = $region.x; $column -lt $region.x + $region.width; $column += $stride) {
        $pixel = $image.GetPixel($column, $row)
        [void]$colors.Add($pixel.ToArgb())
		[BitConverter]::GetBytes($pixel.ToArgb()).CopyTo($pixelBytes, $samples * 4)
        $samples++
        $luminance = 0.2126 * $pixel.R + 0.7152 * $pixel.G + 0.0722 * $pixel.B
        $minimum = [Math]::Min($minimum, $luminance); $maximum = [Math]::Max($maximum, $luminance)
        if ([Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B)) - [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B)) -ge 16) { $chromatic++ }
        if ($null -ne $previous -and ([Math]::Abs([int]$pixel.R - [int]$previous.R) + [Math]::Abs([int]$pixel.G - [int]$previous.G) + [Math]::Abs([int]$pixel.B - [int]$previous.B)) -ge 60) { $edges++ }
        $previous = $pixel
      }
    }
	$hasher = [System.Security.Cryptography.SHA256]::Create()
	try { $pixelSha = [BitConverter]::ToString($hasher.ComputeHash($pixelBytes)).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
	$statistics += [pscustomobject]@{ name = $region.name; elementId = $region.elementId; x = $region.x; y = $region.y; width = $region.width; height = $region.height; samples = $samples; uniqueColors = $colors.Count; luminanceRange = $maximum - $minimum; edgePixels = $edges; chromaticPixels = $chromatic; sha256 = $pixelSha }
  }
  [pscustomobject]@{ width = $image.Width; height = $image.Height; regions = @($statistics) } | ConvertTo-Json -Depth 4 -Compress
} finally { $image.Dispose() }
`;
	try {
		return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
			env: { ...process.env, KW_ACCEPTANCE_CPU_PNG: path.resolve(file), KW_ACCEPTANCE_CPU_REGIONS: JSON.stringify(regions) },
			encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
		}));
	} catch (error) { throw new Error('CPU PNG/region decoding failed: ' + clip(error.stderr ?? error.message, 500)); }
}

export async function readAcceptanceControlDom(phase, requestedSectionId, expectedQuery = null, menuExpectation = 'closed', verificationToken = null) {
	const previous = globalThis.__original109ControlProbe;
	if (verificationToken && previous?.token !== verificationToken) throw new Error('Exact frame probe token was replaced');
	const section = requestedSectionId ? document.getElementById(requestedSectionId) : document.querySelector('#queries-container > kw-query-section');
	const id = section?.id;
	const editor = window.queryEditors?.[id];
	const main = id && document.getElementById(id + '_run_btn');
	const toggle = id && document.getElementById(id + '_run_toggle');
	const menu = id && document.getElementById(id + '_run_menu');
	if (typeof section?.executionCtrl?.isRunSelectionReady !== 'function' || !editor || !section.querySelector('.monaco-editor') || !main || !toggle || !menu) throw new Error('Exact first Query/readiness/controls unavailable; do not substitute a healthy neighbor');
	if (!verificationToken && menuExpectation === 'closed') toggle.scrollIntoView({ block: 'center' });
	await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	const query = editor.getValue();
	const expectedRunDisabled = section.executionCtrl.isRunSelectionReady() !== true;
	if (typeof query !== 'string' || expectedQuery !== null && query !== expectedQuery || main.disabled !== expectedRunDisabled || toggle.disabled || document.visibilityState !== 'visible') throw new Error('Exact Query control/query/frame state changed');
	const region = (element, name) => {
		const bounds = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		if (bounds.width <= 0 || bounds.height <= 0 || bounds.left < 0 || bounds.top < 0 || bounds.right > innerWidth || bounds.bottom > innerHeight
			|| style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0 || style.pointerEvents === 'none' && element.disabled !== true) throw new Error('Intended Query control/menu geometry is not visible: ' + name);
		return { name, elementId: element.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, disabled: element.disabled === true };
	};
	const menuStyle = getComputedStyle(menu);
	const menuOpen = menuStyle.display !== 'none' && menuStyle.visibility === 'visible';
	if (menuOpen !== (menuExpectation === 'open')) throw new Error('Actual visible-menu/Escape frame state differs');
	const regions = [region(main, 'query-controls'), region(toggle, 'query-toggle')];
	let menuLabels = [];
	if (menuOpen) {
		menuLabels = Array.from(menu.querySelectorAll('[role=menuitem]')).filter(item => getComputedStyle(item).display !== 'none').map(item => item.textContent.trim());
		if (!['Run All', 'Run Query', 'Run Query (take 100)', 'Run Query (sample 100)'].every(label => menuLabels.includes(label))) throw new Error('Actual cold Run-options menu items missing');
		regions.push(region(menu, 'query-menu'));
	} else if (menuExpectation === 'dismissed') {
		const priorRegion = previous?.regions?.find(value => value.name === 'query-menu');
		if (!priorRegion || previous.sectionId !== id || previous.frameUrl !== location.href) throw new Error('Visible menu frame geometry unavailable for Escape comparison');
		regions.push({ ...priorRegion });
	}
	const probe = { phase, ready: true, sectionId: id, query, expectedRunDisabled, mainRunDisabled: main.disabled, toggleDisabled: toggle.disabled,
		token: verificationToken ?? crypto.randomUUID(), frameUrl: location.href, documentTitle: document.title,
		viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, regions, menuOpen, menuLabels,
		dismissed: menuExpectation === 'dismissed' && !menuOpen, paintedAt: Date.now() };
	if (!verificationToken) globalThis.__original109ControlProbe = Object.freeze(probe);
	return probe;
}

function assertSameControlProbe(before, after) {
	for (const field of ['phase', 'ready', 'sectionId', 'query', 'expectedRunDisabled', 'mainRunDisabled', 'toggleDisabled', 'token', 'frameUrl', 'documentTitle', 'viewport', 'regions', 'menuOpen', 'menuLabels', 'dismissed']) {
		if (!isDeepStrictEqual(before?.[field], after?.[field])) throw new Error('Exact control frame changed before/after native capture: ' + field);
	}
}

async function readNativeDocuments(nativeUI, window, title, diagnostics = {}) {
	const evidence = diagnostics.nativeTree = { request: { method: 'getElementTree', windowId: window.id, maxDepth: null },
		responseShape: null, roots: [], documents: [], controlTypes: [], visited: 0, maximumDepth: 0, matchCount: 0, truncated: false };
	if (typeof nativeUI.getElementTree !== 'function') throw new Error('BLOCKED: actual native document geometry capability missing');
	const tree = await nativeUI.getElementTree(window.id);
	evidence.responseShape = { kind: Array.isArray(tree) ? 'array' : tree === null ? 'null' : typeof tree,
		keys: tree && typeof tree === 'object' && !Array.isArray(tree) ? Object.keys(tree).slice(0, 16).map(key => key.slice(0, 80)) : [] };
	const roots = Array.isArray(tree) ? tree : [tree?.root ?? tree?.tree ?? tree];
	const snapshot = (element, depth) => ({ id: typeof element?.id === 'string' ? element.id.slice(0, 256) : null,
		controlType: typeof element?.controlType === 'string' ? element.controlType.slice(0, 80) : null,
		name: typeof element?.name === 'string' ? element.name.slice(0, 512) : null, isVisible: typeof element?.isVisible === 'boolean' ? element.isVisible : null,
		bounds: element?.bounds ? Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number.isFinite(element.bounds[key]) ? element.bounds[key] : null])) : null, depth });
	evidence.preparedWindow = { id: window.id, processId: window.processId ?? null, nativeHandle: window.nativeHandle ?? null,
		title: typeof window.title === 'string' ? window.title.slice(0, 512) : null, bounds: snapshot(window, 0).bounds };
	evidence.roots = roots.slice(0, 8).map(node => snapshot(node?.element ?? node, 0));
	if (roots.length > 8) evidence.truncated = true;
	const queue = roots.map(node => ({ node, depth: 0 }));
	const documents = [];
	while (queue.length) {
		if (evidence.visited === 12000) { evidence.truncated = true; throw new Error('BLOCKED: native document geometry exceeded its bounded tree inventory'); }
		evidence.visited++;
		const { node, depth } = queue.shift();
		if (!node || typeof node !== 'object') continue;
		const element = node.element ?? node;
		evidence.maximumDepth = Math.max(evidence.maximumDepth, depth);
		const controlType = typeof element.controlType === 'string' ? element.controlType.slice(0, 80) : null;
		let count = evidence.controlTypes.find(value => value.controlType === controlType);
		if (!count && evidence.controlTypes.length < 64) { count = { controlType, count: 0, maximumDepth: 0, leaves: 0 }; evidence.controlTypes.push(count); }
		if (count) { count.count++; count.maximumDepth = Math.max(count.maximumDepth, depth); if (!node.children?.length) count.leaves++; }
		else evidence.truncated = true;
		if (element.controlType === 'Document') {
			if (evidence.documents.length < 64) evidence.documents.push(snapshot(element, depth));
			else evidence.truncated = true;
		}
		if (element.controlType === 'Document' && element.name === title && element.isVisible === true) documents.push({ id: element.id, controlType: element.controlType, name: element.name, isVisible: element.isVisible, bounds: element.bounds });
		evidence.matchCount = documents.length;
		if (Array.isArray(node.children)) queue.push(...node.children.map(child => ({ node: child, depth: depth + 1 })));
	}
	if (documents.length !== 1) throw new Error('BLOCKED: exact native frame document geometry unavailable or ambiguous');
	return documents;
}

function observeAcceptanceCdpOwner(pid, port) {
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('BLOCKED: explicit isolated --cdp-port / PID required');
	const script = `$ErrorActionPreference = 'Stop'; @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object OwningProcess, LocalAddress, LocalPort) | ConvertTo-Json -Compress`;
	let listeners;
	try {
		const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 }));
		listeners = Array.isArray(value) ? value : [value];
	} catch (error) { throw new Error('BLOCKED: isolated CDP listener ownership unobservable: ' + clip(error.message, 200)); }
	if (!listeners.length || listeners.some(listener => listener.OwningProcess !== pid || listener.LocalPort !== port || !['127.0.0.1', '::1'].includes(listener.LocalAddress))) throw new Error('BLOCKED: CDP endpoint is not owned exclusively by the isolated loopback process');
	return { pid, port, listeners };
}

export function acceptanceControlPath(phase, order, coldPath) {
	if (phase === 'historical-83') return 'history/' + order[82];
	if (phase === 'historical-88') return 'history/' + order[87];
	if (phase === 'historical-109') return 'history/' + order[108];
	return phase === 'second-interaction' ? 'history/original109-authoring.kqlx' : coldPath;
}

export function extractAcceptanceFeature(source, mode = 'original109') {
	if (!['original109', 'current133-api'].includes(mode)) throw new Error('Unsupported acceptance feature mode');
	const marker = mode === 'current133-api' ? 'CURRENT133 API ACCEPTANCE' : 'ORIGINAL109 ACCEPTANCE';
	const lines = source.split(/\r?\n/);
	const start = lines.indexOf('# ' + marker + ' BEGIN');
	const end = lines.indexOf('# ' + marker + ' END');
	if (start < 0 || end <= start || lines.lastIndexOf('# ' + marker + ' BEGIN') !== start || lines.lastIndexOf('# ' + marker + ' END') !== end) throw new Error('Exactly one opt-in ' + mode + ' feature fragment is required');
	const fragment = lines.slice(start + 1, end);
	if (!fragment.length || fragment.some(line => !line.startsWith('#|'))) throw new Error('Malformed opt-in original109 feature fragment');
	return fragment.map(line => line.replace(/^#\| ?/, '')).join('\n').replaceAll('__ORIGINAL109_CONTROL_PROBE__', '(' + readAcceptanceControlDom.toString() + ')') + '\n';
}

export function recordUntouchedRevision(acceptance, reference, revision) {
	const entry = { path: reference.path, phase: revision.phase, documentVersion: revision.documentVersion, isDirty: revision.isDirty,
		sha256: sha256(revision.text), expectedModelSha256: sha256(reference.text), observedAt: Date.now() };
	if (Array.isArray(acceptance.untouched.modelVersions)) {
		const versions = acceptance.untouched.modelVersions;
		const first = versions.find(value => value.path === reference.path && value.openGeneration === revision.openGeneration);
		if (!Number.isSafeInteger(revision.openGeneration) || revision.openGeneration <= 0 || !Number.isSafeInteger(revision.documentVersion) || revision.documentVersion <= 0
			|| first && first.documentVersion !== revision.documentVersion) {
			acceptance.untouched.versionsStable = false;
			acceptance.untouched.versionChanges.push({ ...entry, openGeneration: revision.openGeneration, expectedDocumentVersion: first?.documentVersion ?? null });
		} else if (!first) versions.push({ path: reference.path, openGeneration: revision.openGeneration, documentVersion: revision.documentVersion });
	}
	if (revision.isDirty !== false) {
		acceptance.untouched.allRevisionsClean = false;
		acceptance.untouched.dirtyTransitions.push(entry);
	}
	if (revision.text !== reference.text) {
		acceptance.untouched.exactBytes = false;
		acceptance.untouched.byteChanges.push({ ...entry, origin: 'buffer' });
	}
	return entry;
}

export function recordColdCanaryRevision(acceptance, reference, revision) {
	const canary = acceptance.coldCanary;
	if (!Number.isSafeInteger(revision.openGeneration) || revision.openGeneration <= 0
		|| !Number.isSafeInteger(revision.documentVersion) || revision.documentVersion <= 0) throw new Error('BLOCKED: cold canary document/version identity unavailable');
	const entry = { ...recordUntouchedRevision({ untouched: canary }, reference, revision), openGeneration: revision.openGeneration };
	const first = canary.revisions.find(value => value.openGeneration === entry.openGeneration);
	if (first && first.documentVersion !== entry.documentVersion) {
		canary.versionsStable = false;
		canary.versionChanges.push({ ...entry, expectedDocumentVersion: first.documentVersion });
	}
	canary.revisions.push(entry);
	return entry;
}

export async function closeAcceptanceTabs(vscode, owner, uris) {
	const root = assertAcceptanceRoot(owner);
	const exact = new Set(uris);
	for (const uri of exact) {
		const file = fileURLToPath(uri);
		if (!within(root, file) || path.resolve(file) === root) throw new Error('Refusing cleanup target outside the exact owned root');
		assertCanonicalDirectory(path.dirname(file));
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Refusing aliased cleanup target');
	}
	const matching = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => exact.has(tab.input?.uri?.toString()));
	const tabs = matching();
	if (tabs.some(tab => tab.isDirty) || vscode.workspace.textDocuments.some(document => exact.has(document.uri.toString()) && document.isDirty)) throw new Error('Refusing dirty discard during exact-owned cleanup');
	if (tabs.length && !await vscode.window.tabGroups.close(tabs)) throw new Error('Exact-owned clean close failed; no retry or discard');
	const survivors = matching().length;
	if (survivors) throw new Error('Exact-owned close left surviving tabs; no retry');
	return { closed: tabs.length, survivors, dirtyDiscard: false, onlyOwnedTabs: true, preservedFailures: true };
}

export function inspectHistoricalTabs(vscode, expectedUris) {
	const expected = new Set(expectedUris);
	const retained = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => expected.has(tab.input?.uri?.toString()));
	const actual = retained.map(tab => tab.input.uri.toString());
	if (retained.length !== expected.size || new Set(actual).size !== expected.size) throw new Error('Missing or duplicate exact retained historical tabs: ' + retained.length + '/' + expected.size);
	if (retained.some(tab => tab.isDirty)) throw new Error('Retained historical tabs are not all clean');
	return { retainedCount: retained.length, exactUris: actual, allClean: true };
}

export function observeAcceptanceExecutionBoundary(facade, { ownedUris, coldUri, coldSectionId, source = 'provided-facade', onEvent, observeWrites = false, onWriterEvent }) {
	const wrappers = [];
	const subscriptions = [];
	const providers = new WeakSet();
	const panels = new Map();
	const events = [];
	const writerRecords = [];
	const writerLimits = Object.freeze({ maxRecords: 512, maxBytes: 16 * 1024 * 1024, maxEdits: 64, maxStackFrames: 12 });
	const documentGenerations = new WeakMap();
	const blockers = [];
	let registrationObserved = false;
	let restored = false;
	let cleanupAttempted = false;
	let sequence = 0;
	let writerInstalled = false;
	let writerCalls = 0;
	let writerBytes = 0;
	let writerGeneration = 0;
	let timingObserverCostMs = 0;
	const block = reason => {
		try {
			const message = typeof reason === 'string' ? reason : 'Writer observation failed';
			if (blockers.length < 32 && !blockers.includes(message)) blockers.push(message);
		} catch {}
	};
	const descriptorFor = (target, member) => {
		for (let depth = 0; target && depth < 16; depth++, target = Object.getPrototypeOf(target)) {
			if ((typeof target !== 'object' && typeof target !== 'function') || types.isProxy(target)) return null;
			const descriptor = Object.getOwnPropertyDescriptor(target, member);
			if (descriptor) return descriptor;
		}
		return null;
	};
	const methodFor = (target, member) => {
		const descriptor = descriptorFor(target, member);
		return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function' ? descriptor.value : null;
	};
	const sameDescriptor = (left, right) => left && Object.hasOwn(left, 'value') && left.value === right.value
		&& left.writable === right.writable && left.enumerable === right.enumerable && left.configurable === right.configurable;
	const wrap = (target, member, before) => {
		try {
			if (!target || types.isProxy(target)) { block('Actual execution boundary is not writable: ' + member); return false; }
			const descriptor = Object.getOwnPropertyDescriptor(target, member);
			const resolved = descriptorFor(target, member);
			if (!resolved || !Object.hasOwn(resolved, 'value') || typeof resolved.value !== 'function' || !resolved.configurable && !resolved.writable) {
				block('Actual execution boundary is not writable: ' + member); return false;
			}
			const original = resolved.value;
			const wrapper = function (...args) {
				try { before(args); } catch { block('Writer observation failed'); }
				return Reflect.apply(original, this, args);
			};
			const installed = descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, writable: true, enumerable: false, configurable: true };
			Object.defineProperty(target, member, installed);
			wrappers.push({ target, member, descriptor, installed });
			return true;
		} catch { block('Actual execution boundary is not writable: ' + member); return false; }
	};
	const data = (value, member) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, member)?.value : undefined;
	const canonicalUri = value => {
		if (typeof value !== 'string') return null;
		const parsed = new URL(value);
		if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search || parsed.hash) return null;
		const canonical = pathToFileURL(path.resolve(fileURLToPath(parsed))).href;
		return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
	};
	const uriKey = uri => {
		const method = methodFor(uri, 'toString');
		return method ? canonicalUri(Reflect.apply(method, uri, [])) : null;
	};
	const hasPrototype = (value, prototype) => {
		for (let depth = 0; value && depth < 16; depth++, value = Object.getPrototypeOf(value)) {
			if (types.isProxy(value)) return false;
			if (value === prototype) return true;
		}
		return false;
	};
	const projectFrames = () => {
		const stack = new Error().stack;
		if (typeof stack !== 'string') throw new Error('Writer observation failed');
		const root = REPO_ROOT.replaceAll('\\', '/') + '/';
		return Object.freeze(stack.split(/\r?\n/).slice(1).flatMap(frame => {
			const normalized = frame.replaceAll('\\', '/');
			const start = normalized.toLowerCase().indexOf(root.toLowerCase());
			const location = start < 0 ? null : normalized.slice(start + root.length).match(/^(.+?):(\d+):(\d+)\)?$/);
			return location ? [Object.freeze({ path: location[1], line: Number(location[2]), column: Number(location[3]) })] : [];
		}).slice(0, writerLimits.maxStackFrames));
	};
	if (observeWrites) {
		try {
			const workspace = descriptorFor(facade, 'workspace')?.value;
			const constructor = descriptorFor(facade, 'WorkspaceEdit')?.value;
			const prototype = descriptorFor(constructor, 'prototype')?.value;
			const entriesMethod = methodFor(prototype, 'entries');
			const exactOwned = new Map([...ownedUris].map(uri => [canonicalUri(uri), uri]));
			if (!workspace || !prototype || !entriesMethod || exactOwned.has(null)) block('Actual writer observation capability missing');
			else {
				const nativeFields = new Map(['TextEdit', 'Range', 'Position'].map(name => {
					const nativePrototype = descriptorFor(descriptorFor(facade, name)?.value, 'prototype')?.value;
					return [name, nativePrototype];
				}));
				const readField = (value, member, nativeKind) => {
					const descriptor = descriptorFor(value, member);
					if (descriptor && Object.hasOwn(descriptor, 'value')) return descriptor.value;
					const nativePrototype = nativeFields.get(nativeKind);
					if (!nativePrototype || !hasPrototype(value, nativePrototype) || !descriptor?.get
						|| descriptor.get !== descriptorFor(nativePrototype, member)?.get) throw new Error('Writer observation failed');
					return Reflect.apply(descriptor.get, value, []);
				};
				const readHostField = (value, member) => {
					const descriptor = descriptorFor(value, member);
					if (!descriptor) throw new Error('Writer observation failed');
					return Object.hasOwn(descriptor, 'value') ? descriptor.value : Reflect.apply(descriptor.get, value, []);
				};
				const observeWriter = args => {
					const started = performance.now();
					const attempt = ++writerCalls;
					try {
						const edit = args[0];
						if (!hasPrototype(edit, prototype) || methodFor(edit, 'entries') !== entriesMethod) {
							block('Writer observation requires a VS Code-owned WorkspaceEdit'); return;
						}
						const entries = Reflect.apply(entriesMethod, edit, []);
						if (!Array.isArray(entries) || types.isProxy(entries)) { block('Writer observation failed'); return; }
						if (entries.length > writerLimits.maxEdits) { block('Writer observation exceeded its 64-edit bound'); return; }
						const selected = [];
						let editCount = 0;
						for (let index = 0; index < entries.length; index++) {
							const entry = data(entries, String(index));
							if (!Array.isArray(entry) || types.isProxy(entry)) { block('Writer observation failed'); return; }
							const uri = exactOwned.get(uriKey(data(entry, '0')));
							if (!uri) continue;
							const edits = data(entry, '1');
							if (!Array.isArray(edits) || types.isProxy(edits)) { block('Writer observation failed'); return; }
							editCount += edits.length;
							if (editCount > writerLimits.maxEdits) { block('Writer observation exceeded its 64-edit bound'); return; }
							selected.push({ uri, edits });
						}
						if (!editCount) return;
						if (writerRecords.length + editCount > writerLimits.maxRecords) { block('Writer observation exceeded its 512-record bound'); return; }
						const documents = readHostField(workspace, 'textDocuments');
						if (!Array.isArray(documents) || types.isProxy(documents)) { block('Writer observation failed'); return; }
						const stackFrames = projectFrames();
						if (!stackFrames.length) { block('Project writer stack unavailable'); return; }
						const pending = [];
						let bytes = 0;
						for (const { uri, edits } of selected) {
							const key = canonicalUri(uri);
							const matches = documents.filter(document => uriKey(readHostField(document, 'uri')) === key);
							if (matches.length !== 1) { block('Exact owned writer document unavailable'); return; }
							const document = matches[0];
							const getText = methodFor(document, 'getText');
							const offsetAt = methodFor(document, 'offsetAt');
							if (!getText || !offsetAt) { block('Exact owned writer document capability missing'); return; }
							const beforeText = Reflect.apply(getText, document, []);
							const documentVersion = readHostField(document, 'version');
							if (typeof beforeText !== 'string' || !Number.isSafeInteger(documentVersion) || documentVersion <= 0) { block('Exact owned writer document identity unavailable'); return; }
							if (!documentGenerations.has(document)) documentGenerations.set(document, ++writerGeneration);
							const documentGeneration = documentGenerations.get(document);
							const beforeSha256 = sha256(beforeText);
							for (let index = 0; index < edits.length; index++) {
								const textEdit = data(edits, String(index));
								const range = readField(textEdit, 'range', 'TextEdit');
								const replacementText = readField(textEdit, 'newText', 'TextEdit');
								const start = readField(range, 'start', 'Range');
								const end = readField(range, 'end', 'Range');
								const startLine = readField(start, 'line', 'Position');
								const startCharacter = readField(start, 'character', 'Position');
								const endLine = readField(end, 'line', 'Position');
								const endCharacter = readField(end, 'character', 'Position');
								if (typeof replacementText !== 'string' || [startLine, startCharacter, endLine, endCharacter].some(value => !Number.isSafeInteger(value) || value < 0)) { block('Writer observation failed'); return; }
								const startOffset = Reflect.apply(offsetAt, document, [start]);
								const endOffset = Reflect.apply(offsetAt, document, [end]);
								if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset < startOffset || endOffset > beforeText.length) { block('Writer observation failed'); return; }
								const newTextBytes = Buffer.byteLength(replacementText, 'utf8');
								bytes += newTextBytes;
								if (writerBytes + bytes > writerLimits.maxBytes) { block('Writer observation exceeded its 16-MiB byte bound'); return; }
								const record = Object.freeze({ sequence: writerRecords.length + pending.length + 1, attempt, stage: 'attempted', uri,
									documentGeneration, documentVersion, beforeLength: beforeText.length, beforeSha256, startLine, startCharacter, endLine, endCharacter, startOffset, endOffset,
									fullReplacement: startOffset === 0 && endOffset === beforeText.length, newTextLength: replacementText.length, newTextBytes, newTextSha256: sha256(replacementText), stackFrames, at: Date.now() });
								pending.push({ record, replacementText });
							}
						}
						writerBytes += bytes;
						for (const { record, replacementText } of pending) {
							writerRecords.push(record);
							try { onWriterEvent?.(Object.freeze({ ...record, replacementText })); } catch { block('Writer observation failed'); }
						}
					} catch { block('Writer observation failed'); }
					finally { timingObserverCostMs += Math.max(0, performance.now() - started); }
				};
				writerInstalled = wrap(workspace, 'applyEdit', observeWriter);
			}
		} catch { block('Actual writer observation capability missing'); }
	}
	const inspect = (entry, direction, message) => {
		const type = data(message, 'type');
		if (direction === 'outbound' && type === 'documentData') {
			const state = data(message, 'state');
			const sections = data(state, 'sections');
			if (Array.isArray(sections)) entry.sectionIds = sections.filter(section => data(section, 'type') === 'query' || data(section, 'type') === 'sql').map(section => data(section, 'id'));
			entry.viewSessionId = data(message, 'viewSessionId');
		}
		const ingress = direction === 'inbound' && ['executeQuery', 'executeSqlQuery'].includes(type);
		const start = direction === 'inbound' && type === 'toolExecutionStarted'
			|| direction === 'outbound' && ['kustoExecutionStarted', 'sqlExecutionStarted', 'copilotWriteQueryExecutionStarted'].includes(type);
		if (!ingress && !start) return;
		if (events.length >= 512) { block('Execution observation exceeded its 512-event bound'); return; }
		const query = data(message, 'query');
		const boxId = data(message, 'boxId');
		const blank = typeof query === 'string' ? query.trim() === '' : entry.uri === coldUri && boxId === coldSectionId ? true : null;
		const event = Object.freeze({ sequence: ++sequence, stage: ingress ? 'ingress' : 'start', direction, type, uri: entry.uri, panelGeneration: entry.generation,
			boxId: typeof boxId === 'string' ? boxId : null, executionId: typeof data(message, 'executionId') === 'string' ? data(message, 'executionId') : null,
			queryLength: typeof query === 'string' ? query.length : null, querySha256: typeof query === 'string' ? sha256(query) : null, blank, at: Date.now() });
		events.push(event);
		try { onEvent?.(event); } catch { block('Writer observation failed'); }
	};
	const attach = (document, panel) => {
		const uri = document?.uri?.toString();
		if (!ownedUris.has(uri) || panels.has(panel)) return;
		const webview = panel?.webview;
		if (!webview || !methodFor(webview, 'onDidReceiveMessage')) { block('Actual panel execution-ingress capability missing'); return; }
		if (panels.size >= 256) { block('Owned panel observation exceeded its 256-panel bound'); return; }
		const entry = { uri, generation: panels.size + 1, handle: data(webview, '_handle') ?? null, cspSource: webview.cspSource ?? null,
			sectionIds: [], viewSessionId: null, attachedBeforeResolve: false, panel };
		panels.set(panel, entry);
		wrap(webview, 'postMessage', args => inspect(entry, 'outbound', args[0]));
		subscriptions.push(webview.onDidReceiveMessage(message => { try { inspect(entry, 'inbound', message); } catch { block('Writer observation failed'); } }));
		entry.attachedBeforeResolve = true;
	};
	try {
		wrap(facade.window, 'registerCustomEditorProvider', args => {
			const [viewType, provider] = args;
			if (!['kusto.kqlxEditor', 'kusto.kqlCompatEditor', 'kusto.sqlCompatEditor', 'kusto.mdCompatEditor'].includes(viewType) || providers.has(provider)) return;
			registrationObserved = true;
			providers.add(provider);
			wrap(provider, 'resolveCustomTextEditor', values => attach(values[0], values[1]));
		});
	} catch { block('Actual execution observation setup failed'); }
	const snapshot = () => {
		const coldPanelObserved = [...panels.values()].some(entry => entry.uri === coldUri && entry.attachedBeforeResolve);
		const observed = registrationObserved && coldPanelObserved && blockers.length === 0;
		return Object.freeze({ source, status: blockers.length ? 'blocked' : observed ? restored ? 'complete' : 'observing' : 'armed', registrationObserved, coldPanelObserved, restored,
			ingressCount: observed ? events.filter(event => event.stage === 'ingress').length : null,
			startCount: observed ? events.filter(event => event.stage === 'start').length : null,
			blankExecutions: observed ? events.filter(event => event.blank === true).length : null,
			events: Object.freeze([...events]), blockers: Object.freeze([...blockers]),
			writerRecords: Object.freeze([...writerRecords]),
			writerObservation: Object.freeze({ enabled: observeWrites, status: !observeWrites ? 'disabled' : blockers.length || !writerInstalled ? 'blocked' : restored ? 'complete' : 'observing',
				installed: writerInstalled, calls: writerCalls, records: writerRecords.length, bytes: writerBytes, ...writerLimits, timingObserverCostMs,
				stackQualification: 'UNQUALIFIED_LOCATION_ONLY_NOT_CAUSE' }),
			panels: Object.freeze([...panels.values()].map(({ panel, ...entry }) => Object.freeze({ ...entry, sectionIds: [...entry.sectionIds] }))) });
	};
	return {
		snapshot,
		writerDocumentGeneration: document => documentGenerations.get(document) ?? null,
		panelFor: uri => {
			const entry = [...panels.values()].filter(value => value.uri === uri).at(-1);
			return entry ? { ...entry, active: entry.panel.active, visible: entry.panel.visible, title: entry.panel.title } : null;
		},
		restore: () => {
			if (cleanupAttempted) return snapshot();
			cleanupAttempted = true;
			let exact = true;
			for (const subscription of subscriptions) { try { subscription.dispose(); } catch { exact = false; block('Execution observation subscription cleanup failed'); } }
			for (const { target, member, descriptor, installed } of [...wrappers].reverse()) {
				try {
					if (!sameDescriptor(Object.getOwnPropertyDescriptor(target, member), installed)) { exact = false; block('Exact execution wrapper changed before cleanup: ' + member); continue; }
					if (descriptor) Object.defineProperty(target, member, descriptor); else if (!Reflect.deleteProperty(target, member)) throw new Error('Cleanup failed');
				} catch { exact = false; block('Execution observation descriptor cleanup failed: ' + member); }
			}
			restored = exact;
			return snapshot();
		},
	};
}

export async function createAcceptanceSession(vscode, config) {
	if (!['original109', 'current133-api'].includes(config.acceptance)) throw new Error('Explicit acceptance configuration required');
	const apiOnly = config.acceptance === 'current133-api';
	const root = assertAcceptanceRoot(config.owner);
	if (vscode.workspace.workspaceFolders?.length || vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Refusing pre-existing tabs; an empty isolated host is required');
	const extension = vscode.extensions.getExtension(WORKBENCH_ID);
	if (!extension || extension.extensionPath.toLowerCase() !== config.expectedExtensionPath?.toLowerCase()) throw new Error('Unexpected executing installed extension/profile path; do not activate');
	if (!within(root, extension.extensionPath)) throw new Error('Installed product path is outside the isolated owned profile');
	assertCanonicalDirectory(extension.extensionPath);
	for (const directory of [config.historyRoot, config.evidenceRoot]) {
		if (!within(root, directory)) throw new Error('Acceptance runtime directory outside owned root');
		assertCanonicalDirectory(directory);
	}
	const order = validateActivationOrder(config.acceptancePlan.activationOrder);
	const uriFor = relative => vscode.Uri.file(path.join(config.historyRoot, archiveRelativePath(relative)));
	const coldCanary = inspectAcceptanceColdCanary(config.owner, config.historyRoot, config.coldCanary, config.acceptancePlan.files);
	if (order[19] !== coldCanary.sourcePath || config.acceptancePlan.legacyPath !== coldCanary.sourcePath
		|| config.acceptancePlan.legacySectionId !== coldCanary.sectionId) throw new Error('Cold source must remain the exact recorded archival original target20');
	const coldUri = vscode.Uri.file(coldCanary.filePath);
	const canaryUri = uriFor(CANARY_PATH);
	const authorUri = apiOnly ? vscode.Uri.file(path.join(root, 'authoring', 'original109-authoring.kqlx')) : uriFor('original109-authoring.kqlx');
	const hiddenUri = uriFor('original109-hide.txt');
	const stagedImages = new Map();
	const references = new Map(config.acceptancePlan.files.map(file => {
		const uri = uriFor(file.path);
		assertCanonicalDirectory(path.dirname(uri.fsPath));
		const stat = fs.lstatSync(uri.fsPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Staged before-image is aliased before admission: ' + file.path);
		const bytes = fs.readFileSync(uri.fsPath);
		if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error('Staged archive changed before observer setup: ' + file.path);
		stagedImages.set(file.path, bytes);
		return [uri.toString(), { ...file, uri, text: bytes.toString('utf8').replace(/^\uFEFF/, '') }];
	}));
	validateBeforeImages({ files: config.acceptancePlan.files }, stagedImages, order, config.acceptance);
	const oracle = config.acceptancePlan.archivedCanary;
	if (apiOnly && (stagedImages.get(CANARY_PATH)?.length !== 28864 || sha256(stagedImages.get(CANARY_PATH)) !== CANARY_SHA
		|| oracle?.sha256 !== CANARY_SHA || sha256(JSON.stringify(JSON.parse(references.get(canaryUri.toString()).text).state.sections)) !== oracle.resultGraphSha256)) throw new Error('Unchanged archived canary/result-owner-binding graph required before opening');
	const initialText = references.get(uriFor(coldCanary.sourcePath).toString()).text;
	const coldReference = { ...coldCanary, uri: coldUri, text: initialText };
	if (apiOnly) fs.mkdirSync(path.dirname(authorUri.fsPath));
	fs.copyFileSync(coldUri.fsPath, authorUri.fsPath, fs.constants.COPYFILE_EXCL);
	fs.writeFileSync(hiddenUri.fsPath, 'Acceptance-owned non-Workbench hide target\n', { flag: 'wx' });
	const ownedUris = new Set([...order.map(relative => uriFor(relative).toString()), coldUri.toString(), authorUri.toString(), hiddenUri.toString(), ...(apiOnly ? [canaryUri.toString()] : [])]);
	const settings = vscode.workspace.getConfiguration('files', coldUri);
	if (settings.get('autoSave') !== 'afterDelay' || settings.get('autoSaveDelay') !== 1000) throw new Error('Acceptance requires effective Auto Save afterDelay/1000, without setup Save');
	const helperRequire = createRequire(config.helperPath);
	const journal = await helperRequire(config.helperPath).createJournal({ fixtureRoot: config.historyRoot, evidenceRoot: config.evidenceRoot,
		initialText: apiOnly ? references.get(canaryUri.toString()).text : initialText });
	const state = {
		schemaVersion: 1, mode: config.acceptance, archive: config.acceptancePlan.archive, expectedOrder: order, activationOrder: [], activationAttempts: [],
		cold: { firstWorkbenchActivation: false, firstToolTarget: null, activationPhase: 'not-attempted', tabReadiness: { before: null, after: null }, activationCalls: 0, warmingCalls: 0, legacyBytes: fs.statSync(coldUri.fsPath).size,
			controlsReady: false, menuOpened: false, escapeDismissed: false, blankExecutions: null, uri: coldUri.toString(), path: coldCanary.path, sectionId: coldCanary.sectionId, firstMetadataId: null },
		coldCanary: { ...coldCanary, uri: coldUri.toString(), sourceUri: uriFor(coldCanary.sourcePath).toString(), checkedSourceCount: 1,
			exactBytes: true, allRevisionsClean: true, versionsStable: true, dirtyTransitions: [], byteChanges: [], versionChanges: [], revisions: [], setupSaves: 0, rebaselines: 0, checkpoints: [] },
		untouched: { checkedSourceCount: references.size, exactBytes: true, allRevisionsClean: true, dirtyTransitions: [], byteChanges: [], setupSaves: 0, rebaselines: 0, checkpoints: [] },
		lifecycle: { authoring: false, nativeSave: false, reopen: false, secondInteraction: false }, notes: [], dashboard: null,
		fixtureOwnership: { status: 'blocked', path: null, forged: false, developmentSeeds: false,
			reason: 'Development fixture seeds are absent in Production. No lawful Production offline synthetic result path is supplied; composed note/dashboard acceptance is not attempted.' },
		identity: { expected: config.expectedBuildIdentity, before: null, after: null }, historicalInventories: [],
		pixels: { status: 'pending-cpu-review', captures: [] },
		cleanup: { canonicalTempRoot: true, markerVerified: true, aliasFree: true, dirtyDiscard: false, onlyOwnedTabs: true, preservedFailures: true, survivors: null },
		operations: [], failures: [], tabDiagnostics: [], observerFailures: [], nativeSaves: [], rawCaptures: [], independentBoundaries: {},
		execution: { status: 'blocked', source: null, ingressCount: null, startCount: null, blankExecutions: null, restored: false, blockers: ['Actual Workbench facade observation not installed'] },
	};
	if (apiOnly) Object.assign(state, {
		archivedCanary: oracle, dashboards: [], roles: { archive: 133, cold: 1, authoring: 1, canary: 1, authoringUnopened: true, authoringExactBytes: true },
		api: { status: 'prepared', warmReport: false, uri: canaryUri.toString(), openFileId: null, initialActivationCalls: 0, initialActivation: null,
			tabReadiness: { before: null, after: null }, activationCalls: 0, phases: [], checks: [], history: [], snapshotFailures: [], autoRevealEvents: [] },
		untouched: { ...state.untouched, versionsStable: true, modelVersions: [], versionChanges: [] },
		lifecycle: { nativeAuthoring: 'UNATTEMPTED' }, pixels: { status: 'UNATTEMPTED', captures: [], humanReview: 'human-unreviewed' },
		fixtureOwnership: { status: 'blocked', path: 'archived-native-admission', forged: false, developmentSeeds: false, reason: 'StageSetupBlockingOwner: archived native admission unattempted; no auth seed or query execution authorized' },
	});
	let phase = apiOnly ? 'prepared' : 'before-cold';
	let authoringRevision = 0;
	let intendedQuery = '';
	let expectedActiveUri = null;
	let observationTail = Promise.resolve();
	let nativeUI;
	let cdp;
	let executionObserver;
	let coldAttemptStarted = false;
	const generations = new WeakMap();
	let generationSequence = 0;
	const generation = document => { if (!generations.has(document)) generations.set(document, ++generationSequence); return generations.get(document); };
	const referenceFor = uri => uri === coldUri.toString() ? coldReference : references.get(uri);
	const activeUri = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString();
	const documentFor = uri => vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
	const viewTypeFor = uri => /\.txt$/.test(uri.fsPath) ? 'default' : /\.(kql|csl)$/.test(uri.fsPath) ? 'kusto.kqlCompatEditor'
		: /\.sql$/.test(uri.fsPath) ? 'kusto.sqlCompatEditor' : /\.md$/.test(uri.fsPath) ? 'kusto.mdCompatEditor' : 'kusto.kqlxEditor';
	const exactActive = uri => {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		return input?.uri?.toString() === uri.toString() && (apiOnly && /\.md$/i.test(uri.fsPath) && input instanceof vscode.TabInputText || (viewTypeFor(uri) === 'default'
			? input.viewType === undefined : input instanceof vscode.TabInputCustom && input.viewType === viewTypeFor(uri)));
	};
	const tabSnapshot = uri => {
		const describe = tab => ({ uri: tab?.input?.uri?.toString() ?? null, fsPath: tab?.input?.uri?.fsPath ?? null,
			viewType: tab?.input?.viewType ?? null, inputType: tab?.input?.constructor?.name ?? null, isCustom: tab?.input instanceof vscode.TabInputCustom,
			label: tab?.label ?? null, isDirty: tab?.isDirty ?? null, isActive: tab?.isActive ?? null });
		const document = documentFor(uri);
		return { phase, at: Date.now(), expected: { uri: uri.toString(), fsPath: uri.fsPath, viewType: viewTypeFor(uri) },
			active: describe(vscode.window.tabGroups.activeTabGroup.activeTab),
			tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ ...describe(tab), groupIsActive: group.isActive ?? null }))),
			document: document ? { uri: document.uri.toString(), version: document.version, isDirty: document.isDirty, sha256: sha256(document.getText()) } : null };
	};
	const tabFailure = (message, uri, extra = {}) => {
		state.tabDiagnostics.push({ ...tabSnapshot(uri), ...extra });
		return new Error(message + '; expected=' + uri.toString() + '; actual=' + (activeUri() ?? '<no URI>') + '; all tab URIs/view types retained in acceptance-state.json tabDiagnostics');
	};
	const saveState = () => {
		if (executionObserver) state.execution = executionObserver.snapshot();
		state.cold.blankExecutions = state.execution.blankExecutions;
		writeJsonAtomic(path.join(config.evidenceRoot, 'acceptance-state.json'), state);
	};
	const observe = (document, event, extra = {}) => {
		const uri = document.uri.toString();
		if (!referenceFor(uri) && uri !== authorUri.toString()) return;
		const revision = { phase: event + ':' + phase, documentVersion: document.version, openGeneration: generation(document), isDirty: document.isDirty, text: document.getText(), ...extra };
		if (uri === coldUri.toString() || uri === authorUri.toString() || apiOnly && uri === canaryUri.toString()) journal.capture(revision.text, { ...revision, text: undefined, fileUri: uri });
		if (apiOnly && uri === authorUri.toString()) state.roles.authoringUnopened = false;
		observationTail = observationTail.then(() => {
			if (referenceFor(uri)) {
				const reference = referenceFor(uri);
				const entry = uri === coldUri.toString() ? recordColdCanaryRevision(state, reference, revision) : recordUntouchedRevision(state, reference, revision);
				journal.note({ ...entry, openGeneration: revision.openGeneration });
				if (revision.text !== reference.text) {
					const file = path.join(config.evidenceRoot, 'first-changed-buffer', reference.path);
					fs.mkdirSync(path.dirname(file), { recursive: true });
					if (!fs.existsSync(file)) fs.writeFileSync(file, revision.text, { flag: 'wx' });
				}
			} else {
				fs.writeFileSync(path.join(config.evidenceRoot, 'last-authoring-buffer.kqlx'), revision.text);
				if (!authoringRevision && (revision.isDirty || revision.text !== initialText)) throw new Error('Separate authoring copy changed before native user intent');
			}
			saveState();
		}).catch(error => { state.observerFailures.push(clip(error.message)); saveState(); });
	};
	const observers = [
		vscode.workspace.onDidOpenTextDocument(document => observe(document, 'open')),
		vscode.workspace.onDidChangeTextDocument(event => observe(event.document, 'change', { changes: event.contentChanges.map(change => ({ offset: change.rangeOffset, removedLength: change.rangeLength, insertedLength: change.text.length })) })),
		vscode.workspace.onWillSaveTextDocument(event => {
			if (references.has(event.document.uri.toString())) state.untouched.setupSaves++;
			if (event.document.uri.toString() === coldUri.toString()) state.coldCanary.setupSaves++;
			if (event.document.uri.toString() === authorUri.toString()) state.nativeSaves.push({ event: 'will-save', reason: event.reason, authoringRevision, version: event.document.version, at: Date.now() });
			observe(event.document, 'will-save', { reason: event.reason });
		}),
		vscode.workspace.onDidSaveTextDocument(document => {
			if (document.uri.toString() === authorUri.toString()) state.nativeSaves.push({ event: 'did-save', authoringRevision, version: document.version, at: Date.now() });
			observe(document, 'did-save');
		}),
		vscode.workspace.onDidCloseTextDocument(document => observe(document, 'close')),
		vscode.window.tabGroups.onDidChangeTabs(event => {
			for (const tab of [...event.opened, ...event.changed, ...event.closed]) {
				const uri = tab.input?.uri?.toString();
				if (apiOnly && phase === 'hidden' && uri === canaryUri.toString() && tab.isActive === true) state.api.autoRevealEvents.push({ phase, uri, event: 'tab-active' });
				const reference = referenceFor(uri);
				if (reference && tab.isDirty) {
					const untouched = uri === coldUri.toString() ? state.coldCanary : state.untouched;
					untouched.allRevisionsClean = false;
					untouched.dirtyTransitions.push({ phase: 'tab:' + phase, path: reference.path, isDirty: true, at: Date.now() });
					saveState();
				}
			}
		}),
		...(apiOnly ? [vscode.window.tabGroups.onDidChangeTabGroups(() => {
			if (phase === 'hidden' && exactActive(canaryUri)) state.api.autoRevealEvents.push({ phase, uri: canaryUri.toString(), event: 'group-active' });
		})] : []),
	];
	const assertActive = uri => { if (!exactActive(uri)) throw tabFailure('Exact owned URI/custom editor is not active; no healthy-neighbor substitution', uri); };
	const checkpoint = async name => {
		phase = name;
		await observationTail;
		assertAcceptanceRoot(config.owner);
		for (const reference of references.values()) {
			assertCanonicalDirectory(path.dirname(reference.uri.fsPath));
			const stat = fs.lstatSync(reference.uri.fsPath);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Archive copy became aliased: ' + reference.path);
			const bytes = fs.readFileSync(reference.uri.fsPath);
			const actual = sha256(bytes);
			if (actual !== reference.sha256) {
				state.untouched.exactBytes = false;
				state.untouched.byteChanges.push({ phase: name, path: reference.path, origin: 'disk', expectedSha256: reference.sha256, sha256: actual });
				const file = path.join(config.evidenceRoot, 'first-changed-disk', reference.path);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
			}
			const document = documentFor(reference.uri);
			if (document) recordUntouchedRevision(state, reference, { phase: name, openGeneration: generation(document), documentVersion: document.version, isDirty: document.isDirty, text: document.getText() });
		}
		if (apiOnly) {
			assertCanonicalDirectory(path.dirname(authorUri.fsPath));
			const stat = fs.lstatSync(authorUri.fsPath);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256File(authorUri.fsPath) !== coldCanary.sha256) state.roles.authoringExactBytes = false;
			if (documentFor(authorUri)) state.roles.authoringUnopened = false;
		}
		try { inspectAcceptanceColdCanary(config.owner, config.historyRoot, state.coldCanary, config.acceptancePlan.files); }
		catch (error) { state.coldCanary.exactBytes = false; state.coldCanary.byteChanges.push({ phase: name, origin: 'disk', error: clip(error.message) }); }
		const coldDocument = documentFor(coldUri);
		if (coldDocument) recordColdCanaryRevision(state, coldReference, { phase: name, openGeneration: generation(coldDocument), documentVersion: coldDocument.version, isDirty: coldDocument.isDirty, text: coldDocument.getText() });
		for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === coldUri.toString() && tab.isDirty)) {
			state.coldCanary.allRevisionsClean = false;
			state.coldCanary.dirtyTransitions.push({ phase: name, path: coldReference.path, isDirty: tab.isDirty, at: Date.now() });
		}
		state.coldCanary.checkpoints.push(name);
		state.untouched.checkpoints.push(name);
		if (name !== 'after-cleanup') {
			const inventory = inspectHistoricalTabs(vscode, state.activationOrder.map(relative => uriFor(relative).toString()));
			if (!apiOnly || ['full109', 'hidden', 'reactivated', 'before-cleanup'].includes(name)) state.historicalInventories.push({ phase: name, ...inventory, exactPaths: inventory.exactUris.map(uri => path.relative(config.historyRoot, fileURLToPath(uri)).split(path.sep).join('/')) });
		}
		await journal.flush();
		saveState();
		if (!state.untouched.exactBytes || !state.untouched.allRevisionsClean || state.untouched.setupSaves || !state.coldCanary.exactBytes
			|| !state.coldCanary.allRevisionsClean || !state.coldCanary.versionsStable || state.coldCanary.setupSaves || state.observerFailures.length
			|| apiOnly && (!state.untouched.versionsStable || !state.roles.authoringExactBytes || !state.roles.authoringUnopened)) throw new Error('Untouched archive / separate cold canary exact bytes, clean state or version history failed; preserve all fixtures');
		return { phase: name, sourceCount: references.size, coldCanaryCount: 1, exactBytes: true, allRevisionsClean: true, activationCount: state.activationOrder.length };
	};
	const guard = action => async (...args) => {
		try { const result = await action(...args); saveState(); return result; }
		catch (error) {
			executionObserver?.restore();
			nativeUI?.stop();
			cdp?.disconnect();
			state.failures.push({ phase, error: clip(error.message), at: Date.now() });
			await observationTail; await journal.flush(); saveState();
			const verdict = !state.untouched.exactBytes || !state.untouched.allRevisionsClean || apiOnly && !state.untouched.versionsStable || !state.coldCanary.exactBytes
				|| !state.coldCanary.allRevisionsClean || !state.coldCanary.versionsStable ? 'PRESERVATION_FAILED'
				: phase === 'cold-open' && state.cold.activationCalls === 0 ? 'HARNESS_BLOCKED_SETUP' : String(error.message).startsWith('BLOCKED:') ? 'HARNESS_BLOCKED' : 'WORKFLOW_FAILED';
			writeJsonAtomic(path.join(config.evidenceRoot, 'lifecycle-summary.json'), { verdict, failure: clip(error.message), fixtureUri: (apiOnly ? canaryUri : authorUri).toString(), operations: state.operations, journal: journal.summary() });
			throw error;
		}
	};
	const loadedModule = () => Object.values(helperRequire.cache).find(module => module?.filename?.toLowerCase() === config.expectedBuildIdentity.mainPath.toLowerCase());
	const readIdentity = driverMode => readLoadedBuildIdentity({ extension, cache: helperRequire.cache, expected: config.expectedBuildIdentity,
		vscodeVersion: vscode.version, source: gitInfo(config.sourceRoot), driverExtensionMode: driverMode });
	const metadataId = uri => {
		const owner = loadedModule()?.exports?.toolOrchestrator;
		if (typeof owner?.collectOpenWorkbenchFiles !== 'function') throw tabFailure('Metadata-only file inventory unavailable; do not warm a bridge to obtain identity', uri);
		const openFiles = owner.collectOpenWorkbenchFiles().openFiles;
		const matches = Array.isArray(openFiles) ? openFiles.filter(entry => entry.uri === uri.toString()) : [];
		if (matches.length !== 1 || typeof matches[0].openFileId !== 'string' || !matches[0].openFileId) throw tabFailure('Exact owned openFileId is absent or ambiguous; do not retry', uri, { metadataInventory: openFiles ?? null });
		return matches[0].openFileId;
	};
	const invoke = async (name, input) => {
		const operation = { sequence: state.operations.length + 1, phase, name, input, success: false, at: Date.now() };
		state.operations.push(operation); saveState();
		try {
			const value = parseAcceptanceToolResult(name, await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input }));
			operation.success = true;
			return value;
		} catch (error) { operation.error = clip(error.message); saveState(); throw error; }
	};
	const readApiTool = async (name, input) => {
		try { return await invoke(name, input); } catch (error) { return { success: false, error: clip(error.message) }; }
	};
	const firstHistoricalActivation = async uri => {
		const operation = { sequence: state.operations.length + 1, phase, name: 'kusto-workbench_activate-workbench-file', input: { targetFileUri: uri.toString() }, success: false, at: Date.now() };
		state.operations.push(operation); saveState();
		try {
			operation.raw = await vscode.lm.invokeTool(operation.name, { toolInvocationToken: undefined, input: operation.input });
			operation.text = operation.raw?.content?.find(part => typeof part?.value === 'string')?.value;
			try { operation.value = JSON.parse(operation.text); } catch { operation.decodeError = 'First public activation did not return a JSON object'; }
			const value = operation.value;
			operation.success = !!value && !Array.isArray(value) && value.success === true && value.uri === uri.toString()
				&& typeof value.openFileId === 'string' && value.openFileId.length > 0
				&& (value.isLiveWorkbench === true && value.isReadOnlyFallback !== true
					|| /\.md$/i.test(uri.fsPath) && value.isReadOnlyFallback === true && value.isLiveWorkbench === false);
			if (!operation.success) operation.error = clip(value?.error ?? operation.decodeError ?? 'First public activation did not admit the exact target');
		} catch (error) { operation.transportError = clip(error?.message ?? error); operation.error = operation.transportError; }
		operation.finishedAt = Date.now(); operation.elapsedMs = operation.finishedAt - operation.at;
		operation.activeImmediatelyAfter = activeUri() ?? null;
		saveState(); return operation;
	};
	const apiSnapshot = async uri => {
		const listed = await readApiTool('kusto-workbench_list-sections', {});
		const matches = listed.openFiles?.filter(file => file.uri === uri.toString() || file.logicalUri === uri.toString()) ?? [];
		for (const file of listed.openFiles ?? []) if (file.sectionsUnavailable || file.error) {
			if (!state.api.snapshotFailures.some(entry => entry.uri === file.uri)) state.api.snapshotFailures.push({ phase, uri: file.uri, error: clip(file.error ?? 'Snapshot unavailable') });
		}
		const current = matches[0];
		const snapshot = Array.isArray(listed.sections) && matches.length === 1 && current.sectionsUnavailable !== true && !current.error
			&& (current.isReadOnlyFallback !== true || /\.md$/i.test(uri.fsPath)) && listed.filePath?.toLowerCase() === uri.fsPath.toLowerCase();
		return { uri: uri.toString(), openFileId: current?.openFileId ?? null, exact: exactActive(uri), snapshot,
			readOnlyFallback: current?.isReadOnlyFallback === true, sectionCount: listed.sections?.length ?? null, error: listed.error ?? current?.error ?? null };
	};
	const apiBridge = () => {
		const connections = loadedModule()?.exports?.toolOrchestrator?.liveConnections;
		const matches = connections instanceof Map ? [...connections.values()].filter(entry => (entry.documentUri ?? entry.documentInfo?.uriString) === canaryUri.toString()) : [];
		const connection = matches.length === 1 ? matches[0] : null;
		return { uri: canaryUri.toString(), liveConnectionCount: matches.length, token: connection?.token ?? null, sequence: connection?.sequence ?? null,
			snapshotCallbackObserved: typeof connection?.stateGetter === 'function',
			stateGetter: fingerprintMethod('stateGetter', connection?.stateGetter, fs.readFileSync(config.expectedBuildIdentity.mainPath, 'utf8')) };
	};
	const apiOracles = async name => {
		phase = name;
		const target = { openFileId: state.api.openFileId, targetFileUri: canaryUri.toString() };
		const activeBefore = activeUri();
		const bridge = apiBridge();
		const notes = await readApiTool('kusto-workbench_manage-development-notes', { action: 'view', ...target });
		const activeAfterNote = activeUri();
		const dashboard = await readApiTool('kusto-workbench_validate-html-dashboard', { sectionId: oracle.htmlSectionId, ...target });
		const activeAfter = activeUri();
		const note = { phase: name, uri: target.targetFileUri, openFileId: target.openFileId, success: notes.success === true, exact: isDeepStrictEqual(notes.notes, [oracle.note]), notes: notes.notes ?? null, error: notes.error ?? null };
		const validation = { phase: name, uri: target.targetFileUri, openFileId: target.openFileId, sectionId: dashboard.sectionId ?? oracle.htmlSectionId,
			success: dashboard.success === true, valid: dashboard.valid === true, hasProvenance: dashboard.hasProvenance === true,
			bindingCount: dashboard.bindingCount ?? 0, dataSourceCount: dashboard.dataSourceCount ?? 0, factColumns: dashboard.factColumns ?? [],
			issues: dashboard.issues ?? [], diagnostics: dashboard.diagnostics ?? [], error: dashboard.error ?? null,
			exactTarget: dashboard.filePath?.toLowerCase() === canaryUri.fsPath.toLowerCase() };
		const check = { phase: name, ...target, uri: target.targetFileUri, activeBefore, activeAfterNote, activeAfter,
			noAutoReveal: activeBefore === activeAfterNote && activeBefore === activeAfter && state.api.autoRevealEvents.length === 0,
			hidden: !exactActive(canaryUri), bridge, oraclesExact: note.success && note.exact && validation.success && validation.valid && validation.hasProvenance
				&& validation.bindingCount === 6 && validation.dataSourceCount === 1 && validation.exactTarget && isDeepStrictEqual(validation.factColumns, oracle.factColumns)
				&& validation.issues.length === 0 && validation.diagnostics.length === 0 };
		state.notes.push(note); state.dashboards.push(validation); state.api.checks.push(check); saveState();
		return check;
	};
	const prepareRuntime = async () => {
		const driver = vscode.extensions.getExtension('workbench-test.published-corruption-driver');
		const driverContext = await driver?.activate();
		if (driverContext?.extensionMode !== vscode.ExtensionMode.Development) throw new Error('Inert driver actual Development context not observed');
		try {
			if (extension.isActive === true) throw new Error('Workbench activated before actual facade observation; ingress is unobservable');
			const workbenchFacade = createRequire(config.expectedBuildIdentity.mainPath)('vscode');
			executionObserver = observeAcceptanceExecutionBoundary(workbenchFacade, { ownedUris, coldUri: (apiOnly ? canaryUri : coldUri).toString(),
				coldSectionId: apiOnly ? oracle.factSectionId : config.acceptancePlan.legacySectionId,
				source: 'actual-workbench-vscode-facade', onEvent: event => { journal.note({ phase: 'execution-observed', ...event }); saveState(); } });
		} catch (error) { state.execution.blockers.push('BLOCKED: ' + clip(error.message)); }
		await extension.activate();
		if (vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('A Workbench runtime opened before the first case; do not warm or close it');
		state.identity.before = readIdentity(driverContext.extensionMode);
		if (state.identity.before.extensionMode !== vscode.ExtensionMode.Production || !state.identity.before.contextObserved || !state.identity.before.moduleCacheLoaded) throw new Error('Actual Production context / loaded main module not observed');
		const commands = await vscode.commands.getCommands(true);
		if (commands.some(name => name.startsWith('kustoWorkbench.test.'))) throw new Error('Production fixture ownership hard gate failed: Development seed commands exposed');
	};
	const waitForExactOwnedTab = (uri, deadline, requireActive) => new Promise((resolve, reject) => {
		const subscriptions = [];
		const reference = referenceFor(uri.toString());
		const isCold = uri.toString() === coldUri.toString();
		let settled = false;
		const finish = (error, snapshot) => {
			if (settled) return;
			settled = true; clearTimeout(timer);
			for (const subscription of subscriptions) subscription.dispose();
			if (error) reject(error); else resolve(snapshot);
		};
		const check = () => {
			try {
				const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString());
				if (!tabs.length) return;
				if (tabs.length !== 1 || !(tabs[0].input instanceof vscode.TabInputCustom) || tabs[0].input.viewType !== viewTypeFor(uri)) throw tabFailure('BLOCKED: exact owned tab is duplicate or has the wrong editor type', uri);
				const document = documentFor(uri);
				if (tabs[0].isDirty !== false || document && (document.isDirty !== false || document.getText() !== reference.text)) {
					if (document) {
						const revision = { phase: 'tab-readiness:' + phase, openGeneration: generation(document), documentVersion: document.version, isDirty: tabs[0].isDirty || document.isDirty, text: document.getText() };
						if (isCold) recordColdCanaryRevision(state, reference, revision); else recordUntouchedRevision(state, reference, revision);
					} else {
						const untouched = isCold ? state.coldCanary : state.untouched;
						untouched.allRevisionsClean = false; untouched.dirtyTransitions.push({ phase: 'tab-readiness:' + phase, path: reference.path, isDirty: true, at: Date.now() });
					}
					throw tabFailure('Exact owned tab/buffer changed or became dirty; no normalization or Save', uri);
				}
				if (!document || requireActive && !exactActive(uri)) return;
				finish(null, tabSnapshot(uri));
			} catch (error) { finish(error); }
		};
		const timer = setTimeout(() => finish(tabFailure(requireActive ? 'Exact owned URI/custom editor is not active after first activation; no healthy-neighbor substitution'
			: 'BLOCKED: exact clean owned Workbench tab/buffer unavailable before first activation', uri)), Math.max(0, deadline - Date.now()));
		try {
			subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(check));
			subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(check));
			subscriptions.push(vscode.workspace.onDidOpenTextDocument(check));
			subscriptions.push(vscode.workspace.onDidChangeTextDocument(check));
			check();
		} catch (error) { finish(tabFailure('BLOCKED: native tab readiness observation unavailable: ' + clip(error.message), uri)); }
	});
	const open = async (uri, requireActive = true, deadline) => {
		await vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri), { preview: false });
		let snapshot;
		if (requireActive) assertActive(uri); else snapshot = await waitForExactOwnedTab(uri, deadline, false);
		expectedActiveUri = uri;
		return snapshot;
	};
	const artifact = name => {
		const files = findFiles(config.frameworkRunsRoot, file => file === name + '.json');
		if (files.length !== 1) throw new Error('Exact current-run JSON artifact unavailable/ambiguous: ' + name);
		return readJson(files[0]);
	};
	const controlTarget = name => {
		const uri = expectedActiveUri.toString();
		const panel = executionObserver?.panelFor(uri);
		if (!panel || panel.active !== true || panel.visible !== true) throw new Error('BLOCKED: actual exact-URI panel observation unavailable');
		const relative = acceptanceControlPath(name, order, coldCanary.path);
		if (vscode.Uri.file(path.join(root, relative)).toString() !== uri) throw new Error('Exact control URI differs from the intended recorded checkpoint');
		const reference = referenceFor(uri) ?? { text: initialText };
		let archivedId;
		if (/\.(kqlx|sqlx|mdx)$/.test(relative)) archivedId = JSON.parse(reference.text).state?.sections?.find(section => section.type === 'query' || section.type === 'sql')?.id;
		else {
			const companion = references.get(vscode.Uri.file(expectedActiveUri.fsPath + '.json').toString());
			if (companion) archivedId = JSON.parse(companion.text).state?.sections?.find(section => section.type === 'query' || section.type === 'sql')?.id;
		}
		const sectionId = panel.sectionIds[0] ?? archivedId;
		if (typeof sectionId !== 'string' || !sectionId) throw new Error('BLOCKED: authoritative first Query section identity unavailable');
		return { uri, sectionId, panel: { uri: panel.uri, handle: panel.handle, cspSource: panel.cspSource, generation: panel.generation, active: panel.active, visible: panel.visible } };
	};
	const session = {
		state,
		openApi: guard(async () => {
			if (!apiOnly || coldAttemptStarted) throw new Error('Readonly API initialization cannot substitute for or replay the cold case');
			coldAttemptStarted = true;
			await checkpoint('prepared'); await prepareRuntime();
			phase = 'initial';
			const deadline = Date.now() + STEP_TIMEOUT_MS;
			state.api.tabReadiness.before = await open(canaryUri, false, deadline);
			state.api.openFileId = metadataId(canaryUri); state.api.initialActivationCalls++;
			const result = await invoke('kusto-workbench_activate-workbench-file', { openFileId: state.api.openFileId, targetFileUri: canaryUri.toString() });
			state.api.initialActivation = { uri: result.uri ?? null, openFileId: result.openFileId ?? state.api.openFileId, success: false };
			if (result.isLiveWorkbench !== true || result.uri !== canaryUri.toString()
				|| result.openFileId !== undefined && result.openFileId !== state.api.openFileId) throw tabFailure('First API activation did not establish the exact URI/ID panel; no replay', canaryUri, { activation: state.api.initialActivation });
			state.api.tabReadiness.after = await waitForExactOwnedTab(canaryUri, deadline, true);
			assertActive(canaryUri);
			if (metadataId(canaryUri) !== state.api.openFileId) throw tabFailure('First API activation changed the exact current openFileId; no replay', canaryUri);
			state.api.initialActivation.success = true;
			state.api.status = 'observing'; state.api.warmReport = true;
			await invoke('kusto-workbench_list-connections', {});
			const snapshot = await apiSnapshot(canaryUri);
			const oracles = await apiOracles('initial');
			state.api.phases.push('initial');
			await checkpoint('initial');
			if (!snapshot.exact || !snapshot.snapshot || snapshot.openFileId !== state.api.openFileId || !oracles.oraclesExact || !oracles.noAutoReveal || oracles.hidden) throw new Error('BLOCKED: StageSetupBlockingOwner: unchanged archived canary was not lawfully admitted; no fake result values, auth seed, query or offline-query substitution');
			state.fixtureOwnership.status = 'legitimate-production-owner'; state.fixtureOwnership.reason = null;
			return { phase: 'initial', warmReport: true, coldGate: 'SEPARATE_UNATTEMPTED', openFileId: state.api.openFileId, uri: state.api.uri, oracles, loadedBuild: state.identity.before };
		}),
		hideApi: guard(async () => {
			if (!apiOnly || state.api.phases.at(-1) !== 'full109') throw new Error('Exact full109 must precede hidden API reads');
			await checkpoint('before-hidden'); await open(hiddenUri);
			const oracles = await apiOracles('hidden'); state.api.phases.push('hidden');
			return { oracles, preservation: await checkpoint('hidden') };
		}),
		reactivateApi: guard(async () => {
			if (!apiOnly || state.api.phases.at(-1) !== 'hidden' || state.api.activationCalls !== 0) throw new Error('Sole ordinary exact-ID activation cannot be replayed');
			await checkpoint('before-reactivated'); phase = 'reactivated'; state.api.activationCalls++;
			const result = await readApiTool('kusto-workbench_activate-workbench-file', { openFileId: state.api.openFileId, targetFileUri: canaryUri.toString() });
			state.api.activation = { uri: result.uri ?? null, openFileId: result.openFileId ?? state.api.openFileId,
				success: result.success === true && result.isLiveWorkbench === true && result.uri === canaryUri.toString()
					&& (result.openFileId === undefined || result.openFileId === state.api.openFileId) && exactActive(canaryUri), error: result.error ?? null };
			const oracles = await apiOracles('reactivated'); state.api.phases.push('reactivated');
			return { activation: state.api.activation, oracles, preservation: await checkpoint('reactivated') };
		}),
		openCold: guard(async () => {
			if (coldAttemptStarted) throw new Error('First cold activation was already attempted; no retry or replay');
			coldAttemptStarted = true;
			await checkpoint('before-cold');
			await prepareRuntime();
			phase = 'cold-open'; state.cold.firstWorkbenchActivation = true;
			state.cold.activationPhase = 'opening';
			const deadline = Date.now() + STEP_TIMEOUT_MS;
			state.cold.tabReadiness.before = await open(coldUri, false, deadline);
			state.cold.activationPhase = 'tab-ready';
			await checkpoint('before-cold-activation');
			phase = 'cold-open';
			const openFileId = metadataId(coldUri);
			state.cold.firstMetadataId = { uri: coldUri.toString(), openFileId, matchingCount: 1, lookupCount: 1, source: 'metadata-only' };
			state.cold.firstToolTarget = 'openFileId'; state.cold.activationCalls++; state.cold.activationPhase = 'tool-invoked';
			const result = await invoke('kusto-workbench_activate-workbench-file', { openFileId, targetFileUri: coldUri.toString() });
			if (result.isLiveWorkbench !== true || result.uri !== coldUri.toString()) throw tabFailure('First cold activation did not establish the exact usable panel', coldUri, { toolResult: result });
			state.cold.tabReadiness.after = await waitForExactOwnedTab(coldUri, deadline, true);
			assertActive(coldUri);
			await checkpoint('after-cold-activation');
			phase = 'cold-open';
			state.cold.activationPhase = 'exact-active';
			return { coldUri: coldUri.toString(), coldBytes: state.cold.legacyBytes, loadedBuild: state.identity.before, firstToolTarget: 'openFileId', activationCalls: 1, tabReadiness: state.cold.tabReadiness };
		}),
		acceptControl: guard(async name => {
			phase = name; assertActive(expectedActiveUri);
			if (!ACCEPTANCE_CONTROL_PHASES.includes(name) || state.rawCaptures.some(capture => capture.phase === name)) throw new Error('Unknown or replayed native control phase');
			await checkpoint(name);
			const probe = artifact(name === 'cold-escape' ? 'original109-cold-escape' : 'original109-controls-' + name);
			if (probe.ready !== true || !probe.token || !probe.sectionId) throw new Error('Actual Query control/frame probe failed: ' + name);
			if (name === 'cold-controls') state.cold.controlsReady = true;
			if (name === 'cold-menu') { if (probe.menuOpen !== true) throw new Error('Cold native menu missing'); state.cold.menuOpened = true; }
			const raw = { phase: name, probe, file: path.join(config.evidenceRoot, name + '.png'), native: false, currentFrame: false, fallback: true };
			state.rawCaptures.push(raw);
			try {
				raw.target = controlTarget(name);
				if (!nativeUI) {
					const candidates = listProcesses().filter(entry => String(entry.Name).toLowerCase() === 'code.exe'
						&& String(entry.CommandLine).toLowerCase().includes(config.userData.toLowerCase()) && !/--type=/.test(String(entry.CommandLine)));
					if (candidates.length !== 1) throw new Error('BLOCKED: isolated native window PID is ambiguous or missing');
					raw.cdpOwner = observeAcceptanceCdpOwner(candidates[0].ProcessId, config.cdpPort);
					const { NativeUIClient } = await import(pathToFileURL(config.nativeUiModule).href);
					const { CdpClient } = await import(pathToFileURL(config.cdpModule).href);
					if (typeof CdpClient?.prototype?.synchronizeResolvedWebviewForNativeCapture !== 'function') throw new Error('BLOCKED: actual tester CDP synchronization API unavailable');
					nativeUI = new NativeUIClient(); nativeUI.targetPid = candidates[0].ProcessId; await nativeUI.start();
					cdp = new CdpClient(config.cdpPort); await cdp.connect();
				}
				const window = await nativeUI.prepareDevHostScreenshot();
				const expectation = name === 'cold-menu' ? 'open' : name === 'cold-escape' ? 'dismissed' : 'closed';
				const expression = `(() => { if (globalThis.__original109ControlProbe?.token !== ${JSON.stringify(probe.token)}) throw new Error('BLOCKED: exact Query control frame token missing or changed'); return (${readAcceptanceControlDom.toString()})(${JSON.stringify(name)}, ${JSON.stringify(raw.target.sectionId)}, ${JSON.stringify(probe.query)}, ${JSON.stringify(expectation)}, ${JSON.stringify(probe.token)}); })()`;
				raw.beforeProbe = await cdp.evaluateInWebview(expression, undefined, { timeoutMs: 5000 });
				assertSameControlProbe(probe, raw.beforeProbe);
				const resolved = { ...cdp.resolvedWebviewContext };
				raw.nativeGeometry = { frameOwner: await readAcceptanceFrameOwner(cdp, resolved) };
				raw.nativeGeometry.nativeDocuments = await readNativeDocuments(nativeUI, window, raw.nativeGeometry.frameOwner.shell.documentTitle, raw.nativeGeometry);
				Object.assign(raw, await captureSynchronizedNativeFrame(nativeUI, cdp, raw.file, resolved));
				const reply = await cdp.withWebviewClient(resolved.targetId, client => cdp.withProtocolTimeout(client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true,
					...(resolved.uniqueContextId ? { uniqueContextId: resolved.uniqueContextId } : { contextId: resolved.contextId }) }), 'exact post-capture Query frame verification'), { retries: 1, retryOperationTimeouts: false });
				if (reply.exceptionDetails) throw new Error('Exact control frame was replaced after native capture');
				raw.afterProbe = reply.result.value;
				assertSameControlProbe(probe, raw.afterProbe);
				raw.afterNativeGeometry = { frameOwner: await readAcceptanceFrameOwner(cdp, resolved) };
				raw.afterNativeGeometry.nativeDocuments = await readNativeDocuments(nativeUI, window, raw.afterNativeGeometry.frameOwner.shell.documentTitle, raw.afterNativeGeometry);
				assertStableNativeGeometry(raw.nativeGeometry, raw.afterNativeGeometry);
				assertActive(expectedActiveUri);
				raw.controlProof = correlateControlRegions(probe, raw.target, raw, raw.nativeGeometry);
				raw.regions = raw.controlProof.regions;
			} catch (error) { raw.error = clip(error.message); raw.blocked = String(error.message).startsWith('BLOCKED:') || String(error.message).includes('BLOCKED: exact Query control frame token missing or changed'); }
			saveState();
			return { phase: name, domControlsReady: probe.ready, nativeFrameProven: !raw.error && raw.native, controlGeometryProven: !raw.error && !!raw.controlProof,
				status: raw.blocked ? 'BLOCKED' : raw.error ? 'REJECTED' : 'PENDING_CPU_REVIEW', captureError: raw.error ?? null, visualReview: 'human-unreviewed', cpuReview: 'pending-parent-collector' };
		}),
		clickColdToggle: guard(async () => {
			await checkpoint('before-cold-toggle');
			assertActive(coldUri);
			const capture = state.rawCaptures.find(value => value.phase === 'cold-controls');
			const toggle = capture?.controlProof?.regions?.find(region => region.name === 'query-toggle');
			if (capture?.error || capture?.native !== true || !toggle || typeof nativeUI?.clickInDevHostAt !== 'function') throw new Error('BLOCKED: real cold toggle input requires exact synchronized control geometry');
			await nativeUI.clickInDevHostAt(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
			assertActive(coldUri);
			return { input: 'real-native-mouse', uri: coldUri.toString(), sectionId: capture.controlProof.sectionId, elementId: toggle.elementId };
		}),
		acceptEscape: guard(async () => {
			const probe = artifact('original109-cold-escape');
			if (probe.dismissed !== true || probe.query !== '') throw new Error('Cold native Escape / blank-query boundary failed');
			saveState();
			if (state.execution.events?.length) throw new Error('Actual execution ingress/start observed during the no-execution cold workflow');
			state.cold.escapeDismissed = true;
			return { ...await checkpoint('cold'), execution: state.execution.status, ingressCount: state.execution.ingressCount, startCount: state.execution.startCount, blankExecutions: state.execution.blankExecutions };
		}),
		checkpoint: guard(checkpoint),
		hideCold: guard(async () => { await checkpoint('before-hide'); await open(hiddenUri); return { hidden: true, nonWorkbenchTarget: hiddenUri.toString() }; }),
		revealCold: guard(async () => {
			await checkpoint('before-reveal');
			const result = await invoke('kusto-workbench_activate-workbench-file', { openFileId: metadataId(coldUri), targetFileUri: coldUri.toString() });
			if (result.isLiveWorkbench !== true || result.uri !== coldUri.toString()) throw new Error('Exact reveal failed');
			assertActive(coldUri); expectedActiveUri = coldUri; return checkpoint('revealed');
		}),
		activateRange: guard(async (start, end) => {
			if (start !== state.activationAttempts.length || end > 109 || end <= start) throw new Error('Recorded original109 range was skipped or replayed');
			if (apiOnly && state.api.phases.at(-1) !== 'initial') throw new Error('Initial archived API oracles must precede exact historical opens');
			for (let index = start; index < end; index++) {
				phase = 'historical-' + (index + 1);
				const attempt = { ordinal: index + 1, expected: order[index], observed: null, at: Date.now() };
				state.activationAttempts.push(attempt); saveState();
				if (apiOnly) await checkpoint('before-open-' + (index + 1));
				phase = 'historical-' + (index + 1);
				const uri = uriFor(order[index]);
				const first = apiOnly ? await firstHistoricalActivation(uri) : (await open(uri), undefined);
				const observedUri = activeUri();
				attempt.observed = typeof observedUri === 'string' ? path.relative(config.historyRoot, fileURLToPath(observedUri)).split(path.sep).join('/') : null;
				if (!apiOnly && attempt.observed !== attempt.expected) throw new Error('Historical activation selected another file');
				if (attempt.observed === attempt.expected) state.activationOrder.push(attempt.observed);
				saveState();
				if (apiOnly) {
					state.api.history.push({ path: order[index], firstCallPassed: first.success && attempt.observed === attempt.expected,
						firstActivation: first, ...await apiSnapshot(uri) });
					await checkpoint('after-open-' + (index + 1));
				}
			}
			if (apiOnly && end === 109) { state.api.phases.push('full109'); return checkpoint('full109'); }
			return checkpoint('after-' + end);
		}),
		closeCold: guard(async () => { await checkpoint('before-close'); const result = await closeAcceptanceTabs(vscode, config.owner, [coldUri.toString()]); await checkpoint('closed'); return result; }),
		reopenCold: guard(async () => { await checkpoint('before-reopen'); await open(coldUri); await waitForExactOwnedTab(coldUri, Date.now() + STEP_TIMEOUT_MS, true); return checkpoint('reopened'); }),
		openAuthoring: guard(async () => { await checkpoint('before-authoring'); await open(authorUri); return { uri: authorUri.toString(), separateDisposableCopy: true }; }),
		beginAuthoring: guard(async revision => {
			await checkpoint('before-native-authoring-' + revision);
			assertActive(authorUri);
			if (revision !== authoringRevision + 1 || revision > 2) throw new Error('Native authoring intent cannot be replayed');
			const document = documentFor(authorUri);
			if (!document || document.isDirty || revision === 1 && document.getText() !== initialText) throw new Error('Authoring baseline was not exactly clean');
			authoringRevision = revision; intendedQuery = 'print AcceptanceAuthored=' + revision; phase = 'native-authoring-' + revision;
			return { uri: authorUri.toString(), revision, intendedQuery, nativeSaveCommand: 'workbench.action.files.save' };
		}),
		waitForAuthoringSave: guard(async revision => {
			assertActive(authorUri);
			if (revision !== authoringRevision) throw new Error('Native Save target/revision mismatch');
			const expected = JSON.parse(initialText); expected.state.sections[0].query = intendedQuery;
			const deadline = Date.now() + 10000; let previous = ''; let stableSince = Date.now();
			while (Date.now() < deadline) {
				const text = fs.readFileSync(authorUri.fsPath, 'utf8');
				const document = documentFor(authorUri);
				if (text !== previous || !document || document.isDirty || document.getText() !== text) stableSince = Date.now();
				if (Date.now() - stableSince >= 500 && isDeepStrictEqual(JSON.parse(text), expected)) {
					await observationTail;
					const manual = state.nativeSaves.some(entry => entry.authoringRevision === revision && entry.event === 'will-save' && entry.reason === vscode.TextDocumentSaveReason.Manual);
					const committed = state.nativeSaves.some(entry => entry.authoringRevision === revision && entry.event === 'did-save');
					if (!manual || !committed) throw new Error('Explicit native Save boundary not observed; Auto Save is not a substitute and Save must not be replayed');
					state.lifecycle.authoring = true; state.lifecycle.nativeSave = true;
					if (revision === 2 && state.lifecycle.reopen) state.lifecycle.secondInteraction = true;
					return { revision, query: intendedQuery, dirty: false, sha256: sha256(text), manualNativeSave: true, source: await checkpoint('authored-save-' + revision) };
				}
				previous = text; await new Promise(resolve => setTimeout(resolve, 50));
			}
			throw new Error('Native Save did not settle; no replay, all failure fixtures retained');
		}),
		reopenAuthoring: guard(async () => {
			if (!state.lifecycle.nativeSave || authoringRevision !== 1) throw new Error('First authored native Save not accepted');
			const before = fs.readFileSync(authorUri.fsPath);
			await closeAcceptanceTabs(vscode, config.owner, [authorUri.toString()]); await open(authorUri);
			if (!fs.readFileSync(authorUri.fsPath).equals(before)) throw new Error('Authoring reopen changed durable bytes');
			state.lifecycle.reopen = true; return { reopened: true, exactSavedBytes: true };
		}),
		productionOwnershipGate: guard(async () => {
			state.independentBoundaries = { coldControlsDom: state.cold.controlsReady && state.cold.menuOpened && state.cold.escapeDismissed, coldControlsPixels: 'PENDING_PARENT_CPU_REVIEW',
				original109: state.activationOrder.length === 109 && JSON.stringify(state.activationOrder) === JSON.stringify(order),
				untouched: state.untouched.exactBytes && state.untouched.allRevisionsClean && state.coldCanary.exactBytes
					&& state.coldCanary.allRevisionsClean && state.coldCanary.versionsStable, nativeAuthoring: state.lifecycle.secondInteraction };
			return { complete: false, fixtureOwnership: state.fixtureOwnership, independentBoundaries: state.independentBoundaries, notesDashboard: 'BLOCKED_NOT_ATTEMPTED' };
		}),
		finish: guard(async () => {
			await checkpoint('before-cleanup');
			Object.assign(state.cleanup, await closeAcceptanceTabs(vscode, config.owner, [...ownedUris]));
			await checkpoint('after-cleanup');
			state.identity.after = readIdentity(state.identity.before?.driverExtensionMode);
			executionObserver?.restore();
			for (const observer of observers) observer.dispose();
			nativeUI?.stop();
			cdp?.disconnect();
			const summary = await journal.close();
			summary.harnessFailures.push(...state.observerFailures);
			if (apiOnly) {
				if (state.api.phases.at(-1) === 'reactivated') state.api.phases.push('closed');
				state.api.status = state.api.phases.length === 5 && state.api.history.length === 109 && state.api.history.every(entry => entry.firstCallPassed === true && entry.exact && entry.snapshot)
					&& state.api.snapshotFailures.length === 0 && state.api.activation?.success === true && state.api.checks.length === 3
					&& state.api.checks.every(entry => entry.oraclesExact && entry.noAutoReveal && entry.hidden === (entry.phase === 'hidden')) ? 'complete' : 'partial';
			}
			saveState();
			writeJsonAtomic(path.join(config.evidenceRoot, 'lifecycle-summary.json'), { verdict: apiOnly ? state.api.status === 'complete' ? 'API_PRESERVATION_COMPLETE' : 'PARTIAL_API_PRESERVATION' : 'PARTIAL_ACCEPTANCE_ONLY',
				fixtureUri: (apiOnly ? canaryUri : authorUri).toString(), operations: state.operations, journal: summary });
			return { acceptanceQualified: false, independentBoundaries: state.independentBoundaries, cleanup: state.cleanup, loadedBuild: state.identity.after,
				...(apiOnly ? { apiPreservationStatus: 'AWAITING_INDEPENDENT_COLLECTION', nativeAuthoring: 'UNATTEMPTED', pixels: 'UNATTEMPTED' } : {}),
				fixtureOwnership: state.fixtureOwnership, visualReview: 'human-unreviewed', fixtureRootPreserved: root };
		}),
	};
	if (apiOnly) for (const name of ['openCold', 'acceptControl', 'clickColdToggle', 'acceptEscape', 'hideCold', 'revealCold', 'closeCold', 'reopenCold', 'openAuthoring', 'beginAuthoring', 'waitForAuthoringSave', 'reopenAuthoring', 'productionOwnershipGate']) {
		session[name] = guard(async () => { throw new Error('Readonly API mode cannot perform the separate native/pixel/authoring workflow: ' + name); });
	}
	saveState();
	return session;
}

async function openZip(file) {
	const yauzl = createRequire(require.resolve('extract-zip'))('yauzl');
	const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value)));
	const entries = new Map();
	try {
		await new Promise((resolve, reject) => {
			zip.on('error', reject);
			zip.on('entry', entry => {
				if (entries.has(entry.fileName)) { reject(new Error('Duplicate ZIP entry: ' + entry.fileName)); return; }
				entries.set(entry.fileName, entry); zip.readEntry();
			});
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
	return { names: [...entries.keys()], entry: name => entries.get(name), read, close: () => zip.close() };
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
		treeSha256: tree.length ? treeHash(tree) : null, treeFiles: tree.length, assetTrees: hashAssetTrees(tree),
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
	return { treeSha256: treeHash(files), treeFiles: files.length, assetTrees: hashAssetTrees(files) };
}

function hashAssetTrees(files) {
	return { monaco: treeHash(files.filter(file => /monaco/i.test(file.path))), css: treeHash(files.filter(file => /\.css$/i.test(file.path))),
		scripts: treeHash(files.filter(file => /\.(js|mjs|cjs)$/i.test(file.path))) };
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

function gitInfo(root = REPO_ROOT) {
	const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
	try {
		const patch = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
		const untracked = git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).map(file => ({ path: file, sha256: sha256File(path.join(root, file)) }));
		const dependencies = ['package.json', 'package-lock.json'].filter(file => fs.existsSync(path.join(root, file))).map(file => ({ path: file, sha256: sha256File(path.join(root, file)) }));
		return { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean), patchSha256: sha256(Buffer.concat([patch, Buffer.from(JSON.stringify(untracked))])), dependenciesSha256: treeHash(dependencies) };
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

export function stageAssets(options, assetsDir) {
	if (options.acceptance) {
		const root = assertAcceptanceRoot(options.owner);
		if (!within(root, assetsDir) || path.resolve(options.featureDir).toLowerCase() !== ACCEPTANCE_FEATURE_DIR.toLowerCase()) throw new Error('Acceptance assets require the exact approved feature and owned root');
		assertCanonicalDirectory(assetsDir);
	}
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
	if (options.acceptance) {
		const source = path.join(options.featureDir, 'workbench-tool-session-activation-sweep.feature');
		assets.featureSource = copy(source, 'activation-sweep-source.feature.txt');
		const featureName = options.acceptance + '-acceptance.feature';
		assets.feature = path.join(featureDir, featureName);
		fs.writeFileSync(assets.feature, extractAcceptanceFeature(fs.readFileSync(assets.featureSource, 'utf8'), options.acceptance), { flag: 'wx' });
		assets.files[featureName] = { source: assets.featureSource, path: assets.feature, sha256: sha256File(assets.feature) };
		assets.helper = copy(path.join(DEFAULTS.featureDir, 'lifecycle-journal.cjs'), 'lifecycle-journal.cjs');
		assets.acceptanceHarness = copy(fileURLToPath(import.meta.url), 'acceptance-harness.mjs');
		assets.acceptanceHarnessSha256 = sha256File(assets.acceptanceHarness);
		copy(path.join(options.featureDir, 'e2e.settings.json'), 'e2e.settings.json');
	} else if (options.observation === 'legacy') {
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

export function collectAcceptanceState(context) {
	const config = context.acceptanceConfig;
	const root = assertAcceptanceRoot(config.owner);
	const file = path.join(context.evidenceRoot, 'acceptance-state.json');
	if (!fs.existsSync(file)) return null;
	const state = readJson(file);
	const archiveVerified = sha256File(config.beforeArchiveCopy) === state.archive.beforeSha256 && sha256File(config.orderArchiveCopy) === state.archive.orderSha256;
	if (state.identity.before) Object.freeze(state.identity.before);
	if (state.identity.after) Object.freeze(state.identity.after);
	if (config.acceptance !== 'current133-api') {
	state.pixels.captures = (state.rawCaptures ?? []).map(raw => {
		let capture = { phase: raw.phase, native: false, currentFrame: false, fallback: true, decoded: false, controlsNonblank: false };
		try {
			if (raw.error) throw new Error(raw.error);
			const expectedPath = acceptanceControlPath(raw.phase, config.acceptancePlan.activationOrder, config.coldCanary.path);
			if (!expectedPath || path.resolve(fileURLToPath(raw.target?.uri)).toLowerCase() !== path.resolve(root, expectedPath).toLowerCase()) throw new Error('Native control evidence does not target the exact intended cold-copy/historical/authoring URI');
			assertSameControlProbe(raw.probe, raw.beforeProbe);
			assertSameControlProbe(raw.probe, raw.afterProbe);
			assertStableNativeGeometry(raw.nativeGeometry, raw.afterNativeGeometry);
			if (!within(context.evidenceRoot, raw.file)) throw new Error('Native PNG outside exact owned evidence root');
			assertCanonicalDirectory(path.dirname(raw.file));
			const stat = fs.lstatSync(raw.file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Native PNG became aliased');
			capture = { ...capture, ...admitNativeCapture(raw.result, raw.expectedWindow, raw.webviewSynchronization, raw.resolvedContext), sha256: sha256File(raw.file) };
			capture.controlProof = correlateControlRegions(raw.probe, raw.target, capture, raw.nativeGeometry);
			const decoded = decodePngControlRegions(raw.file, capture.controlProof.regions);
			capture = assessControlPixels(capture, decoded);
		} catch (error) { capture.error = clip(error.message); capture.blocked = raw.blocked === true || String(error.message).startsWith('BLOCKED:'); }
		return capture;
	});
	state.pixels.menuEscapeDistinctFrames = verifyMenuEscapeFrames(state.pixels.captures.find(capture => capture.phase === 'cold-menu'), state.pixels.captures.find(capture => capture.phase === 'cold-escape'));
	state.pixels.capabilityBlockers = state.pixels.captures.filter(capture => capture.blocked).map(capture => ({ phase: capture.phase, error: capture.error }));
	state.pixels.status = state.pixels.capabilityBlockers.length ? 'cpu-evidence-blocked' : state.pixels.captures.length === ACCEPTANCE_CONTROL_PHASES.length
		&& state.pixels.menuEscapeDistinctFrames && state.pixels.captures.every(capture => capture.controlsNonblank) ? 'cpu-verified-unreviewed' : 'cpu-evidence-rejected';
	}
	state.collection = { ownedRoot: root, visualReview: 'human-unreviewed', cpuOnly: config.acceptance !== 'current133-api', archiveVerified, expectedBuildIdentity: config.expectedBuildIdentity };
	if (config.acceptance === 'current133-api') Object.assign(state.collection, { expectedOrder: [...config.acceptancePlan.activationOrder], archivedCanary: structuredClone(config.acceptancePlan.archivedCanary) });
	try {
		state.collection.coldCanary = { ...inspectAcceptanceColdCanary(config.owner, config.historyRoot, config.coldCanary, config.acceptancePlan.files), checkedSourceCount: 1 };
	} catch (error) {
		state.collection.coldCanary = { verified: false, checkedSourceCount: 1, error: clip(error.message) };
		if (state.coldCanary) {
			state.coldCanary.exactBytes = false;
			state.coldCanary.byteChanges.push({ phase: 'independent-post-host-collection', origin: 'disk', error: clip(error.message) });
		}
	}
	for (const source of config.acceptancePlan.files) {
		const actual = sha256File(path.join(config.historyRoot, source.path));
		if (actual !== source.sha256) { state.untouched.exactBytes = false; state.untouched.byteChanges.push({ phase: 'independent-post-host-collection', path: source.path, sha256: actual }); }
	}
	const currentSource = gitInfo(config.sourceRoot);
	const expected = config.expectedBuildIdentity;
	for (const target of [expected.installedPath, expected.mainPath, expected.vsixPath]) if (!within(root, target)) throw new Error('Parent identity target outside the owned stage');
	const installedPath = assertCanonicalDirectory(expected.installedPath);
	assertCanonicalDirectory(path.dirname(expected.mainPath));
	const mainStat = fs.lstatSync(expected.mainPath);
	if (!mainStat.isFile() || mainStat.isSymbolicLink() || mainStat.nlink !== 1) throw new Error('Parent executing main is aliased');
	const mainPath = fs.realpathSync.native(expected.mainPath);
	if (!within(installedPath, mainPath)) throw new Error('Parent executing main outside installed product');
	state.identity.parentFinal = Object.freeze({ installedPath, mainPath, mainSha256: sha256File(mainPath), ...hashInstalledTree(installedPath, config.packageIdentity.vsixMainEntry.split('/')[1]),
		vsixSha256: sha256File(expected.vsixPath), sourceHead: currentSource.head, sourcePatchSha256: currentSource.patchSha256,
		dependenciesSha256: currentSource.dependenciesSha256, vscodeVersion: expected.vscodeVersion });
	if (config.acceptance === 'current133-api') {
		const packagedSource = fs.readFileSync(mainPath, 'utf8');
		state.collection.runtimeVerified = Object.fromEntries(['before', 'after'].map(phase => {
			const methods = state.identity[phase]?.runtime?.methods;
			return [phase, Array.isArray(methods) && methods.length === 6 && methods.every(method => method.matchesPackage === true
				&& Number.isSafeInteger(method.offset) && method.offset >= 0 && Number.isSafeInteger(method.length) && method.length > 0
				&& method.offset + method.length <= packagedSource.length && sha256(packagedSource.slice(method.offset, method.offset + method.length)) === method.sha256)];
		}));
		state.collection.runtimeVerified.panelOwners = false;
		state.collection.runtimeLimitation = 'Executing provider, gateway and webview identities are not observed by orchestrator method fingerprints';
	}
	writeJsonAtomic(path.join(context.evidenceRoot, 'acceptance-collected.json'), state);
	return state;
}

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
	if (context.acceptance) {
		evidence.acceptanceRequired = true;
		evidence.acceptanceMode = context.acceptance;
		evidence.acceptance = collectAcceptanceState(context);
	}
	return evidence;
}

function coldSetupStopped(evidence) {
	const acceptance = evidence.acceptance;
	const cold = acceptance?.cold;
	return cold?.activationCalls === 0 && cold.firstToolTarget === null
		&& (cold.activationPhase === undefined || ['not-attempted', 'opening', 'tab-ready'].includes(cold.activationPhase))
		&& Array.isArray(acceptance.operations) && acceptance.operations.length === 0
		&& Array.isArray(evidence.summary?.operations) && evidence.summary.operations.length === 0
		&& acceptance.untouched?.exactBytes === true && acceptance.untouched.allRevisionsClean === true
		&& !evidence.revisions?.invalid?.length && !evidence.firstInvalid && !evidence.saveLogs?.errors?.length
		&& (evidence.summary?.verdict === 'HARNESS_BLOCKED_SETUP' || acceptance.failures?.some(failure => failure.phase === 'cold-open')
			&& evidence.results?.failedSteps?.length === 1 && evidence.results.failedSteps[0].text?.includes('"original109-isolation"'));
}

function checkAcceptance(evidence, add) {
	const acceptance = evidence.acceptance;
	const blocked = reason => add('HARNESS_BLOCKED', 'acceptance: ' + reason);
	const failed = reason => add('WORKFLOW_FAILED', 'acceptance: ' + reason);
	const suspect = reason => add('HARNESS_SUSPECT', 'acceptance: ' + reason);
	if (!acceptance || acceptance.schemaVersion !== 1 || acceptance.mode !== 'original109') {
		blocked('original109 acceptance artifact missing or unsupported');
		return;
	}
	const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
	const archive = acceptance.archive;
	if (archive?.verified !== true || archive.immutableBeforeImages !== true || archive.baselineCount !== 131
		|| archive.sourceCount !== 131 || archive.sidecarsSeparate !== true
		|| archive.linksConfined !== true || !Number.isSafeInteger(archive.linkedTargetCount) || archive.linkedTargetCount < 0
		|| !hash(archive.beforeSha256) || !hash(archive.orderSha256)) blocked('immutable private before-image archive not independently verified');
	if (acceptance.collection?.archiveVerified !== true) blocked('independent parent archive verification missing or failed');
	const expected = acceptance.expectedOrder;
	const actual = acceptance.activationOrder;
	if (!Array.isArray(expected) || expected.length !== 109 || new Set(expected).size !== 109
		|| expected[82] !== 'past/azure-mcp-growth-analysis.kqlx'
		|| expected[87] !== 'past/azure-mcp-vs-tool-calls-investigation.kqlx'
		|| expected[108] !== 'upgraded-kql-files/historical_success_rate copy.kql'
		|| !Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) blocked('complete exact recorded original109 order not observed');
	for (const phase of ['full109', 'closed', 'reopened']) {
		const inventories = acceptance.historicalInventories?.filter(entry => entry.phase === phase) ?? [];
		if (!inventories.some(entry => entry.retainedCount === 109 && entry.allClean === true
			&& Array.isArray(entry.exactPaths) && entry.exactPaths.length === 109 && JSON.stringify([...entry.exactPaths].sort()) === JSON.stringify([...expected ?? []].sort()))) blocked('independent exact retained109 tab inventory missing at ' + phase);
	}
	const cold = acceptance.cold;
	const canary = acceptance.coldCanary;
	const inspectedCanary = acceptance.collection?.coldCanary;
	try {
		const root = acceptance.collection?.ownedRoot;
		if (!root || !canary || canary.count !== 1 || canary.checkedSourceCount !== 1 || canary.bytes !== 498
			|| canary.markerVerified !== true || canary.aliasFree !== true || !/^[0-9a-f]{48}$/.test(canary.rootMarker ?? '')
			|| !hash(canary.sha256) || canary.sourceSha256 !== canary.sha256 || expected?.[19] !== canary.sourcePath
			|| canary.path !== 'cold-canary/' + path.basename(canary.sourcePath) || canary.root !== path.join(root, 'cold-canary')
			|| cold?.path !== canary.path || cold.uri !== canary.uri || cold.sectionId !== canary.sectionId
			|| path.resolve(fileURLToPath(canary.uri)).toLowerCase() !== path.resolve(root, canary.path).toLowerCase()
			|| path.resolve(fileURLToPath(canary.sourceUri)).toLowerCase() !== path.resolve(root, 'history', canary.sourcePath).toLowerCase()
			|| canary.uri === canary.sourceUri || inspectedCanary?.verified !== true || inspectedCanary.checkedSourceCount !== 1
			|| inspectedCanary.sha256 !== canary.sha256 || inspectedCanary.sourceSha256 !== canary.sourceSha256
			|| inspectedCanary.rootMarker !== canary.rootMarker || inspectedCanary.markerVerified !== true || inspectedCanary.aliasFree !== true
			|| inspectedCanary.path !== canary.path || inspectedCanary.sourcePath !== canary.sourcePath) throw new Error('Separate cold canary count/hash/URI/source/root marker inspection missing or not linked to archival target20');
	} catch (error) { blocked(clip(error.message)); }
	if (canary?.exactBytes !== true || canary.allRevisionsClean !== true || canary.versionsStable !== true
		|| !Array.isArray(canary.dirtyTransitions) || canary.dirtyTransitions.length || !Array.isArray(canary.byteChanges) || canary.byteChanges.length
		|| !Array.isArray(canary.versionChanges) || canary.versionChanges.length) add('PRESERVATION_FAILED', 'acceptance: independent cold canary bytes, dirty state or version history changed');
	const canaryVersions = new Map();
	if (!Array.isArray(canary?.revisions) || !canary.revisions.length || canary.revisions.some(entry => {
		if (!Number.isSafeInteger(entry.openGeneration) || entry.openGeneration <= 0 || !Number.isSafeInteger(entry.documentVersion) || entry.documentVersion <= 0
			|| entry.isDirty !== false || entry.sha256 !== canary.sha256 || entry.expectedModelSha256 !== canary.sha256) return true;
		const previous = canaryVersions.get(entry.openGeneration);
		canaryVersions.set(entry.openGeneration, entry.documentVersion);
		return previous !== undefined && previous !== entry.documentVersion;
	}) || canary.setupSaves !== 0 || canary.rebaselines !== 0
		|| !['before-cold', 'cold', 'hidden', 'revealed', 'closed', 'reopened', 'full109'].every(phase => canary?.checkpoints?.includes(phase))) blocked('independent cold canary clean byte/version close-reopen observation incomplete or rebaselined');
	const setupStopped = coldSetupStopped(evidence);
	if (setupStopped) add('HARNESS_BLOCKED_SETUP', 'acceptance: cold setup stopped before the first exact-ID activation; controls/pixels were not attempted');
	const missingCapabilities = acceptance.execution?.status === 'blocked' || acceptance.pixels?.capabilityBlockers?.length > 0;
	if (cold?.firstWorkbenchActivation !== true || cold.firstToolTarget !== 'openFileId' || cold.activationPhase !== 'exact-active' || cold.activationCalls !== 1
		|| cold.warmingCalls !== 0 || cold.legacyBytes !== 498 || cold.blankExecutions !== 0) blocked('cold-first exact-ID activation was warmed, retried, executed blank text, or not proven');
	if (cold?.firstMetadataId?.uri !== cold?.uri || typeof cold?.firstMetadataId?.openFileId !== 'string' || !cold.firstMetadataId.openFileId
		|| cold.firstMetadataId.matchingCount !== 1 || cold.firstMetadataId.lookupCount !== 1 || cold.firstMetadataId.source !== 'metadata-only') blocked('first cold metadata-only exact-ID lookup was missing, ambiguous or repeated');
	const cleanColdTab = tab => typeof cold?.uri === 'string' && tab?.uri === cold.uri && tab.viewType === 'kusto.kqlxEditor' && tab.isCustom === true && tab.isDirty === false;
	const cleanColdSnapshot = snapshot => {
		const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs.filter(tab => tab.uri === cold?.uri) : [];
		return tabs.length === 1 && cleanColdTab(tabs[0]) && snapshot.expected?.uri === cold.uri && snapshot.expected.viewType === 'kusto.kqlxEditor'
			&& snapshot.document?.uri === cold.uri && snapshot.document.isDirty === false && hash(snapshot.document.sha256);
	};
	const beforeTab = cold?.tabReadiness?.before;
	const afterTab = cold?.tabReadiness?.after;
	if (!cleanColdSnapshot(beforeTab) || !cleanColdSnapshot(afterTab) || !cleanColdTab(afterTab?.active)
		|| beforeTab.document.sha256 !== afterTab.document.sha256
		|| beforeTab.document.sha256 !== canary?.sha256 || beforeTab.document.version !== afterTab.document.version
		|| cold.uri !== acceptance.pixels?.captures?.find(capture => capture.phase === 'cold-controls')?.controlProof?.uri) blocked('exact clean pre-tool tab and post-tool current SDK focus evidence missing, changed, or not bound to the cold control frame');
	if (cold?.controlsReady !== true || cold.menuOpened !== true || cold.escapeDismissed !== true) {
		if (setupStopped) blocked('initial Query controls/menu/Escape unattempted after the cold setup blocker');
		else if (missingCapabilities) blocked('initial Query controls/menu/Escape not qualified because a required observation capability is unavailable');
		else failed('initial Query controls/menu/Escape unavailable');
	}
	const execution = acceptance.execution;
	if (execution?.source !== 'actual-workbench-vscode-facade' || execution.status !== 'complete' || execution.registrationObserved !== true
		|| execution.coldPanelObserved !== true || execution.restored !== true || !Array.isArray(execution.blockers) || execution.blockers.length
		|| !Array.isArray(execution.events) || !Number.isSafeInteger(execution.ingressCount) || !Number.isSafeInteger(execution.startCount)
		|| !Number.isSafeInteger(execution.blankExecutions) || execution.blankExecutions !== cold?.blankExecutions) blocked('actual Workbench execution ingress/start observation missing, incomplete, or not exactly restored');
	if (execution?.events?.length || execution?.ingressCount > 0 || execution?.startCount > 0 || execution?.blankExecutions > 0) failed('real execution ingress/start observed during the no-execution workflow');
	const untouched = acceptance.untouched;
	if (untouched?.exactBytes !== true || untouched.allRevisionsClean !== true
		|| !Array.isArray(untouched.dirtyTransitions) || untouched.dirtyTransitions.length
		|| !Array.isArray(untouched.byteChanges) || untouched.byteChanges.length) add('PRESERVATION_FAILED', 'acceptance: untouched bytes or clean state changed, including reverted revisions');
	if (untouched?.checkedSourceCount !== archive?.sourceCount || untouched?.setupSaves !== 0 || untouched?.rebaselines !== 0
		|| !['cold', 'hidden', 'revealed', 'closed', 'reopened', 'full109'].every(phase => untouched?.checkpoints?.includes(phase))) blocked('untouched lifecycle observation incomplete or rebaselined');
	for (const phase of ['authoring', 'nativeSave', 'reopen', 'secondInteraction']) {
		if (acceptance.lifecycle?.[phase] !== true) blocked('missing native lifecycle boundary: ' + phase);
	}
	const ownership = acceptance.fixtureOwnership;
	const legitimate = ownership?.status === 'legitimate-production-owner' && ownership.path === 'offline-query' && ownership.forged === false && ownership.developmentSeeds === false;
	if (!legitimate) blocked('lawful Production result owner unavailable; composed note/dashboard acceptance remains blocked');
	else {
		for (const phase of ['initial', 'hidden', 'reactivated', 'reopened', 'second-interaction']) {
			const note = acceptance.notes?.find(entry => entry.phase === phase);
			if (note?.success !== true || note.exact !== true || !Array.isArray(note.notes) || note.notes.length !== 1) failed('exact note unavailable at ' + phase + ' (empty success is not evidence)');
		}
		const dashboard = acceptance.dashboard;
		if (dashboard?.success !== true || dashboard.valid !== true || dashboard.bindingCount !== 6 || dashboard.dataSourceCount !== 1
			|| !Array.isArray(dashboard.issues) || dashboard.issues.length) failed('six-binding production dashboard not qualified');
	}
	const identity = acceptance.identity;
	const reference = identity?.expected;
	if (!reference || !hash(reference.vsixSha256) || !hash(reference.mainSha256) || !hash(reference.treeSha256)
		|| !hash(reference.sourcePatchSha256) || !/^[0-9a-f]{40}$/i.test(reference.sourceHead ?? '')) blocked('expected package/source identity missing');
	if (!isDeepStrictEqual(reference, acceptance.collection?.expectedBuildIdentity)) blocked('host expected identity differs from the immutable parent configuration');
	for (const phase of ['before', 'after']) {
		const loaded = identity?.[phase];
		if (!loaded || loaded.extensionMode !== 1 || loaded.driverExtensionMode !== 2 || loaded.contextObserved !== true
			|| loaded.contextPath !== reference?.installedPath || loaded.moduleCacheLoaded !== true
			|| loaded.moduleCachePath !== reference?.mainPath) blocked('actual Production context / loaded require.cache module missing at ' + phase);
		for (const field of ['installedPath', 'mainPath', 'vsixSha256', 'mainSha256', 'treeSha256', 'vscodeVersion', 'sourceHead', 'sourcePatchSha256']) {
			if (!reference?.[field] || loaded?.[field] !== reference[field]) blocked('loaded build mismatch at ' + phase + ': ' + field);
		}
	}
	for (const field of ['installedPath', 'mainPath', 'vsixSha256', 'mainSha256', 'treeSha256', 'sourceHead', 'sourcePatchSha256']) {
		if (!reference?.[field] || identity?.parentFinal?.[field] !== reference[field]) blocked('independent parent-final build mismatch or missing evidence: ' + field);
	}
	const pixels = acceptance.pixels;
	if (pixels?.status !== 'cpu-verified-unreviewed') {
		if (setupStopped) blocked('native pixel evidence unattempted after the cold setup blocker');
		else if (pixels?.capabilityBlockers?.length) blocked('actual native/CDP frame geometry capability unavailable; retain failed captures');
		else suspect('CPU pixel evidence missing; human visual review must remain unreviewed');
	}
	for (const phase of ACCEPTANCE_CONTROL_PHASES) {
		const capture = pixels?.captures?.find(entry => entry.phase === phase);
		if (!capture && (missingCapabilities || setupStopped)) { blocked('native frame unattempted after a setup/capability blocker at ' + phase); continue; }
		if (capture?.blocked === true) { blocked('native frame proof unavailable at ' + phase + ': ' + capture.error); continue; }
		if (!capture || capture.native !== true || !Number.isSafeInteger(capture.pid) || capture.pid <= 0
			|| !capture.hwnd || capture.foregroundHwnd !== capture.hwnd || capture.currentFrame !== true || capture.fallback !== false
			|| !Number.isFinite(capture.dpi) || capture.dpi <= 0 || !(capture.bounds?.width > 0) || !(capture.bounds?.height > 0)
			|| capture.decoded !== true || capture.controlsNonblank !== true || !hash(capture.sha256)) suspect('missing, gray, stale, wrong-window, or fallback native controls pixels at ' + phase);
		if (!Array.isArray(execution?.panels)) { blocked('actual exact-URI panel inventory unavailable for native frame correlation at ' + phase); continue; }
		try {
			admitSynchronizedContext(capture?.webviewSynchronization, capture?.resolvedContext);
			const proof = capture.controlProof;
			const expectedPath = acceptanceControlPath(phase, expected ?? [], canary?.path);
			if (!proof || !expectedPath || !acceptance.collection?.ownedRoot
				|| path.resolve(fileURLToPath(proof.uri)).toLowerCase() !== path.resolve(acceptance.collection.ownedRoot, expectedPath).toLowerCase()
				|| !execution?.panels?.some(panel => panel.uri === proof.uri && panel.generation === proof.panelGeneration && panel.handle === proof.panelHandle)) throw new Error('Exact intended URI/panel/section region correlation missing');
			if (assessControlPixels(capture, { width: capture.bounds.width, height: capture.bounds.height, regions: capture.regions }).controlsNonblank !== true) throw new Error('Exact intended main/toggle/menu pixel regions rejected');
		} catch (error) { suspect('native synchronized control proof rejected at ' + phase + ': ' + clip(error.message)); }
	}
	if (!setupStopped && !pixels?.capabilityBlockers?.length && !verifyMenuEscapeFrames(pixels?.captures?.find(capture => capture.phase === 'cold-menu'), pixels?.captures?.find(capture => capture.phase === 'cold-escape'))) suspect('visible-menu and Escape lack different synchronized frames / changed exact-menu pixels');
	const cleanup = acceptance.cleanup;
	if (cleanup?.canonicalTempRoot !== true || cleanup.markerVerified !== true || cleanup.aliasFree !== true || cleanup.dirtyDiscard !== false
		|| cleanup.onlyOwnedTabs !== true || cleanup.preservedFailures !== true || cleanup.survivors !== 0) suspect('unsafe or incomplete exact-owned cleanup; failure fixtures must survive');
}

function checkApiPreservation(evidence, add) {
	const state = evidence.acceptance;
	const blocked = reason => add('HARNESS_BLOCKED', 'API preservation: ' + reason);
	const failed = reason => add('WORKFLOW_FAILED', 'API preservation: ' + reason);
	const suspect = reason => add('HARNESS_SUSPECT', 'API preservation: ' + reason);
	const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
	if (state?.schemaVersion !== 1 || state.mode !== 'current133-api') { blocked('current133-api artifact missing or unsupported'); return; }
	const archive = state.archive;
	if (archive?.verified !== true || archive.immutableBeforeImages !== true || archive.baselineCount !== 133 || archive.sourceCount !== 133
		|| archive.structuredCount !== 101 || archive.beforeSha256 !== CURRENT_BEFORE_SHA || !hash(archive.orderSha256)
		|| archive.sidecarsSeparate !== true || archive.linksConfined !== true || state.collection?.archiveVerified !== true) blocked('independent immutable133/structured101 archive verification missing');
	const order = state.expectedOrder;
	try { validateActivationOrder(order); } catch { blocked('exact original109 order missing'); }
	if (!isDeepStrictEqual(order, state.collection?.expectedOrder) || !isDeepStrictEqual(order, state.activationOrder)) blocked('complete recorded original109 order not observed');
	for (const phase of ['full109', 'hidden', 'reactivated', 'before-cleanup']) {
		if (!state.historicalInventories?.some(entry => entry.phase === phase && entry.retainedCount === 109 && entry.allClean === true
			&& Array.isArray(entry.exactPaths) && isDeepStrictEqual([...entry.exactPaths].sort(), [...order ?? []].sort()))) blocked('exact retained109 inventory missing at ' + phase);
	}
	const canary = state.archivedCanary;
	if (canary?.path !== CANARY_PATH || canary.count !== 1 || canary.bytes !== 28864 || canary.sha256 !== CANARY_SHA || !hash(canary.resultGraphSha256)
		|| canary.sectionIds?.length !== 10 || canary.bindingIds?.length !== 6 || !isDeepStrictEqual(canary, state.collection?.archivedCanary)) blocked('unchanged archived canary/result-owner-binding graph not independently verified');
	const api = state.api;
	const matchesOwnedPath = (uri, file) => {
		try {
			const url = new URL(uri);
			return url.protocol === 'file:' && !url.search && !url.hash && path.resolve(fileURLToPath(url)).toLowerCase() === path.resolve(file).toLowerCase();
		} catch { return false; }
	};
	const canaryUri = api?.uri;
	if (!state.collection?.ownedRoot || !matchesOwnedPath(canaryUri, path.join(state.collection.ownedRoot, 'history', CANARY_PATH))) blocked('exact SDK URI does not point at the independently owned archived canary');
	const beforeTab = api?.tabReadiness?.before;
	const afterTab = api?.tabReadiness?.after;
	const exactCleanTab = tab => tab?.uri === canaryUri && tab.isCustom === true && tab.viewType === 'kusto.kqlxEditor' && tab.isDirty === false;
	const initialReady = api?.initialActivationCalls === 1 && api.initialActivation?.success === true
		&& api.initialActivation.uri === canaryUri && api.initialActivation.openFileId === api.openFileId
		&& beforeTab?.expected?.uri === canaryUri && Array.isArray(beforeTab.tabs)
		&& beforeTab.tabs.filter(tab => tab.uri === canaryUri).length === 1 && beforeTab.tabs.some(exactCleanTab)
		&& afterTab?.expected?.uri === canaryUri && exactCleanTab(afterTab.active) && afterTab.active.isActive === true
		&& Array.isArray(afterTab.tabs) && afterTab.tabs.filter(tab => tab.uri === canaryUri).length === 1 && afterTab.tabs.some(exactCleanTab);
	if (!initialReady) blocked('one initial exact-ID activation and clean exact SDK tab/focus observations required; onboarding may be active only before activation');
	const initialNote = state.notes?.find(entry => entry.phase === 'initial');
	const initialDashboard = state.dashboards?.find(entry => entry.phase === 'initial');
	const admitted = initialReady && api?.warmReport === true && typeof api.openFileId === 'string' && api.openFileId.length > 0
		&& archive?.verified === true && archive.sourceCount === 133 && archive.baselineCount === 133 && archive.structuredCount === 101
		&& state.collection?.archiveVerified === true && isDeepStrictEqual(canary, state.collection.archivedCanary)
		&& state.fixtureOwnership?.status === 'legitimate-production-owner' && state.fixtureOwnership.path === 'archived-native-admission'
		&& state.fixtureOwnership.forged === false && state.fixtureOwnership.developmentSeeds === false
		&& initialNote?.uri === canaryUri && initialNote.openFileId === api.openFileId && initialNote.success === true && initialNote.exact === true
		&& isDeepStrictEqual(initialNote.notes, [canary?.note])
		&& initialDashboard?.uri === canaryUri && initialDashboard.openFileId === api.openFileId && initialDashboard.sectionId === canary?.htmlSectionId
		&& initialDashboard.success === true && initialDashboard.valid === true && initialDashboard.hasProvenance === true && initialDashboard.exactTarget === true
		&& initialDashboard.bindingCount === 6 && initialDashboard.dataSourceCount === 1 && isDeepStrictEqual(initialDashboard.factColumns, canary?.factColumns)
		&& Array.isArray(initialDashboard.issues) && initialDashboard.issues.length === 0 && Array.isArray(initialDashboard.diagnostics) && initialDashboard.diagnostics.length === 0;
	const operations = [evidence.summary?.operations, state.operations].filter(Array.isArray).flat();
	const observedTool = (name, phase) => admitted && operations.some(operation => operation?.name === 'kusto-workbench_' + name
		&& operation.phase !== 'initial' && (phase === undefined || operation.phase === phase)
		&& (operation.success === true || operation.success === false && typeof operation.error === 'string' && operation.error.trim().length > 0));
	if (api?.status !== 'complete' || api.warmReport !== true || !api.openFileId || api.activationCalls !== 1
		|| !isDeepStrictEqual(api.phases, ['initial', 'full109', 'hidden', 'reactivated', 'closed'])) blocked('composed warm-report / hidden-read / sole ordinary activation / readonly-close lifecycle incomplete');
	if (api?.activation?.success !== true || api.activation.uri !== canaryUri || api.activation.openFileId !== api.openFileId) {
		const activation = api?.activation;
		const reason = 'sole ordinary exact-ID activation failed or returned another target; never replay';
		if (observedTool('activate-workbench-file', 'reactivated') && typeof activation?.success === 'boolean'
			&& typeof activation.uri === 'string' && typeof activation.openFileId === 'string') failed(reason + (typeof activation.error === 'string' ? ': ' + activation.error : ''));
		else blocked(reason);
	}
	if (!Array.isArray(api?.snapshotFailures) || api.snapshotFailures.length || !Array.isArray(api.autoRevealEvents) || api.autoRevealEvents.length) blocked('earlier public snapshot failures or transient auto-reveal events remain disqualifying');
	for (const failure of Array.isArray(api?.snapshotFailures) ? api.snapshotFailures : []) {
		if (observedTool('list-sections', failure.phase) && typeof failure.uri === 'string' && typeof failure.error === 'string' && failure.error.length > 0) failed('public snapshot failed at ' + failure.phase + ': ' + failure.error);
	}
	if (api?.history?.length !== 109 || api.history.some((entry, index) => entry.path !== order?.[index] || entry.exact !== true || entry.snapshot !== true
		|| !matchesOwnedPath(entry.uri, path.join(state.collection.ownedRoot ?? '', 'history', entry.path)))) blocked('all109 exact primary opens and public API results required; partial88 and missing snapshots are not passes');
	for (const [index, entry] of (Array.isArray(api?.history) ? api.history : []).entries()) {
		const first = entry.firstActivation;
		const firstTarget = first?.input?.targetFileUri;
		if (!first || first.name !== 'kusto-workbench_activate-workbench-file'
			|| first.phase !== 'historical-' + (index + 1) || firstTarget !== entry.uri
			|| typeof entry.firstCallPassed !== 'boolean' || typeof first.success !== 'boolean') {
			blocked('first public historical activation observation missing: ' + entry.path);
		} else if (!entry.firstCallPassed || !first.success || first.value?.success !== true
			|| first.value.uri !== entry.uri || typeof first.value.openFileId !== 'string' || !first.value.openFileId
			|| !(first.value.isLiveWorkbench === true && first.value.isReadOnlyFallback !== true
				|| /\.md$/i.test(entry.path) && first.value.isReadOnlyFallback === true && first.value.isLiveWorkbench === false)) {
			failed('first public historical activation failed: ' + entry.path + (typeof first.error === 'string' ? ': ' + first.error : ''));
		}
		if (observedTool('list-sections') && entry.path === order?.[index] && entry.exact === true && entry.snapshot === false
			&& matchesOwnedPath(entry.uri, path.join(state.collection.ownedRoot ?? '', 'history', entry.path))) failed('public historical snapshot failed: ' + entry.path + (typeof entry.error === 'string' ? ': ' + entry.error : ''));
	}
	for (const phase of ['initial', 'hidden', 'reactivated']) {
		const check = api?.checks?.find(entry => entry.phase === phase);
		const note = state.notes?.find(entry => entry.phase === phase);
		const dashboard = state.dashboards?.find(entry => entry.phase === phase);
		for (const entry of [check, note, dashboard]) if (entry?.uri !== canaryUri || entry?.openFileId !== api?.openFileId) blocked('exact canary URI/ID oracle missing at ' + phase);
		if (check?.noAutoReveal !== true || check.activeBefore !== check.activeAfter || check.hidden !== (phase === 'hidden')
			|| phase === 'hidden' && check.activeAfter === canaryUri || phase !== 'hidden' && check.activeAfter !== canaryUri
			|| check.bridge?.uri !== canaryUri || check.bridge.liveConnectionCount !== 1 || check.bridge.snapshotCallbackObserved !== true) blocked('actual bridge owner / no-auto-reveal observation missing at ' + phase);
		if (note?.success !== true || note.exact !== true || !isDeepStrictEqual(note.notes, [canary?.note])) {
			const reason = 'full exact note, including metadata and related IDs, unavailable at ' + phase;
			if (observedTool('manage-development-notes', phase) && note?.uri === canaryUri && note.openFileId === api.openFileId
				&& typeof note.success === 'boolean' && typeof note.exact === 'boolean' && (Array.isArray(note.notes) || note.notes === null && note.success === false && typeof note.error === 'string')) failed(reason + (typeof note.error === 'string' ? ': ' + note.error : ''));
			else blocked(reason);
		}
		if (dashboard?.sectionId !== canary?.htmlSectionId || dashboard?.success !== true || dashboard.valid !== true || dashboard.hasProvenance !== true || dashboard.exactTarget !== true
			|| dashboard.bindingCount !== 6 || dashboard.dataSourceCount !== 1 || !isDeepStrictEqual(dashboard.factColumns, canary?.factColumns)
			|| !Array.isArray(dashboard.issues) || dashboard.issues.length || !Array.isArray(dashboard.diagnostics) || dashboard.diagnostics.length) {
			const reason = 'six-binding exact-target dashboard unavailable at ' + phase;
			if (!observedTool('validate-html-dashboard', phase) || dashboard?.uri !== canaryUri || dashboard.openFileId !== api.openFileId
				|| ['success', 'valid', 'hasProvenance', 'exactTarget', 'bindingCount', 'dataSourceCount', 'factColumns', 'issues', 'diagnostics'].some(field => dashboard[field] === undefined)) blocked(reason);
			else if (!['success', 'valid', 'hasProvenance', 'exactTarget'].every(field => typeof dashboard[field] === 'boolean')
				|| !['bindingCount', 'dataSourceCount'].every(field => Number.isSafeInteger(dashboard[field]) && dashboard[field] >= 0)
				|| !['factColumns', 'issues', 'diagnostics'].every(field => Array.isArray(dashboard[field]))) suspect('malformed observed dashboard oracle at ' + phase + '; no product cause inferred');
			else failed(reason + (typeof dashboard.error === 'string' ? ': ' + dashboard.error : ''));
		}
	}
	const untouched = state.untouched;
	if (untouched?.exactBytes === false || untouched?.allRevisionsClean === false || untouched?.versionsStable === false
		|| untouched?.dirtyTransitions?.length || untouched?.byteChanges?.length || untouched?.versionChanges?.length) add('PRESERVATION_FAILED', 'API preservation: bytes, dirty state or model versions changed, including reverted revisions');
	if (untouched?.exactBytes !== true || untouched.allRevisionsClean !== true || untouched.versionsStable !== true
		|| !Array.isArray(untouched.dirtyTransitions) || untouched.dirtyTransitions.length || !Array.isArray(untouched.byteChanges) || untouched.byteChanges.length
		|| !Array.isArray(untouched.versionChanges) || untouched.versionChanges.length) blocked('complete clean byte/version observation unavailable');
	if (untouched?.checkedSourceCount !== 133 || untouched.setupSaves !== 0 || untouched.rebaselines !== 0
		|| !['prepared', 'initial', 'full109', 'hidden', 'reactivated', 'before-cleanup', 'after-cleanup'].every(phase => untouched?.checkpoints?.includes(phase))) blocked('immutable133 lifecycle checkpoints missing or rebaselined');
	const cold = state.coldCanary;
	const inspectedCold = state.collection?.coldCanary;
	if (cold?.count !== 1 || cold.checkedSourceCount !== 1 || cold.sourcePath !== order?.[19]
		|| inspectedCold?.verified !== true || inspectedCold.markerVerified !== true || inspectedCold.aliasFree !== true
		|| !['root', 'rootMarker', 'filePath', 'path', 'sourcePath', 'bytes', 'sha256', 'sourceSha256', 'sectionId'].every(field => cold?.[field] !== undefined && cold[field] === inspectedCold?.[field])) blocked('separate cold copy linkage and independent inspection missing');
	if (cold?.exactBytes === false || cold?.allRevisionsClean === false || cold?.versionsStable === false
		|| cold?.dirtyTransitions?.length || cold?.byteChanges?.length || cold?.versionChanges?.length) add('PRESERVATION_FAILED', 'API preservation: separate cold copy changed, including reverted revisions');
	if (cold?.exactBytes !== true || cold.allRevisionsClean !== true || cold.versionsStable !== true
		|| !['dirtyTransitions', 'byteChanges', 'versionChanges', 'revisions'].every(field => Array.isArray(cold?.[field]))
		|| cold.setupSaves !== 0 || cold.rebaselines !== 0
		|| !['prepared', 'initial', 'full109', 'hidden', 'reactivated', 'before-cleanup', 'after-cleanup'].every(phase => cold?.checkpoints?.includes(phase))) blocked('separate cold copy complete preservation ledger missing or rebaselined');
	const roles = state.roles;
	if (roles?.archive !== 133 || roles.cold !== 1 || roles.authoring !== 1 || roles.canary !== 1 || roles.authoringUnopened !== true || roles.authoringExactBytes !== true) blocked('133 archive / separate cold1 / authoring1 / archived canary1 roles not preserved');
	if (state.fixtureOwnership?.status !== 'legitimate-production-owner' || state.fixtureOwnership.path !== 'archived-native-admission'
		|| state.fixtureOwnership.forged !== false || state.fixtureOwnership.developmentSeeds !== false) blocked('unchanged archived data admission not verified; no owner or authentication cause inferred; fake values and offline-query substitution remain forbidden');
	const identity = state.identity;
	const expected = identity?.expected;
	if (!expected || !isDeepStrictEqual(expected, state.collection?.expectedBuildIdentity)) blocked('independent frozen candidate identity missing');
	if (state.collection?.runtimeVerified?.panelOwners !== true) blocked('executing provider/gateway/webview identity unavailable; matching orchestrator methods and disk hashes alone cannot qualify the candidate');
	for (const phase of ['before', 'after']) {
		const loaded = identity?.[phase];
		if (loaded?.extensionMode !== 1 || loaded.driverExtensionMode !== 2 || loaded.contextObserved !== true || loaded.contextPath !== expected?.installedPath
			|| loaded.moduleCacheLoaded !== true || loaded.moduleCachePath !== expected?.mainPath) blocked('actual Production context / loaded module missing at ' + phase);
		const methods = loaded?.runtime?.methods;
		if (loaded?.runtime?.source !== 'executing-require-cache' || !['constructor', 'collectOpenWorkbenchFiles', 'listSections', 'manageDevelopmentNotes', 'validateHtmlDashboard', 'activateWorkbenchFile']
			.every(name => methods?.some(method => method.name === name && method.matchesPackage === true && hash(method.sha256) && method.offset >= 0 && method.length > 0))
			|| state.collection?.runtimeVerified?.[phase] !== true) blocked('executing runtime METHOD fingerprints do not match the independent package at ' + phase);
	}
	for (const phase of ['before', 'after', 'parentFinal']) {
		for (const field of ['installedPath', 'mainPath', 'vsixSha256', 'mainSha256', 'treeSha256', 'vscodeVersion', 'sourceHead', 'sourcePatchSha256', 'dependenciesSha256', 'assetTrees']) {
			if (!expected?.[field] || !isDeepStrictEqual(identity?.[phase]?.[field], expected[field])) blocked('independent candidate/source/dependencies/Monaco/CSS/script identity mismatch at ' + phase + ': ' + field);
		}
	}
	if (state.lifecycle?.nativeAuthoring !== 'UNATTEMPTED' || state.pixels?.status !== 'UNATTEMPTED' || state.pixels.captures?.length !== 0) blocked('API-only evidence must not claim native authoring or pixels');
	const execution = state.execution;
	if (execution?.source !== 'actual-workbench-vscode-facade' || execution.status !== 'complete' || execution.registrationObserved !== true || execution.coldPanelObserved !== true
		|| execution.restored !== true || execution.ingressCount !== 0 || execution.startCount !== 0 || execution.events?.length !== 0 || execution.blockers?.length !== 0) blocked('actual no-execution observation missing or execution attempted');
	const cleanup = state.cleanup;
	if (cleanup?.canonicalTempRoot !== true || cleanup.markerVerified !== true || cleanup.aliasFree !== true || cleanup.dirtyDiscard !== false
		|| cleanup.onlyOwnedTabs !== true || cleanup.preservedFailures !== true || cleanup.survivors !== 0) blocked('exact-owned clean cleanup incomplete; retain failure fixtures');
}

export function classify(evidence, legacy) {
	const flags = new Set();
	const reasons = [];
	const add = (flag, reason) => { flags.add(flag); reasons.push(flag + ': ' + reason); };
	const acceptanceRequired = evidence.acceptanceRequired === true || evidence.acceptance !== undefined;
	const apiOnly = (evidence.acceptanceMode ?? evidence.acceptance?.mode) === 'current133-api';
	const state = evidence.acceptance;
	const setupFailure = apiOnly ? state?.failures?.find(failure => failure.phase === 'initial' && failure.error?.startsWith('BLOCKED: StageSetupBlockingOwner:')) : null;
	const initialDashboard = apiOnly ? state?.dashboards?.find(entry => entry.phase === 'initial') : null;
	const setupStopEarly = Boolean(setupFailure && state.schemaVersion === 1 && state.mode === 'current133-api'
		&& state.fixtureOwnership?.status === 'blocked' && state.fixtureOwnership.path === 'archived-native-admission'
		&& state.fixtureOwnership.forged === false && state.fixtureOwnership.developmentSeeds === false
		&& state.api?.status === 'observing' && isDeepStrictEqual(state.api.phases, ['initial'])
		&& state.api.activationCalls === 0 && state.api.history?.length === 0 && state.activationOrder?.length === 0
		&& evidence.summary?.operations?.every(operation => operation.phase === 'initial')
		&& initialDashboard?.success === true && initialDashboard.valid === false && initialDashboard.exactTarget === true
		&& initialDashboard.uri === state.api.uri && initialDashboard.openFileId === state.api.openFileId
		&& (initialDashboard.hasProvenance === false || initialDashboard.dataSourceCount === 0));
	const apiDetails = apiOnly ? { apiPreservationQualified: false, apiPreservationStatus: 'PARTIAL', acceptanceQualified: false,
		nativeAuthoring: evidence.acceptance?.lifecycle?.nativeAuthoring ?? 'UNATTEMPTED', pixels: evidence.acceptance?.pixels?.status ?? 'UNATTEMPTED', visualReview: 'human-unreviewed',
		...(setupStopEarly ? { rawStatus: 'StageSetupBlockingOwner' } : {}) } : {};
	if (acceptanceRequired) { if (apiOnly) checkApiPreservation(evidence, add); else checkAcceptance(evidence, add); }
	const { cli, results } = evidence;
	if (cli.spawnError) add('HARNESS_BLOCKED', 'CLI spawn failed');
	if (cli.timedOut) add('HARNESS_BLOCKED', 'CLI exceeded hard limit and was terminated');
	if (!results) add('HARNESS_BLOCKED', 'results.json missing or unreadable');
	if (legacy) {
		if (evidence.legacy?.trace?.firstInvalid || evidence.legacy?.firstInvalidCopy) add('CORRUPTION_OBSERVED', 'legacy trace recorded invalid root JSON');
		for (const operation of evidence.legacy?.trace?.operations ?? []) if (operation.error) add('WORKFLOW_FAILED', 'tool rejected: ' + clip(operation.name, 80));
	} else {
		if (['WORKFLOW_FAILED', 'PRESERVATION_FAILED', 'CORRUPTION_OBSERVED', 'HARNESS_BLOCKED_SETUP', 'HARNESS_BLOCKED', 'HARNESS_SUSPECT'].includes(evidence.summary?.verdict)) {
			const verdict = apiOnly && evidence.summary.verdict === 'HARNESS_BLOCKED_SETUP' ? 'HARNESS_BLOCKED'
				: acceptanceRequired && coldSetupStopped(evidence) && evidence.summary.verdict === 'WORKFLOW_FAILED' ? 'HARNESS_BLOCKED_SETUP' : evidence.summary.verdict;
			const failure = apiOnly && !setupStopEarly && evidence.summary.failure?.startsWith('BLOCKED: StageSetupBlockingOwner:')
				? 'public API oracle failed; result-owner cause unproven' : evidence.summary.failure ?? 'scenario reported a failed contract';
			add(verdict, failure);
		}
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
		for (const operation of evidence.summary?.operations ?? []) if (!setupStopEarly && (operation?.success === false || operation?.error)) add('WORKFLOW_FAILED', 'tool rejected: ' + clip(operation.name ?? 'unknown', 80) + (apiOnly && operation.error ? ': ' + clip(operation.error, 300) : ''));
		const journal = evidence.journal;
		for (const failure of journal?.harnessFailures ?? []) add('HARNESS_SUSPECT', /overflow/i.test(failure) ? 'journal overflow' : /worker/i.test(failure) ? 'journal worker failure' : 'journal harness failure');
		if ((journal?.metrics?.callbackMaximumMs ?? 0) > STALL_LIMIT_MS) add('HARNESS_SUSPECT', `observer callback stall ${Math.round(journal.metrics.callbackMaximumMs)}ms`);
		if ((journal?.metrics?.transportMaximumMs ?? 0) > STALL_LIMIT_MS) add('HARNESS_SUSPECT', 'journal transport exceeded one second');
		if ((journal?.metrics?.eventLoopMaximumMs ?? 0) > STALL_LIMIT_MS) add('HARNESS_SUSPECT', 'extension-host event loop exceeded one second (cause unproven)');
	}
	if (evidence.saveLogs.errors.length) add('WORKFLOW_FAILED_SAVE', `${evidence.saveLogs.errors.length} native Save listener error/ignored/blocklisted log line(s)`);
	if (!acceptanceRequired && evidence.summary?.verdict === 'FAULT_SCENARIO_BEHAVIOR_CONFIRMED' && results?.completed && cli.exitCode === 0
		&& flags.has('WORKFLOW_FAILED_SAVE') && [...flags].every(flag => flag === 'WORKFLOW_FAILED_SAVE')
		&& evidence.revisions?.texts > 0) {
		return { primary: 'EXPECTED_FAULT_CONFIRMED', flags: ['EXPECTED_SAVE_TIMEOUT'], nativeSaveError: true, reasons: ['fault-injected early-commit behavior confirmed; not a clean Save-health pass'] };
	}
	for (const step of results?.failedSteps ?? []) {
		if (!setupStopEarly && /"success"\s*:\s*false|kusto-workbench_[\w-]+:\s*(Error|\{)/.test(step.error)) add('WORKFLOW_FAILED', 'registered tool rejection in failed step');
		else if (/First malformed notebook/i.test(step.error)) add('CORRUPTION_OBSERVED', 'failed step reported malformed notebook');
		else if (/tim(e|ed)[ -]?out/i.test(step.error)) add('HARNESS_BLOCKED', 'UI timeout blocker (label only, not causal): ' + clip(step.text, 120));
	}
	if (setupStopEarly && !['CORRUPTION_OBSERVED', 'PRESERVATION_FAILED', 'WORKFLOW_FAILED_SAVE'].some(flag => flags.has(flag))) add('HARNESS_BLOCKED_SETUP', 'API preservation: ' + setupFailure.error);
	const explained = ['CORRUPTION_OBSERVED', 'PRESERVATION_FAILED', 'WORKFLOW_FAILED', 'WORKFLOW_FAILED_SAVE', 'HARNESS_BLOCKED'].some(flag => flags.has(flag));
	if (results && !results.completed && !explained) add('HARNESS_BLOCKED', 'unidentified test error');
	if (results?.completed && cli.exitCode !== 0 && !flags.size) add('HARNESS_BLOCKED', `CLI exit ${cli.exitCode} despite passing scenarios`);
	if (!flags.size) {
		if (apiOnly && results?.completed && cli.exitCode === 0 && evidence.summary?.verdict === 'API_PRESERVATION_COMPLETE' && evidence.revisions?.present && evidence.revisions.texts > 0) {
			return { primary: 'API_PRESERVATION_VERIFIED_NOT_RELEASE', flags: [], reasons: ['composed public API109 and immutable133 preservation verified; native authoring, pixels and release qualification not attempted'],
				...apiDetails, apiPreservationQualified: true, apiPreservationStatus: 'VERIFIED_NOT_RELEASE' };
		}
		if (apiOnly) add('HARNESS_BLOCKED', 'API preservation lifecycle summary/revisions missing or not complete');
		if (legacy && results?.completed && cli.exitCode === 0 && evidence.legacy?.trace) return { primary: 'LEGACY_OBSERVATION_ONLY', flags: ['PRESERVATION_UNVERIFIED'], reasons: ['old workflow completed without exact per-section preservation assertions'] };
		const validated = legacy
			? Boolean(evidence.legacy?.trace && !evidence.legacy.trace.firstInvalid)
			: Boolean(verdictPasses(evidence.summary?.verdict) && evidence.revisions?.present && evidence.revisions.texts > 0);
		if (!apiOnly && results?.completed && cli.exitCode === 0 && validated) return { primary: 'PASS_UNREVIEWED_VISUAL', flags: [], reasons: ['scenario completed, exact state validated, no Save errors; visuals not reviewed'],
			...(acceptanceRequired ? { acceptanceQualified: true, visualReview: 'human-unreviewed' } : {}) };
		add('HARNESS_BLOCKED', legacy ? 'legacy trace unavailable for exact-state validation' : 'lifecycle-summary verdict/revisions missing or not passing');
	}
	const primaryKey = PRIMARY_ORDER.find(flag => flags.has(flag));
	const primary = primaryKey.startsWith('WORKFLOW_FAILED') ? 'WORKFLOW_FAILED' : primaryKey.replace('_SETUP', '');
	const publicFlags = [...new Set([...flags].map(flag => flag === 'WORKFLOW_FAILED_SAVE' ? 'WORKFLOW_FAILED' : flag.replace('_SETUP', '')))];
	return { primary, flags: publicFlags, nativeSaveError: flags.has('WORKFLOW_FAILED_SAVE'), reasons,
		...(acceptanceRequired ? { acceptanceQualified: false, visualReview: 'human-unreviewed' } : {}), ...apiDetails };
}

	export function finalizeAttemptEvidence(context, collect = collectEvidence) {
		const acceptanceRequired = ['original109', 'current133-api'].includes(context.acceptance);
		const required = acceptanceRequired ? { acceptanceRequired: true, acceptanceMode: context.acceptance } : {};
		const record = { evidence: { cli: context.cli, ...required } };
		try {
			record.evidence = { ...collect(context), ...required };
			return { ...record, ...classify(record.evidence, context.legacy) };
		} catch (error) {
			return {
				...record, analysisError: clip(error.message, 1000), primary: 'HARNESS_SUSPECT',
				flags: ['HARNESS_SUSPECT'], reasons: ['Evidence collection or classification failed after CLI execution'],
				...(acceptanceRequired ? { acceptanceQualified: false, visualReview: 'human-unreviewed' } : {}),
				...(context.acceptance === 'current133-api' ? { apiPreservationQualified: false, apiPreservationStatus: 'PARTIAL', nativeAuthoring: 'UNATTEMPTED', pixels: 'UNATTEMPTED' } : {}),
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
		record.setup.seedCheck = options.acceptance ? { mode: 'empty-isolated-profile', seedsRead: false, authRead: false } : assertSeedsInactive({ seedProfile: options.seedProfile, seedAuth: options.seedAuth });
		const driverDir = path.join(attemptDir, options.observation === 'legacy' ? 'published-corruption-driver-' + randomBytes(2).toString('hex') : 'd');
		fs.mkdirSync(driverDir);
		fs.writeFileSync(path.join(driverDir, 'package.json'), JSON.stringify({ name: 'published-corruption-driver', publisher: 'workbench-test', version: '0.0.0', engines: { vscode: '^1.107.0' }, main: './extension.js', activationEvents: [], contributes: {} }, null, 2), { flag: 'wx' });
		fs.writeFileSync(path.join(driverDir, 'extension.js'), options.acceptance
			? 'exports.activate = context => ({ extensionMode: context.extensionMode, extensionPath: context.extensionPath });\n'
			: 'exports.activate = () => {};\n', { flag: 'wx' });
		const testerRoot = path.join(driverDir, 'tests/vscode-extension-tester');
		const profileDir = path.join(testerRoot, 'profiles', PROFILE_NAME);
		const userData = path.join(profileDir, 'user-data');
		const extensionsDir = path.join(profileDir, 'extensions');
		const authShared = path.join(testerRoot, 'auth-shared');
		const sharedData = path.join(authShared, 'shared-data');
		for (const directory of [userData, path.join(userData, 'User'), extensionsDir, sharedData]) fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({ name: PROFILE_NAME, created: new Date().toISOString() }, null, 2), { flag: 'wx' });
		record.driverDir = driverDir;
		record.setup.seedSnapshot = options.acceptance ? { copied: [], mode: 'no-auth-seeds' } : snapshotSeeds(options, userData, authShared);
		const settingsFile = path.join(userData, 'User/settings.json');
		const { settings, droppedKeys } = buildSettings(campaign.originalSettings, arm.autoSave);
		if (options.acceptance) {
			settings['workbench.editor.limit.enabled'] = false;
			settings['kustoWorkbench.externalTools.enabled'] = false;
		}
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
		if (options.acceptance) {
			if (!within(extensionsDir, installedPath)) throw new Error('Installed Workbench path escaped the isolated extensions root');
			assertCanonicalDirectory(installedPath);
		}
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
		const fixtureParent = options.acceptance ? campaign.staged.historyRoot : path.join(attemptDir, 'fixtures');
		fs.mkdirSync(evidenceRoot);
		if (!options.acceptance) fs.mkdirSync(fixtureParent);
		const legacy = options.observation === 'legacy';
		const cliArgs = [options.cli, 'run', '--features', assets.featureDir, '--extension-path', driverDir, '--reuse-named-profile', PROFILE_NAME, '--vscode-version', options.vscodeVersion, '--no-build', '--timeout', String(options.acceptance ? 180000 : STEP_TIMEOUT_MS)];
		if (options.cdpPort !== null) cliArgs.push('--cdp-port', String(options.cdpPort));
		let acceptanceConfig;
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
			if (options.acceptance) {
				Object.assign(config, {
					acceptance: options.acceptance, owner: campaign.owner, historyRoot: campaign.staged.historyRoot,
					coldCanary: campaign.staged.coldCanary,
					acceptancePlan: campaign.acceptancePlan, beforeArchiveCopy: campaign.beforeArchiveCopy, orderArchiveCopy: campaign.orderArchiveCopy,
					acceptanceHarnessPath: assets.acceptanceHarness, acceptanceHarnessSha256: assets.acceptanceHarnessSha256,
					sourceRoot: REPO_ROOT, userData: fs.realpathSync.native(userData),
					nativeUiModule: path.join(path.dirname(path.dirname(options.cli)), 'dist/runner/native-ui-client.js'),
					cdpModule: path.join(path.dirname(path.dirname(options.cli)), 'dist/runner/cdp-client.js'),
					expectedBuildIdentity: { installedPath: fs.realpathSync.native(installedPath), mainPath: fs.realpathSync.native(installedMain), vsixPath: vsixCopy,
						vsixSha256: vsixInfo.sha256, mainSha256: vsixInfo.mainSha256, treeSha256: vsixInfo.treeSha256,
						vscodeVersion: options.vscodeVersion, sourceHead: campaign.source.head, sourcePatchSha256: campaign.source.patchSha256,
						dependenciesSha256: campaign.source.dependenciesSha256, assetTrees: vsixInfo.assetTrees },
				});
				acceptanceConfig = config;
			}
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
		Object.assign(record, finalizeAttemptEvidence({ attemptDir, driverDir, evidenceRoot, fixtureParent, legacy, cli, acceptance: options.acceptance, acceptanceConfig }));
		if (options.acceptance) verifyAssets(assets, vsixCopy, vsixInfo.sha256);
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

export function readReplayInputs(options) {
	if (options.acceptance) return { originalSettings: {}, baseline: { initialHash: null, source: null, reason: 'immutable before-images only; no original run or auth/profile inputs' },
		settingsIdentity: { path: null, sha256: null, source: 'empty-isolated-profile' } };
	for (const required of [path.join(options.seedProfile, 'user-data/Local State'), path.join(options.seedProfile, 'user-data/User/globalStorage/state.vscdb'), path.join(options.seedAuth, 'Local State')]) {
		if (!fs.existsSync(required)) throw new Error('Seed file missing: ' + required);
	}
	const originalSettings = readJson(options.originalSettings);
	if (!originalSettings || typeof originalSettings !== 'object' || Array.isArray(originalSettings)) throw new Error('Original settings must be a JSON object');
	return { originalSettings, baseline: fs.existsSync(options.baselineRun) ? recoverBaselineHash(options.baselineRun) : { initialHash: null, source: null, reason: 'baseline run not found' },
		settingsIdentity: { path: options.originalSettings } };
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
	const inputs = readReplayInputs(options);
	const { originalSettings, baseline } = inputs;
	const archived = options.acceptance ? await inspectAcceptanceArchives(options.beforeArchive, options.orderArchive, options.acceptance) : null;
	const owner = options.acceptance ? createAcceptanceRoot(options.outputParent) : null;
	const outputParent = owner ? path.dirname(owner.root) : prepareOutputParent(options.outputParent);
	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
	const id = `c${stamp}${randomBytes(2).toString('hex')}`;
	const dir = owner?.root ?? path.join(outputParent, id);
	if (!owner) fs.mkdirSync(dir);
	const assetsDir = path.join(dir, 'assets');
	fs.mkdirSync(assetsDir);
	const vsixCopy = path.join(assetsDir, path.basename(options.vsix));
	fs.copyFileSync(options.vsix, vsixCopy, fs.constants.COPYFILE_EXCL);
	if (sha256File(vsixCopy) !== vsixSha) throw new Error('Campaign VSIX copy hash mismatch');
	const controllerCopy = path.join(assetsDir, 'controller-extension.vsix');
	fs.copyFileSync(controllerVsix, controllerCopy, fs.constants.COPYFILE_EXCL);
	const assets = stageAssets({ ...options, owner }, assetsDir);
	let acceptancePlan;
	let staged;
	let beforeArchiveCopy;
	let orderArchiveCopy;
	if (archived) {
		const { images, ...plan } = archived;
		acceptancePlan = plan;
		beforeArchiveCopy = path.join(assetsDir, 'private-before-images.zip');
		orderArchiveCopy = path.join(assetsDir, 'private-original109-order.zip');
		fs.copyFileSync(options.beforeArchive, beforeArchiveCopy, fs.constants.COPYFILE_EXCL);
		fs.copyFileSync(options.orderArchive, orderArchiveCopy, fs.constants.COPYFILE_EXCL);
		if (sha256File(beforeArchiveCopy) !== plan.archive.beforeSha256 || sha256File(orderArchiveCopy) !== plan.archive.orderSha256) throw new Error('Private archive copy hash mismatch');
		staged = stageBeforeImages(owner, plan, images);
	}
	const env = childEnv();
	const packageIdentity = {
		vsixSha256: vsixSha, vsixVersion: vsixInfo.version, vsixMainEntry: vsixInfo.mainEntry, vsixMainSha256: vsixInfo.mainSha256, vsixTreeSha256: vsixInfo.treeSha256,
		controllerVsixSha256: controllerInfo.sha256, controllerVersion: controllerInfo.version,
		cliVersion: cliPackage.version, cliPath: options.cli,
		editorVersion: editor.version, editorCommit: editor.commit,
	};
	const manifestFile = path.join(dir, 'manifest.json');
	const source = gitInfo();
	const manifest = {
		schemaVersion: 1, campaignId: id, createdAt: new Date().toISOString(), dir,
		options,
		toolchain: { node: process.version, cli: { path: options.cli, version: cliPackage.version, binSha256: sha256File(options.cli) }, editor, controller: controllerInfo },
		source,
		vsix: { ...vsixInfo, campaignCopy: vsixCopy },
		assets: { files: assets.files, featureSha256: assets.featureSha256, helperSha256: assets.helperSha256, legacyKnownCeb1477a: options.observation === 'legacy' ? assets.featureSha256.startsWith('ceb1477a') : null },
		baseline, originalSettings: options.acceptance ? inputs.settingsIdentity : { path: options.originalSettings, sha256: sha256File(options.originalSettings) },
		packageIdentity, droppedEnvKeys: env.dropped, attempts: [],
		...(owner ? { owner, acceptancePlan, coldCanary: staged.coldCanary, beforeArchiveCopy, orderArchiveCopy, fixtureRoot: staged.historyRoot, qualification: 'NOT_RUN', visualReview: 'human-unreviewed' } : {}),
	};
	writeJsonAtomic(manifestFile, manifest);
	console.log(`Campaign ${id}: ${options.observation}, autosave ${options.autosave}, repeats ${options.repeats}, VSIX ${vsixInfo.version} (${vsixSha.slice(0, 12)}), editor ${editor.version}/${editor.commit.slice(0, 10)}`);

	const campaign = { id, dir, options, editor, vsixInfo, controllerInfo, controllerVsix: controllerCopy, assets, vsixCopy, env, baseline, originalSettings, packageIdentity,
		source, owner, staged, acceptancePlan, beforeArchiveCopy, orderArchiveCopy };
	const arms = armsFor(options);
	let index = 0;
	for (const arm of arms) {
		index++;
		const record = await runAttempt(campaign, arm, index);
		manifest.attempts.push({ attemptId: record.attemptId, dir: record.dir, repeat: arm.repeat, autoSave: arm.autoSave, primary: record.primary, flags: record.flags,
			acceptanceQualified: record.acceptanceQualified ?? false, apiPreservationQualified: record.apiPreservationQualified ?? false, exitCode: record.evidence?.cli?.exitCode ?? null });
		writeJsonAtomic(manifestFile, manifest);
		const duration = record.evidence?.cli?.durationMs ? `${Math.round(record.evidence.cli.durationMs / 1000)}s` : '-';
		console.log(`[${index}/${arms.length}] r${arm.repeat} ${arm.autoSave.padEnd(10)} ${record.primary.padEnd(22)} flags=${record.flags.join(',') || '-'} exit=${record.evidence?.cli?.exitCode ?? '-'} ${duration} ${record.dir}`);
		if (record.setupError) { console.log('    setup: ' + record.setupError); break; }
		if (record.primary === 'HARNESS_BLOCKED') break;
	}
	manifest.finishedAt = new Date().toISOString();
	manifest.allPassed = manifest.attempts.length === arms.length && manifest.attempts.every(attempt => attempt.primary === 'PASS_UNREVIEWED_VISUAL');
	manifest.apiPreservationVerified = options.acceptance === 'current133-api' && manifest.attempts.length === arms.length && manifest.attempts.every(attempt => attempt.primary === 'API_PRESERVATION_VERIFIED_NOT_RELEASE');
	if (options.acceptance) manifest.qualification = options.acceptance === 'current133-api' ? 'NOT_RELEASE_QUALIFIED' : manifest.allPassed ? 'PASS_UNREVIEWED_VISUAL' : options.prepareOnly ? 'NOT_RUN' : 'NOT_QUALIFIED';
	writeJsonAtomic(manifestFile, manifest);
	console.log('Manifest: ' + manifestFile);
	 process.exitCode = manifest.allPassed || manifest.apiPreservationVerified || options.prepareOnly && manifest.attempts.every(attempt => attempt.primary === 'PREPARED') ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
	console.error('BOOTSTRAP ERROR: ' + clip(error.message, 1000));
	process.exitCode = 2;
});
