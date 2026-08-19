/**
 * Pure utility functions extracted from CopilotService (queryEditorCopilot.ts).
 *
 * Zero VS Code imports — can be unit-tested with Vitest.
 */

import type { CopilotLocalTool } from './queryEditorTypes';

// ---------------------------------------------------------------------------
// getCopilotLocalTools
// ---------------------------------------------------------------------------

export function getCopilotLocalTools(): CopilotLocalTool[] {
	return [
		{
			name: 'get_extended_schema',
			label: 'Get extended schema',
			description: 'Provides cached database schema (tables + columns) to improve query correctness.',
			enabledByDefault: true
		},
		{
			name: 'get_query_optimization_best_practices',
			label: 'Get query optimization best practices',
			description: 'Returns the extension\'s query optimization best practices document (optimize-query-rules.md).',
			enabledByDefault: true
		},
		{
			name: 'execute_kusto_query',
			label: 'Execute Kusto query and read results',
			description: 'Executes a KQL query against the connected cluster and returns the results for analysis.',
			enabledByDefault: true
		},
		{
			name: 'search_cached_schemas',
			label: 'Search cached schemas',
			description: 'Searches all cached database schemas for tables, columns, functions, or docstrings matching a regex pattern.',
			enabledByDefault: true
		},
		{
			name: 'respond_to_query_performance_optimization_request',
			label: 'Respond to query performance optimization or data comparison request',
			description:
				'Creates a comparison section with your proposed query, prettifies it, and runs both queries to compare performance and / or results.',
			enabledByDefault: true
		},
		{
			name: 'respond_to_all_other_queries',
			label: 'Respond to all other queries',
			description:
				'Returns a runnable query for all other requests. The extension will set it in the editor and run it.',
			enabledByDefault: true
		},
		{
			name: 'ask_user_clarifying_question',
			label: 'Ask user clarifying question',
			description:
				'Ask the user a clarifying question when you need more information to write the correct query.',
			enabledByDefault: true
		},
		{
			name: 'update_development_note',
			label: 'Update development note',
			description:
				'Create, update, or remove a development note. Use ONLY for non-obvious corrections, gotchas, schema hints, or clarifications that would prevent repeating mistakes. To remove a note, set content to empty.',
			enabledByDefault: true
		}
	];
}
// ---------------------------------------------------------------------------
// getSqlCopilotLocalTools
// ---------------------------------------------------------------------------

export function getSqlCopilotLocalTools(): CopilotLocalTool[] {
	return [
		{
			name: 'get_sql_schema',
			label: 'Get database schema',
			description: 'Provides the connected SQL database schema (tables + columns) to improve query correctness.',
			enabledByDefault: true
		},
		{
			name: 'get_query_optimization_best_practices',
			label: 'Get query optimization best practices',
			description: 'Returns the extension\'s SQL query optimization best practices document (optimize-sql-rules.md).',
			enabledByDefault: true
		},
		{
			name: 'execute_sql_query',
			label: 'Execute SQL query and read results',
			description: 'Executes a T-SQL query against the connected SQL server and returns the results (limited to 100 rows).',
			enabledByDefault: true
		},
		{
			name: 'respond_to_query_performance_optimization_request',
			label: 'Respond to query performance optimization or data comparison request',
			description:
				'Creates a comparison section with your proposed query and runs both queries to compare performance and / or results.',
			enabledByDefault: true
		},
		{
			name: 'respond_to_sql_query',
			label: 'Respond with final query',
			description:
				'Returns a runnable T-SQL query. The extension will set it in the editor and optionally run it.',
			enabledByDefault: true
		},
		{
			name: 'ask_user_clarifying_question',
			label: 'Ask user clarifying question',
			description:
				'Ask the user a clarifying question when you need more information to write the correct query.',
			enabledByDefault: true
		}
	];
}