export class SqlQueryCancelledError extends Error {
	readonly isCancelled = true;

	constructor(message: string = 'Query cancelled') {
		super(message);
		this.name = 'SqlQueryCancelledError';
	}
}

export class SqlQueryExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqlQueryExecutionError';
	}
}