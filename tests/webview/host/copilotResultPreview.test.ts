import { describe, expect, it } from 'vitest';
import { formatQueryResultForCopilot, summarizeQueryResultForCopilot } from '../../../src/host/copilotResultPreview';

describe('formatQueryResultForCopilot', () => {
	it('formats object column descriptors and wrapped SQL cells', () => {
		const text = formatQueryResultForCopilot({
			columns: [{ name: 'BigValue', type: 'bigint' }, { name: 'NullValue', type: 'int' }],
			rows: [[
				{ display: '9007199254740993', full: '9007199254740993' },
				{ display: 'null', full: 'null', isNull: true },
			]],
			metadata: { cluster: 'sql://server', database: 'Db', executionTime: '1.000s' },
		});
		expect(text).toContain('BigValue\tNullValue');
		expect(text).toContain('9007199254740993\tnull');
		expect(text).not.toContain('[object Object]');
	});

	it('reports empty results without a table preview', () => {
		expect(formatQueryResultForCopilot({
			columns: [], rows: [], metadata: { cluster: '', database: '', executionTime: '' },
		})).toBe('Query returned no results.');
	});

	it('retains column context for an empty typed result', () => {
		expect(formatQueryResultForCopilot({
			columns: [{ name: 'Value', type: 'int' }], rows: [], metadata: {},
		})).toBe('Query returned no results.\nColumns:\nValue\n');
	});

	it('escapes control characters and bounds cells and total output', () => {
		const text = formatQueryResultForCopilot({
			columns: [{ name: 'Payload', type: 'string' }],
			rows: [[{ full: `line1\nline2\t${'x'.repeat(100)}` }], [{ full: 'second row' }]],
			metadata: {},
		}, 50, 20, 80);

		expect(text).toContain('line1\\nline2\\t');
		expect(text).toContain('[truncated]');
		expect(text.length).toBeLessThanOrEqual(112);
	});

	it('formats every Kusto result under one fair aggregate row cap', () => {
		const text = formatQueryResultForCopilot({
			columns: ['First'], rows: [[1], [2], [3]], metadata: { resultName: 'One' },
			additionalResults: {
				version: 1,
				sets: [{
					resultIndex: 1, columns: ['Second'], rows: [['a'], ['b'], ['c']],
					metadata: { resultName: 'Two' },
				}],
			},
		}, 4);

		expect(text).toContain('Result #1 - One');
		expect(text).toContain('Result #2 - Two');
		expect(text).toContain('1\n2');
		expect(text).toContain('a\nb');
		expect(text).not.toContain('\n3\n');
		expect(text).not.toContain('\nc\n');
	});

	it('summarizes multi-result batches while preserving single-result wording', () => {
		expect(summarizeQueryResultForCopilot({ columns: ['A'], rows: [[1]], metadata: {} }))
			.toBe('1 rows');
		expect(summarizeQueryResultForCopilot({
			columns: ['A'], rows: [[1]], metadata: {},
			additionalResults: { version: 1, sets: [{
				resultIndex: 1, columns: ['B'], rows: [[2], [3]], metadata: {},
			}] },
		})).toBe('2 result sets, 3 rows');
	});
});