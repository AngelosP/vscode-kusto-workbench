const transientNetworkPattern = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\bHTTP(?: status)?\s*(?:429|502|503|504)\b/i;
const vscodeDownloadPattern = /Downloading VS Code|Error downloading|update\.code\.visualstudio\.com/i;
const vscodeLaunchPattern = /Launching VS Code|VS Code launched|Extension Development Host/i;

export function shouldRetryVscodeBootstrapFailure({ status, output, hasStructuredResults = false }) {
	if (status === 0 || hasStructuredResults) return false;
	const text = String(output || '');
	return vscodeDownloadPattern.test(text)
		&& transientNetworkPattern.test(text)
		&& !vscodeLaunchPattern.test(text);
}