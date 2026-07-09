import { describe, expect, it } from 'vitest';
import { decideKustoSupplementalCompletionPolicy, type KustoSupplementalCompletionPolicyInput } from '../../src/webview/shared/kusto-supplemental-completion-policy';

const ready: KustoSupplementalCompletionPolicyInput = {
	hasModelUri: true,
	hasBoxId: true,
	hasPrimarySchema: true,
	primaryReady: true,
	schemaSignatureMatches: true,
	hasPendingWorkerUpdate: false,
	enhancementPending: false,
	missingCrossClusterCount: 0,
};

describe('decideKustoSupplementalCompletionPolicy', () => {
	it('suppresses supplemental completions when worker/schema context is authoritative', () => {
		expect(decideKustoSupplementalCompletionPolicy(ready)).toEqual({ allow: false, reason: 'worker-ready' });
	});

	it('does not provide blind fallback when model or box is unavailable', () => {
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, hasModelUri: false })).toEqual({ allow: false, reason: 'missing-model-or-box' });
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, hasBoxId: false })).toEqual({ allow: false, reason: 'missing-model-or-box' });
	});

	it('allows fallback while primary schema is unavailable or not applied to the current model', () => {
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, hasPrimarySchema: false })).toEqual({ allow: true, reason: 'no-primary-schema' });
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, primaryReady: false })).toEqual({ allow: true, reason: 'primary-not-ready' });
	});

	it('allows fallback while worker state is stale or pending', () => {
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, schemaSignatureMatches: false })).toEqual({ allow: true, reason: 'schema-signature-mismatch' });
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, hasPendingWorkerUpdate: true })).toEqual({ allow: true, reason: 'pending-worker-update' });
	});

	it('allows fallback while deferred enhancement or cross-cluster schemas are still pending', () => {
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, enhancementPending: true })).toEqual({ allow: true, reason: 'enhancement-pending' });
		expect(decideKustoSupplementalCompletionPolicy({ ...ready, missingCrossClusterCount: 1 })).toEqual({ allow: true, reason: 'cross-cluster-not-ready' });
	});
});
