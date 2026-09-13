import assert from 'node:assert/strict';
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	cleanupOwnedManagedWorkspace,
	findManagedWorkspaceStorageEntries,
	movePathWithCrossDeviceFallback,
	normalizeManagedWorkspaceOwner,
	repairResidueEntries,
	resolveManagedWorkspacePath,
	runWithGuaranteedCleanup,
	selectE2eShard,
	shouldRetryVscodeBootstrapFailure,
	validateE2eWorkspaceConfiguration,
} from '../../scripts/e2e-full-suite-support.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fullSuiteRunnerPath = path.join(repoRoot, 'scripts', 'e2e-full-suite.mjs');
const exportSkillFeaturePath = path.join(
	repoRoot,
	'tests',
	'vscode-extension-tester',
	'e2e',
	'default',
	'export-skill-sidecar',
	'export-skill-sidecar.feature',
);

test('rejects unresolved environment placeholders at the repository root', () => {
	const placeholderEntries = readdirSync(repoRoot, { withFileTypes: true })
		.map(entry => entry.name)
		.filter(name => name.includes('${'));

	assert.deepEqual(placeholderEntries, []);
});

test('keeps export-skill setup inside its guarded temp workspace', () => {
	const feature = readFileSync(exportSkillFeaturePath, 'utf8');
	const backgroundEnd = feature.indexOf('\n  Scenario:');
	const preflight = feature.indexOf('I collect JSON artifact "export-skill-workspace-preflight" from extension host expression');
	const addWorkspace = feature.indexOf('I add folder "${TEMP}/vscode-kusto-workbench-export-skill-sidecar"');
	const guard = feature.indexOf('I collect JSON artifact "export-skill-workspace" from extension host expression');
	const firstDelete = feature.indexOf('I delete file ');
	const firstFixtureWrite = feature.indexOf('Given a file ');
	const firstExport = feature.indexOf('I start command "kusto.exportSkill"');
	const exactExport = feature.indexOf('I collect JSON artifact "export-skill-exact-bytes" from extension host expression');
	const dismiss = feature.indexOf('I press "Escape"');
	const exactPreservation = feature.indexOf('I collect JSON artifact "preserved-local-skill-exact-bytes" from extension host expression');
	const cleanup = feature.indexOf('I collect JSON artifact "export-skill-workspace-cleanup" from extension host expression');

	assert.equal(feature.includes('${VSCODE_EXT_TEST_WORKSPACE}'), false);
	assert.ok(backgroundEnd > 0);
	assert.ok(preflight > 0 && preflight < backgroundEnd);
	assert.ok(addWorkspace > 0 && addWorkspace < backgroundEnd);
	assert.ok(preflight < addWorkspace);
	assert.ok(addWorkspace < guard && guard < backgroundEnd);
	assert.ok(guard < firstDelete);
	assert.ok(guard < firstFixtureWrite);
	assert.ok(guard < firstExport);
	assert.ok(exactExport > firstExport);
	assert.ok(dismiss > firstExport);
	assert.ok(exactPreservation > dismiss);
	assert.ok(cleanup > exactPreservation);
	assert.ok(feature.includes('lstatSync(candidatePath, { throwIfNoEntry: false })'));
	assert.ok(feature.includes("ownerContent = 'export-skill-sidecar-v1\\n'"));
	assert.ok(feature.includes('workspace already exists without its ownership marker'));
});

test('does not use the suite-only workspace variable in Gherkin features', () => {
	const e2eRoot = path.join(repoRoot, 'tests', 'vscode-extension-tester', 'e2e');
	const pending = [e2eRoot];
	const offenders = [];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const candidate = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(candidate);
			else if (entry.isFile() && entry.name.endsWith('.feature')
				&& readFileSync(candidate, 'utf8').includes('${VSCODE_EXT_TEST_WORKSPACE}')) {
				offenders.push(path.relative(repoRoot, candidate));
			}
		}
	}
	assert.deepEqual(offenders.sort(), []);
});

test('resolves managed E2E workspace paths without preserving placeholders', () => {
	const tempRoot = path.resolve(repoRoot, '..', 'e2e-temp');
	assert.equal(
		resolveManagedWorkspacePath('${TEMP}/export-skill', { TEMP: tempRoot }),
		path.join(tempRoot, 'export-skill'),
	);
	assert.throws(
		() => resolveManagedWorkspacePath('${TEMP}/export-skill', {}),
		/requires environment variable TEMP/,
	);
	assert.throws(
		() => resolveManagedWorkspacePath('relative/export-skill', {}),
		/must resolve to an absolute path/,
	);
	assert.throws(
		() => resolveManagedWorkspacePath(path.join(tempRoot, '${}', 'export-skill'), {}),
		/invalid environment placeholder/,
	);
	assert.throws(
		() => resolveManagedWorkspacePath(path.join(tempRoot, '${TEMP', 'export-skill'), {}),
		/invalid environment placeholder/,
	);
});

