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
