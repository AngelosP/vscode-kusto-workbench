import { describe, it, expect } from 'vitest';
import { buildOptimizeQueryPrompt, getCopilotLocalTools } from '../../../src/host/copilotPromptUtils';

// ---------------------------------------------------------------------------
// buildOptimizeQueryPrompt
// ---------------------------------------------------------------------------

describe('buildOptimizeQueryPrompt', () => {
	it('includes the query in a kusto code block', () => {
		const prompt = buildOptimizeQueryPrompt('T | take 10');
		expect(prompt).toContain('```kusto\nT | take 10\n```');
	});

	it('includes the role instruction', () => {
		const prompt = buildOptimizeQueryPrompt('T');
		expect(prompt).toContain('senior Kusto Query Language (KQL) performance engineer');
	});

	it('includes optimization rules', () => {
		const prompt = buildOptimizeQueryPrompt('T');
		expect(prompt).toContain('Push the most selective filters');
		expect(prompt).toContain('Consolidate transformations');
		expect(prompt).toContain('Project away unused columns');
	});

	it('includes the output format instruction', () => {
		const prompt = buildOptimizeQueryPrompt('T');
		expect(prompt).toContain('Return **ONLY** the optimized query');
	});

	it('handles multi-line queries', () => {
		const query = 'T\n| where x > 1\n| take 10';
		const prompt = buildOptimizeQueryPrompt(query);
		expect(prompt).toContain(query);
	});

	it('handles empty query', () => {
		const prompt = buildOptimizeQueryPrompt('');
		expect(prompt).toContain('```kusto\n\n```');
	});
});

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