test('rejects runner-opened and self-managed workspace configuration together', () => {
	const owner = { markerName: '.owner', content: 'owned\n' };
	assert.deepEqual(normalizeManagedWorkspaceOwner(owner), owner);
	assert.throws(() => normalizeManagedWorkspaceOwner({ markerName: '../owner', content: 'owned\n' }), /one file name/);
	assert.throws(() => normalizeManagedWorkspaceOwner({ markerName: '.owner', content: '', extra: true }), /only markerName and content/);
	assert.doesNotThrow(() => validateE2eWorkspaceConfiguration({ workspaceSettings: {}, managedWorkspacePath: null, managedWorkspaceOwner: null }));
	assert.doesNotThrow(() => validateE2eWorkspaceConfiguration({ workspaceSettings: null, managedWorkspacePath: 'C:\\temp', managedWorkspaceOwner: owner }));
	assert.throws(
		() => validateE2eWorkspaceConfiguration({ workspaceSettings: {}, managedWorkspacePath: 'C:\\temp', managedWorkspaceOwner: owner }),
		/cannot be used together/,
	);
	assert.throws(
		() => validateE2eWorkspaceConfiguration({ workspaceSettings: null, managedWorkspacePath: null, managedWorkspaceOwner: owner }),
		/requires managedWorkspacePath/,
	);
});

