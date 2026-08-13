import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyEditingPreferencesData,
	resetEditingPreferencesRevisionForTests,
} from '../../src/webview/core/editing-preferences.js';
import type { EditingPreferencesDataMessage } from '../../src/shared/editingPreferences.js';
import {
	caretDocOverlaysByBoxId,
	queryBoxes,
} from '../../src/webview/core/state.js';

function message(revision: number, enabled: boolean) {
	return {
		type: 'editingPreferencesData' as const,
		revision,
		caretDocsEnabled: enabled,
		caretDocsEnabledUserSet: true,
		autoTriggerAutocompleteEnabled: enabled,
		autoTriggerAutocompleteEnabledUserSet: true,
		copilotInlineCompletionsEnabled: enabled,
		copilotInlineCompletionsEnabledUserSet: true,
	};
}

describe('editing preference UI application', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		queryBoxes.splice(0, queryBoxes.length);
		for (const key of Object.keys(caretDocOverlaysByBoxId)) delete caretDocOverlaysByBoxId[key];
		resetEditingPreferencesRevisionForTests();
	});

	it('updates Kusto and SQL toolbar controls plus Kusto documentation without persisting', () => {
		const queryToolbar = document.createElement('kw-query-toolbar') as any;
		queryToolbar.setCaretDocsActive = vi.fn();
		queryToolbar.setAutoCompleteActive = vi.fn();
		queryToolbar.setCopilotInlineActive = vi.fn();
		const sqlToolbar = document.createElement('kw-sql-toolbar') as any;
		sqlToolbar.setAutoCompleteActive = vi.fn();
		sqlToolbar.setCopilotInlineActive = vi.fn();
		document.body.append(queryToolbar, sqlToolbar);
		queryBoxes.push('query_1');
		const docs = document.createElement('div');
		docs.id = 'query_1_caret_docs';
		const docsText = document.createElement('div');
		docsText.id = 'query_1_caret_docs_text';
		document.body.append(docs, docsText);
		const overlay = { update: vi.fn(), hide: vi.fn() };
		caretDocOverlaysByBoxId.query_1 = overlay as any;

		expect(applyEditingPreferencesData(message(1, true))).toBe(true);
		expect(queryToolbar.setCaretDocsActive).toHaveBeenCalledWith(true);
		expect(queryToolbar.setAutoCompleteActive).toHaveBeenCalledWith(true);
		expect(sqlToolbar.setAutoCompleteActive).toHaveBeenCalledWith(true);
		expect(sqlToolbar.setCopilotInlineActive).toHaveBeenCalledWith(true);
		expect(docs.style.display).toBe('flex');
		expect(overlay.update).toHaveBeenCalledOnce();
		expect(window.__kustoCaretDocsEnabledUserSet).toBe(true);
	});

	it('ignores stale snapshots and hides active documentation overlays when disabled', () => {
		const overlay = { update: vi.fn(), hide: vi.fn() };
		caretDocOverlaysByBoxId.query_1 = overlay as any;

		expect(applyEditingPreferencesData(message(4, false))).toBe(true);
		expect(overlay.hide).toHaveBeenCalledOnce();
		expect(applyEditingPreferencesData(message(3, true))).toBe(false);
		expect(overlay.update).not.toHaveBeenCalled();
	});

	it('rejects malformed high revisions without poisoning one canonical application', () => {
		const queryToolbar = document.createElement('kw-query-toolbar') as any;
		queryToolbar.setCaretDocsActive = vi.fn();
		queryToolbar.setAutoCompleteActive = vi.fn();
		queryToolbar.setCopilotInlineActive = vi.fn();
		const sqlToolbar = document.createElement('kw-sql-toolbar') as any;
		sqlToolbar.setAutoCompleteActive = vi.fn();
		sqlToolbar.setCopilotInlineActive = vi.fn();
		document.body.append(queryToolbar, sqlToolbar);
		queryBoxes.push('query_1');
		const docs = document.createElement('div');
		docs.id = 'query_1_caret_docs';
		docs.style.display = 'none';
		const docsText = document.createElement('div');
		docsText.id = 'query_1_caret_docs_text';
		docsText.textContent = 'existing documentation';
		document.body.append(docs, docsText);
		const malformed = {
			...message(999, true),
			caretDocsEnabled: 'false',
		} as unknown as EditingPreferencesDataMessage;

		expect(applyEditingPreferencesData(malformed)).toBe(false);
		expect(queryToolbar.setCaretDocsActive).not.toHaveBeenCalled();
		expect(queryToolbar.setAutoCompleteActive).not.toHaveBeenCalled();
		expect(queryToolbar.setCopilotInlineActive).not.toHaveBeenCalled();
		expect(sqlToolbar.setAutoCompleteActive).not.toHaveBeenCalled();
		expect(sqlToolbar.setCopilotInlineActive).not.toHaveBeenCalled();
		expect(docs.style.display).toBe('none');
		expect(docsText.textContent).toBe('existing documentation');
		expect(docsText.classList.contains('is-watermark')).toBe(false);

		expect(applyEditingPreferencesData(message(1, false))).toBe(true);
		expect(queryToolbar.setCaretDocsActive).toHaveBeenCalledOnce();
		expect(queryToolbar.setCaretDocsActive).toHaveBeenCalledWith(false);
		expect(queryToolbar.setAutoCompleteActive).toHaveBeenCalledOnce();
		expect(queryToolbar.setCopilotInlineActive).toHaveBeenCalledOnce();
		expect(sqlToolbar.setAutoCompleteActive).toHaveBeenCalledOnce();
		expect(sqlToolbar.setCopilotInlineActive).toHaveBeenCalledOnce();
		expect(docs.style.display).toBe('none');
		expect(docsText.textContent).toBe('existing documentation');
	});

	it('reapplies an equal maximum revision for cross-window convergence', () => {
		expect(applyEditingPreferencesData(message(Number.MAX_SAFE_INTEGER, true))).toBe(true);
		expect(applyEditingPreferencesData(message(Number.MAX_SAFE_INTEGER, false))).toBe(true);
	});
});