/**
 * Pure utility functions extracted from CopilotService (queryEditorCopilot.ts).
 *
 * Zero VS Code imports — can be unit-tested with Vitest.
 */

import type { CopilotLocalTool } from './queryEditorTypes';

// ---------------------------------------------------------------------------
// buildOptimizeQueryPrompt
// ---------------------------------------------------------------------------

export function buildOptimizeQueryPrompt(query: string): string {
	return `Role: You are a senior Kusto Query Language (KQL) performance engineer.

Task: Rewrite the KQL query below to improve performance while preserving **exactly** the same output rows and values (same schema, same grouping keys, same aggregations, same results).

Hard constraints:
- Do **not** change functionality, semantics, or returned results in any way.
- If you are not 100% sure a change is equivalent, **do not** make it.
- Keep the query readable and idiomatic KQL.

Optimization rules (apply in this order, as applicable):
1) Push the most selective filters as early as possible (ideally immediately after the table):
	- Highest priority: time filters and numeric/boolean filters
	- Next: fast string operators like \`has\`, \`has_any\`
	- Last: slower string operators like \`contains\`, regex
2) Consolidate transformations with \`summarize\` when equivalent:
	- If \`extend\` outputs are only used as \`summarize by\` keys or aggregates, move/inline them into \`summarize\` instead of carrying them earlier.
3) Project away unused columns early (especially before heavy operators):
	- Add \`project\` / \`project-away\` to reduce carried columns, but only if it cannot affect semantics.
	- For dynamic/JSON fields, prefer extracting only what is needed (and only when needed).
4) Replace \`contains\` with \`has\` only when it is guaranteed to be equivalent for the given literal and data (no false negatives/positives).

Output format:
- Return **ONLY** the optimized query in a single \`\`\`kusto\`\`\` code block.
- No explanation, no bullets, no extra text.

Original query:
\`\`\`kusto
${query}
\`\`\``;
}

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
