import assert from 'node:assert/strict';
import test from 'node:test';

import {
	selectE2eShard,
	shouldRetryVscodeBootstrapFailure,
} from '../../scripts/e2e-full-suite-support.mjs';

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