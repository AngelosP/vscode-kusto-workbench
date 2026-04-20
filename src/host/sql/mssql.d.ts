/**
 * Ambient type declarations for the `mssql` npm package (v11+).
 *
 * These are minimal declarations covering only the APIs used by MssqlDialect.
 * The package is dynamically imported and externalized from esbuild.
 */
declare module 'mssql' {
	export interface config {
		server: string;
		port?: number;
		database?: string;
		user?: string;
		password?: string;
		options?: {
			encrypt?: boolean;
			trustServerCertificate?: boolean;
		};
		authentication?: {
			type: string;
			options?: Record<string, unknown>;
		};
		requestTimeout?: number;
		connectionTimeout?: number;
		[key: string]: unknown;
	}

	export interface IColumnMetadata {
		index: number;
		name: string;
		length: number;
		type: unknown;
		nullable: boolean;
		[key: string]: unknown;
	}

	export interface IRecordSet<T> extends Array<T> {
		columns: Record<string, IColumnMetadata>;
	}

	export interface IResult<T> {
		recordsets: IRecordSet<T>[];
		recordset: IRecordSet<T>;
		rowsAffected: number[];
		output: Record<string, unknown>;
	}

	export class Request {
		constructor(pool: ConnectionPool);
		timeout: number;
		query<T = Record<string, unknown>>(command: string): Promise<IResult<T>>;
	}

	export class ConnectionPool {
		constructor(config: config);
		config: config;
		connect(): Promise<this>;
		close(): Promise<void>;
		connected: boolean;
		request(): Request;
	}
}
