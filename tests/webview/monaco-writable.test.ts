import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	__kustoEnsureEditorWritableSoon,
	__kustoForceEditorWritable,
} from '../../src/webview/monaco/writable.js';
import { pState } from '../../src/webview/shared/persistence-state.js';

describe('Monaco writability guards', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		document.body.innerHTML = '';
		pState.documentMutationAllowed = true;
		delete (window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode;
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
		pState.documentMutationAllowed = true;
		delete (window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode;
	});

	it('keeps browser-capability-locked editors read-only without writable retries', () => {
		pState.documentMutationAllowed = false;
		(window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode = true;
		const editorDom = document.createElement('div');
		document.body.appendChild(editorDom);
		const updateOptions = vi.fn();
		const editor = {
			getDomNode: () => editorDom,
			updateOptions,
		};

		__kustoForceEditorWritable(editor);
		__kustoEnsureEditorWritableSoon(editor);

		expect(updateOptions).toHaveBeenCalled();
		expect(updateOptions.mock.calls.every(([options]) =>
			options.readOnly === true && options.domReadOnly === true)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('preserves a SQL comparison admission lock across delayed writable retries', () => {
		const section = document.createElement('kw-sql-section');
		section.setAttribute('data-sql-comparison-admission-pending', '');
		const editorDom = document.createElement('div');
		section.appendChild(editorDom);
		document.body.appendChild(section);
		const updateOptions = vi.fn();
		const editor = {
			getDomNode: () => editorDom,
			updateOptions,
		};

		__kustoForceEditorWritable(editor);
		__kustoEnsureEditorWritableSoon(editor);
		vi.runAllTimers();

		expect(updateOptions).toHaveBeenCalled();
		expect(updateOptions.mock.calls.every(([options]) =>
			options.readOnly === true && options.domReadOnly === true)).toBe(true);

		section.removeAttribute('data-sql-comparison-admission-pending');
		__kustoForceEditorWritable(editor);
		expect(updateOptions).toHaveBeenLastCalledWith({ readOnly: false, domReadOnly: false });
	});
});
