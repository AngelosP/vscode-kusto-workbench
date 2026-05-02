import * as vscode from 'vscode';
import * as crypto from 'crypto';

/** Bump this when you change skill-template.md in a way that requires re-export. */
export const TEMPLATE_VERSION = 12;

export const SKILL_FILENAME = 'SKILL.md';
export const HTML_DASHBOARD_RULES_FILENAME = 'html-dashboard-rules.md';

const STATE_KEY = 'kusto.exportedSkills'; // globalState key
const EXPORTED_FILENAMES = [SKILL_FILENAME, HTML_DASHBOARD_RULES_FILENAME] as const;

export interface SkillExportFile {
	fileName: string;
	content: string;
}

interface ExportedSkillRecord {
	/** Absolute fsPath of the written SKILL.md file. */
	path: string;
	/** TEMPLATE_VERSION at time of last write. */
	templateVersion: number;
	/** Legacy SHA-256 of the SKILL.md content we last wrote. */
	contentFingerprint?: string;
	/** SHA-256 per exported file name, used to detect user edits. */
	fileFingerprints?: Record<string, string>;
	/** Exported files intentionally kept missing by the user. */
	missingFiles?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeContentFingerprint(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readExtensionText(extensionUri: vscode.Uri, ...segments: string[]): Promise<string> {
	const uri = vscode.Uri.joinPath(extensionUri, ...segments);
	const raw = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(raw).toString('utf8');
}

function ensureFinalNewline(content: string): string {
	return content.endsWith('\n') ? content : `${content}\n`;
}

export function createSkillExportFiles(templateContent: string, htmlDashboardRules: string): SkillExportFile[] {
	return [
		{ fileName: SKILL_FILENAME, content: ensureFinalNewline(templateContent.trimEnd()) },
		{ fileName: HTML_DASHBOARD_RULES_FILENAME, content: htmlDashboardRules },
	];
}

async function readSkillExportFiles(extensionUri: vscode.Uri): Promise<SkillExportFile[]> {
	const templateContent = await readExtensionText(extensionUri, 'media', 'skill-template.md');
	const htmlDashboardRules = await readExtensionText(extensionUri, 'copilot-instructions', 'html-dashboard-rules.md');
	return createSkillExportFiles(templateContent, htmlDashboardRules);
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

async function anyExportedFileExists(targetDir: vscode.Uri): Promise<boolean> {
	for (const fileName of EXPORTED_FILENAMES) {
		if (await fileExists(vscode.Uri.joinPath(targetDir, fileName))) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function createRecord(targetDir: vscode.Uri, files: SkillExportFile[]): ExportedSkillRecord {
	const fileFingerprints = Object.fromEntries(files.map(file => [file.fileName, computeContentFingerprint(file.content)]));
	const fileUri = vscode.Uri.joinPath(targetDir, SKILL_FILENAME);
	return {
		path: fileUri.fsPath,
		templateVersion: TEMPLATE_VERSION,
		contentFingerprint: fileFingerprints[SKILL_FILENAME],
		fileFingerprints,
	};
}

async function writeExportFiles(targetDir: vscode.Uri, files: SkillExportFile[]): Promise<ExportedSkillRecord> {
	await vscode.workspace.fs.createDirectory(targetDir);
	for (const file of files) {
		const fileUri = vscode.Uri.joinPath(targetDir, file.fileName);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(file.content, 'utf8'));
	}
	return createRecord(targetDir, files);
}

async function writeSkillFiles(targetDir: vscode.Uri, files: SkillExportFile[], state: vscode.Memento): Promise<void> {
	const record = await writeExportFiles(targetDir, files);
	const records = getRecords(state).filter(r => r.path !== record.path);
	records.push(record);
	await saveRecords(state, records);
}

function getPreviousFingerprint(record: ExportedSkillRecord, fileName: string): string | undefined {
	return record.fileFingerprints?.[fileName] ?? (fileName === SKILL_FILENAME ? record.contentFingerprint : undefined);
}

interface ExportFileDiskState {
	fileName: string;
	uri: vscode.Uri;
	expectedContent: string;
	exists: boolean;
	diskContent: string;
	diskFingerprint?: string;
	previousFingerprint?: string;
	intentionallyMissing: boolean;
	changed: boolean;
}

async function inspectExportFiles(record: ExportedSkillRecord, targetDir: vscode.Uri, files: SkillExportFile[]): Promise<ExportFileDiskState[]> {
	const states: ExportFileDiskState[] = [];
	for (const file of files) {
		const uri = vscode.Uri.joinPath(targetDir, file.fileName);
		const previousFingerprint = getPreviousFingerprint(record, file.fileName);
		const intentionallyMissing = record.missingFiles?.includes(file.fileName) ?? false;
		const exists = await fileExists(uri);
		let diskContent = '';
		let diskFingerprint: string | undefined;
		if (exists) {
			const diskRaw = await vscode.workspace.fs.readFile(uri);
			diskContent = Buffer.from(diskRaw).toString('utf8');
			diskFingerprint = computeContentFingerprint(diskContent);
		}

		states.push({
			fileName: file.fileName,
			uri,
			expectedContent: file.content,
			exists,
			diskContent,
			diskFingerprint,
			previousFingerprint,
			intentionallyMissing,
			changed: intentionallyMissing ? exists : previousFingerprint ? diskFingerprint !== previousFingerprint : exists,
		});
	}
	return states;
}

async function createRecordFromDisk(record: ExportedSkillRecord, targetDir: vscode.Uri, files: SkillExportFile[]): Promise<ExportedSkillRecord> {
	const fileFingerprints: Record<string, string> = {};
	const missingFiles: string[] = [];
	for (const file of files) {
		const uri = vscode.Uri.joinPath(targetDir, file.fileName);
		if (!await fileExists(uri)) {
			if (getPreviousFingerprint(record, file.fileName) || record.missingFiles?.includes(file.fileName)) {
				missingFiles.push(file.fileName);
			}
			continue;
		}
		const diskRaw = await vscode.workspace.fs.readFile(uri);
		fileFingerprints[file.fileName] = computeContentFingerprint(Buffer.from(diskRaw).toString('utf8'));
	}
	return {
		path: record.path,
		templateVersion: TEMPLATE_VERSION,
		contentFingerprint: fileFingerprints[SKILL_FILENAME] ?? record.contentFingerprint,
		fileFingerprints,
		missingFiles: missingFiles.length > 0 ? missingFiles : undefined,
	};
}

async function getManualExportConflicts(targetDir: vscode.Uri, record: ExportedSkillRecord | undefined): Promise<string[]> {
	const conflicts: string[] = [];
	for (const fileName of EXPORTED_FILENAMES) {
		const uri = vscode.Uri.joinPath(targetDir, fileName);
		if (!await fileExists(uri)) {
			continue;
		}
		const previousFingerprint = record ? getPreviousFingerprint(record, fileName) : undefined;
		if (!previousFingerprint) {
			conflicts.push(vscode.workspace.asRelativePath(uri));
			continue;
		}
		const diskRaw = await vscode.workspace.fs.readFile(uri);
		const diskFingerprint = computeContentFingerprint(Buffer.from(diskRaw).toString('utf8'));
		if (diskFingerprint !== previousFingerprint) {
			conflicts.push(vscode.workspace.asRelativePath(uri));
		}
	}
	return conflicts;
}

async function createUntitledDocument(pathHint: string, content: string): Promise<vscode.TextDocument> {
	const uri = vscode.Uri.parse(`untitled:${pathHint}`);
	const doc = await vscode.workspace.openTextDocument(uri);
	const edit = new vscode.WorkspaceEdit();
	edit.insert(uri, new vscode.Position(0, 0), content);
	await vscode.workspace.applyEdit(edit);
	return doc;
}

async function showExportFileDiff(state: ExportFileDiskState): Promise<void> {
	const updatedDoc = await createUntitledDocument(`${state.uri.fsPath}.updated`, state.expectedContent);
	if (state.exists) {
		await vscode.commands.executeCommand('vscode.diff', state.uri, updatedDoc.uri, `Skill ${state.fileName}: Current ↔ Updated`);
		return;
	}

	const currentDoc = await createUntitledDocument(`${state.uri.fsPath}.current`, '');
	await vscode.commands.executeCommand('vscode.diff', currentDoc.uri, updatedDoc.uri, `Skill ${state.fileName}: Current ↔ Updated`);
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

export async function checkAndUpdateSkillFiles(context: vscode.ExtensionContext): Promise<void> {
	const records = getRecords(context.globalState);
	if (records.length === 0) {
		return;
	}

	let exportFiles: SkillExportFile[] | undefined;

	const updatedRecords: ExportedSkillRecord[] = [];

	for (const record of records) {
		const fileUri = vscode.Uri.file(record.path);
		const targetDir = vscode.Uri.joinPath(fileUri, '..');

		// If the whole export folder was deleted, drop the record silently.
		if (!await anyExportedFileExists(targetDir)) {
			continue;
		}

		// Load export files lazily once a tracked export still exists.
		if (exportFiles === undefined) {
			exportFiles = await readSkillExportFiles(context.extensionUri);
		}

		const diskStates = await inspectExportFiles(record, targetDir, exportFiles);
		const changedStates = diskStates.filter(state => state.changed);
		const missingUntrackedStates = diskStates.filter(state => !state.exists && !state.previousFingerprint && !state.intentionallyMissing);

		if (changedStates.length === 0) {
			if (record.templateVersion === TEMPLATE_VERSION && missingUntrackedStates.length === 0) {
				updatedRecords.push(record);
			} else {
				// Files untouched by user, or a current legacy record lacks the new sidecar — silent write.
				updatedRecords.push(await writeExportFiles(targetDir, exportFiles));
			}
		} else {
			// User customized or created at least one exported file — show diffs and ask.
			const changedPaths = changedStates.map(state => vscode.workspace.asRelativePath(state.uri)).join(', ');
			const message = record.templateVersion === TEMPLATE_VERSION
				? `Kusto Workbench exported skill files no longer match the tracked export: ${changedPaths}.`
				: `Kusto Workbench has an updated skill export. These files have local edits or conflicts: ${changedPaths}.`;
			const pick = await vscode.window.showInformationMessage(
				message,
				'Overwrite with new template',
				'Keep my version',
				'Show diffs',
			);

			if (pick === 'Overwrite with new template') {
				updatedRecords.push(await writeExportFiles(targetDir, exportFiles));
			} else if (pick === 'Show diffs') {
				for (const state of changedStates) {
					await showExportFileDiff(state);
				}
				// Keep old record — user can re-export or next activation will ask again.
				updatedRecords.push(record);
			} else if (pick === 'Keep my version') {
				// "Keep my version" — update templateVersion so we don't ask again.
				updatedRecords.push(await createRecordFromDisk(record, targetDir, exportFiles));
			} else {
				// Dismissed prompt — ask again next activation.
				updatedRecords.push(record);
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
	const conflicts = await getManualExportConflicts(picked.targetDir, existingRecord);
	if (conflicts.length > 0) {
		const overwrite = await vscode.window.showWarningMessage(
			`${conflicts.join(', ')} already have local edits or would be overwritten. Overwrite?`,
			'Overwrite',
			'Cancel',
		);
		if (overwrite !== 'Overwrite') {
			return;
		}
	}

	const exportFiles = await readSkillExportFiles(context.extensionUri);
	await writeSkillFiles(picked.targetDir, exportFiles, context.globalState);

	const relPath = vscode.workspace.asRelativePath(picked.targetDir);
	void vscode.window.showInformationMessage(`Exported Kusto Workbench skill to ${relPath}`);
}
