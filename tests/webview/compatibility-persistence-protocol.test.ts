import { describe, expect, it } from 'vitest';

import {
	COMPATIBILITY_PERSISTENCE_CHANNEL,
	COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION,
	parseCompatibilityPersistenceEnvelope,
	parseCompatibilityPersistenceHostMessage,
	parseCompatibilityPersistenceWebviewMessage,
	stampCompatibilityPersistenceHostMessage,
	stampCompatibilityPersistenceWebviewMessage,
} from '../../src/shared/compatibilityPersistenceProtocol.js';

const envelope = {
	protocolVersion: COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION,
	channel: COMPATIBILITY_PERSISTENCE_CHANNEL,
	viewSessionId: 'compatibility-session-1',
} as const;

const state = {
	sections: [{ id: 'compat_primary_query', type: 'query', query: 'print 1', future: { retained: true } }],
	futureRoot: 'retained',
} as const;

describe('compatibility persistence protocol', () => {
	it('runtime-validates every webview-to-host lifecycle message', () => {
		const messages = [
			{ ...envelope, type: 'requestDocument', requestId: 'document-request-1' },
			{
				...envelope, type: 'persistDocument', state, sourceGeneration: 3,
				editRevision: 4, snapshotId: 'snapshot-1', reason: 'edit',
			},
			{
				...envelope, type: 'persistDocument', state: { sections: [] }, sourceGeneration: 3,
				flushRequestId: 'final-1', flushUnavailableReason: 'restore-in-progress',
			},
			{
				...envelope, type: 'documentReloadResult', requestId: 'reload-1', applied: true,
				editRevision: 4, markdownCommandBarrierSupported: true,
			},
		] as const;

		for (const message of messages) {
			const parsed = parseCompatibilityPersistenceWebviewMessage(message);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value.type).toBe(message.type);
		}
	});

	it('runtime-validates every host-to-webview lifecycle message', () => {
		const messages = [
			{
				...envelope, type: 'documentData', ok: true, requestId: 'document-request-1',
				requestSource: 'webview',
				reloadRequestId: 'reload-1', sourceGeneration: 3, forceReload: true,
				documentUri: 'file:///tmp/query.kql', documentKind: 'kql', allowedSectionKinds: ['query'],
				firstSectionPinned: true, documentMutationAllowed: true, editRevision: 4, state,
				compatibilityMode: true, compatibilitySingleKind: 'query', defaultSectionKind: 'query',
				upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: 'Create a companion file.',
			},
			{
				...envelope, type: 'documentData', ok: false, requestId: 'document-request-2',
				requestSource: 'host',
				reloadRequestId: 'reload-2', sourceGeneration: 4, forceReload: true,
				documentUri: 'file:///tmp/query.kql', documentKind: 'kql', allowedSectionKinds: [],
				firstSectionPinned: false, documentMutationAllowed: false, error: 'Invalid companion.',
			},
			{ ...envelope, type: 'requestFinalPersist', requestId: 'final-1', reason: 'save' },
			{ ...envelope, type: 'persistDocumentAck', snapshotId: 'snapshot-1', editRevision: 4 },
		] as const;

		for (const message of messages) {
			const parsed = parseCompatibilityPersistenceHostMessage(message);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value.type).toBe(message.type);
		}
	});

	it('rejects malformed envelopes, correlations, revisions, booleans, and state containers', () => {
		expect(parseCompatibilityPersistenceEnvelope({ ...envelope, protocolVersion: '1' }).ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'requestDocument', requestId: '',
		}).ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'documentReloadResult', requestId: 'reload-1', applied: 'true', editRevision: 0,
		}).ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'persistDocument', state: null, sourceGeneration: 1,
			editRevision: 1, snapshotId: 'snapshot-1',
		}).ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'persistDocument', state: { sections: [
				{ id: 'compat_primary_sql', type: 'sql', query: 'select 1' },
			] }, sourceGeneration: 1, editRevision: 1, snapshotId: 'snapshot-wrong-primary',
		}, 'kql').ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'persistDocument', state: { sections: [
				{ id: 'compat_primary_query', type: 'query', query: 'print 1' },
				{ id: 'compat_primary_query', type: 'markdown', text: 'duplicate' },
			] }, sourceGeneration: 1, editRevision: 99, snapshotId: 'snapshot-duplicate',
		}, 'kql').ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'persistDocument', state, sourceGeneration: 1,
			editRevision: '1', snapshotId: 'snapshot-1',
		}).ok).toBe(false);
		expect(parseCompatibilityPersistenceWebviewMessage({
			...envelope, type: 'persistDocument', state: { sections: [] }, sourceGeneration: 1,
			flushRequestId: 'final-1', flushUnavailableReason: 'restore-in-progress', snapshotId: 'wrong',
		}).ok).toBe(false);
		expect(parseCompatibilityPersistenceHostMessage({
			...envelope, type: 'documentData', ok: true, requestId: 'request-1', reloadRequestId: 'reload-1',
			requestSource: 'webview',
			sourceGeneration: 1, forceReload: true, documentUri: 'file:///tmp/query.kql', documentKind: 'kql',
			allowedSectionKinds: ['query'], firstSectionPinned: true, documentMutationAllowed: true,
			editRevision: 0, state: { sections: [null] }, compatibilityMode: true,
			compatibilitySingleKind: 'query', defaultSectionKind: 'query',
			upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: '',
		}).ok).toBe(false);
		expect(parseCompatibilityPersistenceHostMessage({
			...envelope, type: 'documentData', ok: true, requestId: 'request-wrong-primary',
			requestSource: 'webview', reloadRequestId: 'reload-wrong-primary', sourceGeneration: 1,
			forceReload: true, documentUri: 'file:///tmp/query.kql', documentKind: 'kql',
			allowedSectionKinds: ['query'], firstSectionPinned: true, documentMutationAllowed: true,
			editRevision: 0, state: { sections: [
				{ id: 'compat_primary_sql', type: 'sql', query: 'select 1' },
			] }, compatibilityMode: true, compatibilitySingleKind: 'query', defaultSectionKind: 'query',
			upgradeRequestType: 'requestUpgradeToKqlx', compatibilityTooltip: '',
		}).ok).toBe(false);
	});

	it('preserves unknown state data and overwrites forged envelope fields while stamping', () => {
		const host = stampCompatibilityPersistenceHostMessage('host-session', {
			...envelope,
			viewSessionId: 'forged-session',
			type: 'persistDocumentAck', snapshotId: 'snapshot-1', editRevision: 2,
		});
		expect(host.ok && host.value.viewSessionId).toBe('host-session');

		const webview = stampCompatibilityPersistenceWebviewMessage('host-session', {
			type: 'persistDocument', state, sourceGeneration: 2, editRevision: 3, snapshotId: 'snapshot-2',
		});
		expect(webview.ok && webview.value.viewSessionId).toBe('host-session');
		if (webview.ok && webview.value.type === 'persistDocument' && 'snapshotId' in webview.value) {
			expect(webview.value.state).toBe(state);
		}
	});
});