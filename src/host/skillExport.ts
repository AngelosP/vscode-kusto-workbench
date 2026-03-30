import * as vscode from 'vscode';
import * as crypto from 'crypto';

/** Bump this when you change skill-template.md in a way that requires re-export. */
const TEMPLATE_VERSION = 2;

const SKILL_FILENAME = 'SKILL.md';
const STATE_KEY = 'kusto.exportedSkills'; // globalState key

interface ExportedSkillRecord {
	/** Absolute fsPath of the written file. */
	path: string;
	/** TEMPLATE_VERSION at time of last write. */
	templateVersion: number;
	/** SHA-256 of the content we last wrote (detects user edits). */
	contentFingerprint: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeContentFingerprint(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readTemplate(extensionUri: vscode.Uri): Promise<string> {
	const templateUri = vscode.Uri.joinPath(extensionUri, 'media', 'skill-template.md');
	const raw = await vscode.workspace.fs.readFile(templateUri);
	return Buffer.from(raw).toString('utf8');
}

function getRecords(state: vscode.Memento): ExportedSkillRecord[] {
	return state.get<ExportedSkillRecord[]>(STATE_KEY, []);
}

async function saveRecords(state: vscode.Memento, records: ExportedSkillRecord[]): Promise<void> {
	await state.update(STATE_KEY, records);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function writeSkillFile(
	targetDir: vscode.Uri,
	content: string,
	state: vscode.Memento,
): Promise<void> {
	const fileUri = vscode.Uri.joinPath(targetDir, SKILL_FILENAME);
	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));

	const fingerprint = computeContentFingerprint(content);
	const records = getRecords(state).filter(r => r.path !== fileUri.fsPath);
	records.push({ path: fileUri.fsPath, templateVersion: TEMPLATE_VERSION, contentFingerprint: fingerprint });
	await saveRecords(state, records);
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

export async function checkAndUpdateSkillFiles(context: vscode.ExtensionContext): Promise<void> {
	const records = getRecords(context.globalState);
	if (records.length === 0) {
		return;
	}

	let templateContent: string | undefined;

	const updatedRecords: ExportedSkillRecord[] = [];

	for (const record of records) {
		const fileUri = vscode.Uri.file(record.path);

		// If the file was deleted, drop the record silently.
		if (!await fileExists(fileUri)) {
			continue;
		}

		// Nothing to do if already on current template version.
		if (record.templateVersion === TEMPLATE_VERSION) {
			updatedRecords.push(record);
			continue;
		}

		// Template changed — load it lazily.
		if (templateContent === undefined) {
			templateContent = await readTemplate(context.extensionUri);
		}

		const diskRaw = await vscode.workspace.fs.readFile(fileUri);
		const diskContent = Buffer.from(diskRaw).toString('utf8');
		const diskFingerprint = computeContentFingerprint(diskContent);

		if (diskFingerprint === record.contentFingerprint) {
			// File untouched by user — silent overwrite.
			await writeSkillFile(vscode.Uri.joinPath(fileUri, '..'), templateContent, context.globalState);
			updatedRecords.push({
				path: record.path,
				templateVersion: TEMPLATE_VERSION,
				contentFingerprint: computeContentFingerprint(templateContent),
			});
		} else {
			// User customized the file — show diff and ask.
			const pick = await vscode.window.showInformationMessage(
				`Kusto Workbench has an updated skill template. Your file "${vscode.workspace.asRelativePath(fileUri)}" has local edits.`,
				'Overwrite with new template',
				'Keep my version',
				'Show diff',
			);

			if (pick === 'Overwrite with new template') {
				await writeSkillFile(vscode.Uri.joinPath(fileUri, '..'), templateContent, context.globalState);
				updatedRecords.push({
					path: record.path,
					templateVersion: TEMPLATE_VERSION,
					contentFingerprint: computeContentFingerprint(templateContent),
				});
			} else if (pick === 'Show diff') {
				// Create a virtual document with the new template for diffing.
				const newTemplateUri = vscode.Uri.parse(`untitled:${record.path}.new`);
				const doc = await vscode.workspace.openTextDocument(newTemplateUri);
				const edit = new vscode.WorkspaceEdit();
				edit.insert(newTemplateUri, new vscode.Position(0, 0), templateContent);
				await vscode.workspace.applyEdit(edit);
				await vscode.commands.executeCommand('vscode.diff', fileUri, doc.uri, 'Skill: Current ↔ Updated');
				// Keep old record — user can re-export or next activation will ask again.
				updatedRecords.push(record);
			} else {
				// "Keep my version" — update templateVersion so we don't ask again.
				updatedRecords.push({
					path: record.path,
					templateVersion: TEMPLATE_VERSION,
					contentFingerprint: diskFingerprint,
				});
			}
		}
	}

	await saveRecords(context.globalState, updatedRecords);
}

// ---------------------------------------------------------------------------
// Export command
// ---------------------------------------------------------------------------

export async function exportSkillCommand(context: vscode.ExtensionContext): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		void vscode.window.showWarningMessage('Open a workspace folder first to export the Kusto Workbench skill.');
		return;
	}

	const rootUri = workspaceFolders[0].uri;

	interface DestinationItem extends vscode.QuickPickItem {
		targetDir: vscode.Uri;
	}

	const destinations: DestinationItem[] = [
		{
			label: '$(globe) .github/skills/kusto-workbench',
			description: 'Share with your team via source control',
			targetDir: vscode.Uri.joinPath(rootUri, '.github', 'skills', 'kusto-workbench'),
		},
		{
			label: '$(lock) .vscode/skills/kusto-workbench',
			description: 'Local only (gitignored by convention)',
			targetDir: vscode.Uri.joinPath(rootUri, '.vscode', 'skills', 'kusto-workbench'),
		},
	];

	const picked = await vscode.window.showQuickPick(destinations, {
		placeHolder: 'Where should the Kusto Workbench skill be exported?',
	});
	if (!picked) {
		return;
	}

	const targetFileUri = vscode.Uri.joinPath(picked.targetDir, SKILL_FILENAME);

	// Check for existing non-tracked file (e.g. manually created).
	const records = getRecords(context.globalState);
	const existingRecord = records.find(r => r.path === targetFileUri.fsPath);
	if (!existingRecord && await fileExists(targetFileUri)) {
		const overwrite = await vscode.window.showWarningMessage(
			`${vscode.workspace.asRelativePath(targetFileUri)} already exists. Overwrite?`,
			'Overwrite',
			'Cancel',
		);
		if (overwrite !== 'Overwrite') {
			return;
		}
	}

	const templateContent = await readTemplate(context.extensionUri);
	await writeSkillFile(picked.targetDir, templateContent, context.globalState);

	const relPath = vscode.workspace.asRelativePath(targetFileUri);
	void vscode.window.showInformationMessage(`Exported Kusto Workbench skill to ${relPath}`);
}
