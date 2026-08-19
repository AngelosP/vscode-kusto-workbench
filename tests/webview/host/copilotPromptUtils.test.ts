import { describe, it, expect } from 'vitest';
import { getCopilotLocalTools } from '../../../src/host/copilotPromptUtils';

// ---------------------------------------------------------------------------
// getCopilotLocalTools
// ---------------------------------------------------------------------------

describe('getCopilotLocalTools', () => {
	it('returns an array of tools', () => {
		const tools = getCopilotLocalTools();
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.length).toBeGreaterThan(0);
	});

	it('includes expected tool names', () => {
		const tools = getCopilotLocalTools();
		const names = tools.map(t => t.name);
		expect(names).toContain('get_extended_schema');
		expect(names).toContain('execute_kusto_query');
		expect(names).toContain('respond_to_query_performance_optimization_request');
		expect(names).toContain('respond_to_all_other_queries');
		expect(names).toContain('ask_user_clarifying_question');
		expect(names).toContain('update_development_note');
		expect(names).toContain('search_cached_schemas');
		expect(names).toContain('get_query_optimization_best_practices');
	});

	it('all tools have required fields', () => {
		const tools = getCopilotLocalTools();
		for (const tool of tools) {
			expect(tool.name).toBeTruthy();
			expect(tool.label).toBeTruthy();
			expect(tool.description).toBeTruthy();
		}
	});

	it('all tools have enabledByDefault set to true', () => {
		const tools = getCopilotLocalTools();
		for (const tool of tools) {
			expect(tool.enabledByDefault).toBe(true);
		}
	});

	it('returns a new array on each call', () => {
		const a = getCopilotLocalTools();
		const b = getCopilotLocalTools();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});
});
