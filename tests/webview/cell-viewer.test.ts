import { describe, it, expect } from 'vitest';
import { __kustoGetCellViewerColumnName } from '../../src/webview/modules/cellViewer.js';

// ── __kustoGetCellViewerColumnName ────────────────────────────────────────────

describe('__kustoGetCellViewerColumnName', () => {
	it('returns string column name from columns array', () => {
		const state = { columns: ['Alpha', 'Beta', 'Gamma'] };
		expect(__kustoGetCellViewerColumnName(state, 0)).toBe('Alpha');
		expect(__kustoGetCellViewerColumnName(state, 1)).toBe('Beta');
		expect(__kustoGetCellViewerColumnName(state, 2)).toBe('Gamma');
	});

	it('returns col.name when columns are objects', () => {
		const state = { columns: [{ name: 'Id' }, { name: 'Value' }] };
		expect(__kustoGetCellViewerColumnName(state, 0)).toBe('Id');
		expect(__kustoGetCellViewerColumnName(state, 1)).toBe('Value');
	});

	it('returns col.columnName when name is missing', () => {
		const state = { columns: [{ columnName: 'MyCol' }] };
		expect(__kustoGetCellViewerColumnName(state, 0)).toBe('MyCol');
	});

	it('returns col.displayName as fallback', () => {
		const state = { columns: [{ displayName: 'Display' }] };
		expect(__kustoGetCellViewerColumnName(state, 0)).toBe('Display');
	});

	it('returns fallback for out-of-bounds index', () => {
		const state = { columns: ['Only'] };
		expect(__kustoGetCellViewerColumnName(state, 5)).toBe('column 6');
	});

	it('returns fallback for null state', () => {
		expect(__kustoGetCellViewerColumnName(null, 0)).toBe('column 1');
	});

	it('returns fallback for state without columns', () => {
		expect(__kustoGetCellViewerColumnName({}, 0)).toBe('column 1');
	});

	it('returns fallback for empty columns array', () => {
		expect(__kustoGetCellViewerColumnName({ columns: [] }, 0)).toBe('column 1');
	});

	it('prefers name over columnName', () => {
		const state = { columns: [{ name: 'Name', columnName: 'ColumnName' }] };
		expect(__kustoGetCellViewerColumnName(state, 0)).toBe('Name');
	});

	it('handles column with empty name string', () => {
		const state = { columns: [{ name: '', columnName: 'Fallback' }] };
		expect(__kustoGetCellViewerColumnName(state, 0)).toBe('Fallback');
	});
});
