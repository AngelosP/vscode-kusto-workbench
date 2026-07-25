import { SyntheticRequestBroker } from './synthetic-request-broker.js';

export type SyntheticSchemaRequestMetadata = Readonly<{
	connectionId: string;
	database: string;
	schemaKey: string;
	accountPartition: string;
	connectionIdentity: string;
}>;

export type SyntheticDatabaseRequestMetadata = Readonly<{
	connectionId: string;
	accountPartition: string;
	connectionIdentity: string;
}>;

export const kustoSyntheticSchemaRequests = new SyntheticRequestBroker<unknown, SyntheticSchemaRequestMetadata>();
export const kustoSyntheticDatabaseRequests = new SyntheticRequestBroker<unknown[], SyntheticDatabaseRequestMetadata>();

export function isKustoSyntheticSchemaRequest(requestId: string): boolean {
	const id = String(requestId || '');
	return id.startsWith('__schema_req__') || kustoSyntheticSchemaRequests.isSynthetic(id);
}

export function isKustoSyntheticDatabaseRequest(requestId: string): boolean {
	const id = String(requestId || '');
	return id.startsWith('__kusto_dbreq__') || kustoSyntheticDatabaseRequests.isSynthetic(id);
}
