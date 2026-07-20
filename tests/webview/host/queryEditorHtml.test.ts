import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { escapeQueryEditorDocumentTitle, queryEditorBodyAttributes } from '../../../src/host/queryEditorHtml.js';

describe('query editor HTML title', () => {
	it('escapes a custom editor filename for use in the title element', () => {
		expect(escapeQueryEditorDocumentTitle(`a<&>"'.kqlx`)).toBe('a&lt;&amp;&gt;&quot;&#39;.kqlx');
	});

	it('injects the E2E capability only outside production', () => {
		expect(queryEditorBodyAttributes(false, vscode.ExtensionMode.Production)).toBe('');
		expect(queryEditorBodyAttributes(false, vscode.ExtensionMode.Development))
			.toBe(' data-kusto-e2e-enabled="true"');
		expect(queryEditorBodyAttributes(true, vscode.ExtensionMode.Production))
			.toBe(' data-kusto-document-loading="true"');
	});
});