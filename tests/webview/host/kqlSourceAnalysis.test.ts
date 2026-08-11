import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
	analyzeKqlSource,
	isKqlTabularNameInScope,
	resolveKqlLetSourceName
} from '../../../src/host/kqlLanguageService/sourceAnalysis';

describe('analyzeKqlSource', () => {
	it('returns one immutable offset-preserving analysis', () => {
		const text = [
			'let X = TableA;',
			'let Y = X;',
			'let F = (T:(id:long)) {',
			'    T',
			'    | where Message contains "join StringOnly;"',
			'    // | join CommentOnly on id',
			'};',
			'Y | join (TableB) on id'
		].join('\r\n');

		const analysis = analyzeKqlSource(text);

		expect(analysis.maskedText).toHaveLength(text.length);
		for (let offset = 0; offset < text.length; offset++) {
			if (text[offset] === '\r' || text[offset] === '\n') {
				expect(analysis.maskedText[offset]).toBe(text[offset]);
			}
		}
		expect(analysis.maskedText).not.toContain('StringOnly');
		expect(analysis.maskedText).not.toContain('CommentOnly');
		expect(analysis.statements).toHaveLength(4);
		expect(analysis.letBindings.map((binding) => [binding.name, binding.kind])).toEqual([
			['X', 'tabular'],
			['Y', 'tabular'],
			['F', 'function']
		]);
		expect(resolveKqlLetSourceName(analysis, 'Y')).toBe('TableA');
		expect(isKqlTabularNameInScope(analysis, 'T', text.indexOf('    T') + 4)).toBe(true);
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA', 'TableB']);
		for (const reference of analysis.physicalTableReferences) {
			expect(text.slice(reference.startOffset, reference.endOffset)).toBe(reference.name);
		}

		expect(Object.isFrozen(analysis)).toBe(true);
		expect(Object.isFrozen(analysis.statements)).toBe(true);
		expect(Object.isFrozen(analysis.statements[0])).toBe(true);
		expect(Object.isFrozen(analysis.letBindings)).toBe(true);
		expect(Object.isFrozen(analysis.tabularScopes)).toBe(true);
		expect(Object.isFrozen(analysis.physicalTableReferences)).toBe(true);
		expect(Object.isFrozen(analysis.physicalTableReferences[0])).toBe(true);
	});

	it('does not split on protected semicolons or blank lines', () => {
		const text = [
			'print ```first;',
			'',
			'second```;',
			'TableA | where Value == "x;y"'
		].join('\n');

		const analysis = analyzeKqlSource(text);
		expect(analysis.statements).toHaveLength(2);
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
	});

	it('resolves wrapped aliases and suppresses qualified, print, and stored-function aliases', () => {
		const text = [
			'let Wrapped = materialize(TableA | take 1);',
			"let Qualified = cluster('Remote').database('Db').AlreadyQualified;",
			'let Printed = print Value = 1;',
			'let Stored = StoredTabularFunction();',
			'Wrapped | union Qualified, Printed, Stored'
		].join('\n');

		const analysis = analyzeKqlSource(text);
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
		expect(resolveKqlLetSourceName(analysis, 'Wrapped')).toBe('TableA');
	});

	it('finds sources in every function body while excluding tabular parameters', () => {
		const text = [
			'let Zero = () { TableA | take 1 };',
			'let Scalar = (limit:long) { TableB | take limit };',
			'let Tabular = (T:(id:long)) {',
			'    let Local = TableC;',
			'    T | join (Local) on id | join (TableD) on id',
			'};',
			'Zero()'
		].join('\n');

		const analysis = analyzeKqlSource(text);
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableA',
			'TableB',
			'TableC',
			'TableD'
		]);
		expect(analysis.physicalTableReferences.some((reference) => reference.name === 'T')).toBe(false);
		expect(analysis.physicalTableReferences.some((reference) => reference.name === 'Local')).toBe(false);
	});

	it('finds every source-form and pipeline union operand', () => {
		const text = [
			'union kind=outer TableA, (TableB | take 1);',
			'TableC | union TableD, TableE'
		].join('\n');

		expect(analyzeKqlSource(text).physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableA',
			'TableB',
			'TableC',
			'TableD',
			'TableE'
		]);
	});

	it('masks ordinary, hidden, verbatim, and hidden-verbatim strings', () => {
		const text = [
			'TableA',
			"| where Message contains 'it\\'s join OrdinaryOnly on id'",
			'    or Message contains h"join HiddenOnly on id"',
			"    or Message contains @'join VerbatimOnly on id'",
			'    or Message contains H@"join HiddenVerbatimOnly on id"'
		].join('\n');

		const analysis = analyzeKqlSource(text);
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
		for (const name of ['OrdinaryOnly', 'HiddenOnly', 'VerbatimOnly', 'HiddenVerbatimOnly']) {
			expect(analysis.maskedText).not.toContain(name);
		}
	});

	it('never resolves a let source through a future declaration', () => {
		const text = [
			'let A = B;',
			'let B = TableB;',
			'A | take 1'
		].join('\n');
		const analysis = analyzeKqlSource(text);

		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['B', 'TableB']);
		expect(resolveKqlLetSourceName(analysis, 'A')).toBe('B');
		expect(resolveKqlLetSourceName(analysis, 'B')).toBe('TableB');
	});

	it('does not classify scalar parameters or scalar lets as table sources', () => {
		const text = [
			'let F = (limit:long) {',
			'    let adjusted = limit + 1;',
			'    TableA | take adjusted',
			'};',
			'F(10)'
		].join('\n');
		const analysis = analyzeKqlSource(text);

		expect(analysis.letBindings.find((binding) => binding.name === 'adjusted')?.kind).toBe('scalar');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
	});

	it('unwraps grouped materialize sources in aliases and union operands', () => {
		const text = [
			'let X = (materialize(TableA | take 1));',
			'X | union (materialize(TableB)), TableC'
		].join('\n');
		const analysis = analyzeKqlSource(text);

		expect(resolveKqlLetSourceName(analysis, 'X')).toBe('TableA');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableA',
			'TableB',
			'TableC'
		]);
	});

	it('resolves same-name lexical shadowing by binding identity', () => {
		const text = [
			'let X = TableA;',
			'let F = () {',
			'    let X = materialize(X);',
			'    X | take 1',
			'};',
			'F()'
		].join('\n');
		const analysis = analyzeKqlSource(text);
		const innerUseOffset = text.indexOf('    X | take 1') + 4;

		expect(resolveKqlLetSourceName(analysis, 'X', innerUseOffset)).toBe('TableA');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
	});

	it('applies one consistent skip policy to dot-command bodies', () => {
		const direct = ".create function F() { TableA | take 1 }";
		const aliased = ".create function F() { let X = TableA; X | take 1 }";

		expect(analyzeKqlSource(direct).physicalTableReferences).toEqual([]);
		expect(analyzeKqlSource(aliased).physicalTableReferences).toEqual([]);
	});

	it('treats source-form search as tabular but nonphysical', () => {
		const direct = 'search "needle"';
		const aliased = 'let Results = search "needle"; Results | take 1';

		expect(analyzeKqlSource(direct).physicalTableReferences).toEqual([]);
		const aliasedAnalysis = analyzeKqlSource(aliased);
		expect(aliasedAnalysis.letBindings[0].kind).toBe('tabular');
		expect(aliasedAnalysis.physicalTableReferences).toEqual([]);
	});

	it('keeps scalar literals, scalar parameters, and query parameters nonphysical', () => {
		const text = [
			'declare query_parameters(flag:bool = true);',
			'let literal = true;',
			'let fromQueryParameter = flag;',
			'let F = (limit:long, T:(id:long)) {',
			'    let fromScalarParameter = limit;',
			'    let fromTabularParameter = T;',
			'    fromTabularParameter | take fromScalarParameter',
			'};',
			'TableA | where Enabled == fromQueryParameter and Enabled == literal'
		].join('\n');
		const analysis = analyzeKqlSource(text);
		const kinds = new Map(analysis.letBindings.map((binding) => [binding.name, binding.kind]));

		expect(kinds.get('literal')).toBe('scalar');
		expect(kinds.get('fromQueryParameter')).toBe('scalar');
		expect(kinds.get('fromScalarParameter')).toBe('scalar');
		expect(kinds.get('fromTabularParameter')).toBe('tabular');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
	});

	it('keeps an entire management-command query payload outside physical references', () => {
		const semicolonPayload = '.set-or-append Target <| let n = 1; Source | take n';
		const blankLinePayload = [
			'.set-or-append Target <| let n = 1;',
			'',
			'Source | take n'
		].join('\n');

		expect(analyzeKqlSource(semicolonPayload).physicalTableReferences).toEqual([]);
		expect(analyzeKqlSource(blankLinePayload).physicalTableReferences).toEqual([]);
	});

	it('keeps blank-line-formatted management function bodies outside physical references', () => {
		const text = [
			'.create-or-alter function with (folder = "Tests")',
			'',
			'F()',
			'{',
			'    TableA | join (TableB) on Id',
			'}',
			'',
			'TableAfter | take 1'
		].join('\n');

		expect(analyzeKqlSource(text).physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableAfter'
		]);
	});

	it('excludes only command spans when commands appear after ordinary queries', () => {
		const ordinaryCommand = [
			'TableBefore | take 1;',
			'.show tables;',
			'TableAfter | take 1'
		].join('\n');
		const queryPayloadCommand = [
			'TableBefore | take 1;',
			'.set-or-append Target <| let n = 1;',
			'',
			'PayloadSource | take n'
		].join('\n');

		expect(analyzeKqlSource(ordinaryCommand).physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableBefore',
			'TableAfter'
		]);
		expect(analyzeKqlSource(queryPayloadCommand).physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableBefore'
		]);
	});

	it('collects physical sources inside scalar query wrappers', () => {
		const text = [
			'let cutoff = toscalar(TableA | summarize max(Value));',
			'TableB | where Value > cutoff'
		].join('\n');
		const analysis = analyzeKqlSource(text);

		expect(analysis.letBindings[0].kind).toBe('scalar');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA', 'TableB']);
	});

	it('classifies grouped tabular constructors and qualified expressions', () => {
		const text = [
			'let UnionRows = (union TableA, TableB);',
			'let SearchRows = (search "needle");',
			"let QualifiedRows = (cluster('Remote').database('Db').AlreadyQualified);",
			'UnionRows | union SearchRows, QualifiedRows, TableC'
		].join('\n');
		const analysis = analyzeKqlSource(text);
		const kinds = new Map(analysis.letBindings.map((binding) => [binding.name, binding.kind]));

		expect(kinds.get('UnionRows')).toBe('tabular');
		expect(kinds.get('SearchRows')).toBe('tabular');
		expect(kinds.get('QualifiedRows')).toBe('tabular');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableA',
			'TableB',
			'TableC'
		]);
	});

	it('uses the innermost parameter kind when names shadow', () => {
		const text = [
			'declare query_parameters(P:string);',
			'let Outer = (P:(id:long)) {',
			'    let Inner = (P:long) {',
			'        let ScalarValue = P;',
			'        TableA | take ScalarValue',
			'    };',
			'    let Rows = P;',
			'    Rows | take 1',
			'};',
			'Outer(TableA)'
		].join('\n');
		const analysis = analyzeKqlSource(text);
		const kinds = new Map(analysis.letBindings.map((binding) => [binding.name, binding.kind]));

		expect(kinds.get('ScalarValue')).toBe('scalar');
		expect(kinds.get('Rows')).toBe('tabular');
		expect(analysis.physicalTableReferences.map((reference) => reference.name)).toEqual(['TableA']);
	});

	it('bounds union operands to their nested statement', () => {
		const text = 'let F = () { let U = union TableA, TableB; print X = 1, Y = 2 }; F()';

		expect(analyzeKqlSource(text).physicalTableReferences.map((reference) => reference.name)).toEqual([
			'TableA',
			'TableB'
		]);
	});

	it('bounds a nested union before outer join keys', () => {
		const text = 'Base | join (union TableA, TableB) on Key1, Key2';

		expect(analyzeKqlSource(text).physicalTableReferences.map((reference) => reference.name)).toEqual([
			'Base',
			'TableA',
			'TableB'
		]);
	});

	it('does not expose wildcard table patterns as partial references', () => {
		expect(analyzeKqlSource('union Events*').physicalTableReferences).toEqual([]);
	});

	it('is the sole scanner consumed by diagnostics, references, and schema inference', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string): string => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8'
		);
		const serviceSource = readSource('src/host/kqlLanguageService/service.ts');
		const inferenceSource = readSource('src/host/kqlSchemaInference.ts');
		const qualificationSource = readSource('src/webview/core/section-factory.ts');

		expect(serviceSource).toContain('return analyzeKqlSource(text).physicalTableReferences.map');
		expect(serviceSource).toContain('const analysis = analyzeKqlSource(text);');
		expect(serviceSource).toContain('for (const reference of analysis.physicalTableReferences)');
		expect(inferenceSource).toContain('const analysis = analyzeKqlSource(queryText);');
		expect(inferenceSource).not.toContain('new KqlLanguageService');
		for (const source of [serviceSource, inferenceSource]) {
			expect(source).not.toContain('stripCommentsAndStringsBestEffort');
			expect(source).not.toContain('maskCommentsPreserveLayout');
			expect(source).not.toContain('buildCommentRanges');
			expect(source).not.toContain('extractJoinOrLookupRightTable');
		}
		expect(qualificationSource).not.toContain('Fallback: previous best-effort lexer');
		expect(qualificationSource).not.toContain('const isIdentChar =');
	});
});
