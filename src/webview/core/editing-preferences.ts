import {
	parseEditingPreferencesHostMessage,
	type EditingPreferencesDataMessage,
} from '../../shared/editingPreferences.js';
import {
	autoTriggerAutocompleteEnabled,
	caretDocsEnabled,
	caretDocOverlaysByBoxId,
	copilotInlineCompletionsEnabled,
	queryBoxes,
	setAutoTriggerAutocompleteEnabled,
	setCaretDocsEnabled,
	setCopilotInlineCompletionsEnabled,
} from './state.js';

let latestRevision = -1;

export type EditingPreferencesRuntimeSnapshot = Readonly<{
	revision: number;
	caretDocsEnabled: boolean;
	caretDocsEnabledUserSet: boolean;
	autoTriggerAutocompleteEnabled: boolean;
	autoTriggerAutocompleteEnabledUserSet: boolean;
	copilotInlineCompletionsEnabled: boolean;
	copilotInlineCompletionsEnabledUserSet: boolean;
}>;

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

export function applyEditingPreferencesData(message: unknown): boolean {
	const parsed = parseEditingPreferencesHostMessage(message);
	if (!parsed.ok) return false;
	const preferences = parsed.value;
	const revision = preferences.revision;
	if (revision < latestRevision) {
		return false;
	}
	setCaretDocsEnabled(preferences.caretDocsEnabled);
	setAutoTriggerAutocompleteEnabled(preferences.autoTriggerAutocompleteEnabled);
	setCopilotInlineCompletionsEnabled(preferences.copilotInlineCompletionsEnabled);
	try { window.__kustoCaretDocsEnabledUserSet = preferences.caretDocsEnabledUserSet; } catch (error) { console.error('[kusto]', error); }
	try { window.__kustoAutoTriggerAutocompleteEnabledUserSet = preferences.autoTriggerAutocompleteEnabledUserSet; } catch (error) { console.error('[kusto]', error); }
	try { window.__kustoCopilotInlineCompletionsEnabledUserSet = preferences.copilotInlineCompletionsEnabledUserSet; } catch (error) { console.error('[kusto]', error); }
	updateCaretDocsToggleButtons();
	updateAutoTriggerAutocompleteToggleButtons();
	updateCopilotInlineCompletionsToggleButtons();
	applyCaretDocsPresentation(preferences.caretDocsEnabled);
	latestRevision = revision;
	return true;
}

export function captureEditingPreferencesRuntime(): EditingPreferencesRuntimeSnapshot {
	return {
		revision: latestRevision,
		caretDocsEnabled,
		caretDocsEnabledUserSet: !!window.__kustoCaretDocsEnabledUserSet,
		autoTriggerAutocompleteEnabled,
		autoTriggerAutocompleteEnabledUserSet: !!window.__kustoAutoTriggerAutocompleteEnabledUserSet,
		copilotInlineCompletionsEnabled,
		copilotInlineCompletionsEnabledUserSet: !!window.__kustoCopilotInlineCompletionsEnabledUserSet,
	};
}

export function restoreEditingPreferencesRuntime(snapshot: EditingPreferencesRuntimeSnapshot): void {
	latestRevision = snapshot.revision;
	setCaretDocsEnabled(snapshot.caretDocsEnabled);
	setAutoTriggerAutocompleteEnabled(snapshot.autoTriggerAutocompleteEnabled);
	setCopilotInlineCompletionsEnabled(snapshot.copilotInlineCompletionsEnabled);
	window.__kustoCaretDocsEnabledUserSet = snapshot.caretDocsEnabledUserSet;
	window.__kustoAutoTriggerAutocompleteEnabledUserSet = snapshot.autoTriggerAutocompleteEnabledUserSet;
	window.__kustoCopilotInlineCompletionsEnabledUserSet = snapshot.copilotInlineCompletionsEnabledUserSet;
	updateCaretDocsToggleButtons();
	updateAutoTriggerAutocompleteToggleButtons();
	updateCopilotInlineCompletionsToggleButtons();
	applyCaretDocsPresentation(snapshot.caretDocsEnabled);
}

export function resetEditingPreferencesRevisionForTests(): void {
	latestRevision = -1;
}