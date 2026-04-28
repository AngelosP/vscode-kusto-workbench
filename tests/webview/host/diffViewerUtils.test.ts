import { describe, it, expect } from 'vitest';
import { formatKqlxForDiff, getDiffHtml, serializeForInlineScript } from '../../../src/host/diffViewerUtils';

// ---------------------------------------------------------------------------
// formatKqlxForDiff
// ---------------------------------------------------------------------------

describe('formatKqlxForDiff', () => {

	// ── Fallback behaviour ────────────────────────────────────────────────

	it('returns raw input for invalid JSON', () => {
		const raw = 'this is not json { broken';
		expect(formatKqlxForDiff(raw)).toBe(raw);
	});

	it('returns raw input for valid JSON that is not a kqlx file', () => {
		const raw = '{"hello": "world"}';
		expect(formatKqlxForDiff(raw)).toBe(raw);
	});

	// ── Empty file ────────────────────────────────────────────────────────

	it('produces a header for an empty kqlx file', () => {
		const raw = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } }, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('kqlx v1');
		expect(result).toContain('0 sections');
		expect(result).toContain('────');
	});

	it('produces a header for an empty string input', () => {
		// parseKqlxText('') returns an empty kqlx file.
		const result = formatKqlxForDiff('');
		expect(result).toContain('kqlx v1');
		expect(result).toContain('0 sections');
	});

	// ── Query section ─────────────────────────────────────────────────────

	it('renders a query section with multiline query text', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'query_1', type: 'query', name: 'My Query',
					clusterUrl: 'https://help.kusto.windows.net',
					database: 'Samples',
					query: 'StormEvents\n| where StartTime > ago(7d)\n| count',
					runMode: 'default',
					cacheEnabled: true, cacheValue: 5, cacheUnit: 'minutes',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);

		expect(result).toContain('══ [Kusto] My Query ══');
		expect(result).toContain('Cluster: https://help.kusto.windows.net');
		expect(result).toContain('Database: Samples');
		expect(result).toContain('Run mode: default | Cache: 5 minutes');
		// Raw query text — no JSON escaping.
		expect(result).toContain('StormEvents\n| where StartTime > ago(7d)\n| count');
		expect(result).toContain('1 section');
	});

	it('renders a query section with linked query path', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'query_1', type: 'query', name: 'Linked',
					linkedQueryPath: './queries/main.kql',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('Linked query: ./queries/main.kql');
	});

	it('renders a copilotQuery section as [Kusto]', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'query_2', type: 'copilotQuery', name: 'AI Query',
					query: 'print "hello"',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Kusto] AI Query ══');
		expect(result).toContain('print "hello"');
	});

	// ── Noise fields stripped ─────────────────────────────────────────────

	it('strips resultJson from output', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'query_1', type: 'query', name: 'Q1',
					query: 'T | count',
					resultJson: '{"rows":[[42]],"columns":[{"name":"Count","type":"long"}]}',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).not.toContain('resultJson');
		expect(result).not.toContain('"rows"');
	});

	it('strips pixel height and width fields', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'query_1', type: 'query', name: 'Q',
					query: 'T',
					editorHeightPx: 200, resultsHeightPx: 300,
					copilotChatWidthPx: 400,
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).not.toContain('200');
		expect(result).not.toContain('300');
		expect(result).not.toContain('400');
		expect(result).not.toContain('HeightPx');
		expect(result).not.toContain('WidthPx');
	});

	it('strips ephemeral UI state fields', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'query_1', type: 'query', name: 'Q',
					query: 'T',
					copilotChatVisible: true,
					resultsVisible: false,
					favoritesMode: true,
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).not.toContain('copilotChatVisible');
		expect(result).not.toContain('resultsVisible');
		expect(result).not.toContain('favoritesMode');
	});

	// ── Markdown section ──────────────────────────────────────────────────

	it('renders a markdown section with raw text', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'markdown_1', type: 'markdown', title: 'Notes',
					text: '# Heading\n\nSome *bold* text.',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Markdown] Notes ══');
		expect(result).toContain('# Heading');
		expect(result).toContain('Some *bold* text.');
	});

	// ── Python section ────────────────────────────────────────────────────

	it('renders a python section with raw code', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'python_1', type: 'python', name: 'Compute',
					code: 'import pandas as pd\ndf.head()',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Python] Compute ══');
		expect(result).toContain('import pandas as pd');
		expect(result).toContain('df.head()');
	});

	// ── HTML section ──────────────────────────────────────────────────────

	it('renders an html section', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'html_1', type: 'html', name: 'Widget',
					code: '<div>Hello</div>',
					mode: 'preview',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [HTML] Widget ══');
		expect(result).toContain('Mode: preview');
		expect(result).toContain('<div>Hello</div>');
	});

	// ── URL section ───────────────────────────────────────────────────────

	it('renders a url section', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'url_1', type: 'url', name: 'Dashboard',
					url: 'https://example.com/dashboard',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [URL] Dashboard ══');
		expect(result).toContain('https://example.com/dashboard');
	});

	// ── Chart section ─────────────────────────────────────────────────────

	it('renders a chart section with key-value config', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'chart_1', type: 'chart', name: 'My Chart',
					chartType: 'bar',
					dataSourceId: 'query_1',
					xColumn: 'State',
					yColumns: ['count_', 'total'],
					chartTitle: 'Storm Counts',
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Chart] My Chart ══');
		expect(result).toContain('Type: bar');
		expect(result).toContain('Data source: query_1');
		expect(result).toContain('X: State | Y: count_, total');
		expect(result).toContain('Title: Storm Counts');
	});

	// ── Transformation section ────────────────────────────────────────────

	it('renders a summarize transformation', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					id: 'transformation_1', type: 'transformation', name: 'Agg',
					transformationType: 'summarize',
					dataSourceId: 'query_1',
					groupByColumns: ['State', 'County'],
					aggregations: [
						{ column: 'DamageProperty', function: 'sum' },
						{ column: '*', function: 'count' },
					],
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Transformation] Agg ══');
		expect(result).toContain('Type: summarize');
		expect(result).toContain('Data source: query_1');
		expect(result).toContain('Group by: State, County');
		expect(result).toContain('sum(DamageProperty)');
		expect(result).toContain('count(*)');
	});

	// ── Devnotes section ──────────────────────────────────────────────────

	it('renders a devnotes section with entries', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [{
					type: 'devnotes',
					entries: [
						{ id: 'n1', created: '2026-04-01T00:00:00Z', updated: '2026-04-01T10:00:00Z', category: 'correction', content: 'Fixed column name', source: 'user' },
						{ id: 'n2', created: '2026-04-02T00:00:00Z', updated: '2026-04-02T00:00:00Z', category: 'schema-hint', content: 'Table uses datetime', source: 'copilot' },
					]
				}]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Dev Notes] ══');
		expect(result).toContain('[correction]');
		expect(result).toContain('Fixed column name');
		expect(result).toContain('[schema-hint]');
		expect(result).toContain('Table uses datetime');
	});

	// ── Mixed sections ────────────────────────────────────────────────────

	it('renders multiple section types with separators', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [
					{ id: 'query_1', type: 'query', name: 'Q1', query: 'T | count' },
					{ id: 'markdown_1', type: 'markdown', title: 'Notes', text: 'hello' },
					{ id: 'chart_1', type: 'chart', name: 'C1', chartType: 'line', dataSourceId: 'query_1' },
				]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [Kusto] Q1 ══');
		expect(result).toContain('══ [Markdown] Notes ══');
		expect(result).toContain('══ [Chart] C1 ══');
		expect(result).toContain('3 sections');
	});

	// ── mdx kind ──────────────────────────────────────────────────────────

	it('handles an mdx-kind file', () => {
		const raw = JSON.stringify({
			kind: 'mdx', version: 1,
			state: {
				sections: [
					{ id: 'markdown_1', type: 'markdown', text: 'doc content' },
				]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('mdx v1');
		expect(result).toContain('doc content');
	});

	// ── sqlx kind ─────────────────────────────────────────────────────────

	it('handles a sqlx-kind file', () => {
		const raw = JSON.stringify({
			kind: 'sqlx', version: 1,
			state: {
				sections: [
					{ id: 'sql_1', type: 'sql', name: 'My SQL', query: 'SELECT 1', serverUrl: 'myserver.database.windows.net', database: 'mydb' },
				]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('sqlx v1');
		expect(result).toContain('══ [SQL] My SQL ══');
		expect(result).toContain('Server: myserver.database.windows.net');
		expect(result).toContain('Database: mydb');
		expect(result).toContain('SELECT 1');
	});

	// ── SQL section inside a kqlx file ────────────────────────────────────

	it('formats sql section with server and database', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [
					{ id: 'sql_1', type: 'sql', name: 'Sales', query: 'SELECT * FROM Orders', serverUrl: 'sql.example.com', database: 'SalesDB' },
				]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('══ [SQL] Sales ══');
		expect(result).toContain('Server: sql.example.com');
		expect(result).toContain('Database: SalesDB');
		expect(result).toContain('SELECT * FROM Orders');
	});

	// ── Unknown section type ──────────────────────────────────────────────

	it('gracefully handles an unknown section type via JSON fallback', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [
					{ id: 'x_1', type: 'unknown_future', name: 'X', someProp: 42, resultJson: 'noise' },
				]
			}
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		// Should still have a header and not crash.
		expect(result).toContain('══ [unknown_future]');
		expect(result).toContain('"someProp": 42');
		// Noise stripped even in unknown sections.
		expect(result).not.toContain('resultJson');
	});

	// ── Determinism ───────────────────────────────────────────────────────

	it('produces identical output for identical input', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: {
				sections: [
					{ id: 'query_1', type: 'query', name: 'Q', query: 'T', clusterUrl: 'http://c', database: 'db' },
					{ id: 'chart_1', type: 'chart', name: 'C', chartType: 'bar', dataSourceId: 'query_1' },
				]
			}
		}, null, 2);
		const a = formatKqlxForDiff(raw);
		const b = formatKqlxForDiff(raw);
		expect(a).toBe(b);
	});

	// ── Collapsed section ─────────────────────────────────────────────────

	it('indicates collapsed state', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [{ id: 'query_1', type: 'query', name: 'Q', expanded: false }] }
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('Collapsed: yes');
	});

	// ── Caret docs disabled ───────────────────────────────────────────────

	it('shows caret docs: disabled when false', () => {
		const raw = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { caretDocsEnabled: false, sections: [] }
		}, null, 2);
		const result = formatKqlxForDiff(raw);
		expect(result).toContain('Caret docs: disabled');
	});
});

