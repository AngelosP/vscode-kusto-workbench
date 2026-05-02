export interface MarkdownCursorPosition {
	line: number;
	column: number;
}

export function offsetToMarkdownCursorPosition(text: string, offset: number): MarkdownCursorPosition {
	const normalizedText = String(text);
	const safeOffset = Math.max(0, Math.min(Math.floor(Number.isFinite(offset) ? offset : 0), normalizedText.length));
	let line = 1;
	let lineStart = 0;

	for (let index = 0; index < safeOffset; index++) {
		const char = normalizedText.charAt(index);
		if (char === '\r') {
			line++;
			if (normalizedText.charAt(index + 1) === '\n' && index + 1 < safeOffset) {
				index++;
			}
			lineStart = index + 1;
		} else if (char === '\n') {
			line++;
			lineStart = index + 1;
		}
	}

	return { line, column: safeOffset - lineStart + 1 };
}

export function getTextareaCursorPosition(textarea: Pick<HTMLTextAreaElement, 'value' | 'selectionStart'>): MarkdownCursorPosition {
	return offsetToMarkdownCursorPosition(textarea.value, textarea.selectionStart);
}

export function getCodeMirrorCursorPosition(root: ParentNode): MarkdownCursorPosition | null {
	const codeMirrorElement = root.querySelector?.('.CodeMirror') as (Element & { CodeMirror?: unknown }) | null;
	const codeMirror = codeMirrorElement?.CodeMirror as { getCursor?: () => { line?: unknown; ch?: unknown } } | undefined;
	const cursor = codeMirror?.getCursor?.();
	if (!cursor || typeof cursor.line !== 'number' || typeof cursor.ch !== 'number' || !Number.isFinite(cursor.line) || !Number.isFinite(cursor.ch)) {
		return null;
	}
	return { line: Math.floor(cursor.line) + 1, column: Math.floor(cursor.ch) + 1 };
}

export function getDomSelectionCursorPosition(root: Node, selection: Selection | null): MarkdownCursorPosition | null {
	if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !root.contains(selection.anchorNode)) {
		return null;
	}

	let text = '';
	let offset = 0;
	let foundAnchor = false;
	const doc = root.ownerDocument as Document;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if (node === selection.anchorNode) {
			const anchorText = node.textContent as string;
			offset = text.length + Math.max(0, Math.min(selection.anchorOffset, anchorText.length));
			foundAnchor = true;
			break;
		}
		text += node.textContent as string;
		node = walker.nextNode();
	}

	if (!foundAnchor) {
		return null;
	}

	return offsetToMarkdownCursorPosition(text + (selection.anchorNode.textContent as string), offset);
}

export function getMarkdownCursorPosition(root: HTMLElement, selection: Selection | null = window.getSelection()): MarkdownCursorPosition | null {
	const codeMirrorPosition = getCodeMirrorCursorPosition(root);
	if (codeMirrorPosition) {
		return codeMirrorPosition;
	}
	const active = root.ownerDocument.activeElement;
	if (active instanceof HTMLTextAreaElement && root.contains(active)) {
		return getTextareaCursorPosition(active);
	}
	return getDomSelectionCursorPosition(root, selection);
}