test('matches only the intended reusable-profile workspace storage', () => {
	const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'kusto-e2e-workspace-storage-'));
	try {
		const userDataRoot = path.join(fixtureRoot, 'user-data');
		const storageRoot = path.join(userDataRoot, 'User', 'workspaceStorage');
		const workspaceDir = path.join(fixtureRoot, 'managed-workspace');
		for (const name of ['matching-folder', 'matching-workspace', 'new-tombstone', 'old-tombstone', 'unrelated', 'malformed', 'mixed-metadata', 'mixed-folder', 'multi-folder', 'ext-dev']) {
			mkdirSync(path.join(storageRoot, name), { recursive: true });
		}
		writeFileSync(
			path.join(storageRoot, 'matching-folder', 'workspace.json'),
			JSON.stringify({ folder: pathToFileURL(workspaceDir).toString() }),
		);
		const generatedWorkspacePath = path.join(userDataRoot, 'Workspaces', 'generated', 'workspace.json');
		mkdirSync(path.dirname(generatedWorkspacePath), { recursive: true });
		writeFileSync(generatedWorkspacePath, JSON.stringify({
			folders: [{ name: 'managed', path: workspaceDir }],
		}));
		writeFileSync(
			path.join(storageRoot, 'matching-workspace', 'workspace.json'),
			JSON.stringify({ workspace: pathToFileURL(generatedWorkspacePath).toString() }),
		);
		const missingWorkspacePath = path.join(userDataRoot, 'Workspaces', 'removed-after-close', 'workspace.json');
		for (const name of ['new-tombstone', 'old-tombstone']) {
			writeFileSync(
				path.join(storageRoot, name, 'workspace.json'),
				JSON.stringify({ workspace: pathToFileURL(missingWorkspacePath).toString() }),
			);
		}
		writeFileSync(
			path.join(storageRoot, 'unrelated', 'workspace.json'),
			JSON.stringify({ folder: pathToFileURL(path.join(fixtureRoot, 'other-workspace')).toString() }),
		);
		writeFileSync(path.join(storageRoot, 'malformed', 'workspace.json'), '{broken');
		writeFileSync(
			path.join(storageRoot, 'mixed-metadata', 'workspace.json'),
			JSON.stringify({ folder: pathToFileURL(workspaceDir).toString(), workspace: null }),
		);
		const mixedFolderWorkspacePath = path.join(userDataRoot, 'Workspaces', 'mixed-folder', 'workspace.json');
		mkdirSync(path.dirname(mixedFolderWorkspacePath), { recursive: true });
		writeFileSync(mixedFolderWorkspacePath, JSON.stringify({
			folders: [{ path: workspaceDir, uri: null }],
		}));
		writeFileSync(
			path.join(storageRoot, 'mixed-folder', 'workspace.json'),
			JSON.stringify({ workspace: pathToFileURL(mixedFolderWorkspacePath).toString() }),
		);
		const multiWorkspacePath = path.join(userDataRoot, 'Workspaces', 'multi', 'workspace.json');
		mkdirSync(path.dirname(multiWorkspacePath), { recursive: true });
		writeFileSync(multiWorkspacePath, JSON.stringify({
			folders: [
				{ path: workspaceDir },
				{ path: path.join(fixtureRoot, 'other-workspace') },
			],
		}));
		writeFileSync(
			path.join(storageRoot, 'multi-folder', 'workspace.json'),
			JSON.stringify({ workspace: pathToFileURL(multiWorkspacePath).toString() }),
		);
		writeFileSync(
			path.join(storageRoot, 'ext-dev', 'workspace.json'),
			JSON.stringify({ folder: pathToFileURL(workspaceDir).toString() }),
		);

		assert.deepEqual(
			findManagedWorkspaceStorageEntries({
				profile: 'default',
				storageRoot,
				workspaceDir,
				allowlist: new Set(['ext-dev']),
				entryNamesBefore: new Set(['old-tombstone', 'unrelated', 'malformed', 'mixed-metadata', 'mixed-folder', 'multi-folder', 'ext-dev']),
			}),
			[
				{
					profile: 'default',
					name: 'matching-folder',
					path: path.join(storageRoot, 'matching-folder'),
					kind: 'directory',
				},
				{
					profile: 'default',
					name: 'matching-workspace',
					path: path.join(storageRoot, 'matching-workspace'),
					kind: 'directory',
				},
				{
					profile: 'default',
					name: 'new-tombstone',
					path: path.join(storageRoot, 'new-tombstone'),
					kind: 'directory',
				},
			],
		);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test('falls back to copy and remove when workspace residue crosses volumes', () => {
	const calls = [];
	movePathWithCrossDeviceFallback('source', 'target', {
		renameSync: () => {
			const error = new Error('cross-device move');
			error.code = 'EXDEV';
			throw error;
		},
		cpSync: (source, target, options) => calls.push(['copy', source, target, options]),
		rmSync: (source, options) => calls.push(['remove', source, options]),
	});

	assert.deepEqual(calls, [
		['copy', 'source', 'target', { recursive: true, force: false, errorOnExist: true }],
		['remove', 'source', { recursive: true, force: true }],
	]);
});

test('retains an earlier managed backup when a later move fails', () => {
	const residues = [
		{ profile: 'default', name: 'first', path: 'source-first', kind: 'directory' },
		{ profile: 'default', name: 'second', path: 'source-second', kind: 'directory' },
	];
	const moves = [];
	const outcome = repairResidueEntries(residues, 'backup-root', {
		lstatSync: () => ({}),
		mkdirSync: () => undefined,
		movePathWithCrossDeviceFallback: (source, target) => {
			if (source === 'source-second') throw new Error('second move failed');
			moves.push([source, target]);
		},
	});

	assert.deepEqual(moves, [['source-first', path.join('backup-root', 'default', 'first')]]);
	assert.deepEqual(outcome.repaired, [{
		...residues[0],
		repairedTo: path.join('backup-root', 'default', 'first'),
	}]);
	assert.deepEqual(outcome.errors, [{
		...residues[1],
		target: path.join('backup-root', 'default', 'second'),
		error: 'second move failed',
	}]);
});

test('retains an earlier managed backup when a later lstat fails', () => {
	const residues = [
		{ profile: 'default', name: 'first', path: 'source-first', kind: 'directory' },
		{ profile: 'default', name: 'second', path: 'source-second', kind: 'directory' },
	];
	const moves = [];
	const outcome = repairResidueEntries(residues, 'backup-root', {
		lstatSync: source => {
			if (source === 'source-second') throw new Error('second lstat failed');
			return {};
		},
		mkdirSync: () => undefined,
		movePathWithCrossDeviceFallback: (source, target) => moves.push([source, target]),
	});

	assert.deepEqual(moves, [['source-first', path.join('backup-root', 'default', 'first')]]);
	assert.equal(outcome.repaired.length, 1);
	assert.deepEqual(outcome.errors, [{
		...residues[1],
		target: path.join('backup-root', 'default', 'second'),
		error: 'second lstat failed',
	}]);
});

test('repairs dangling residue links instead of silently skipping them', () => {
	const moves = [];
	const residue = { profile: 'default', name: 'dangling-link', path: 'dangling-source', kind: 'file' };
	const outcome = repairResidueEntries([residue], 'backup-root', {
		lstatSync: () => ({ isSymbolicLink: () => true }),
		mkdirSync: () => undefined,
		movePathWithCrossDeviceFallback: (source, target) => moves.push([source, target]),
	});
	assert.deepEqual(moves, [['dangling-source', path.join('backup-root', 'default', 'dangling-link')]]);
	assert.equal(outcome.repaired.length, 1);
	assert.deepEqual(outcome.errors, []);
});

test('runs cleanup after artifact processing fails and preserves both errors', () => {
	const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'kusto-e2e-owned-workspace-'));
	const workspaceDir = path.join(fixtureRoot, 'workspace');
	const markerName = '.owner';
	const markerContent = 'owned\n';
	try {
		mkdirSync(path.join(workspaceDir, '.github'), { recursive: true });
		writeFileSync(path.join(workspaceDir, markerName), markerContent);
		writeFileSync(path.join(workspaceDir, '.github', 'generated.txt'), 'generated');
		const outcome = runWithGuaranteedCleanup(
			() => JSON.parse('{truncated'),
			() => cleanupOwnedManagedWorkspace({
				workspaceDir,
				owner: { markerName, content: markerContent },
				protectedRoot: repoRoot,
			}),
		);

		assert.match(outcome.operationError?.message ?? '', /JSON/);
		assert.deepEqual(outcome.cleanupValue, {
			removed: true,
			path: workspaceDir,
			markerPath: path.join(workspaceDir, markerName),
		});
		assert.equal(outcome.cleanupError, undefined);
		assert.equal(lstatSync(workspaceDir, { throwIfNoEntry: false }), undefined);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test('rejects deleting a managed workspace that contains the protected root', () => {
	const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'kusto-e2e-ancestor-workspace-'));
	const protectedRoot = path.join(fixtureRoot, 'repository');
	const markerName = '.owner';
	const markerContent = 'owned\n';
	try {
		mkdirSync(protectedRoot);
		writeFileSync(path.join(fixtureRoot, markerName), markerContent);
		assert.throws(
			() => cleanupOwnedManagedWorkspace({
				workspaceDir: fixtureRoot,
				owner: { markerName, content: markerContent },
				protectedRoot,
			}),
			/overlaps the protected root/,
		);
		assert.ok(lstatSync(protectedRoot).isDirectory());
		assert.equal(readFileSync(path.join(fixtureRoot, markerName), 'utf8'), markerContent);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test('records structured managed workspace repair errors in suite runs', () => {
	const runner = readFileSync(fullSuiteRunnerPath, 'utf8');
	assert.match(runner, /repairResidueEntries\(residueEntries, backupRoot, \{\s*lstatSync,/);
	assert.match(runner, /managedWorkspaceRepairErrors = managedRepair\.errors/);
	assert.match(runner, /managedWorkspaceRepairErrors: postRun\.cleanupValue\?\.managedWorkspaceRepairErrors \?\? \[\]/);
	assert.match(runner, /managedWorkspaceCleanup: postRun\.cleanupValue\?\.managedWorkspaceCleanup/);
	assert.match(runner, /managedWorkspaceCleanup = \{\s*removed: false,\s*path: testCase\.managedWorkspacePath,\s*error: message,/);
});

test('partitions E2E cases deterministically without overlap', () => {
	const cases = ['a', 'b', 'c', 'd', 'e'];

	assert.deepEqual(selectE2eShard(cases, 1, 2), ['a', 'c', 'e']);
	assert.deepEqual(selectE2eShard(cases, 2, 2), ['b', 'd']);
	assert.deepEqual(
		[...selectE2eShard(cases, 1, 2), ...selectE2eShard(cases, 2, 2)].sort(),
		cases,
	);
});

test('rejects invalid E2E shard coordinates', () => {
	assert.throws(() => selectE2eShard([], 1, 0), /count must be a positive integer/);
	assert.throws(() => selectE2eShard([], 0, 2), /index must be between 1 and 2/);
	assert.throws(() => selectE2eShard([], 3, 2), /index must be between 1 and 2/);
});

test('retries a transient VS Code download failure before launch', () => {
	assert.equal(shouldRetryVscodeBootstrapFailure({
		status: 1,
		output: 'Downloading VS Code (1.132.1)...\nError downloading: aborted\ncode: ECONNRESET',
	}), true);
});

test('retries retryable HTTP download responses', () => {
	assert.equal(shouldRetryVscodeBootstrapFailure({
		status: 1,
		output: 'Found at https://update.code.visualstudio.com/...\nHTTP status 503',
	}), true);
});

test('retries the timeout emitted by the installed VS Code downloader', () => {
	assert.equal(shouldRetryVscodeBootstrapFailure({
		status: 1,
		output: 'Downloading VS Code (1.132.1)...\nError: @vscode/test-electron request timeout out after 30000ms',
	}), true);
});

test('does not retry product, step, or post-launch failures', () => {
	for (const candidate of [
		{ status: 1, output: 'Then element should exist: assertion failed' },
		{ status: 1, output: 'Step timed out after 30000ms' },
		{ status: 1, output: 'Downloading VS Code\nLaunching VS Code\nECONNRESET' },
		{ status: 1, output: 'Downloading VS Code\nECONNRESET', hasStructuredResults: true },
		{ status: 0, output: 'Downloading VS Code\nECONNRESET' },
	]) {
		assert.equal(shouldRetryVscodeBootstrapFailure(candidate), false);
	}
});