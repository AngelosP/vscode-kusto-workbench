import { hasKustoEditorLifecycleIdentity } from '../../shared/kustoSchemaLifecycle.js';
import type { KustoEditorSchemaCoordinator } from './kusto-editor-schema-coordinator.js';

export type KustoSchemaDeliveryAdmission = 'synthetic' | 'editor' | 'legacy' | 'rejected';

type KustoDeliveryMessage = Readonly<Record<string, unknown>>;

function stringField(message: KustoDeliveryMessage, key: string): string {
	return String(message[key] || '').trim();
}

function classifyOwner(
	message: KustoDeliveryMessage,
	coordinator: KustoEditorSchemaCoordinator,
	synthetic: boolean,
): { kind: Exclude<KustoSchemaDeliveryAdmission, 'editor'>; boxId: string } | {
	kind: 'editor';
	boxId: string;
} {
	const boxId = stringField(message, 'boxId');
	if (synthetic) return { kind: 'synthetic', boxId };
	const current = coordinator.getIdentity(boxId);
	if (!current) {
		return { kind: hasKustoEditorLifecycleIdentity(message) ? 'rejected' : 'legacy', boxId };
	}
	if (!hasKustoEditorLifecycleIdentity(message)) return { kind: 'rejected', boxId };
	return { kind: 'editor', boxId };
}

export function admitKustoDatabaseDelivery(
	message: KustoDeliveryMessage,
	coordinator: KustoEditorSchemaCoordinator,
	synthetic: boolean = false,
): KustoSchemaDeliveryAdmission {
	const owner = classifyOwner(message, coordinator, synthetic);
	if (owner.kind !== 'editor') return owner.kind;
	const requestToken = stringField(message, 'requestToken');
	return requestToken && coordinator.isDatabaseRequestCurrent(
		owner.boxId,
		{
			sectionInstanceId: stringField(message, 'sectionInstanceId'),
			targetGeneration: Number(message.targetGeneration),
		},
		stringField(message, 'connectionId'),
		requestToken,
	) ? 'editor' : 'rejected';
}

export function admitKustoSchemaDelivery(
	message: KustoDeliveryMessage,
	coordinator: KustoEditorSchemaCoordinator,
	synthetic: boolean = false,
): KustoSchemaDeliveryAdmission {
	const owner = classifyOwner(message, coordinator, synthetic);
	if (owner.kind !== 'editor') return owner.kind;
	const requestToken = stringField(message, 'requestToken');
	return requestToken && coordinator.isSchemaRequestCurrent(
		owner.boxId,
		{
			sectionInstanceId: stringField(message, 'sectionInstanceId'),
			targetGeneration: Number(message.targetGeneration),
		},
		{
			connectionId: stringField(message, 'connectionId'),
			database: stringField(message, 'database'),
		},
		requestToken,
	) ? 'editor' : 'rejected';
}