// ---------------------------------------------------------------------------
// Diff HTML inline script serialization
// ---------------------------------------------------------------------------

describe('serializeForInlineScript', () => {
 it('round-trips script-like content without raw script delimiters', () => {
  const dangerous = [
   '```html',
   '<script type="application/kw-provenance">',
   '{ "note": "</script> and </SCRIPT> and </script   >" }',
   '</script>',
   '```',
   '\u2028line separator\u2029paragraph separator',
  ].join('\n');

  const serialized = serializeForInlineScript(dangerous);

  expect(serialized).not.toMatch(/<script/i);
  expect(serialized).not.toMatch(/<\/script/i);
  expect(serialized).not.toContain('\u2028');
  expect(serialized).not.toContain('\u2029');
  expect(serialized).toContain('\\u003Cscript');
  expect(serialized).toContain('\\u2028');
  expect(serialized).toContain('\\u2029');
  expect(JSON.parse(serialized)).toBe(dangerous);
 });
});

describe('getDiffHtml', () => {
 const originalMarkdown = [
  '# Kusto Workbench Agent',
  '',
  '```html',
  '<script type="application/kw-provenance">',
  '{ "bindings": { "total": { "display": { "type": "scalar", "agg": "COUNT" } } } }',
  '</script>',
  '```',
 ].join('\n');

 const modifiedMarkdown = [
  '# Kusto Workbench Agent',
  '',
  '```html',
  '<SCRIPT type="application/kw-provenance">',
  '{ "bindings": { "total": { "display": { "type": "scalar", "agg": "COUNT" } } } }',
  '</SCRIPT>',
  '```',
 ].join('\n');

 it('keeps markdown script fences from terminating the bootstrap script', () => {
  const html = getDiffHtml({
   originalContent: originalMarkdown,
   modifiedContent: modifiedMarkdown,
   language: 'markdown',
   fileName: 'custom-agent.md',
  });

  expect(html.match(/<\/script\s*>/gi)).toHaveLength(2);
  expect(html).not.toContain('<script type="application/kw-provenance">');
  expect(html).not.toContain('</SCRIPT>');
  expect(html).toContain('\\u003Cscript type=\\"application/kw-provenance\\"');
 });

 it('keeps smart-view content from terminating the bootstrap script', () => {
  const html = getDiffHtml({
   originalContent: '{ "kind": "kqlx" }',
   modifiedContent: '{ "kind": "kqlx" }',
   originalSmart: originalMarkdown,
   modifiedSmart: modifiedMarkdown,
   language: 'json',
   fileName: 'dashboard.kqlx',
  });

  expect(html.match(/<\/script\s*>/gi)).toHaveLength(2);
  expect(html).not.toContain('<script type="application/kw-provenance">');
  expect(html).not.toContain('</SCRIPT>');
 });
});
