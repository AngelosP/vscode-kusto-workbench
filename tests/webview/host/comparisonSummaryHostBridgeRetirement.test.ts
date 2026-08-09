import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
	return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('comparison summary host bridge retirement', () => {
	it('keeps comparison summaries local and prevents the dead host bridge from returning', () => {
		const provider = readSource('src/host/queryEditorProvider.ts');
		const copilot = readSource('src/host/queryEditorCopilot.ts');
		const sqlLifecycle = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const hostMessages = readSource('src/host/queryEditorTypes.ts');
		const webviewMessages = readSource('src/webview/shared/webview-messages.ts');
		const executionController = readSource('src/webview/sections/query-execution.controller.ts');
		const querySection = readSource('src/webview/sections/kw-query-section.ts');

		for (const source of [provider, copilot, sqlLifecycle, hostMessages, webviewMessages]) {
			expect(source).not.toContain('waitForComparisonSummary');
			expect(source).not.toContain('deleteComparisonSummary');
			expect(source).not.toContain("type: 'comparisonSummary'");
			expect(source).not.toContain("type: 'clearComparisonSummary'");
		}
		expect(provider).not.toContain('latestComparisonSummaryByKey');
		expect(provider).not.toContain('pendingComparisonSummaryByKey');
		expect(provider).not.toContain("case 'comparisonSummary':");
		expect(provider).not.toContain("case 'clearComparisonSummary':");

		expect(executionController).toContain('export function displayComparisonSummary');
		expect(executionController).toContain('getCurrentResultArtifact(comparisonBoxId)');
		expect(executionController).toContain('getResultArtifact(comparisonSourceArtifactId)');
		expect(executionController).toContain("banner.className = 'comparison-summary-banner';");
		expect(executionController).not.toContain("type: 'comparisonSummary'");
		expect(querySection).toContain("this.querySelector('.comparison-summary-banner')?.remove();");
		expect(querySection).not.toContain("type: 'clearComparisonSummary'");
	});
});
