import * as vscode from 'vscode';

import { validatePowerBiHtmlBindings, type PowerBiExportInput } from './powerBiExport';
import {
	compilePowerBiProjectArtifacts,
	type PowerBiProjectArtifactManifest,
} from './powerBiProjectArtifacts';

export interface PowerBiProjectWriteOptions {
	readonly signal?: AbortSignal;
	readonly commitOnFirstWrite?: boolean;
}

function parentDirectories(manifest: PowerBiProjectArtifactManifest): string[] {
	const directories = new Set<string>();
	for (const artifact of manifest.artifacts) {
		const segments = artifact.path.split('/');
		segments.pop();
		for (let length = 1; length <= segments.length; length++) {
			directories.add(segments.slice(0, length).join('/'));
		}
	}
	return [...directories].sort((left, right) => {
		const depthDifference = left.split('/').length - right.split('/').length;
		if (depthDifference !== 0) return depthDifference;
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

export async function writePowerBiProjectArtifacts(
	manifest: PowerBiProjectArtifactManifest,
	folderUri: vscode.Uri,
	options?: PowerBiProjectWriteOptions,
): Promise<void> {
	let externalWriteCommitted = false;
	const admitWrite = (): void => {
		if (options?.commitOnFirstWrite === false) {
			if (!options.signal?.aborted) return;
			const error = new Error('Power BI export preparation canceled.');
			error.name = 'AbortError';
			throw error;
		}
		if (externalWriteCommitted) return;
		if (options?.signal?.aborted) {
			const error = new Error('Power BI export canceled before external commit.');
			error.name = 'AbortError';
			throw error;
		}
		externalWriteCommitted = true;
	};

	for (const directory of parentDirectories(manifest)) {
		admitWrite();
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folderUri, directory));
	}
	for (const artifact of manifest.artifacts) {
		admitWrite();
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(folderUri, artifact.path),
			Uint8Array.from(artifact.bytes),
		);
	}
}

export async function exportHtmlToPowerBI(
	input: PowerBiExportInput,
	folderUri: vscode.Uri,
	options?: PowerBiProjectWriteOptions,
): Promise<void> {
	const portableDashboard = validatePowerBiHtmlBindings(input.htmlCode, input.dataSources);
	const manifest = compilePowerBiProjectArtifacts(input, portableDashboard);
	await writePowerBiProjectArtifacts(manifest, folderUri, options);
}