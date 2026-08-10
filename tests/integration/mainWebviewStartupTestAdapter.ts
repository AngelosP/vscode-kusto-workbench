import type * as vscode from 'vscode';
import {
	COMPATIBILITY_PERSISTENCE_CHANNEL,
	COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION,
	type CompatibilityPersistenceEnvelope,
} from '../../src/shared/compatibilityPersistenceProtocol';

const adaptedPanels = new WeakSet<object>();
const deferredPanels = new WeakSet<object>();
const adaptedCompatibilityPanels = new WeakSet<object>();
const compatibilityBootstrapByPanel = new WeakMap<object, CompatibilityPersistenceEnvelope>();
let compatibilityRequestSequence = 0;

export function deferMainWebviewReadyForTest(panel: vscode.WebviewPanel): void {
	deferredPanels.add(panel as object);
}

export function registerCompatibilityPersistenceTestBootstrap(
	panel: vscode.WebviewPanel,
	bootstrap: CompatibilityPersistenceEnvelope | undefined,
): void {
	if (!bootstrap) return;
	compatibilityBootstrapByPanel.set(panel as object, bootstrap);
}

export function getCompatibilityPersistenceTestBootstrap(
	panel: vscode.WebviewPanel,
): CompatibilityPersistenceEnvelope | undefined {
	return compatibilityBootstrapByPanel.get(panel as object);
}

export function adaptCompatibilityPersistenceTestPanel(panel: vscode.WebviewPanel): void {
	if (adaptedCompatibilityPanels.has(panel as object)) return;
	adaptedCompatibilityPanels.add(panel as object);
	let latestProjection: Record<string, unknown> | undefined;
	let observedEnvelope: CompatibilityPersistenceEnvelope | undefined;
	const webview = panel.webview as any;
	const originalPostMessage = webview.postMessage.bind(webview);
	webview.postMessage = async (message: any) => {
		if (message?.channel === COMPATIBILITY_PERSISTENCE_CHANNEL
			&& message?.protocolVersion === COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION
			&& typeof message?.viewSessionId === 'string') {
			observedEnvelope = {
				protocolVersion: COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION,
				channel: COMPATIBILITY_PERSISTENCE_CHANNEL,
				viewSessionId: message.viewSessionId,
			};
		}
		if (message?.type === 'documentData' && message?.ok === true) latestProjection = message;
		return originalPostMessage(message);
	};
	const originalOnDidReceiveMessage = webview.onDidReceiveMessage.bind(webview);
	webview.onDidReceiveMessage = (handler: (message: any) => unknown, ...args: any[]) =>
		originalOnDidReceiveMessage((message: any) => {
			const lifecycleType = message?.type === 'requestDocument'
				|| message?.type === 'persistDocument'
				|| message?.type === 'documentReloadResult';
			const hasExplicitEnvelope = message?.protocolVersion !== undefined
				|| message?.channel !== undefined
				|| message?.viewSessionId !== undefined;
			if (!lifecycleType || hasExplicitEnvelope) return handler(message);
			const envelope = compatibilityBootstrapByPanel.get(panel as object) ?? observedEnvelope;
			if (!envelope) return handler(message);

			let payload = message;
			if (message.type === 'requestDocument') {
				payload = {
					...message,
					requestId: typeof message.requestId === 'string' && message.requestId.trim()
						? message.requestId.trim()
						: `compat-test-request-${++compatibilityRequestSequence}`,
				};
			} else if (message.type === 'persistDocument') {
				const unavailable = message.flushUnavailableReason !== undefined;
				const state = normalizeCompatibilityTestState(message.state, latestProjection);
				payload = {
					...message,
					...(state ? { state } : {}),
					sourceGeneration: message.sourceGeneration ?? latestProjection?.sourceGeneration ?? 0,
					...(!unavailable ? {
						editRevision: message.editRevision ?? latestProjection?.editRevision ?? 0,
						snapshotId: message.snapshotId ?? `compat-test-snapshot-${++compatibilityRequestSequence}`,
					} : {}),
				};
			}
			return handler({ ...envelope, ...payload });
		}, ...args);
}

function normalizeCompatibilityTestState(
	state: unknown,
	latestProjection: Record<string, unknown> | undefined,
): unknown {
	if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
	const record = state as Record<string, unknown>;
	if (!Array.isArray(record.sections)) return state;
	const projectedSections = Array.isArray((latestProjection?.state as Record<string, unknown> | undefined)?.sections)
		? ((latestProjection!.state as Record<string, unknown>).sections as unknown[])
		: [];
	return {
		...record,
		sections: record.sections.map((section, index) => {
			if (!section || typeof section !== 'object' || Array.isArray(section)) return section;
			const item = section as Record<string, unknown>;
			if (typeof item.id === 'string' && item.id.trim()) return item;
			const projected = projectedSections[index];
			const projectedRecord = projected && typeof projected === 'object' && !Array.isArray(projected)
				? projected as Record<string, unknown>
				: undefined;
			const type = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'section';
			const projectedId = projectedRecord && projectedRecord.type === item.type
				? String(projectedRecord.id || '').trim()
				: '';
			return {
				...item,
				id: projectedId || `compat_${index + 1}_${type.replace(/[^a-z0-9_-]/gi, '_')}`,
			};
		}),
	};
}

export function adaptMainWebviewStartupTestPanel(panel: vscode.WebviewPanel): void {
	if (adaptedPanels.has(panel as object)) return;
	adaptedPanels.add(panel as object);
	const webview = panel.webview as any;
	const originalOnDidReceiveMessage = webview.onDidReceiveMessage.bind(webview);
	webview.onDidReceiveMessage = (handler: (message: any) => unknown, ...args: any[]) => {
		const subscription = originalOnDidReceiveMessage(handler, ...args);
		if (!deferredPanels.has(panel as object)) {
			queueMicrotask(() => {
				void Promise.resolve(handler({ type: 'mainWebviewDispatcherReady' })).catch(() => undefined);
			});
		}
		return subscription;
	};
}
