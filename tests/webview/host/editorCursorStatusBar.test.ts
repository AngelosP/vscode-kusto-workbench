import { beforeEach, describe, expect, it } from 'vitest';
import { __mockStatusBarItems, StatusBarAlignment } from 'vscode';
import { EditorCursorStatusBar } from '../../../src/host/editorCursorStatusBar';

describe('EditorCursorStatusBar', () => {
	beforeEach(() => {
		__mockStatusBarItems.length = 0;
	});

	it('creates a named right-aligned status bar item', () => {
		const status = new EditorCursorStatusBar();
		const item = __mockStatusBarItems[0];

		expect(item.id).toBe('kustoWorkbench.cursorPosition');
		expect(item.alignment).toBe(StatusBarAlignment.Right);
		expect(item.priority).toBe(1000);
		expect(item.name).toBe('Kusto Workbench Cursor Position');
		expect(item.tooltip).toBe('Kusto Workbench editor cursor position');
		expect(item.accessibilityInformation).toEqual({
			label: 'Kusto Workbench editor cursor position',
			role: 'status',
		});
		expect(status.getSnapshot()).toEqual({ visible: false, text: '' });
	});

	it('shows formatted line and column snapshots', () => {
		const status = new EditorCursorStatusBar();
		const item = __mockStatusBarItems[0];

		status.update('owner-a', { line: 4.9, column: 41.2, boxId: 'query_1', editorKind: 'kusto' });

		expect(item.text).toBe('Ln 4, Col 41');
		expect(item.shown).toBe(true);
		expect(status.getSnapshot()).toEqual({
			visible: true,
			text: 'Ln 4, Col 41',
			ownerId: 'owner-a',
			line: 4,
			column: 41,
			boxId: 'query_1',
			editorKind: 'kusto',
		});
	});

	it('ignores stale owner clears', () => {
		const status = new EditorCursorStatusBar();
		const item = __mockStatusBarItems[0];

		status.update('owner-a', { line: 1, column: 2, boxId: 'query_1', editorKind: 'kusto' });
		status.update('owner-b', { line: 3, column: 4, boxId: 'sql_1', editorKind: 'sql' });
		status.clear('owner-a');

		expect(item.shown).toBe(true);
		expect(status.getSnapshot().ownerId).toBe('owner-b');
		expect(status.getSnapshot().text).toBe('Ln 3, Col 4');

		status.clear('owner-b');
		expect(item.shown).toBe(false);
		expect(status.getSnapshot()).toEqual({ visible: false, text: '' });
	});

	it('clears by active owner prefix only', () => {
		const status = new EditorCursorStatusBar();
		const item = __mockStatusBarItems[0];

		status.update('queryEditor:2:query_1', { line: 7, column: 8, editorKind: 'kusto' });
		status.clearOwnerPrefix('queryEditor:1:');
		expect(item.shown).toBe(true);

		status.clearOwnerPrefix('queryEditor:2:');
		expect(item.shown).toBe(false);

		status.clearOwnerPrefix('anything:');
		expect(status.getSnapshot()).toEqual({ visible: false, text: '' });
	});

	it('clears invalid and explicitly hidden payloads for the active owner', () => {
		const status = new EditorCursorStatusBar();
		const item = __mockStatusBarItems[0];

		status.update('owner-a', { line: 1, column: 1, editorKind: 'html' });
		status.update('owner-a', { line: Number.NaN, column: 1, editorKind: 'html' });
		expect(item.shown).toBe(false);

		status.update('owner-a', { line: 1, column: 1, editorKind: 'html' });
		status.update('owner-a', { line: 1, column: 0, editorKind: 'html' });
		expect(item.shown).toBe(false);

		status.update('owner-a', { line: 1, column: 1, editorKind: 'html' });
		status.update('owner-a', { visible: false, reason: 'preview' });
		expect(item.shown).toBe(false);
	});

	it('ignores invalid hidden payloads from stale owners and disposes the item', () => {
		const status = new EditorCursorStatusBar();
		const item = __mockStatusBarItems[0];

		status.update('owner-a', { line: 9, column: 10, editorKind: 'python' });
		status.update('owner-b', { visible: false });
		expect(item.shown).toBe(true);
		expect(status.getSnapshot().ownerId).toBe('owner-a');

		status.update('owner-b', { line: 'bad', column: 10 });
		expect(item.shown).toBe(true);

		status.dispose();
		expect(item.shown).toBe(false);
		expect(item.disposed).toBe(true);
	});
});
