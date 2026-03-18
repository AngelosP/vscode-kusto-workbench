import * as assert from 'assert';
import {
	createEmptyKqlxFile,
	createEmptyKqlxOrMdxFile,
	parseKqlxText,
	stringifyKqlxFile,
	KqlxFileV1
} from '../../src/host/kqlxFormat';

suite('createEmptyKqlxFile', () => {
	test('returns kqlx file with kind, version 1, empty sections', () => {
		const file = createEmptyKqlxFile();
		assert.strictEqual(file.kind, 'kqlx');
		assert.strictEqual(file.version, 1);
		assert.ok(Array.isArray(file.state.sections));
		assert.strictEqual(file.state.sections.length, 0);
	});
});

suite('createEmptyKqlxOrMdxFile', () => {
	test('kind kqlx → kind is kqlx', () => {
		const file = createEmptyKqlxOrMdxFile('kqlx');
		assert.strictEqual(file.kind, 'kqlx');
		assert.strictEqual(file.version, 1);
		assert.deepStrictEqual(file.state.sections, []);
	});

	test('kind mdx → kind is mdx', () => {
		const file = createEmptyKqlxOrMdxFile('mdx');
		assert.strictEqual(file.kind, 'mdx');
		assert.strictEqual(file.version, 1);
		assert.deepStrictEqual(file.state.sections, []);
	});
});

suite('parseKqlxText', () => {
	test('valid minimal JSON → ok: true', () => {
		const text = '{"kind":"kqlx","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.file.kind, 'kqlx');
			assert.strictEqual(result.file.version, 1);
			assert.deepStrictEqual(result.file.state.sections, []);
		}
	});

	test('empty string → ok: true with default empty kqlx file', () => {
		const result = parseKqlxText('');
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.file.kind, 'kqlx');
			assert.deepStrictEqual(result.file.state.sections, []);
		}
	});

	test('empty string with defaultKind mdx → ok: true with mdx kind', () => {
		const result = parseKqlxText('', { defaultKind: 'mdx' });
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.file.kind, 'mdx');
		}
	});

	test('invalid JSON (syntax error) → ok: false', () => {
		const result = parseKqlxText('{not valid json}');
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes('Invalid JSON'));
		}
	});

	test('valid JSON but wrong kind → ok: false', () => {
		const text = '{"kind":"bad","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes('kind'));
		}
	});

	test('kind mdx accepted when allowedKinds includes mdx', () => {
		const text = '{"kind":"mdx","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'] });
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.file.kind, 'mdx');
		}
	});

	test('wrong version → ok: false', () => {
		const text = '{"kind":"kqlx","version":99,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes('version'));
		}
	});

	test('missing state → ok: false', () => {
		const text = '{"kind":"kqlx","version":1}';
		const result = parseKqlxText(text);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes('state'));
		}
	});

	test('sections not an array → treated as empty array', () => {
		const text = '{"kind":"kqlx","version":1,"state":{"sections":"oops"}}';
		const result = parseKqlxText(text);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.deepStrictEqual(result.file.state.sections, []);
		}
	});

	test('root is not an object (e.g. array) → ok: false', () => {
		const result = parseKqlxText('[1,2,3]');
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes('root must be a JSON object'));
		}
	});

	test('sections are preserved in parsed output', () => {
		const sections = [
			{ type: 'query', name: 'Q1', query: 'StormEvents | take 10' },
			{ type: 'markdown', title: 'Notes', text: 'Hello' }
		];
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } });
		const result = parseKqlxText(text);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.file.state.sections.length, 2);
			const q = result.file.state.sections[0] as any;
			assert.strictEqual(q.type, 'query');
			assert.strictEqual(q.name, 'Q1');
			assert.strictEqual(q.query, 'StormEvents | take 10');
			const md = result.file.state.sections[1] as any;
			assert.strictEqual(md.type, 'markdown');
			assert.strictEqual(md.title, 'Notes');
		}
	});
});

suite('stringifyKqlxFile', () => {
	test('output has 2-space indentation', () => {
		const file = createEmptyKqlxFile();
		const text = stringifyKqlxFile(file);
		assert.ok(text.includes('  "kind"'), 'should use 2-space indent');
	});

	test('output ends with newline', () => {
		const file = createEmptyKqlxFile();
		const text = stringifyKqlxFile(file);
		assert.ok(text.endsWith('\n'), 'should end with newline');
	});

	test('round-trip: parse(stringify(createEmpty())) equals createEmpty()', () => {
		const original = createEmptyKqlxFile();
		const text = stringifyKqlxFile(original);
		const parsed = parseKqlxText(text);
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.deepStrictEqual(parsed.file, original);
		}
	});

	test('round-trip with sections preserves all fields', () => {
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
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.deepStrictEqual(parsed.file, file);
		}
	});
});

suite('parseKqlxText edge cases', () => {
	test('whitespace-only text (spaces, tabs, newlines) → empty file with defaults', () => {
		const result = parseKqlxText('   \t\n  ');
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.file.kind, 'kqlx');
			assert.deepStrictEqual(result.file.state.sections, []);
		}
	});

	test('section-level extra fields are preserved through roundtrip', () => {
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
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			const s = parsed.file.state.sections[0] as any;
			assert.strictEqual(s.customField, 'preserved', 'extra section fields should survive roundtrip');
			assert.deepStrictEqual(s.metadata, { x: 42 }, 'nested extra fields should survive roundtrip');
		}
	});

	test('root-level extra fields are NOT preserved (by design)', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [] },
			extraProp: 'should be dropped'
		});
		const parsed = parseKqlxText(text);
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.strictEqual((parsed.file as any).extraProp, undefined, 'root extra fields should be dropped');
		}
	});

	test('state-level extra fields beyond caretDocsEnabled are NOT preserved', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], customState: true }
		});
		const parsed = parseKqlxText(text);
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.strictEqual((parsed.file.state as any).customState, undefined,
				'state extra fields should be dropped');
		}
	});

	test('caretDocsEnabled is preserved when true', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], caretDocsEnabled: true }
		});
		const parsed = parseKqlxText(text);
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.strictEqual(parsed.file.state.caretDocsEnabled, true);
		}
	});

	test('caretDocsEnabled is omitted when not a boolean', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], caretDocsEnabled: 'yes' }
		});
		const parsed = parseKqlxText(text);
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.strictEqual(parsed.file.state.caretDocsEnabled, undefined,
				'non-boolean caretDocsEnabled should be omitted');
		}
	});

	test('unicode characters in query text survive roundtrip', () => {
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
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.deepStrictEqual(parsed.file, file, 'unicode should be preserved through roundtrip');
		}
	});

	test('stringifyKqlxFile output is valid JSON that can be parsed back', () => {
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
		// Should not throw
		const reparsed = JSON.parse(text);
		assert.strictEqual(reparsed.kind, 'kqlx');
		assert.strictEqual(reparsed.version, 1);
		assert.strictEqual(reparsed.state.sections.length, 1);
	});
});
