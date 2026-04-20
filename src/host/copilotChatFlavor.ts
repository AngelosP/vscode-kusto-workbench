/**
 * Flavor configuration for the copilot chat — captures all differences
 * between Kusto and SQL copilot so the rest of the system is generic.
 */

export type CopilotChatFlavorId = 'kusto' | 'sql';

export interface CopilotChatFlavor {
	readonly id: CopilotChatFlavorId;

	/** Human-readable role for the preamble, e.g. "senior KQL engineer". */
	readonly role: string;
	/** Language name used in prompts, e.g. "KQL" or "T-SQL". */
	readonly language: string;
	/** Relative path under `copilot-instructions/` to the rules file. */
	readonly rulesFileName: string;
	/** Whether this flavor supports development notes. */
	readonly supportsDevNotes: boolean;
	/** Whether this flavor supports query snapshot context. */
	readonly supportsQuerySnapshot: boolean;
	/** Whether this flavor supports the optimization comparison view. */
	readonly supportsOptimizationComparison: boolean;
	/** Whether this flavor supports inline completions. */
	readonly supportsInlineCompletions: boolean;
}

export const kustoCopilotFlavor: CopilotChatFlavor = {
	id: 'kusto',
	role: 'senior Kusto Query Language (KQL) engineer',
	language: 'KQL',
	rulesFileName: 'general-query-rules.md',
	supportsDevNotes: true,
	supportsQuerySnapshot: true,
	supportsOptimizationComparison: true,
	supportsInlineCompletions: true,
};

export const sqlCopilotFlavor: CopilotChatFlavor = {
	id: 'sql',
	role: 'senior T-SQL engineer',
	language: 'T-SQL',
	rulesFileName: 'sql-query-rules.md',
	supportsDevNotes: false,
	supportsQuerySnapshot: false,
	supportsOptimizationComparison: true,
	supportsInlineCompletions: true,
};

export function getCopilotFlavorById(id: CopilotChatFlavorId): CopilotChatFlavor {
	switch (id) {
		case 'kusto': return kustoCopilotFlavor;
		case 'sql': return sqlCopilotFlavor;
	}
}
