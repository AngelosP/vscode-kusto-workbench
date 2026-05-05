import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resolveTutorialsEnabledConfigurationTarget, TutorialViewerPanel } from '../../../src/host/tutorials/tutorialViewerPanel.js';

describe('TutorialViewerPanel HTML template', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vscode.workspace.workspaceFolders = [];
	});

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

		expect(panelSource).toContain("| { type: 'openTutorial'; tutorialId: string; markSeen?: boolean; markSeenTutorialIds?: string[] }");
		expect(panelSource).toContain("| { type: 'setTutorialSeen'; tutorialId: string; seen: boolean }");
		expect(panelSource).toContain('await this.postTutorial(message.tutorialId, { markSeen: message.markSeen === true, markSeenTutorialIds: message.markSeenTutorialIds });');
		expect(panelSource).toContain('await this.setTutorialSeen(message.tutorialId, message.seen === true);');
		expect(panelSource).toContain('if (options.markSeen)');
		expect(panelSource).toContain('await this.subscriptionService.markTutorialSeen(tutorialToMarkSeen.categoryId, tutorialToMarkSeen.updateToken);');
		expect(panelSource).toContain('await this.subscriptionService.setTutorialSeen(tutorial.categoryId, tutorial.updateToken, seen);');
	});

	it('updates the explicit workspace scope when Did you know is disabled there', () => {
		expect(resolveTutorialsEnabledConfigurationTarget({ workspaceValue: false }, false)).toBe(vscode.ConfigurationTarget.Workspace);
		expect(resolveTutorialsEnabledConfigurationTarget({ workspaceFolderValue: false, workspaceValue: true }, true)).toBe(vscode.ConfigurationTarget.WorkspaceFolder);
		expect(resolveTutorialsEnabledConfigurationTarget({ globalValue: false }, false)).toBe(vscode.ConfigurationTarget.Global);
	});

	it('writes the enabled setting back to workspace scope when that scope disabled it', async () => {
		const update = vi.fn(async () => undefined);
		vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }] as any;
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			inspect: () => ({ workspaceValue: false }),
			update,
		} as any);

		await (TutorialViewerPanel.prototype as any).setTutorialsEnabled.call({}, true);

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('kustoWorkbench', vscode.workspace.workspaceFolders[0].uri);
		expect(update).toHaveBeenCalledWith('didYouKnow.enabled', true, vscode.ConfigurationTarget.Workspace);
	});
});
