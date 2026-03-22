import { describe, it, expect } from 'vitest';
import {
	createEmptyKqlxFile,
	createEmptyKqlxOrMdxFile,
	parseKqlxText,
	stringifyKqlxFile,
	type KqlxFileV1
} from '../../../src/host/kqlxFormat';

describe('createEmptyKqlxFile', () => {
	it('returns kqlx file with kind, version 1, empty sections', () => {
		const file = createEmptyKqlxFile();
		expect(file.kind).toBe('kqlx');
		expect(file.version).toBe(1);
		expect(Array.isArray(file.state.sections)).toBe(true);
		expect(file.state.sections).toHaveLength(0);
	});
});

describe('createEmptyKqlxOrMdxFile', () => {
	it('kind kqlx → kind is kqlx', () => {
		const file = createEmptyKqlxOrMdxFile('kqlx');
		expect(file.kind).toBe('kqlx');
		expect(file.version).toBe(1);
		expect(file.state.sections).toEqual([]);
	});

	it('kind mdx → kind is mdx', () => {
		const file = createEmptyKqlxOrMdxFile('mdx');
		expect(file.kind).toBe('mdx');
		expect(file.version).toBe(1);
		expect(file.state.sections).toEqual([]);
	});
});

describe('parseKqlxText', () => {
	it('valid minimal JSON → ok: true', () => {
		const text = '{"kind":"kqlx","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('kqlx');
			expect(result.file.version).toBe(1);
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('empty string → ok: true with default empty kqlx file', () => {
		const result = parseKqlxText('');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('kqlx');
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('empty string with defaultKind mdx → ok: true with mdx kind', () => {
		const result = parseKqlxText('', { defaultKind: 'mdx' });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('mdx');
		}
	});

	it('invalid JSON (syntax error) → ok: false', () => {
		const result = parseKqlxText('{not valid json}');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('Invalid JSON');
		}
	});

	it('valid JSON but wrong kind → ok: false', () => {
		const text = '{"kind":"bad","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('kind');
		}
	});

	it('kind mdx accepted when allowedKinds includes mdx', () => {
		const text = '{"kind":"mdx","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'] });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('mdx');
		}
	});

	it('wrong version → ok: false', () => {
		const text = '{"kind":"kqlx","version":99,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('version');
		}
	});

	it('missing state → ok: false', () => {
		const text = '{"kind":"kqlx","version":1}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('state');
		}
	});

	it('sections not an array → treated as empty array', () => {
		const text = '{"kind":"kqlx","version":1,"state":{"sections":"oops"}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('root is not an object (e.g. array) → ok: false', () => {
		const result = parseKqlxText('[1,2,3]');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('root must be a JSON object');
		}
	});

	it('sections are preserved in parsed output', () => {
		const sections = [
			{ type: 'query', name: 'Q1', query: 'StormEvents | take 10' },
			{ type: 'markdown', title: 'Notes', text: 'Hello' }
		];
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } });
		const result = parseKqlxText(text);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.state.sections).toHaveLength(2);
			const q = result.file.state.sections[0] as any;
			expect(q.type).toBe('query');
			expect(q.name).toBe('Q1');
			expect(q.query).toBe('StormEvents | take 10');
			const md = result.file.state.sections[1] as any;
			expect(md.type).toBe('markdown');
			expect(md.title).toBe('Notes');
		}
	});
});

describe('stringifyKqlxFile', () => {
	it('output has 2-space indentation', () => {
		const file = createEmptyKqlxFile();
		const text = stringifyKqlxFile(file);
		expect(text).toContain('  "kind"');
	});

	it('output ends with newline', () => {
		const file = createEmptyKqlxFile();
		const text = stringifyKqlxFile(file);
		expect(text.endsWith('\n')).toBe(true);
	});

	it('round-trip: parse(stringify(createEmpty())) equals createEmpty()', () => {
		const original = createEmptyKqlxFile();
		const text = stringifyKqlxFile(original);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file).toEqual(original);
		}
	});

	it('round-trip with sections preserves all fields', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', name: 'Test', query: 'StormEvents | count', expanded: true },
					{ type: 'markdown', title: 'Notes', text: '# Hello' }
				]
			}
		};
		const text = stringifyKqlxFile(file);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file).toEqual(file);
		}
	});
});

describe('parseKqlxText edge cases', () => {
	it('whitespace-only text (spaces, tabs, newlines) → empty file with defaults', () => {
		const result = parseKqlxText('   \t\n  ');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('kqlx');
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('section-level extra fields are preserved through roundtrip', () => {
		const sections = [
			{ type: 'query', name: 'Q1', query: 'T | take 1', customField: 'preserved', metadata: { x: 42 } }
		];
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: { sections: sections as any }
		};
		const text = stringifyKqlxFile(file);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			const s = parsed.file.state.sections[0] as any;
			expect(s.customField).toBe('preserved');
			expect(s.metadata).toEqual({ x: 42 });
		}
	});

	it('root-level extra fields are NOT preserved (by design)', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [] },
			extraProp: 'should be dropped'
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect((parsed.file as any).extraProp).toBeUndefined();
		}
	});

	it('state-level extra fields beyond caretDocsEnabled are NOT preserved', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], customState: true }
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect((parsed.file.state as any).customState).toBeUndefined();
		}
	});

	it('caretDocsEnabled is preserved when true', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], caretDocsEnabled: true }
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file.state.caretDocsEnabled).toBe(true);
		}
	});

	it('caretDocsEnabled is omitted when not a boolean', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], caretDocsEnabled: 'yes' }
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file.state.caretDocsEnabled).toBeUndefined();
		}
	});

	it('unicode characters in query text survive roundtrip', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', name: '\u65e5\u672c\u8a9e\u30c6\u30b9\u30c8', query: 'T | where Name == "\u00fc\u00e4\u00f6\u00df\u20ac"' },
					{ type: 'markdown', title: '\u2603 \ud83d\ude80 Emoji', text: 'Hello \u4e16\u754c' }
				]
			}
		};
		const text = stringifyKqlxFile(file);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file).toEqual(file);
		}
	});

	it('stringifyKqlxFile output is valid JSON that can be parsed back', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', name: 'Q', query: 'T | take 1', resultJson: '{"rows":[]}' }
				]
			}
		};
		const text = stringifyKqlxFile(file);
		const reparsed = JSON.parse(text);
		expect(reparsed.kind).toBe('kqlx');
		expect(reparsed.version).toBe(1);
		expect(reparsed.state.sections).toHaveLength(1);
	});
});
