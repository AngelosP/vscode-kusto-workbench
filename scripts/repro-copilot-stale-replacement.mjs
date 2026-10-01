import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

async function main() {
	const extensionRoot = process.argv[2];
	if (!extensionRoot) throw new Error('Usage: node scripts/repro-copilot-stale-replacement.mjs <copilot-extension-directory>');
	const bundlePath = path.join(extensionRoot, 'dist', 'extension.js');
	const bundle = readFileSync(bundlePath, 'utf8');
	const manifest = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
	const source = ts.createSourceFile(bundlePath, bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const printer = ts.createPrinter();
	let replacementBase;
	let replacementTool;
	const visit = node => {
		if (ts.isClassExpression(node) || ts.isClassDeclaration(node)) {
			const methods = new Map(node.members.filter(ts.isMethodDeclaration).map(member => [member.name.getText(source), member]));
			if (methods.has('prepareEdits') && methods.has('applyAllEdits')
				&& node.getText(source).includes('lastOperation')) replacementBase = methods;
			if (methods.has('extractReplaceInputs') && methods.has('invoke')
				&& node.members.some(member => ts.isClassStaticBlockDeclaration(member)
					&& member.getText(source).includes('"replace_string_in_file"'))) replacementTool = methods;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	assert.ok(replacementBase, 'Installed replacement-tool base was not found');
	assert.ok(replacementTool, 'Installed replace_string_in_file implementation was not found');
	const methods = [
		replacementBase.get('prepareEdits'), replacementBase.get('resolveInput'),
		replacementBase.get('applyAllEdits'), replacementTool.get('extractReplaceInputs'), replacementTool.get('invoke'),
	];
	assert.ok(methods.every(Boolean), 'Required installed tool methods are missing');
	const methodSource = methods.map(member => printer.printNode(ts.EmitHint.Unspecified, member, source)).join(',\n');
	const globals = {
		A$: () => {}, ar: Map, _r: class Snapshot {}, Ni: () => Promise.resolve(), Qh: class Location {},
		As: class ToolResult { constructor(content) { this.content = content; } },
		Zi: class TextPart { constructor(value) { this.value = value; } },
		lo: async () => '', FS: {},
	};
	const newline = '\r\n';
	const serialize = sections => JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2).replace(/\n/g, newline) + newline;
	const sections = Array.from({ length: 4 }, (_, index) => ({
		id: `query_${index}`, type: 'query', name: `Synthetic ${index}`, expanded: true,
		resultsVisible: true, query: `print Value=${index}`, resultJson: '{"columns":["Value"],"rows":[[1]]}',
	}));
	const initialText = serialize(sections);
	const positionAt = (text, offset) => {
		const starts = ts.computeLineStarts(text);
		const position = ts.computeLineAndCharacterOfPosition(starts, offset);
		return { line: position.line, character: position.character };
	};
	const offsetAt = (text, position) => {
		const starts = ts.computeLineStarts(text);
		if (position.line >= starts.length) return text.length;
		return starts[position.line] + position.character;
	};
	const originalRange = { start: positionAt(initialText, 0), end: positionAt(initialText, initialText.length) };
	const addedSection = { id: 'markdown_new', type: 'markdown', name: 'Synthetic note', text: '', expanded: true };
	const baseGrownText = serialize([...sections, addedSection]);
	const baseSuffixBytes = Buffer.byteLength(baseGrownText.slice(offsetAt(baseGrownText, originalRange.end), -newline.length));
	assert.ok(baseSuffixBytes < 65_311);
	addedSection.text = 'X'.repeat(65_311 - baseSuffixBytes);
	const grownText = serialize([...sections, addedSection]);
	const replacementRoot = grownText.slice(0, -newline.length);
	const suffix = grownText.slice(offsetAt(grownText, originalRange.end), -newline.length);
	assert.equal(Buffer.byteLength(suffix), 65_311);
	assert.ok(replacementRoot.endsWith(suffix));
	let currentText = initialText;
	let preparations = 0;
	let emittedEdits = 0;
	const uri = { toString: () => 'file:///synthetic.kqlx' };
	const stream = {
		markdown() {}, codeblockUri() {},
		textEdit(_uri, edit) {
			if (edit === true) return;
			const edits = Array.isArray(edit) ? edit : [edit];
			for (const replacement of [...edits].reverse()) {
				const start = offsetAt(currentText, replacement.range.start);
				const end = offsetAt(currentText, replacement.range.end);
				currentText = currentText.slice(0, start) + replacement.newText + currentText.slice(end);
				emittedEdits++;
			}
		},
	};
	const makeTool = () => {
		const tool = vm.runInNewContext(`({${methodSource}})`, globals, { filename: 'installed-copilot-replacement-methods.js' });
		Object.assign(tool, {
			logService: {}, instantiationService: {}, toolName: () => 'replace_string_in_file',
			languageDiagnosticsService: { getDiagnostics: () => [] },
			notebookService: { hasSupportedNotebooks: () => false },
			_prepareEdits: async (_options, inputs) => {
				preparations++;
				return inputs.map(input => {
					const offset = currentText.indexOf(input.oldString);
					return {
						uri, input, document: undefined,
						generatedEdit: offset < 0
							? { success: false, errorMessage: 'Exact source text is no longer present' }
							: { success: true, textEdits: [{
								range: { start: positionAt(currentText, offset), end: positionAt(currentText, offset + input.oldString.length) },
								newText: input.newString,
							}] },
					};
				});
			},
		});
		return tool;
	};
	const tool = makeTool();
	const input = { filePath: 'synthetic.kqlx', oldString: initialText, newString: replacementRoot };
	await tool.resolveInput(input, { stream, request: {}, requestId: 'prepare' });
	await tool.prepareEdits({ input, chatRequestId: 'prepare' }, {});
	currentText = grownText;
	const rounds = [];
	for (let round = 1; round <= 3; round++) {
		await tool.resolveInput(input, { stream, request: {}, requestId: `retry-${round}` });
		const result = await tool.invoke({ input, chatRequestId: `retry-${round}` }, {});
		assert.equal(result.hasError, false);
		assert.equal(currentText, replacementRoot + suffix.repeat(round) + newline);
		assert.throws(() => JSON.parse(currentText));
		rounds.push({ round, preparations, emittedEdits, suffixCopies: round, repeatedBytes: Buffer.byteLength(suffix) * round });
	}
	assert.equal(preparations, 1, 'Identical invocations unexpectedly re-read the changed file');
	const freshTool = makeTool();
	await freshTool.resolveInput(input, { stream, request: {}, requestId: 'fresh-control' });
	const freshResult = await freshTool.invoke({ input, chatRequestId: 'fresh-control' }, {});
	assert.equal(freshResult.hasError, true, 'Fresh preparation must notice that oldString is absent');
	assert.equal(emittedEdits, 3);
	const updatedInput = { ...input, oldString: currentText, newString: grownText };
	await tool.resolveInput(updatedInput, { stream, request: {}, requestId: 'updated-input-control' });
	const updatedResult = await tool.invoke({ input: updatedInput, chatRequestId: 'updated-input-control' }, {});
	assert.equal(updatedResult.hasError, false);
	assert.equal(currentText, grownText);
	assert.equal(JSON.parse(currentText).state.sections.length, 5);
	console.log(JSON.stringify({
		status: 'reproduced', copilotVersion: manifest.version,
		bundleSha256: createHash('sha256').update(bundle).digest('hex'),
		installedMethods: methods.map(member => member.name.getText(source)),
		adapters: 'In-memory exact-match preparation and unversioned text-edit stream; no real agent invocation or file writes',
		fixture: { targetSuffixBytes: 65_311, finalNewlineBytes: Buffer.byteLength(newline) },
		rounds, controls: { freshInstanceRepreparesAndExactMatchAdapterRejects: true, changedArgumentsReadCurrentText: true },
	}, null, 2));
	process.exitCode = 1;
}

main().catch(error => {
	console.error(error);
	process.exitCode = 2;
});