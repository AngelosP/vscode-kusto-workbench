#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eRoot = path.join(repoRoot, 'tests', 'vscode-extension-tester');
const featuresRoot = path.join(e2eRoot, 'e2e');
const runsRoot = path.join(e2eRoot, 'runs');
const historyRoot = path.join(e2eRoot, 'history');
const defaultQuarantinePath = path.join(e2eRoot, 'e2e-suite.quarantine.json');
const workspaceStorageAllowlist = new Set(['ext-dev']);
const quietProfileSettings = {
	'extensions.ignoreRecommendations': true,
	'extensions.showRecommendationsOnlyOnDemand': true,
	'workbench.startupEditor': 'none',
};
const perTestConfigFile = 'e2e.settings.json';

function usage() {
	return `Usage: node scripts/e2e-full-suite.mjs [options]

Options:
  --profiles <csv>                  Profiles to run. Defaults to every e2e profile directory.
  --profile <name>                  Add one profile to run. Can be repeated.
  --test-id <id>                    Add one test id to run. Can be repeated.
  --include-screenshot-generators   Include readme-ss-* screenshot generator features.
  --run-quarantined                 Run quarantined tests instead of skipping them.
  --dry-run                         Discover and report the suite without running tests.
  --no-build                        Skip the one-time npm run compile before test execution.
  --allow-failures                  Always exit 0 after writing summary artifacts.
  --allow-profile-residue           Do not fail when named profiles leave workspaceStorage residue.
  --repair-profile-residue          Move named-profile workspaceStorage residue aside before/after runs.
  --profile-check-only              Only check named-profile residue, then exit.
  --timeout <ms>                    Pass a per-step timeout to vscode-ext-test.
	--vscode-version <version>        VS Code version to pass to vscode-ext-test. Defaults to E2E_VSCODE_VERSION or stable.
  --quarantine <path>               Quarantine manifest path.
  --output-dir <path>               History/output root. Defaults to tests/vscode-extension-tester/history.
  --help                            Show this help.
`;
}

function parseArgs(argv) {
	const options = {
		profiles: [],
		testIds: [],
		includeScreenshotGenerators: false,
		runQuarantined: false,
		dryRun: false,
		noBuild: false,
		allowFailures: false,
		allowProfileResidue: false,
		repairProfileResidue: false,
		profileCheckOnly: false,
		timeout: '',
		vscodeVersion: process.env.E2E_VSCODE_VERSION || 'stable',
		quarantinePath: defaultQuarantinePath,
		outputDir: historyRoot,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			index += 1;
			if (index >= argv.length) {
				throw new Error(`Missing value for ${arg}`);
			}
			return argv[index];
		};

		switch (arg) {
			case '--profiles':
				options.profiles.push(...splitCsv(next()));
				break;
			case '--profile':
				options.profiles.push(next());
				break;
			case '--test-id':
				options.testIds.push(next());
				break;
			case '--include-screenshot-generators':
				options.includeScreenshotGenerators = true;
				break;
			case '--run-quarantined':
				options.runQuarantined = true;
				break;
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--no-build':
				options.noBuild = true;
				break;
			case '--allow-failures':
				options.allowFailures = true;
				break;
			case '--allow-profile-residue':
				options.allowProfileResidue = true;
				break;
			case '--repair-profile-residue':
				options.repairProfileResidue = true;
				break;
			case '--profile-check-only':
				options.profileCheckOnly = true;
				break;
			case '--timeout':
				options.timeout = next();
				break;
			case '--vscode-version':
				options.vscodeVersion = next();
				break;
			case '--quarantine':
				options.quarantinePath = path.resolve(repoRoot, next());
				break;
			case '--output-dir':
				options.outputDir = path.resolve(repoRoot, next());
				break;
			case '--help':
				console.log(usage());
				process.exit(0);
				break;
			default:
				if (arg.startsWith('-')) {
					throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
				}
				options.profiles.push(...splitCsv(arg));
				break;
		}
	}

	options.profiles = unique(options.profiles.map(value => value.trim()).filter(Boolean));
	options.testIds = unique(options.testIds.map(value => value.trim()).filter(Boolean));
	options.vscodeVersion = String(options.vscodeVersion || '').trim() || 'stable';
	return options;
}

