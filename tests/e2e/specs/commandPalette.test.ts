/**
 * E2E Test: Command palette interactions.
 *
 * Tests that various Kusto Workbench commands are available and functional
 * when invoked from the VS Code command palette.
 */
import { expect } from 'chai';
import {
	EditorView,
	Workbench,
} from 'vscode-extension-tester';
import {
	KustoEditorPage,
	executeCommand,
	closeAllEditors,
	sleep,
} from '../pageObjects';

describe('Command Palette Operations', function () {
	this.timeout(120_000);

	before(async function () {
		await sleep(5_000);
	});

	afterEach(async function () {
		await closeAllEditors();
	});

	it('should list Kusto Workbench commands in the command palette', async function () {
		const workbench = new Workbench();
		const input = await workbench.openCommandPrompt();
		await input.setText('>Kusto Workbench');
		await sleep(1_500);

		const picks = await input.getQuickPicks();
		const titles = await Promise.all(picks.map((p) => p.getLabel()));

		expect(titles.length).to.be.greaterThan(0);
		expect(titles.some((t) => t.includes('Kusto Workbench'))).to.be.true;

		await input.cancel();
	});

	it('should open the Query Editor via command palette', async function () {
		await executeCommand('Kusto Workbench: Open Query Editor');
		await sleep(8_000);

		const editorView = new EditorView();
		const titles = await editorView.getOpenEditorTitles();
		expect(titles.length).to.be.greaterThanOrEqual(1);
	});

	it('should open Manage Connections via command palette', async function () {
		await executeCommand('Kusto Workbench: Manage Connections');
		await sleep(3_000);

		const workbench = new Workbench();
		const notifs = await workbench.getNotifications();
		for (const n of notifs) {
			const type = await n.getType();
			expect(type.toString().toLowerCase()).to.not.include('error');
		}
	});

	it('should add a new query section after opening Query Editor', async function () {
		await executeCommand('Kusto Workbench: Open Query Editor');
		await sleep(8_000);

		const editorPage = new KustoEditorPage();
		await editorPage.switchToWebview();

		const initialBoxes = await editorPage.getQueryBoxes();
		const initialCount = initialBoxes.length;

		await editorPage.addSection('query');
		await sleep(2_000);

		const updatedBoxes = await editorPage.getQueryBoxes();
		expect(updatedBoxes.length).to.equal(initialCount + 1);

		await editorPage.switchBack();
	});
});
