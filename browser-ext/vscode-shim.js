// Shim for acquireVsCodeApi() — replaces media/queryEditor/vscode.js in the web viewer.
// The extension's webview code uses `vscode.postMessage(...)` for all communication
// with the extension host. This least-privileged adapter implements only browser CSV
// downloads. The typed browser projection root supplies document presentation directly;
// unavailable host capabilities never receive synthetic responses.

import {
	admitArtifactCsvSaveWebviewMessage,
	parseArtifactCsvSaveHostMessage,
} from '../src/shared/artifactCsvSaveProtocol.js';

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

function postArtifactCsvHostMessage(message) {
	const parsed = parseArtifactCsvSaveHostMessage(message);
	if (!parsed.ok) return false;
	window.postMessage(parsed.value, '*');
	return true;
}

function requestArtifactCsvData(message) {
	const exportId = message.requestId;
	const boxId = message.boxId;
	const artifactId = message.artifactId;
	if (activeArtifactCsvExportIds.has(exportId)
		|| completedArtifactCsvExportIds.has(exportId)) return;
	if (activeArtifactCsvExportIds.size >= artifactCsvMaxActiveIntents) {
		completeArtifactCsvIntent(exportId);
		postArtifactCsvHostMessage({ type: 'cancelArtifactCsvSave', exportId: exportId });
		return;
	}
	const requestId = 'browser-artifact-csv-' + (globalThis.crypto?.randomUUID?.()
		|| Date.now() + '-' + Math.random().toString(16).slice(2));
	const challenge = parseArtifactCsvSaveHostMessage({
		type: 'requestArtifactCsvSaveData', requestId: requestId, exportId: exportId,
		boxId: boxId, artifactId: artifactId,
	});
	if (!challenge.ok) return;
	activeArtifactCsvExportIds.add(exportId);
	const timer = setTimeout(function() {
		pendingArtifactCsvSaves.delete(requestId);
		completeArtifactCsvIntent(exportId);
		postArtifactCsvHostMessage({ type: 'cancelArtifactCsvSave', exportId: exportId });
	}, 60_000);
	pendingArtifactCsvSaves.set(requestId, {
		exportId: exportId, boxId: boxId, artifactId: artifactId,
		suggestedFileName: message.suggestedFileName, timer: timer,
	});
	window.postMessage(challenge.value, '*');
}

function acceptArtifactCsvData(message) {
	const requestId = message.requestId;
	const pending = pendingArtifactCsvSaves.get(requestId);
	if (!pending
		|| pending.boxId !== message.boxId
		|| pending.artifactId !== message.artifactId) return;
	pendingArtifactCsvSaves.delete(requestId);
	clearTimeout(pending.timer);
	completeArtifactCsvIntent(pending.exportId);
	if (message.accepted === true && typeof message.csv === 'string') {
		downloadCsv(message.csv, pending.suggestedFileName);
	}
}

function cancelArtifactCsvIntent(message) {
	const exportId = message.requestId;
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
		const inputType = typeof message;
		if (!message || (inputType !== 'object' && inputType !== 'function')) return;
		const admission = admitArtifactCsvSaveWebviewMessage(message);
		if (admission.recognized) {
			if (!admission.parsed.ok) return;
			const governedMessage = admission.parsed.value;
			if (governedMessage.type === 'requestArtifactCsvSave') {
				requestArtifactCsvData(governedMessage);
			} else if (governedMessage.type === 'artifactCsvSaveData') {
				acceptArtifactCsvData(governedMessage);
			} else {
				cancelArtifactCsvIntent(governedMessage);
			}
			return;
		}
		if (inputType !== 'object') return;

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
