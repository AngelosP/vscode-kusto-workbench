import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const webviewRoot = path.join(repoRoot, 'src/webview');
const ignoredDirectories = new Set(['generated', 'vendor']);

function textFiles(directory: string, extensions: ReadonlySet<string>): string[] {
	const files: string[] = [];
	if (!fs.existsSync(directory)) return files;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) files.push(...textFiles(path.join(directory, entry.name), extensions));
			continue;
		}
		if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(path.join(directory, entry.name));
	}
	return files;
}

function sourceFiles(directory: string): string[] {
	return textFiles(directory, new Set(['.ts']));
}

function relative(file: string): string {
	return path.relative(repoRoot, file).replaceAll('\\', '/');
}

describe('Kusto schema ownership boundaries', () => {
	it('does not reintroduce mutable editor lifecycle maps or window schema authority', () => {
		const forbidden = [
			/\bschemaByBoxId\b/,
			/\bschemaMetaByBoxId\b/,
			/\bkustoPreparationByBoxId\b/,
			/\bschemaWorkerReadyByBoxId\b/,
			/\bschemaEnhancementReadyByBoxId\b/,
			/\bschemaWorkerApplyRequiredByBoxId\b/,
			/\bschemaWorkerReadyWaitersByBoxId\b/,
			/\bpendingSchemaWorkerUpdateByBoxId\b/,
			/(?:window|_win)\.schemaByBoxId\b/,
		];
		const violations: string[] = [];
		for (const file of sourceFiles(webviewRoot)) {
			const text = fs.readFileSync(file, 'utf8');
			for (const pattern of forbidden) {
				if (pattern.test(text)) violations.push(`${relative(file)}: ${pattern.source}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it('keeps worker mutation serialization on the transaction port', () => {
		const violations: string[] = [];
		for (const file of sourceFiles(webviewRoot)) {
			const text = fs.readFileSync(file, 'utf8');
			if (/\b__kustoSchemaOperationQueue\b/.test(text)) violations.push(`${relative(file)}: legacy queue`);
			if (/\.commitCurrent\s*\(/.test(text)) violations.push(`${relative(file)}: ambient commit`);
		}
		expect(violations).toEqual([]);
	});

	it('keeps Monaco and the connection controller below section-factory', () => {
		const files = [
			path.join(webviewRoot, 'monaco/monaco.ts'),
			path.join(webviewRoot, 'monaco/resize.ts'),
			path.join(webviewRoot, 'sections/query-connection.controller.ts'),
		];
		const violations = files
			.filter(file => /(?:from|import\s*\()\s*['"][^'"]*section-factory/.test(fs.readFileSync(file, 'utf8')))
			.map(relative);
		expect(violations).toEqual([]);
	});

	it('does not retain deleted schema authorities in scripts or E2E features', () => {
		const files = [
			...textFiles(path.join(repoRoot, 'scripts'), new Set(['.js', '.mjs', '.ts'])),
			...textFiles(path.join(repoRoot, 'tests/vscode-extension-tester/e2e'), new Set(['.feature'])),
		];
		const forbidden = [
			/window\.schemaByBoxId\b/,
			/\bschemaRequestResolversByBoxId\b/,
			/\bdatabasesRequestResolversByBoxId\b/,
			/\b__kustoSchemaOperationQueue\b/,
		];
		const violations = files.flatMap(file => {
			const text = fs.readFileSync(file, 'utf8');
			return forbidden.filter(pattern => pattern.test(text)).map(pattern => `${relative(file)}: ${pattern.source}`);
		});
		expect(violations).toEqual([]);
	});

	it('cancels Monaco retries on section removal, not Copilot chat toggle', () => {
		const factory = fs.readFileSync(path.join(webviewRoot, 'core/section-factory.ts'), 'utf8');
		const removeBody = factory.match(/export function removeQueryBox[\s\S]*?unregisterSqlDerivedComparisonSession/)?.[0] || '';
		const chatBody = factory.match(/window\.__kustoToggleCopilotChatForBox[\s\S]*?window\.addCopilotQueryBox/)?.[0] || '';
		expect(removeBody).toContain('__kustoCancelMonacoInitRetry');
		expect(chatBody).not.toContain('__kustoCancelMonacoInitRetry');
	});

	it('does not rebuild query ownership from an ID prefix during reorder', () => {
		for (const relativePath of ['core/drag-reorder.ts', 'components/kw-section-reorder-popup.ts']) {
			const text = fs.readFileSync(path.join(webviewRoot, relativePath), 'utf8');
			expect(text).toContain("idsFor('kw-query-section')");
			expect(text).not.toMatch(/setQueryBoxes\([^;\n]*startsWith\(['"]query_['"]\)/);
			expect(text).not.toMatch(/queryBoxes\s*=\s*ids\.filter/);
		}
	});
});
