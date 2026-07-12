import type { EditingPreferencesDataMessage } from '../../shared/editingPreferences.js';
import {
	autoTriggerAutocompleteEnabled,
	caretDocOverlaysByBoxId,
	copilotInlineCompletionsEnabled,
	queryBoxes,
	setAutoTriggerAutocompleteEnabled,
	setCaretDocsEnabled,
	setCopilotInlineCompletionsEnabled,
} from './state.js';

let latestRevision = -1;

export function updateCaretDocsToggleButtons(): void {
	for (const toolbar of document.querySelectorAll('kw-query-toolbar')) {
		try {
			const candidate = toolbar as any;
			if (typeof candidate.setCaretDocsActive === 'function') {
				candidate.setCaretDocsActive(!!(window as any).caretDocsEnabled);
			}
		} catch (error) { console.error('[kusto]', error); }
	}
}

export function updateAutoTriggerAutocompleteToggleButtons(): void {
	for (const toolbar of document.querySelectorAll('kw-query-toolbar, kw-sql-toolbar')) {
		try {
			const candidate = toolbar as any;
			if (typeof candidate.setAutoCompleteActive === 'function') {
				candidate.setAutoCompleteActive(!!autoTriggerAutocompleteEnabled);
			}
		} catch (error) { console.error('[kusto]', error); }
	}
}

export function updateCopilotInlineCompletionsToggleButtons(): void {
	for (const toolbar of document.querySelectorAll('kw-query-toolbar, kw-sql-toolbar')) {
		try {
			const candidate = toolbar as any;
			if (typeof candidate.setCopilotInlineActive === 'function') {
				candidate.setCopilotInlineActive(!!copilotInlineCompletionsEnabled);
			}
		} catch (error) { console.error('[kusto]', error); }
	}
}

export function applyCaretDocsPresentation(enabled: boolean): void {
	if (!enabled) {
		for (const key of Object.keys(caretDocOverlaysByBoxId || {})) {
			try {
				caretDocOverlaysByBoxId[key]?.hide?.();
			} catch (error) { console.error('[kusto]', error); }
		}
		return;
	}

	const watermarkTitle = 'Smart documentation';
	const watermarkBody = 'Kusto documentation will appear here as the cursor moves around';
	for (const boxId of queryBoxes) {
		try {
			const banner = document.getElementById(boxId + '_caret_docs') as HTMLElement | null;
			const text = document.getElementById(boxId + '_caret_docs_text') || banner;
			if (banner) banner.style.display = 'flex';
			if (text) {
				text.innerHTML =
					'<div class="qe-caret-docs-line qe-caret-docs-watermark-title">' + watermarkTitle + '</div>' +
					'<div class="qe-caret-docs-line qe-caret-docs-watermark-body">' + watermarkBody + '</div>';
				text.classList.add('is-watermark');
			}
		} catch (error) { console.error('[kusto]', error); }
	}
	for (const key of Object.keys(caretDocOverlaysByBoxId || {})) {
		try {
			caretDocOverlaysByBoxId[key]?.update?.();
		} catch (error) { console.error('[kusto]', error); }
	}
}

export function applyEditingPreferencesData(message: EditingPreferencesDataMessage): boolean {
	const revision = Number.isFinite(message.revision) ? Math.max(0, Math.floor(message.revision)) : 0;
	if (revision < latestRevision) {
		return false;
	}
	latestRevision = revision;
	setCaretDocsEnabled(!!message.caretDocsEnabled);
	setAutoTriggerAutocompleteEnabled(!!message.autoTriggerAutocompleteEnabled);
	setCopilotInlineCompletionsEnabled(!!message.copilotInlineCompletionsEnabled);
	try { window.__kustoCaretDocsEnabledUserSet = !!message.caretDocsEnabledUserSet; } catch (error) { console.error('[kusto]', error); }
	try { window.__kustoAutoTriggerAutocompleteEnabledUserSet = !!message.autoTriggerAutocompleteEnabledUserSet; } catch (error) { console.error('[kusto]', error); }
	try { window.__kustoCopilotInlineCompletionsEnabledUserSet = !!message.copilotInlineCompletionsEnabledUserSet; } catch (error) { console.error('[kusto]', error); }
	updateCaretDocsToggleButtons();
	updateAutoTriggerAutocompleteToggleButtons();
	updateCopilotInlineCompletionsToggleButtons();
	applyCaretDocsPresentation(!!message.caretDocsEnabled);
	return true;
}

export function resetEditingPreferencesRevisionForTests(): void {
	latestRevision = -1;
}