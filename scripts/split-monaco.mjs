// One-time script to extract caret-docs and inline-completions from monaco.ts.
// Run with: node scripts/split-monaco.mjs
// Then delete split-monaco.mjs and split-monaco-analysis.mjs

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const modulesDir = join(root, 'src', 'webview', 'modules');
const monacoPath = join(modulesDir, 'monaco.ts');

const content = readFileSync(monacoPath, 'utf8');
const lines = content.split('\n');
const total = lines.length;

// ──────────────────────────────────────────────────────────────────────
// Find section boundaries
// ──────────────────────────────────────────────────────────────────────
let caretStart = 0, caretEnd = 0;   // KUSTO_KEYWORD_DOCS → before setMonarchTokensProvider
let inlineStart = 0, inlineEnd = 0; // inline completions block

for (let i = 0; i < total; i++) {
	const line = lines[i];
	if (!caretStart && /const KUSTO_KEYWORD_DOCS:\s*Record/.test(line)) {
		caretStart = i + 1;
	}
	// Monarch tokenizer is the first thing AFTER the caret docs section
	if (caretStart && !caretEnd && /monaco\.languages\.setMonarchTokensProvider/.test(line)) {
		caretEnd = i; // exclusive (line before)
	}
	// Inline completions comment header
	if (!inlineStart && /--- Copilot inline completions Provider ---/.test(line)) {
		inlineStart = i + 1;
	}
	// End: find the registerInlineCompletionsProvider closing });
	if (inlineStart && !inlineEnd && /freeInlineCompletions/.test(line)) {
		for (let j = i + 1; j < Math.min(i + 10, total); j++) {
			if (/^\s+\}\);/.test(lines[j])) {
				inlineEnd = j + 1; // inclusive
				break;
			}
		}
	}
}

console.log(`Caret docs: L${caretStart}–L${caretEnd} (${caretEnd - caretStart} lines)`);
console.log(`Inline completions: L${inlineStart}–L${inlineEnd} (${inlineEnd - inlineStart + 1} lines)`);

