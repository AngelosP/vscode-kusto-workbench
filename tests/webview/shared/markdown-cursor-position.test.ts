import { describe, expect, it } from 'vitest';
import {
	getCodeMirrorCursorPosition,
	getDomSelectionCursorPosition,
	getMarkdownCursorPosition,
	getTextareaCursorPosition,
	offsetToMarkdownCursorPosition,
} from '../../../src/webview/shared/markdown-cursor-position';

describe('markdown cursor position helpers', () => {
	it('converts offsets to one-based line and column for LF and CRLF text', () => {
		expect(offsetToMarkdownCursorPosition('', 0)).toEqual({ line: 1, column: 1 });
		expect(offsetToMarkdownCursorPosition('abc', 2)).toEqual({ line: 1, column: 3 });
		expect(offsetToMarkdownCursorPosition('a\nbc', 3)).toEqual({ line: 2, column: 2 });
		expect(offsetToMarkdownCursorPosition('a\r\nbc', 3)).toEqual({ line: 2, column: 1 });
		expect(offsetToMarkdownCursorPosition('a\rbc', 2)).toEqual({ line: 2, column: 1 });
		expect(offsetToMarkdownCursorPosition('a\r\nbc', 99)).toEqual({ line: 2, column: 3 });
		expect(offsetToMarkdownCursorPosition('abc', -10)).toEqual({ line: 1, column: 1 });
		expect(offsetToMarkdownCursorPosition('abc', Number.NaN)).toEqual({ line: 1, column: 1 });
	});

	it('reads textarea cursor positions', () => {
		const root = document.createElement('div');
		const textarea = document.createElement('textarea');
		textarea.value = 'first\nsecond';
		textarea.selectionStart = 8;
		root.append(textarea);
		document.body.append(root);
		textarea.focus();

		expect(getTextareaCursorPosition(textarea)).toEqual({ line: 2, column: 3 });
		expect(getMarkdownCursorPosition(root)).toEqual({ line: 2, column: 3 });
		root.remove();
	});

	it('prefers CodeMirror cursor positions when available', () => {
		const root = document.createElement('div');
		const codeMirror = document.createElement('div') as HTMLDivElement & { CodeMirror?: { getCursor: () => { line: number; ch: number } } };
		codeMirror.className = 'CodeMirror';
		codeMirror.CodeMirror = { getCursor: () => ({ line: 2, ch: 4 }) };
		const textarea = document.createElement('textarea');
		textarea.value = 'wrong';
		textarea.selectionStart = 1;
		root.append(codeMirror, textarea);
		document.body.append(root);
		textarea.focus();

		expect(getCodeMirrorCursorPosition(root)).toEqual({ line: 3, column: 5 });
		expect(getMarkdownCursorPosition(root)).toEqual({ line: 3, column: 5 });

		codeMirror.CodeMirror = { getCursor: () => ({ line: Number.NaN, ch: 4 }) };
		expect(getCodeMirrorCursorPosition(root)).toBeNull();
		root.remove();
	});

	it('reads DOM selection cursor positions inside a root', () => {
		const root = document.createElement('div');
		root.append('hello');
		const second = document.createTextNode('\nworld');
		root.append(second);
		document.body.append(root);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		const range = document.createRange();
		range.setStart(second, 3);
		range.collapse(true);
		selection?.addRange(range);

		expect(getDomSelectionCursorPosition(root, selection)).toEqual({ line: 2, column: 3 });
		expect(getMarkdownCursorPosition(root)).toEqual({ line: 2, column: 3 });

		selection?.removeAllRanges();
		const rootRange = document.createRange();
		rootRange.setStart(root, 0);
		rootRange.collapse(true);
		selection?.addRange(rootRange);
		expect(getDomSelectionCursorPosition(root, selection)).toBeNull();
		selection?.removeAllRanges();
		root.remove();
	});

	it('returns null for missing or external selections', () => {
		const root = document.createElement('div');
		const outside = document.createTextNode('outside');
		document.body.append(root, outside);
		const selection = window.getSelection();
		selection?.removeAllRanges();

		expect(getDomSelectionCursorPosition(root, null)).toBeNull();
		expect(getDomSelectionCursorPosition(root, selection)).toBeNull();

		const range = document.createRange();
		range.setStart(outside, 2);
		range.collapse(true);
		selection?.addRange(range);
		expect(getDomSelectionCursorPosition(root, selection)).toBeNull();

		selection?.removeAllRanges();
		root.remove();
		outside.remove();
	});
});