function splitCsv(value) {
	return String(value || '').split(',').map(part => part.trim()).filter(Boolean);
}

function unique(values) {
	return [...new Set(values)];
}

function readJson(filePath, fallback) {
	if (!existsSync(filePath)) {
		return fallback;
	}
	return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeSlashes(filePath) {
	return filePath.split(path.sep).join('/');
}

function relativePath(filePath) {
	return normalizeSlashes(path.relative(repoRoot, filePath));
}

function shellForPlatform() {
	return process.platform === 'win32';
}

function discoverProfiles() {
	if (!existsSync(featuresRoot)) {
		throw new Error(`E2E feature root not found: ${relativePath(featuresRoot)}`);
	}
	return readdirSync(featuresRoot, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

function discoverCases(options, quarantineEntries) {
	const profiles = options.profiles.length > 0 ? options.profiles : discoverProfiles();
	const testIdFilter = new Set(options.testIds);
	const cases = [];
	const excludedScreenshotGenerators = [];

	for (const profile of profiles) {
		const profileDir = path.join(featuresRoot, profile);
		if (!existsSync(profileDir)) {
			throw new Error(`E2E profile not found: ${relativePath(profileDir)}`);
		}

		const testIds = readdirSync(profileDir, { withFileTypes: true })
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.filter(testId => testIdFilter.size === 0 || testIdFilter.has(testId))
			.sort((left, right) => left.localeCompare(right));

		for (const testId of testIds) {
			const testDir = path.join(profileDir, testId);
			const featureFiles = readdirSync(testDir).filter(name => name.endsWith('.feature'));
			if (featureFiles.length === 0) {
				continue;
			}

			const testSettings = readTestSettings(testDir);

			const category = testId.startsWith('readme-ss-') || testId.startsWith('tutorial-media-') ? 'screenshot-generator' : 'behavior';
			const quarantine = findQuarantine(quarantineEntries, profile, testId);
			const testCase = {
				profile,
				testId,
				category,
				featureFiles: featureFiles.map(name => relativePath(path.join(testDir, name))),
				workspaceSettings: testSettings.workspaceSettings,
				timeout: testSettings.timeout,
				quarantine,
			};

			if (category === 'screenshot-generator' && !options.includeScreenshotGenerators) {
				excludedScreenshotGenerators.push(testCase);
				continue;
			}

			cases.push(testCase);
		}
	}

	return { cases, excludedScreenshotGenerators };
}

function readTestSettings(testDir) {
	const configPath = path.join(testDir, perTestConfigFile);
	if (!existsSync(configPath)) {
		return { workspaceSettings: null, timeout: '' };
	}

	const config = readJson(configPath, {});
	let workspaceSettings = null;
	if (config.workspaceSettings !== undefined) {
		if (!config.workspaceSettings || typeof config.workspaceSettings !== 'object' || Array.isArray(config.workspaceSettings)) {
			throw new Error(`${relativePath(configPath)} property workspaceSettings must be an object.`);
		}
		workspaceSettings = config.workspaceSettings;
	}

	let timeout = '';
	if (config.timeout !== undefined) {
		const value = String(config.timeout || '').trim();
		if (!/^\d+$/.test(value) || Number(value) <= 0) {
			throw new Error(`${relativePath(configPath)} property timeout must be a positive millisecond value.`);
		}
		timeout = value;
	}

	return { workspaceSettings, timeout };
}

function findQuarantine(entries, profile, testId) {
	return entries.find(entry => {
		const profileMatches = entry.profile === profile || entry.profile === '*';
		const testMatches = entry.testId === testId || entry.testId === '*';
		return profileMatches && testMatches;
	}) || null;
}

function loadQuarantine(options) {
	const manifest = readJson(options.quarantinePath, { version: 1, entries: [] });
	const entries = Array.isArray(manifest.entries) ? manifest.entries.filter(entry => !entry.disabled) : [];
	return { manifest, entries, validationErrors: validateQuarantine(entries) };
}

function validateQuarantine(entries) {
	const validationErrors = [];
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);

	for (const entry of entries) {
		const label = `${entry.profile || '<missing-profile>'}/${entry.testId || '<missing-test-id>'}`;
		for (const fieldName of ['profile', 'testId', 'mode', 'owner', 'reason', 'issue', 'expiresOn']) {
			if (!entry[fieldName]) {
				validationErrors.push(`${label}: missing ${fieldName}`);
			}
		}
		if (entry.mode && !['skip', 'allowed-failure'].includes(entry.mode)) {
			validationErrors.push(`${label}: mode must be skip or allowed-failure`);
		}
		if (entry.expiresOn) {
			const expiry = new Date(`${entry.expiresOn}T00:00:00Z`);
			if (Number.isNaN(expiry.getTime())) {
				validationErrors.push(`${label}: expiresOn is not a valid YYYY-MM-DD date`);
			} else if (expiry < today) {
				validationErrors.push(`${label}: quarantine expired on ${entry.expiresOn}`);
			}
		}
	}

	return validationErrors;
}

function profileWorkspaceStorageRoot(profile) {
	return path.join(e2eRoot, 'profiles', profile, 'user-data', 'User', 'workspaceStorage');
}

function profileSettingsPath(profile) {
	return path.join(e2eRoot, 'profiles', profile, 'user-data', 'User', 'settings.json');
}

function ensureQuietProfileSettings(profile) {
	if (profile === 'default') {
		return null;
	}

	const settingsPath = profileSettingsPath(profile);
	let settings = {};
	if (existsSync(settingsPath)) {
		settings = readJson(settingsPath, {});
	}

	let changed = false;
	for (const [key, value] of Object.entries(quietProfileSettings)) {
		if (settings[key] !== value) {
			settings[key] = value;
			changed = true;
		}
	}

	if (changed) {
		writeJson(settingsPath, settings);
		return settingsPath;
	}
	return null;
}

function listProfileResidue(profile) {
	if (profile === 'default') {
		return [];
	}

	const storageRoot = profileWorkspaceStorageRoot(profile);
	if (!existsSync(storageRoot)) {
		return [{ profile, name: '<missing workspaceStorage>', path: storageRoot, kind: 'missing-workspace-storage' }];
	}

	return readdirSync(storageRoot, { withFileTypes: true })
		.filter(entry => !workspaceStorageAllowlist.has(entry.name))
		.map(entry => ({
			profile,
			name: entry.name,
			path: path.join(storageRoot, entry.name),
			kind: entry.isDirectory() ? 'directory' : 'file',
		}));
}

function repairProfileResidue(residueEntries, backupRoot) {
	if (residueEntries.length === 0) {
		return [];
	}

	const repaired = [];
	for (const residue of residueEntries) {
		if (!existsSync(residue.path)) {
			continue;
		}
		const profileBackupRoot = path.join(backupRoot, residue.profile);
		mkdirSync(profileBackupRoot, { recursive: true });
		const target = path.join(profileBackupRoot, residue.name);
		renameSync(residue.path, target);
		repaired.push({ ...residue, repairedTo: target });
	}
	return repaired;
}

function runCommand(command, args, outputFile, envOverrides = {}) {
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: 'utf8',
		shell: shellForPlatform(),
		maxBuffer: 1024 * 1024 * 200,
		env: { ...process.env, ...envOverrides },
	});
	const stdout = result.stdout || '';
	const stderr = result.stderr || '';
	const combinedOutput = `${stdout}${stderr ? `\n${stderr}` : ''}`;
	if (outputFile) {
		mkdirSync(path.dirname(outputFile), { recursive: true });
		writeFileSync(outputFile, combinedOutput, 'utf8');
	}
	return {
		command,
		args,
		status: typeof result.status === 'number' ? result.status : 1,
		error: result.error ? String(result.error.message || result.error) : '',
		stdout,
		stderr,
		combinedOutput,
		durationMs: Date.now() - startedAt,
	};
}