if (!caretStart || !caretEnd || !inlineStart || !inlineEnd) {
	console.error('ERROR: Could not find section boundaries');
	process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────
// Helper: strip leading tabs (the code is 5-tab indented in require callback)
// ──────────────────────────────────────────────────────────────────────
function unindent(text, maxTabs = 5) {
	return text.split('\n').map(line => {
		let count = 0;
		let i = 0;
		while (i < line.length && line[i] === '\t' && count < maxTabs) {
			count++;
			i++;
		}
		return line.slice(i);
	}).join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// 1. Create monaco-caret-docs.ts
// ──────────────────────────────────────────────────────────────────────
const caretBody = unindent(lines.slice(caretStart - 1, caretEnd).join('\n'));

const caretFile = `// Caret documentation & hover providers — extracted from monaco.ts
// KQL keyword/function docs, control command docs, hover resolution.
// Call initCaretDocsDeps(monaco) from the require callback to provide the AMD reference.
import { postMessageToHost } from '../shared/webview-messages';

// Generated functions merge flag (shared with monaco-completions.ts via re-export from monaco.ts)
export let __kustoGeneratedFunctionsMerged = false;
export function setGeneratedFunctionsMerged(v: boolean) { __kustoGeneratedFunctionsMerged = v; }

// AMD reference — set via initCaretDocsDeps().
let _monacoRange: any = null;

${caretBody}

/** Inject the AMD-scoped monaco reference. Call once after require() resolves. */
export function initCaretDocsDeps(monacoRef: any) {
	_monacoRange = monacoRef ? monacoRef.Range : null;
}

// ── Public API ──
export { getHoverInfoAt, KUSTO_FUNCTION_DOCS, KUSTO_KEYWORD_DOCS };
export { findEnclosingFunctionCall, getTokenAtPosition, getMultiWordOperatorAt };
export { getWordRangeAt, computeArgIndex, buildFunctionSignatureMarkdown };
export { __kustoEnsureGeneratedFunctionsMerged };
export { KUSTO_CONTROL_COMMAND_DOCS_BASE_URL, KUSTO_CONTROL_COMMAND_DOCS_VIEW, __kustoControlCommands };
export { __kustoNormalizeControlCommand, __kustoBuildControlCommandIndex };
export { __kustoGetOrInitControlCommandDocCache, __kustoParseControlCommandSyntaxFromLearnHtml };
export { __kustoExtractWithOptionArgsFromSyntax, __kustoScheduleFetchControlCommandSyntax };
export { __kustoFindEnclosingWithOptionsParen, __kustoFindWithOptionsParenRange };
export { __kustoGetControlCommandHoverAt };
`;

writeFileSync(join(modulesDir, 'monaco-caret-docs.ts'), caretFile);
console.log('✓ monaco-caret-docs.ts written (' + caretFile.split('\n').length + ' lines)');

// Skip inline completions — too coupled to AMD require callback (registers provider at evaluation time)
// Keep in monaco.ts.

// ──────────────────────────────────────────────────────────────────────
// 2. Update monaco.ts — replace caret-docs section with import + init call
// ──────────────────────────────────────────────────────────────────────
const newLines = [...lines];

// Replace caret docs section with import call
const caretReplacement = [
	'\t\t\t\t\t// ── Caret docs loaded from monaco-caret-docs.ts ──',
	"\t\t\t\t\tinitCaretDocsDeps(monaco);",
].join('\n');
// Clear the extracted lines
for (let i = caretStart - 1; i < caretEnd; i++) {
	newLines[i] = null; // mark for removal
}
newLines[caretStart - 1] = caretReplacement;

// Build new content (filter out nulls)
let newContent = newLines.filter(l => l !== null).join('\n');

// Add imports at the top (after existing __kustoInitCompletionDeps import)
const importInsertionPoint = 'import { __kustoInitCompletionDeps } from \'./monaco-completions\';';
newContent = newContent.replace(
	importInsertionPoint,
	importInsertionPoint + '\n' +
	'import {\n' +
	'\tinitCaretDocsDeps,\n' +
	'\tgetHoverInfoAt, KUSTO_FUNCTION_DOCS, KUSTO_KEYWORD_DOCS,\n' +
	'\tfindEnclosingFunctionCall, getTokenAtPosition,\n' +
	'\tKUSTO_CONTROL_COMMAND_DOCS_BASE_URL, KUSTO_CONTROL_COMMAND_DOCS_VIEW, __kustoControlCommands,\n' +
	'} from \'./monaco-caret-docs\';'
);

// Update __kustoGeneratedFunctionsMerged to re-export from caret-docs
newContent = newContent.replace(
	/^export let __kustoGeneratedFunctionsMerged = false;\nexport function setGeneratedFunctionsMerged.*$/m,
	"// Re-export from monaco-caret-docs.ts (consumers import from './monaco')\nexport { __kustoGeneratedFunctionsMerged, setGeneratedFunctionsMerged } from './monaco-caret-docs';"
);

// Move __kustoControlCommandDocCache/Pending to re-export from caret-docs
newContent = newContent.replace(
	/^export let __kustoControlCommandDocCache: Record<string, any> = \{\};\nexport let __kustoControlCommandDocPending: Record<string, any> = \{\};/m,
	"export { __kustoControlCommandDocCache, __kustoControlCommandDocPending } from './monaco-caret-docs';"
);

writeFileSync(monacoPath, newContent);
const newLineCount = newContent.split('\\n').length;
console.log('✓ monaco.ts updated (' + newLineCount + ' lines, was ' + total + ')');
console.log('\\nManual fixup after running script:');
console.log('  1. Verify npx tsc --noEmit passes');
console.log('  2. Run npx vitest run');
