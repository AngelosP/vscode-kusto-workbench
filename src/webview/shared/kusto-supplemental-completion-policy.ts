export type KustoSupplementalCompletionPolicyInput = {
	hasModelUri: boolean;
	hasBoxId: boolean;
	hasPrimarySchema: boolean;
	primaryReady: boolean;
	schemaSignatureMatches: boolean;
	hasPendingWorkerUpdate: boolean;
	enhancementPending: boolean;
	missingCrossClusterCount: number;
};

export type KustoSupplementalCompletionPolicyDecision = {
	allow: boolean;
	reason: string;
};

export function decideKustoSupplementalCompletionPolicy(input: KustoSupplementalCompletionPolicyInput): KustoSupplementalCompletionPolicyDecision {
	if (!input.hasModelUri || !input.hasBoxId) {
		return { allow: false, reason: 'missing-model-or-box' };
	}
	if (!input.hasPrimarySchema) {
		return { allow: true, reason: 'no-primary-schema' };
	}
	if (!input.primaryReady) {
		return { allow: true, reason: 'primary-not-ready' };
	}
	if (!input.schemaSignatureMatches) {
		return { allow: true, reason: 'schema-signature-mismatch' };
	}
	if (input.hasPendingWorkerUpdate) {
		return { allow: true, reason: 'pending-worker-update' };
	}
	if (input.enhancementPending) {
		return { allow: true, reason: 'enhancement-pending' };
	}
	if (input.missingCrossClusterCount > 0) {
		return { allow: true, reason: 'cross-cluster-not-ready' };
	}
	return { allow: false, reason: 'worker-ready' };
}
