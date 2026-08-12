import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Kusto manual resize persistence', () => {
	it('publishes editor and results heights immediately on mouse-up', () => {
		const sectionFactory = source('src/webview/core/section-factory.ts');
		const monaco = source('src/webview/monaco/monaco.ts');

		expect(sectionFactory).toContain("schedulePersist('results-resize', true)");
		expect(monaco).toContain("schedulePersist('editor-resize', true)");
		expect(monaco).toContain("document.addEventListener('mouseleave', onUp)");
		expect(monaco).toContain("window.addEventListener('blur', onUp)");
		expect(monaco).toContain("document.removeEventListener('mouseleave', onUp)");
		expect(monaco).toContain("window.removeEventListener('blur', onUp)");
		expect(sectionFactory).toContain("window.closeRunMenu?.(String(boxId || ''))");
	});
});