function safePathSegment(value) {
	return String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function prepareTestWorkspace(testCase, suiteOutputDir) {
	if (!testCase.workspaceSettings) {
		return null;
	}
	const workspaceDir = path.join(
		suiteOutputDir,
		'workspaces',
		`${safePathSegment(testCase.profile)}__${safePathSegment(testCase.testId)}`,
	);
	const settingsPath = path.join(workspaceDir, '.vscode', 'settings.json');
	writeJson(settingsPath, testCase.workspaceSettings);
	return { workspaceDir, settingsPath };
}

function latestRunDir(profile, testId) {
	const testRunRoot = path.join(runsRoot, profile, testId);
	if (!existsSync(testRunRoot)) {
		return '';
	}
	const candidates = readdirSync(testRunRoot, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(testRunRoot, entry.name))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
	return candidates[0] || '';
}

function artifactDirFromOutput(output, profile, testId) {
	const match = output.match(/Artifacts written to:\s*(.+)\s*$/m);
	if (match) {
		return path.resolve(repoRoot, match[1].trim());
	}
	return latestRunDir(profile, testId);
}

function walkFiles(rootDir) {
	if (!existsSync(rootDir)) {
		return [];
	}
	const files = [];
	for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkFiles(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

function summarizeArtifacts(runDir) {
	if (!runDir || !existsSync(runDir)) {
		return {
			runDir,
			results: null,
			reportPath: '',
			screenshots: [],
			failureScreenshots: [],
			outputChannels: [],
			failures: [],
		};
	}

	const resultsPath = path.join(runDir, 'results.json');
	const reportPath = path.join(runDir, 'report.md');
	const results = existsSync(resultsPath) ? readJson(resultsPath, null) : null;
	const allPngFiles = walkFiles(runDir).filter(filePath => filePath.toLowerCase().endsWith('.png'));
	const screenshots = unique([...(results?.screenshots || []).map(filePath => path.resolve(repoRoot, filePath)), ...allPngFiles]);
	const failureScreenshots = screenshots.filter(filePath => /failure/i.test(path.basename(filePath)));
	const outputChannels = walkFiles(path.join(runDir, 'output-channels')).filter(filePath => filePath.toLowerCase().endsWith('.log'));
	const failures = collectFailures(results);

	return {
		runDir,
		results,
		reportPath: existsSync(reportPath) ? reportPath : '',
		screenshots,
		failureScreenshots,
		outputChannels,
		failures,
	};
}

function collectFailures(results) {
	if (!results?.features) {
		return [];
	}
	const failures = [];
	for (const feature of results.features) {
		for (const scenario of feature.scenarios || []) {
			for (const step of scenario.steps || []) {
				if (step.status === 'failed') {
					failures.push({
						feature: feature.name,
						scenario: scenario.name,
						step: `${step.keyword || ''}${step.text || ''}`.trim(),
						message: step.error?.message || 'Unknown failure',
					});
				}
			}
		}
	}
	return failures;
}

function failureSignature(runRecord) {
	const firstFailure = runRecord.failures[0];
	if (!firstFailure) {
		return '';
	}
	return `${firstFailure.scenario} :: ${firstFailure.step} :: ${firstFailure.message}`.slice(0, 500);
}

function loadLedger(outputRoot) {
	return readJson(path.join(outputRoot, 'flake-ledger.json'), { version: 1, tests: {} });
}

function updateLedger(outputRoot, runRecords) {
	const ledger = loadLedger(outputRoot);
	ledger.updatedAt = new Date().toISOString();
	ledger.tests ||= {};

	for (const runRecord of runRecords.filter(record => record.status === 'passed' || record.status === 'failed')) {
		const key = `${runRecord.profile}/${runRecord.testId}`;
		const entry = ledger.tests[key] || {
			profile: runRecord.profile,
			testId: runRecord.testId,
			category: runRecord.category,
			totalRuns: 0,
			passes: 0,
			failures: 0,
			consecutivePasses: 0,
			consecutiveFailures: 0,
			recent: [],
		};

		entry.category = runRecord.category;
		entry.totalRuns += 1;
		entry.lastRunAt = runRecord.completedAt;
		entry.lastStatus = runRecord.status;
		entry.lastDurationMs = runRecord.durationMs;
		entry.lastRunDir = runRecord.runDir ? relativePath(runRecord.runDir) : '';
		if (runRecord.status === 'passed') {
			entry.passes += 1;
			entry.consecutivePasses += 1;
			entry.consecutiveFailures = 0;
		} else {
			entry.failures += 1;
			entry.consecutiveFailures += 1;
			entry.consecutivePasses = 0;
			entry.lastFailureSignature = failureSignature(runRecord);
		}
		entry.recent = [...(entry.recent || []), {
			status: runRecord.status,
			runAt: runRecord.completedAt,
			durationMs: runRecord.durationMs,
			failureSignature: failureSignature(runRecord),
		}].slice(-20);
		entry.flakeSuspect = entry.recent.some(item => item.status === 'passed') && entry.recent.some(item => item.status === 'failed');
		ledger.tests[key] = entry;
	}

	writeJson(path.join(outputRoot, 'flake-ledger.json'), ledger);
	return ledger;
}

function summarizeSuite({ runStartedAt, completedAt, options, cases, excludedScreenshotGenerators, runRecords, quarantineErrors, profileResidueRecords, ledger }) {
	const executed = runRecords.filter(record => record.status === 'passed' || record.status === 'failed');
	const passed = runRecords.filter(record => record.status === 'passed');
	const failed = runRecords.filter(record => record.status === 'failed');
	const allowedFailures = runRecords.filter(record => record.status === 'allowed-failure');
	const quarantined = runRecords.filter(record => record.status === 'quarantined');
	const skipped = runRecords.filter(record => record.status === 'skipped');
	const residueFailures = profileResidueRecords.filter(record => record.severity === 'failure');
	const flakeSuspects = Object.values(ledger.tests || {}).filter(entry => entry.flakeSuspect);

	return {
		version: 1,
		runStartedAt,
		completedAt,
		vscodeVersion: options.vscodeVersion,
		profiles: options.profiles.length > 0 ? options.profiles : discoverProfiles(),
		includeScreenshotGenerators: options.includeScreenshotGenerators,
		dryRun: options.dryRun,
		totalDiscovered: cases.length + excludedScreenshotGenerators.length,
		totalSelected: cases.length,
		executed: executed.length + allowedFailures.length,
		passed: passed.length,
		failed: failed.length,
		allowedFailures: allowedFailures.length,
		quarantined: quarantined.length,
		skipped: skipped.length,
		excludedScreenshotGenerators: excludedScreenshotGenerators.length,
		quarantinePolicyErrors: quarantineErrors,
		profileResidueFailures: residueFailures.length,
		flakeSuspects: flakeSuspects.map(entry => ({
			profile: entry.profile,
			testId: entry.testId,
			passes: entry.passes,
			failures: entry.failures,
			lastStatus: entry.lastStatus,
			lastFailureSignature: entry.lastFailureSignature || '',
		})),
		runs: runRecords,
		profileResidue: profileResidueRecords,
	};
}

function toMarkdown(summary) {
	const lines = [];
	const result = summary.failed === 0 && summary.quarantinePolicyErrors.length === 0 && summary.profileResidueFailures === 0 ? 'PASS' : 'FAIL';
	lines.push(`# E2E Full Suite Summary`);
	lines.push('');
	lines.push(`**Result:** ${result}`);
	lines.push('');
	lines.push(`- Started: ${summary.runStartedAt}`);
	lines.push(`- Completed: ${summary.completedAt}`);
	lines.push(`- VS Code: ${summary.vscodeVersion}`);
	lines.push(`- Selected: ${summary.totalSelected} tests`);
	lines.push(`- Executed: ${summary.executed}`);
	lines.push(`- Passed: ${summary.passed}`);
	lines.push(`- Failed: ${summary.failed}`);
	lines.push(`- Allowed failures: ${summary.allowedFailures}`);
	lines.push(`- Quarantined/skipped: ${summary.quarantined}`);
	lines.push(`- Screenshot generators excluded: ${summary.excludedScreenshotGenerators}`);
	lines.push(`- Profile residue failures: ${summary.profileResidueFailures}`);
	lines.push('');

	if (summary.quarantinePolicyErrors.length > 0) {
		lines.push('## Quarantine Policy Errors');
		lines.push('');
		for (const error of summary.quarantinePolicyErrors) {
			lines.push(`- ${error}`);
		}
		lines.push('');
	}

	const failedRuns = summary.runs.filter(record => record.status === 'failed' || record.status === 'allowed-failure');
	if (failedRuns.length > 0) {
		lines.push('## Failures');
		lines.push('');
		lines.push('| Profile | Test | First Failure | Report | Failure Screenshots |');
		lines.push('| --- | --- | --- | --- | --- |');
		for (const record of failedRuns) {
			const firstFailure = record.failures[0];
			const message = firstFailure ? `${firstFailure.scenario}: ${firstFailure.step}: ${firstFailure.message}` : record.error || 'No structured failure found';
			const report = record.reportPath ? relativePath(record.reportPath) : '';
			const screenshots = record.failureScreenshots.length > 0
				? record.failureScreenshots.map(filePath => relativePath(filePath)).join('<br>')
				: 'none';
			lines.push(`| ${record.profile} | ${record.testId} | ${escapeMd(message)} | ${report} | ${screenshots} |`);
		}
		lines.push('');
	}

	if (summary.profileResidue.length > 0) {
		lines.push('## Reusable Profile Residue');
		lines.push('');
		lines.push('| Severity | Profile | Phase | Entries | Repair |');
		lines.push('| --- | --- | --- | --- | --- |');
		for (const record of summary.profileResidue) {
			lines.push(`| ${record.severity} | ${record.profile} | ${record.phase} | ${record.entries.map(entry => entry.name).join(', ')} | ${record.repairedTo?.join('<br>') || ''} |`);
		}
		lines.push('');
	}

	if (summary.flakeSuspects.length > 0) {
		lines.push('## Flake Suspects');
		lines.push('');
		lines.push('| Profile | Test | Passes | Failures | Last Status | Last Failure |');
		lines.push('| --- | --- | ---: | ---: | --- | --- |');
		for (const entry of summary.flakeSuspects) {
			lines.push(`| ${entry.profile} | ${entry.testId} | ${entry.passes} | ${entry.failures} | ${entry.lastStatus} | ${escapeMd(entry.lastFailureSignature)} |`);
		}
		lines.push('');
	}

	lines.push('## Runs');
	lines.push('');
	lines.push('| Status | Profile | Test | Category | Duration | Report | Screenshots | Output Channels |');
	lines.push('| --- | --- | --- | --- | ---: | --- | ---: | ---: |');
	for (const record of summary.runs) {
		const report = record.reportPath ? relativePath(record.reportPath) : '';
		lines.push(`| ${record.status} | ${record.profile} | ${record.testId} | ${record.category} | ${record.durationMs || 0}ms | ${report} | ${record.screenshots?.length || 0} | ${record.outputChannels?.length || 0} |`);
	}
	lines.push('');

	return `${lines.join('\n')}\n`;
}

function escapeMd(value) {
	return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function appendHistory(outputRoot, summary) {
	mkdirSync(outputRoot, { recursive: true });
	const compact = {
		runStartedAt: summary.runStartedAt,
		completedAt: summary.completedAt,
		vscodeVersion: summary.vscodeVersion,
		selected: summary.totalSelected,
		executed: summary.executed,
		passed: summary.passed,
		failed: summary.failed,
		allowedFailures: summary.allowedFailures,
		quarantined: summary.quarantined,
		profileResidueFailures: summary.profileResidueFailures,
		failures: summary.runs
			.filter(record => record.status === 'failed')
			.map(record => ({ profile: record.profile, testId: record.testId, signature: failureSignature(record) })),
	};
	appendFileSync(path.join(outputRoot, 'history.jsonl'), `${JSON.stringify(compact)}\n`, 'utf8');
}

function shouldFailSuite(summary) {
	return summary.failed > 0 || summary.quarantinePolicyErrors.length > 0 || summary.profileResidueFailures > 0;
}

function printCaseList(cases, excludedScreenshotGenerators) {
	console.log(`Selected ${cases.length} E2E tests.`);
	for (const testCase of cases) {
		const quarantine = testCase.quarantine ? ` quarantined:${testCase.quarantine.mode}` : '';
		console.log(`- ${testCase.profile}/${testCase.testId} [${testCase.category}]${quarantine}`);
	}
	if (excludedScreenshotGenerators.length > 0) {
		console.log(`Excluded ${excludedScreenshotGenerators.length} screenshot generators. Use --include-screenshot-generators to run them.`);
	}
}

function profileResidueRecord(profile, phase, residues, severity, repaired) {
	return {
		profile,
		phase,
		severity,
		entries: residues.map(entry => ({ name: entry.name, kind: entry.kind, path: relativePath(entry.path) })),
		repairedTo: repaired.map(entry => relativePath(entry.repairedTo)),
	};
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const runStartedAt = new Date().toISOString();
	const runStamp = runStartedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const suiteOutputDir = path.join(options.outputDir, `full-suite-${runStamp}`);
	const commandLogDir = path.join(suiteOutputDir, 'command-output');
	const residueBackupRoot = path.join(suiteOutputDir, 'profile-residue-backups');
	mkdirSync(suiteOutputDir, { recursive: true });

	const quarantine = loadQuarantine(options);
	const { cases, excludedScreenshotGenerators } = discoverCases(options, quarantine.entries);
	const profileResidueRecords = [];
	const runRecords = [];

	printCaseList(cases, excludedScreenshotGenerators);

	const namedProfiles = unique(cases.map(testCase => testCase.profile).filter(profile => profile !== 'default'));
	for (const profile of namedProfiles) {
		const settingsPath = ensureQuietProfileSettings(profile);
		if (settingsPath) {
			console.log(`Seeded quiet VS Code settings for ${profile}: ${relativePath(settingsPath)}`);
		}

		const residues = listProfileResidue(profile);
		if (residues.length > 0) {
			const repaired = options.repairProfileResidue ? repairProfileResidue(residues, path.join(residueBackupRoot, 'pre-run')) : [];
			profileResidueRecords.push(profileResidueRecord(profile, 'pre-run', residues, options.allowProfileResidue || options.repairProfileResidue ? 'warning' : 'failure', repaired));
		}
	}

	if (options.profileCheckOnly) {
		const ledger = loadLedger(options.outputDir);
		const summary = summarizeSuite({
			runStartedAt,
			completedAt: new Date().toISOString(),
			options,
			cases,
			excludedScreenshotGenerators,
			runRecords,
			quarantineErrors: quarantine.validationErrors,
			profileResidueRecords,
			ledger,
		});
		writeSummaryFiles(options.outputDir, suiteOutputDir, summary);
		console.log(toMarkdown(summary));
		process.exit(options.allowFailures || !shouldFailSuite(summary) ? 0 : 1);
	}

	if (options.dryRun) {
		for (const testCase of cases) {
			runRecords.push({ ...testCase, status: testCase.quarantine && !options.runQuarantined ? 'quarantined' : 'skipped', durationMs: 0, screenshots: [], outputChannels: [], failures: [], failureScreenshots: [] });
		}
		const ledger = loadLedger(options.outputDir);
		const summary = summarizeSuite({
			runStartedAt,
			completedAt: new Date().toISOString(),
			options,
			cases,
			excludedScreenshotGenerators,
			runRecords,
			quarantineErrors: quarantine.validationErrors,
			profileResidueRecords,
			ledger,
		});
		writeSummaryFiles(options.outputDir, suiteOutputDir, summary);
		console.log(toMarkdown(summary));
		process.exit(options.allowFailures || !shouldFailSuite(summary) ? 0 : 1);
	}

	if (quarantine.validationErrors.length > 0) {
		const ledger = loadLedger(options.outputDir);
		const summary = summarizeSuite({
			runStartedAt,
			completedAt: new Date().toISOString(),
			options,
			cases,
			excludedScreenshotGenerators,
			runRecords,
			quarantineErrors: quarantine.validationErrors,
			profileResidueRecords,
			ledger,
		});
		writeSummaryFiles(options.outputDir, suiteOutputDir, summary);
		console.log(toMarkdown(summary));
		process.exit(options.allowFailures ? 0 : 1);
	}

	if (!options.noBuild) {
		console.log('Building extension once before E2E suite...');
		const buildResult = runCommand('npm', ['run', 'compile'], path.join(commandLogDir, 'build.log'));
		if (buildResult.status !== 0) {
			throw new Error(`npm run compile failed. See ${relativePath(path.join(commandLogDir, 'build.log'))}`);
		}
	}

	for (const testCase of cases) {
		if (testCase.quarantine && !options.runQuarantined && testCase.quarantine.mode === 'skip') {
			runRecords.push({ ...testCase, status: 'quarantined', durationMs: 0, screenshots: [], outputChannels: [], failures: [], failureScreenshots: [] });
			console.log(`Skipping quarantined ${testCase.profile}/${testCase.testId}: ${testCase.quarantine.reason}`);
			continue;
		}

		console.log(`Running ${testCase.profile}/${testCase.testId}...`);
		const args = ['run', '--no-build', '--test-id', testCase.testId, '--vscode-version', options.vscodeVersion];
		if (testCase.profile !== 'default') {
			args.push('--reuse-named-profile', testCase.profile);
		}
		const timeout = options.timeout || testCase.timeout;
		if (timeout) {
			args.push('--timeout', timeout);
		}

		const preparedWorkspace = prepareTestWorkspace(testCase, suiteOutputDir);
		const envOverrides = preparedWorkspace ? { VSCODE_EXT_TEST_WORKSPACE: preparedWorkspace.workspaceDir } : {};
		if (preparedWorkspace) {
			console.log(`Seeded per-test VS Code workspace settings for ${testCase.profile}/${testCase.testId}: ${relativePath(preparedWorkspace.settingsPath)}`);
		}

		const outputFile = path.join(commandLogDir, `${testCase.profile}__${testCase.testId}.log`);
		const result = runCommand('vscode-ext-test', args, outputFile, envOverrides);
		const runDir = artifactDirFromOutput(result.combinedOutput, testCase.profile, testCase.testId);
		const artifacts = summarizeArtifacts(runDir);
		const resultFailed = result.status !== 0 || (artifacts.results?.totalFailed || 0) > 0;
		const allowedFailure = testCase.quarantine?.mode === 'allowed-failure';
		const status = resultFailed ? (allowedFailure ? 'allowed-failure' : 'failed') : 'passed';

		runRecords.push({
			...testCase,
			status,
			allowedFailure,
			exitCode: result.status,
			error: result.error,
			durationMs: result.durationMs,
			completedAt: new Date().toISOString(),
			runDir,
			workspaceSettingsPath: preparedWorkspace ? preparedWorkspace.settingsPath : '',
			reportPath: artifacts.reportPath,
			screenshots: artifacts.screenshots,
			failureScreenshots: artifacts.failureScreenshots,
			outputChannels: artifacts.outputChannels,
			failures: artifacts.failures,
			commandOutput: outputFile,
		});

		if (testCase.profile !== 'default') {
			const residues = listProfileResidue(testCase.profile);
			if (residues.length > 0) {
				const repaired = options.repairProfileResidue ? repairProfileResidue(residues, path.join(residueBackupRoot, 'post-run', testCase.profile, testCase.testId)) : [];
				profileResidueRecords.push(profileResidueRecord(testCase.profile, `post-run:${testCase.testId}`, residues, options.allowProfileResidue ? 'warning' : 'failure', repaired));
			}
		}
	}

	const ledger = updateLedger(options.outputDir, runRecords);
	const summary = summarizeSuite({
		runStartedAt,
		completedAt: new Date().toISOString(),
		options,
		cases,
		excludedScreenshotGenerators,
		runRecords,
		quarantineErrors: quarantine.validationErrors,
		profileResidueRecords,
		ledger,
	});
	writeSummaryFiles(options.outputDir, suiteOutputDir, summary);
	console.log(toMarkdown(summary));
	process.exit(options.allowFailures || !shouldFailSuite(summary) ? 0 : 1);
}

function writeSummaryFiles(outputRoot, suiteOutputDir, summary) {
	const markdown = toMarkdown(summary);
	writeJson(path.join(suiteOutputDir, 'summary.json'), summary);
	writeFileSync(path.join(suiteOutputDir, 'summary.md'), markdown, 'utf8');
	writeJson(path.join(outputRoot, 'latest-summary.json'), summary);
	writeFileSync(path.join(outputRoot, 'latest-summary.md'), markdown, 'utf8');
	appendHistory(outputRoot, summary);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}