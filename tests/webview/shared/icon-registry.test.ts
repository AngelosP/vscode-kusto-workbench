import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, nothing, html } from 'lit';
import { ICONS, sectionIcons, iconRegistryStyles, undoIcon, redoIcon, commentIcon, prettifyIcon, searchIcon, replaceIcon, indentIcon, outdentIcon, wordWrapIcon, autocompleteIcon, ghostIcon, caretDocsIcon, powerBIIcon, toolsDoubleToSingleIcon, toolsSingleToDoubleIcon, toolsQualifyTablesIcon, toolsSingleLineIcon, toolsInlineFunctionIcon, toolsRenameIcon, exportIcon, runIcon, toolsCodiconIcon, linkCodiconIcon } from '../../../src/webview/shared/icon-registry.js';
import type { SectionType } from '../../../src/webview/shared/icon-registry.js';

describe('icon-registry', () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		render(nothing, container);
		container.remove();
	});

	// ── SVG-sourced icons ─────────────────────────────────────────────────────

	describe('SVG-sourced icons', () => {
		const svgIcons: Array<[string, unknown]> = [
			['kustoCluster', ICONS.kustoCluster],
			['sqlServer', ICONS.sqlServer],
			['table', ICONS.table],
			['function', ICONS.function],
			['folder', ICONS.folder],
			['chevron', ICONS.chevron],
			['star', ICONS.star],
			['starFilled', ICONS.starFilled],
			['add', ICONS.add],
			['shield', ICONS.shield],
			['newFile', ICONS.newFile],
			['spinner', ICONS.spinner],
			['sidebar', ICONS.sidebar],
			['importIcon', ICONS.importIcon],
		];

		for (const [name, icon] of svgIcons) {
			it(`${name} renders as an <svg> element`, () => {
				render(html`${icon}`, container);
				expect(container.querySelector('svg')).not.toBeNull();
			});
		}
	});

	// ── Codicon-sourced icons ─────────────────────────────────────────────────

	describe('codicon-sourced icons', () => {
		const codiconIcons: Array<[string, unknown, string]> = [
			['database', ICONS.database, 'codicon-database'],
			['edit', ICONS.edit, 'codicon-edit'],
			['delete', ICONS.delete, 'codicon-trash'],
			['copy', ICONS.copy, 'codicon-copy'],
			['refresh', ICONS.refresh, 'codicon-refresh'],
			['close', ICONS.close, 'codicon-close'],
			['save', ICONS.save, 'codicon-save'],
			['clearAll', ICONS.clearAll, 'codicon-clear-all'],
			['trash', ICONS.trash, 'codicon-trash'],
			['insert', ICONS.insert, 'codicon-insert'],
			['linkExternal', ICONS.linkExternal, 'codicon-link-external'],
			['notebook', ICONS.notebook, 'codicon-notebook'],
			['code', ICONS.code, 'codicon-code'],
			['comment', ICONS.comment, 'codicon-comment'],
			['arrowUp', ICONS.arrowUp, 'codicon-arrow-up'],
			['arrowLeft', ICONS.arrowLeft, 'codicon-arrow-left'],
			['debugStop', ICONS.debugStop, 'codicon-debug-stop'],
			['discard', ICONS.discard, 'codicon-discard'],
			['gitCompare', ICONS.gitCompare, 'codicon-git-compare'],
			['settingsGear', ICONS.settingsGear, 'codicon-settings-gear'],
			['toolbarTools', ICONS.toolbarTools, 'codicon-tools'],
			['toolbarLink', ICONS.toolbarLink, 'codicon-link'],
		];

		for (const [name, icon, expectedClass] of codiconIcons) {
			it(`${name} renders as a <span> with class ${expectedClass}`, () => {
				render(html`${icon}`, container);
				const span = container.querySelector(`span.codicon.${expectedClass}`);
				expect(span).not.toBeNull();
			});
		}
	});

	// ── All ICONS produce non-empty output ────────────────────────────────────

	describe('completeness', () => {
		it('all ICONS entries produce content when rendered', () => {
			for (const [key, icon] of Object.entries(ICONS)) {
				render(html`${icon}`, container);
				expect(container.innerHTML.trim().length, `ICONS.${key} produced empty output`).toBeGreaterThan(0);
				render(nothing, container);
			}
		});

		it('ICONS has at least 60 entries', () => {
			expect(Object.keys(ICONS).length).toBeGreaterThanOrEqual(60);
		});
	});

	// ── sectionIcons record ───────────────────────────────────────────────────

	describe('sectionIcons', () => {
		const expectedTypes: SectionType[] = ['query', 'markdown', 'chart', 'python', 'url', 'transformation', 'html', 'sql'];

		it('has all 8 section types', () => {
			expect(Object.keys(sectionIcons).sort()).toEqual(expectedTypes.sort());
		});

		for (const type of expectedTypes) {
			it(`${type} section icon renders as SVG`, () => {
				render(html`${sectionIcons[type]}`, container);
				expect(container.querySelector('svg')).not.toBeNull();
			});
		}
	});

	// ── Backward-compatible toolbar exports ───────────────────────────────────

	describe('toolbar backward-compatible exports', () => {
		it('undoIcon matches ICONS.toolbarUndo', () => { expect(undoIcon).toBe(ICONS.toolbarUndo); });
		it('redoIcon matches ICONS.toolbarRedo', () => { expect(redoIcon).toBe(ICONS.toolbarRedo); });
		it('commentIcon matches ICONS.toolbarComment', () => { expect(commentIcon).toBe(ICONS.toolbarComment); });
		it('prettifyIcon matches ICONS.toolbarPrettify', () => { expect(prettifyIcon).toBe(ICONS.toolbarPrettify); });
		it('searchIcon matches ICONS.toolbarSearch', () => { expect(searchIcon).toBe(ICONS.toolbarSearch); });
		it('replaceIcon matches ICONS.toolbarReplace', () => { expect(replaceIcon).toBe(ICONS.toolbarReplace); });
		it('indentIcon matches ICONS.toolbarIndent', () => { expect(indentIcon).toBe(ICONS.toolbarIndent); });
		it('outdentIcon matches ICONS.toolbarOutdent', () => { expect(outdentIcon).toBe(ICONS.toolbarOutdent); });
		it('wordWrapIcon matches ICONS.toolbarWordWrap', () => { expect(wordWrapIcon).toBe(ICONS.toolbarWordWrap); });
		it('autocompleteIcon matches ICONS.toolbarAutocomplete', () => { expect(autocompleteIcon).toBe(ICONS.toolbarAutocomplete); });
		it('ghostIcon matches ICONS.toolbarGhost', () => { expect(ghostIcon).toBe(ICONS.toolbarGhost); });
		it('caretDocsIcon matches ICONS.toolbarCaretDocs', () => { expect(caretDocsIcon).toBe(ICONS.toolbarCaretDocs); });
		it('powerBIIcon matches ICONS.toolbarPowerBI', () => { expect(powerBIIcon).toBe(ICONS.toolbarPowerBI); });
		it('toolsDoubleToSingleIcon matches ICONS.toolbarDoubleToSingle', () => { expect(toolsDoubleToSingleIcon).toBe(ICONS.toolbarDoubleToSingle); });
		it('toolsSingleToDoubleIcon matches ICONS.toolbarSingleToDouble', () => { expect(toolsSingleToDoubleIcon).toBe(ICONS.toolbarSingleToDouble); });
		it('toolsQualifyTablesIcon matches ICONS.toolbarQualifyTables', () => { expect(toolsQualifyTablesIcon).toBe(ICONS.toolbarQualifyTables); });
		it('toolsSingleLineIcon matches ICONS.toolbarSingleLine', () => { expect(toolsSingleLineIcon).toBe(ICONS.toolbarSingleLine); });
		it('toolsInlineFunctionIcon matches ICONS.toolbarInlineFunction', () => { expect(toolsInlineFunctionIcon).toBe(ICONS.toolbarInlineFunction); });
		it('toolsRenameIcon matches ICONS.toolbarRename', () => { expect(toolsRenameIcon).toBe(ICONS.toolbarRename); });
		it('exportIcon matches ICONS.toolbarExport', () => { expect(exportIcon).toBe(ICONS.toolbarExport); });
		it('runIcon matches ICONS.toolbarRun', () => { expect(runIcon).toBe(ICONS.toolbarRun); });
		it('toolsCodiconIcon matches ICONS.toolbarTools', () => { expect(toolsCodiconIcon).toBe(ICONS.toolbarTools); });
		it('linkCodiconIcon matches ICONS.toolbarLink', () => { expect(linkCodiconIcon).toBe(ICONS.toolbarLink); });
	});

	// ── iconRegistryStyles ────────────────────────────────────────────────────

	describe('iconRegistryStyles', () => {
		it('is a non-empty array', () => {
			expect(Array.isArray(iconRegistryStyles)).toBe(true);
			expect((iconRegistryStyles as unknown[]).length).toBeGreaterThan(0);
		});

		it('contains a CSSStyleSheet', () => {
			const first = (iconRegistryStyles as unknown[])[0];
			expect(first).toBeInstanceOf(CSSStyleSheet);
		});
	});
});
