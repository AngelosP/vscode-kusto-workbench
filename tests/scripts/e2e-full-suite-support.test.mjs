import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRetryVscodeBootstrapFailure } from '../../scripts/e2e-full-suite-support.mjs';

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