export const SQL_COPILOT_OUTPUT_ADMITTED_EVENT = 'kusto-workbench-sql-copilot-output-admitted';
export const SQL_COPILOT_REQUEST_RETIRED_EVENT = 'kusto-workbench-sql-copilot-request-retired';

export type SqlCopilotRequestRetiredDetail = Readonly<{
	boxId: string;
	sqlCopilotRequestId: string;
	reason: string;
}>;
