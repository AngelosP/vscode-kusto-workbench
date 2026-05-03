import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('TutorialViewerPanel HTML template', () => {
	it('replaces the codicon font URI placeholder used by the template', () => {
		const root = process.cwd();
		const template = readFileSync(join(root, 'src', 'webview', 'tutorial-viewer.html'), 'utf8');
		const panelSource = readFileSync(join(root, 'src', 'host', 'tutorials', 'tutorialViewerPanel.ts'), 'utf8');

		expect(template).toContain('{{codiconFontUri}}');
		expect(panelSource).toContain('.replace(/{{codiconFontUri}}/g, String(codiconsFontUri))');
		expect(panelSource).not.toContain('.replace(/{{codiconsFontUri}}/g');
	});

	it('marks tutorials seen only when the webview explicitly requests it', () => {
		const root = process.cwd();
		const panelSource = readFileSync(join(root, 'src', 'host', 'tutorials', 'tutorialViewerPanel.ts'), 'utf8');

		expect(panelSource).toContain("| { type: 'openTutorial'; tutorialId: string; markSeen?: boolean }");
		expect(panelSource).toContain('await this.postTutorial(message.tutorialId, { markSeen: message.markSeen === true });');
		expect(panelSource).toContain('if (options.markSeen)');
		expect(panelSource).toContain('await this.subscriptionService.markTutorialSeen(tutorial.categoryId, tutorial.updateToken);');
	});
});
