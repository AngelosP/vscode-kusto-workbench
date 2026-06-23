import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { classifyWorkbenchUri, normalizeWorkbenchUriKey } from '../../../src/host/workbenchFileTypes';

describe('workbenchFileTypes', () => {
	it('classifies core notebook and query file types', () => {
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/a.kqlx'))?.fileKind).toBe('kqlx');
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/a.mdx'))?.fileKind).toBe('mdx');
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/a.sqlx'))?.fileKind).toBe('sqlx');
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/a.kql'))?.fileKind).toBe('kql');
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/a.csl'))?.fileKind).toBe('csl');
	});

	it('maps sidecar files to their logical primary files', () => {
		const primaryKql = classifyWorkbenchUri(vscode.Uri.file('/work/query.kql'))!;
		const kql = classifyWorkbenchUri(vscode.Uri.file('/work/query.kql.json'))!;
		const csl = classifyWorkbenchUri(vscode.Uri.file('/work/query.csl.json'))!;
		const sql = classifyWorkbenchUri(vscode.Uri.file('/work/query.sql.json'))!;

		expect(kql).toMatchObject({ fileKind: 'kql-sidecar', fileName: 'query.kql', isSidecar: true, sidecarFor: '/work/query.kql' });
		expect(kql.openFileId).toBe(primaryKql.openFileId);
		expect(csl).toMatchObject({ fileKind: 'csl-sidecar', fileName: 'query.csl', isSidecar: true, sidecarFor: '/work/query.csl' });
		expect(sql).toMatchObject({ fileKind: 'sql-sidecar', fileName: 'query.sql', isSidecar: true, sidecarFor: '/work/query.sql' });
	});

	it('creates stable public openFileId values from logical URIs', () => {
		const first = classifyWorkbenchUri(vscode.Uri.file('/work/target.kqlx'))!;
		const second = classifyWorkbenchUri(vscode.Uri.file('/work/target.kqlx'))!;
		const other = classifyWorkbenchUri(vscode.Uri.file('/work/other.kqlx'))!;

		expect(first.openFileId).toMatch(/^wf_/);
		expect(first.openFileId).toBe(second.openFileId);
		expect(first.openFileId).not.toBe(other.openFileId);
		expect(first.openFileId).not.toContain('/');
		expect(first.openFileId).not.toContain('\\');
	});

	it('requires Workbench context for optional .md and .sql files', () => {
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/readme.md'))).toBeUndefined();
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/query.sql'))).toBeUndefined();
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/readme.md'), { viewType: 'kusto.mdCompatEditor' })?.fileKind).toBe('md');
		expect(classifyWorkbenchUri(vscode.Uri.file('/work/query.sql'), { viewType: 'kusto.sqlCompatEditor' })?.fileKind).toBe('sql');
	});

	it('normalizes file URI keys using platform casing rules', () => {
		const key = normalizeWorkbenchUriKey(vscode.Uri.file('/work/Query.kql'));
		const expectedPath = process.platform === 'win32' ? '/work/query.kql' : '/work/Query.kql';
		expect(key).toBe(`file:${expectedPath}`);
	});

	it('preserves path casing for non-file URI keys', () => {
		const upper = normalizeWorkbenchUriKey(vscode.Uri.parse('vscode-remote://ssh-remote+host/work/Query.kqlx'));
		const lower = normalizeWorkbenchUriKey(vscode.Uri.parse('vscode-remote://ssh-remote+host/work/query.kqlx'));
		expect(upper).toBe('vscode-remote://ssh-remote+host/work/Query.kqlx');
		expect(lower).toBe('vscode-remote://ssh-remote+host/work/query.kqlx');
		expect(upper).not.toBe(lower);
	});
});