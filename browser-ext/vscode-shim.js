// Shim for acquireVsCodeApi() — replaces media/queryEditor/vscode.js in the web viewer.
// The extension's webview code uses `vscode.postMessage(...)` for all communication
// with the extension host. This least-privileged adapter implements only browser CSV
// downloads. The typed browser projection root supplies document presentation directly;
// unavailable host capabilities never receive synthetic responses.

window.__kustoReadOnlyMode = true;

const pendingArtifactCsvSaves = new Map();
const activeArtifactCsvExportIds = new Set();
const completedArtifactCsvExportIds = new Map();
const artifactCsvIntentTombstoneMs = 10 * 60_000;
const artifactCsvMaxActiveIntents = 8;
const artifactCsvMaxCompletedIntents = 256;

function completeArtifactCsvIntent(exportId) {
	activeArtifactCsvExportIds.delete(exportId);
	const previous = completedArtifactCsvExportIds.get(exportId);
	if (previous) clearTimeout(previous);
	if (!previous && completedArtifactCsvExportIds.size >= artifactCsvMaxCompletedIntents) {
		const oldest = completedArtifactCsvExportIds.entries().next().value;
		if (oldest) {
			clearTimeout(oldest[1]);
			completedArtifactCsvExportIds.delete(oldest[0]);
		}
	}
	const timer = setTimeout(function() {
		completedArtifactCsvExportIds.delete(exportId);
	}, artifactCsvIntentTombstoneMs);
	completedArtifactCsvExportIds.set(exportId, timer);
}

function csvDownloadName(value) {
	const name = String(value || '').trim() || 'results.csv';
	return /\.csv$/i.test(name) ? name : name + '.csv';
}

function downloadCsv(csv, suggestedFileName) {
	const filename = csvDownloadName(suggestedFileName);
	if (window.parent && window.parent !== window) {
		window.parent.postMessage({
			type: 'kusto-workbench-csv-download', csv: csv, filename: filename,
		}, '*');
		return;
	}
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	setTimeout(function() {
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}, 100);
}

function requestArtifactCsvData(message) {
	const exportId = String(message.requestId || '').trim();
	const boxId = String(message.boxId || '').trim();
	const artifactId = String(message.artifactId || '').trim();
	if (!exportId || !boxId || !artifactId || activeArtifactCsvExportIds.has(exportId)
		|| completedArtifactCsvExportIds.has(exportId)) return;
	if (activeArtifactCsvExportIds.size >= artifactCsvMaxActiveIntents) {
		completeArtifactCsvIntent(exportId);
		window.postMessage({ type: 'cancelArtifactCsvSave', exportId: exportId }, '*');
		return;
	}
	activeArtifactCsvExportIds.add(exportId);
	const requestId = 'browser-artifact-csv-' + (globalThis.crypto?.randomUUID?.()
		|| Date.now() + '-' + Math.random().toString(16).slice(2));
	const timer = setTimeout(function() {
		pendingArtifactCsvSaves.delete(requestId);
		completeArtifactCsvIntent(exportId);
		window.postMessage({ type: 'cancelArtifactCsvSave', exportId: exportId }, '*');
	}, 60_000);
	pendingArtifactCsvSaves.set(requestId, {
		exportId: exportId, boxId: boxId, artifactId: artifactId,
		suggestedFileName: message.suggestedFileName, timer: timer,
	});
	window.postMessage({
		type: 'requestArtifactCsvSaveData', requestId: requestId, exportId: exportId,
		boxId: boxId, artifactId: artifactId,
	}, '*');
}

function acceptArtifactCsvData(message) {
	const requestId = String(message.requestId || '').trim();
	const pending = pendingArtifactCsvSaves.get(requestId);
	if (!pending
		|| pending.boxId !== String(message.boxId || '').trim()
		|| pending.artifactId !== String(message.artifactId || '').trim()) return;
	pendingArtifactCsvSaves.delete(requestId);
	clearTimeout(pending.timer);
	completeArtifactCsvIntent(pending.exportId);
	if (message.accepted === true && typeof message.csv === 'string') {
		downloadCsv(message.csv, pending.suggestedFileName);
	}
}

function cancelArtifactCsvIntent(message) {
	const exportId = String(message.requestId || '').trim();
	let knownIntent = activeArtifactCsvExportIds.has(exportId);
	for (const [requestId, pending] of pendingArtifactCsvSaves) {
		if (pending.exportId !== exportId) continue;
		knownIntent = true;
		pendingArtifactCsvSaves.delete(requestId);
		clearTimeout(pending.timer);
	}
	if (knownIntent) completeArtifactCsvIntent(exportId);
}

const vscode = {
	postMessage: function(message) {
		// In read-only mode, intercept specific messages that we can handle in-browser.
		if (!message || typeof message !== 'object') return;

		if (message.type === 'requestArtifactCsvSave') {
			requestArtifactCsvData(message);
			return;
		}
		if (message.type === 'artifactCsvSaveData') {
			acceptArtifactCsvData(message);
			return;
		}
		if (message.type === 'cancelArtifactCsvSaveIntent') {
			cancelArtifactCsvIntent(message);
			return;
		}

		// Imported CSV and legacy bundles do not require artifact governance.
		if ((message.type === 'saveImportedCsv' || message.type === 'saveResultsCsv')
			&& typeof message.csv === 'string') {
			try {
				downloadCsv(message.csv, message.suggestedFileName || message.filename);
			} catch (e) {
				console.warn('[viewer] CSV download failed:', e);
			}
			return;
		}

		// Every other host capability is absent in the read-only browser projection.
	},
	getState: function() { return null; },
	setState: function() {}
};

// Make it available globally, same as acquireVsCodeApi() would.
window.vscode = vscode;
