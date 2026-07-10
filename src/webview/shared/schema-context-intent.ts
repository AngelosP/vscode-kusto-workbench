import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';

export type KustoSchemaContextIntent = Readonly<{
	generation: number;
	boxId: string;
	schemaKey: string;
	modelUri: string;
}>;

export class KustoSchemaContextIntentTracker {
	private generation = 0;
	private currentIntent: KustoSchemaContextIntent | null = null;

	claim(intent: Omit<KustoSchemaContextIntent, 'generation'>): KustoSchemaContextIntent {
		const next = Object.freeze({ generation: ++this.generation, ...intent });
		this.currentIntent = next;
		return next;
	}

	isCurrent(intent: KustoSchemaContextIntent | undefined): boolean {
		return !!intent && this.currentIntent?.generation === intent.generation;
	}

	clear(): void {
		this.generation++;
		this.currentIntent = null;
	}
}

export function canUseKustoDatabaseContextFastPath(args: {
	targetClusterUrl: string;
	trackedClusterUrl?: string | null;
	workerClusterUrl?: string | null;
}): boolean {
	const targetClusterKey = kustoClusterKey(args.targetClusterUrl);
	if (!targetClusterKey) return false;
	const workerClusterKey = kustoClusterKey(args.workerClusterUrl);
	if (workerClusterKey) return workerClusterKey === targetClusterKey;
	const trackedClusterKey = kustoClusterKey(args.trackedClusterUrl);
	return !!trackedClusterKey && trackedClusterKey === targetClusterKey;
}