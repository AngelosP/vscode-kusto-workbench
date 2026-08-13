const transientNetworkPattern = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\bHTTP(?: status)?\s*(?:429|502|503|504)\b|@vscode\/test-electron request timeout out after \d+ms/i;
const vscodeDownloadPattern = /Downloading VS Code|Error downloading|update\.code\.visualstudio\.com/i;
const vscodeLaunchPattern = /Launching VS Code|VS Code launched|Extension Development Host/i;

export function selectE2eShard(cases, shardIndex, shardCount) {
	if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
		throw new Error('E2E shard count must be a positive integer.');
	}
	if (!Number.isSafeInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
		throw new Error(`E2E shard index must be between 1 and ${shardCount}.`);
	}
	return cases.filter((_testCase, index) => index % shardCount === shardIndex - 1);
}

export function shouldRetryVscodeBootstrapFailure({ status, output, hasStructuredResults = false }) {
	if (status === 0 || hasStructuredResults) return false;
	const text = String(output || '');
	return vscodeDownloadPattern.test(text)
		&& transientNetworkPattern.test(text)
		&& !vscodeLaunchPattern.test(text);
}