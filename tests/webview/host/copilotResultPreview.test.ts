import { describe, expect, it } from 'vitest';
import { formatQueryResultForCopilot } from '../../../src/host/copilotResultPreview';

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
});