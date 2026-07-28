export type KustoEditorLifecycleIdentity = Readonly<{
	sectionInstanceId: string;
	targetGeneration: number;
}>;

export type KustoEditorSchemaTarget = Readonly<{
	connectionId: string;
	database?: string;
	connectionRevision?: number;
	connectionIdentityKey?: string;
}>;

export type KustoEditorSchemaRequestIdentity = KustoEditorLifecycleIdentity & Readonly<{
	boxId: string;
	requestToken: string;
}>;

export function hasKustoEditorLifecycleIdentity(
	value: unknown,
): value is KustoEditorLifecycleIdentity {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.sectionInstanceId === 'string'
		&& candidate.sectionInstanceId.length > 0
		&& Number.isSafeInteger(candidate.targetGeneration)
		&& Number(candidate.targetGeneration) >= 0;
}