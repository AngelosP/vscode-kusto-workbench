/**
 * Shared utilities for extracting JavaScript functions/constants from source code.
 * Used by integration tests that run extracted code in a Node vm sandbox.
 *
 * Precondition: the source should have TypeScript annotations stripped before
 * calling these functions (e.g. remove `: any`, `as string`, etc.).
 */
import * as assert from 'assert';

// ── Shared brace-matching parser ──────────────────────────────────────────────

/**
 * Core brace-matching scanner.  Starts at `startIndex` (which must point to the
 * opening `{`) and scans forward until the matching `}` is found at depth 0.
 * Returns the index **one past** the closing `}`.
 *
 * Handles: line comments, block comments, regex literals, single-quoted strings
 * (with Kusto/SQL `''` escape), double-quoted strings, and template literals.
 */
function scanMatchingBrace(source: string, startIndex: number): number {
	let i = startIndex;
	let depth = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inSingle = false;
	let inDouble = false;
	let inTemplate = false;
	let inRegex = false;
	let inRegexCharClass = false;

	const isRegexStart = (pos: number): boolean => {
		// Heuristic: a '/' can start a regex literal when it appears after an operator/delimiter.
		for (let j = pos - 1; j >= 0; j--) {
			const c = source[j];
			if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue;
			return /[=({\[,:;!?&|+\-~*%<>]/.test(c);
		}
		return true;
	};

	for (; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inRegex) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (inRegexCharClass) {
				if (ch === ']') inRegexCharClass = false;
				continue;
			}
			if (ch === '[') {
				inRegexCharClass = true;
				continue;
			}
			if (ch === '/') {
				inRegex = false;
				continue;
			}
			continue;
		}
		if (inSingle) {
			if (ch === "'") {
				if (next === "'") {
					i++;
					continue;
				}
				inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (inTemplate) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '`') inTemplate = false;
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next !== '/' && next !== '*') {
			if (isRegexStart(i)) {
				inRegex = true;
				inRegexCharClass = false;
				continue;
			}
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '`') {
			inTemplate = true;
			continue;
		}

		if (ch === '{') {
			depth++;
			continue;
		}
		if (ch === '}') {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
			continue;
		}
	}

	return -1; // unbalanced
}


// ── Exported extraction functions ─────────────────────────────────────────────

/**
 * Extracts a `const name = (...) => { ... };` arrow function assignment.
 * Finds the `=>` after the const declaration, then scans the `{ ... }` body.
 */
export function extractConstAssignment(source: string, constName: string): string {
	const needle = `const ${constName} =`;
	const start = source.indexOf(needle);
	assert.ok(start >= 0, `Could not find '${needle}' in source`);

	const arrowIdx = source.indexOf('=>', start);
	assert.ok(arrowIdx >= 0, `Could not find '=>' for ${constName}`);

	const firstBrace = source.indexOf('{', arrowIdx);
	assert.ok(firstBrace >= 0, `Could not find '{' for ${constName}`);

	const endBrace = scanMatchingBrace(source, firstBrace);
	assert.ok(endBrace > 0, `Unbalanced braces while extracting ${constName}`);

	const endSemi = source.indexOf(';', endBrace);
	assert.ok(endSemi >= 0, `Could not find terminating ';' for ${constName}`);
	return source.slice(start, endSemi + 1);
}

/**
 * Extracts a `const name = { ... };` object literal assignment.
 * Finds the first `{` after the `=`, then scans to the matching `}`.
 */
export function extractConstObjectAssignment(source: string, constName: string): string {
	const needle = `const ${constName} =`;
	const start = source.indexOf(needle);
	assert.ok(start >= 0, `Could not find '${needle}' in source`);

	const eqIdx = source.indexOf('=', start);
	assert.ok(eqIdx >= 0, `Could not find '=' for ${constName}`);

	const firstBrace = source.indexOf('{', eqIdx);
	assert.ok(firstBrace >= 0, `Could not find '{' for ${constName}`);

	const endBrace = scanMatchingBrace(source, firstBrace);
	assert.ok(endBrace > 0, `Unbalanced braces while extracting ${constName}`);

	const endSemi = source.indexOf(';', endBrace);
	assert.ok(endSemi >= 0, `Could not find terminating ';' for ${constName}`);
	return source.slice(start, endSemi + 1);
}

/**
 * Extracts a general `const name = ...;` statement where the value may contain
 * nested parentheses, braces, and brackets.  Scans for the terminating `;` at
 * zero depth across all three bracket types.
 */
export function extractConstAssignmentStatement(source: string, constName: string): string {
	const needle = `const ${constName} =`;
	const start = source.indexOf(needle);
	assert.ok(start >= 0, `Could not find '${needle}' in source`);

	const eqIdx = source.indexOf('=', start);
	assert.ok(eqIdx >= 0, `Could not find '=' for ${constName}`);

	let i = eqIdx + 1;
	let depthParen = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inSingle = false;
	let inDouble = false;
	let inTemplate = false;
	let inRegex = false;
	let inRegexCharClass = false;

	const isRegexStart = (pos: number): boolean => {
		// Heuristic: a '/' can start a regex literal when it appears after an operator/delimiter.
		for (let j = pos - 1; j >= 0; j--) {
			const c = source[j];
			if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue;
			return /[=({\[,:;!?&|+\-~*%<>]/.test(c);
		}
		return true;
	};

	for (; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inRegex) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (inRegexCharClass) {
				if (ch === ']') inRegexCharClass = false;
				continue;
			}
			if (ch === '[') {
				inRegexCharClass = true;
				continue;
			}
			if (ch === '/') {
				inRegex = false;
				continue;
			}
			continue;
		}
		if (inSingle) {
			if (ch === "'") {
				if (next === "'") {
					i++;
					continue;
				}
				inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (inTemplate) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '`') inTemplate = false;
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next !== '/' && next !== '*') {
			if (isRegexStart(i)) {
				inRegex = true;
				inRegexCharClass = false;
				continue;
			}
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '`') {
			inTemplate = true;
			continue;
		}

		if (ch === '(') { depthParen++; continue; }
		if (ch === ')') { if (depthParen > 0) depthParen--; continue; }
		if (ch === '{') { depthBrace++; continue; }
		if (ch === '}') { if (depthBrace > 0) depthBrace--; continue; }
		if (ch === '[') { depthBracket++; continue; }
		if (ch === ']') { if (depthBracket > 0) depthBracket--; continue; }

		if (ch === ';' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
			return source.slice(start, i + 1);
		}
	}

	assert.fail(`Could not find terminating ';' for ${constName}`);
}
