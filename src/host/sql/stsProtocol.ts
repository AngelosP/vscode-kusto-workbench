export const STS_METHODS = {
	connect: 'connection/connect',
	connectComplete: 'connection/complete',
	cancelConnect: 'connection/cancelconnect',
	disconnect: 'connection/disconnect',
	listDatabases: 'connection/listdatabases',
	executeString: 'query/executeString',
	queryMessage: 'query/message',
	resultSetAvailable: 'query/resultSetAvailable',
	resultSetUpdated: 'query/resultSetUpdated',
	resultSetComplete: 'query/resultSetComplete',
	queryComplete: 'query/complete',
	querySubset: 'query/subset',
	queryCancel: 'query/cancel',
	queryDispose: 'query/dispose',
} as const;

export interface StsConnectionOptions {
	server: string;
	database: string;
	authenticationType: 'AzureMFA' | 'SqlLogin';
	azureAccountToken?: string;
	user?: string;
	password?: string;
	encrypt: 'Mandatory';
	trustServerCertificate: boolean;
	connectTimeout: number;
	commandTimeout?: number;
}

export interface StsConnectParams {
	ownerUri: string;
	connection: { options: StsConnectionOptions };
}

export interface StsConnectionCompleteParams {
	ownerUri: string;
	connectionId?: string;
	messages?: string;
	errorMessage?: string;
	errorNumber?: number;
}

export interface StsOwnerParams {
	ownerUri: string;
	type?: string;
}

export interface StsListDatabasesParams {
	ownerUri: string;
	includeDetails?: boolean;
}

export interface StsListDatabasesResponse {
	databaseNames?: string[];
	databases?: Array<{ name?: string; [key: string]: unknown }>;
}

export interface StsExecuteStringParams {
	ownerUri: string;
	query: string;
	getFullColumnSchema?: boolean;
}

export interface StsResultMessage {
	batchId?: number;
	isError?: boolean;
	time?: string;
	message?: string;
}

export interface StsQueryMessageParams {
	ownerUri: string;
	message?: StsResultMessage;
}

export interface StsColumnInfo {
	columnName?: string;
	dataTypeName?: string;
	isJson?: boolean;
	isVector?: boolean;
	isHierarchyId?: boolean;
	isBytes?: boolean;
	isXml?: boolean;
	[key: string]: unknown;
}

export interface StsDbCellValue {
	displayValue?: string;
	invariantCultureDisplayValue?: string;
	isNull?: boolean;
	rawObject?: unknown;
}

export interface StsResultSetSummary {
	id?: number;
	batchId?: number;
	rowCount?: number;
	complete?: boolean;
	columnInfo?: StsColumnInfo[];
	specialAction?: unknown;
}

export interface StsBatchSummary {
	id?: number;
	hasError?: boolean;
	executionElapsed?: string;
	resultSetSummaries?: StsResultSetSummary[];
}

export interface StsResultSetEventParams {
	ownerUri: string;
	resultSetSummary?: StsResultSetSummary;
}

export interface StsQueryCompleteParams {
	ownerUri: string;
	batchSummaries?: StsBatchSummary[];
	serverConnectionId?: string;
}

export interface StsSubsetParams {
	ownerUri: string;
	batchIndex: number;
	resultSetIndex: number;
	rowsStartIndex: number;
	rowsCount: number;
}

export interface StsResultSetSubset {
	rowCount?: number;
	rows?: StsDbCellValue[][];
}

export interface StsSubsetResult {
	resultSubset?: StsResultSetSubset;
	message?: string;
}