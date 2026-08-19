import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	executeQuery: vi.fn(),
	executeAllQueries: vi.fn(),
	hasTextFocus: vi.fn(() => true),
}));

vi.mock('../../src/webview/core/state.js', () => ({
	activeMonacoEditor: null,
	activeQueryEditorBoxId: 'query_1',
	setActiveQueryEditorBoxId: vi.fn(),
	queryEditors: {
		query_1: {
			hasTextFocus: mocks.hasTextFocus,
			hasWidgetFocus: () => false,
			focus: vi.fn(),
		},
	},
	caretDocOverlaysByBoxId: {},
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetQuerySectionElement: vi.fn(() => null),
}));

vi.mock('../../src/webview/monaco/writable.js', () => ({
	__kustoEnsureAllEditorsWritableSoon: vi.fn(),
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	executeQuery: mocks.executeQuery,
	executeAllQueries: mocks.executeAllQueries,
}));

vi.mock('../../src/webview/shared/safe-run.js', () => ({
	safeRun: (work: () => unknown) => work(),
}));

vi.mock('../../src/webview/core/utils.js', () => ({
	scrollPageBy: vi.fn(),
}));

describe('Kusto execution keyboard shortcuts', () => {
	beforeAll(async () => {
		await import('../../src/webview/core/keyboard-shortcuts.js');
	});

	beforeEach(() => {
		mocks.executeQuery.mockClear();
		mocks.executeAllQueries.mockClear();
		mocks.hasTextFocus.mockReturnValue(true);
		delete (window as any).__kustoReadOnlyMode;
	});

	it('routes Ctrl+Shift+Enter to Run All exactly once when Kusto text has focus', () => {
		document.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true,
			bubbles: true, cancelable: true,
		}));

		expect(mocks.executeAllQueries).toHaveBeenCalledOnce();
		expect(mocks.executeAllQueries).toHaveBeenCalledWith('query_1');
		expect(mocks.executeQuery).not.toHaveBeenCalled();
	});

	it('keeps Ctrl+Enter on focused selection execution', () => {
		document.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Enter', code: 'Enter', ctrlKey: true,
			bubbles: true, cancelable: true,
		}));

		expect(mocks.executeQuery).toHaveBeenCalledOnce();
		expect(mocks.executeQuery).toHaveBeenCalledWith('query_1');
		expect(mocks.executeAllQueries).not.toHaveBeenCalled();
	});

	it('does not run all when the Kusto text area lacks focus', () => {
		mocks.hasTextFocus.mockReturnValue(false);

		document.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true,
			bubbles: true, cancelable: true,
		}));

		expect(mocks.executeAllQueries).not.toHaveBeenCalled();
		expect(mocks.executeQuery).not.toHaveBeenCalled();
	});
});
