import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const transientNetworkPattern = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\bHTTP(?: status)?\s*(?:429|502|503|504)\b|@vscode\/test-electron request timeout out after \d+ms/i;
const vscodeDownloadPattern = /Downloading VS Code|Error downloading|update\.code\.visualstudio\.com/i;
const vscodeLaunchPattern = /Launching VS Code|VS Code launched|Extension Development Host/i;

export function resolveManagedWorkspacePath(template, environment = process.env) {
	if (typeof template !== 'string' || template.trim() === '') {
		throw new Error('Managed E2E workspace path must be a nonempty string.');
	}
	const expanded = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
		const value = environment[name];
		if (!value) {
			throw new Error(`Managed E2E workspace path requires environment variable ${name}.`);
		}
		return value;
	});
	if (expanded.includes('${')) {
		throw new Error(`Managed E2E workspace path contains an invalid environment placeholder: ${template}`);
	}
	if (!path.isAbsolute(expanded)) {
		throw new Error(`Managed E2E workspace path must resolve to an absolute path: ${template}`);
	}
	return path.normalize(expanded);
}

export function normalizeManagedWorkspaceOwner(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Managed E2E workspace owner must be an object.');
	}
	const keys = Object.keys(value).sort();
	if (keys.join(',') !== 'content,markerName') {
		throw new Error('Managed E2E workspace owner must contain only markerName and content.');
	}
	if (typeof value.markerName !== 'string' || value.markerName === ''
		|| value.markerName === '.' || value.markerName === '..'
		|| path.basename(value.markerName) !== value.markerName
		|| /[\\/]/.test(value.markerName)) {
		throw new Error('Managed E2E workspace owner markerName must be one file name.');
	}
	if (typeof value.content !== 'string' || value.content === '') {
		throw new Error('Managed E2E workspace owner content must be a nonempty string.');
	}
	return { markerName: value.markerName, content: value.content };
}

export function validateE2eWorkspaceConfiguration({ workspaceSettings, managedWorkspacePath, managedWorkspaceOwner }) {
	if (workspaceSettings && managedWorkspacePath) {
		throw new Error('workspaceSettings and managedWorkspacePath cannot be used together.');
	}
	if (managedWorkspaceOwner && !managedWorkspacePath) {
		throw new Error('managedWorkspaceOwner requires managedWorkspacePath.');
	}
}

function readWorkspaceFolderPaths(metadataPath) {
	const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
	const hasFolder = Object.hasOwn(metadata, 'folder');
	const hasWorkspace = Object.hasOwn(metadata, 'workspace');
	if (hasFolder === hasWorkspace) {
		return null;
	}
	if (hasFolder) {
		if (typeof metadata.folder !== 'string') {
			return null;
		}
		return [fileURLToPath(metadata.folder)];
	}
	if (typeof metadata.workspace !== 'string') {
		return null;
	}

	const workspaceFilePath = fileURLToPath(metadata.workspace);
	const workspace = JSON.parse(readFileSync(workspaceFilePath, 'utf8'));
	if (!Array.isArray(workspace.folders)) {
		return null;
	}
	const folderPaths = [];
	for (const folder of workspace.folders) {
		if (!folder || typeof folder !== 'object' || Array.isArray(folder)) {
			return null;
		}
		const hasPath = Object.hasOwn(folder, 'path');
		const hasUri = Object.hasOwn(folder, 'uri');
		if (hasPath === hasUri) {
			return null;
		}
		if (hasPath) {
			if (typeof folder.path !== 'string') {
				return null;
			}
			folderPaths.push(path.isAbsolute(folder.path)
				? folder.path
				: path.resolve(path.dirname(workspaceFilePath), folder.path));
		} else {
			if (typeof folder.uri !== 'string') {
				return null;
			}
			folderPaths.push(fileURLToPath(folder.uri));
		}
	}
	return folderPaths;
}

function isPathWithin(candidate, root) {
	const relative = path.relative(root, candidate);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNewUntitledWorkspaceTombstone(metadataPath, storageRoot, entryName, entryNamesBefore) {
	if (!(entryNamesBefore instanceof Set) || entryNamesBefore.has(entryName)) {
		return false;
	}
	try {
		const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
		if (!Object.hasOwn(metadata, 'workspace') || Object.hasOwn(metadata, 'folder') || typeof metadata.workspace !== 'string') {
			return false;
		}
		const workspaceFilePath = fileURLToPath(metadata.workspace);
		if (existsSync(workspaceFilePath)) {
			return false;
		}
		const profileWorkspacesRoot = path.resolve(storageRoot, '..', '..', 'Workspaces');
		return isPathWithin(workspaceFilePath, profileWorkspacesRoot);
	} catch {
		return false;
	}
}

export function findManagedWorkspaceStorageEntries({
	profile,
	storageRoot,
	workspaceDir,
	allowlist = new Set(),
	entryNamesBefore,
}) {
	if (!workspaceDir || !existsSync(storageRoot)) {
		return [];
	}
	const comparablePath = value => {
		const resolved = path.resolve(value);
		let canonical = resolved;
		try {
			canonical = (realpathSync.native || realpathSync)(resolved);
		} catch {
			// Missing paths cannot be canonicalized; retain exact absolute comparison.
		}
		return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
	};
	const expected = comparablePath(workspaceDir);
	return readdirSync(storageRoot, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && !allowlist.has(entry.name))
		.sort((left, right) => left.name.localeCompare(right.name))
		.filter(entry => {
			const metadataPath = path.join(storageRoot, entry.name, 'workspace.json');
			try {
				const folderPaths = readWorkspaceFolderPaths(metadataPath);
				return folderPaths?.length === 1 && comparablePath(folderPaths[0]) === expected;
			} catch {
				return isNewUntitledWorkspaceTombstone(metadataPath, storageRoot, entry.name, entryNamesBefore);
			}
		})
		.map(entry => ({
			profile,
			name: entry.name,
			path: path.join(storageRoot, entry.name),
			kind: 'directory',
		}));
}

export function movePathWithCrossDeviceFallback(source, target, operations = { renameSync, cpSync, rmSync }) {
	try {
		operations.renameSync(source, target);
	} catch (error) {
		if (!error || typeof error !== 'object' || error.code !== 'EXDEV') {
			throw error;
		}
		operations.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
		operations.rmSync(source, { recursive: true, force: true });
	}
}

export function repairResidueEntries(
	residueEntries,
	backupRoot,
	operations = { lstatSync, mkdirSync, movePathWithCrossDeviceFallback },
) {
	const repaired = [];
	const errors = [];
	for (const residue of residueEntries) {
		const profileBackupRoot = path.join(backupRoot, residue.profile);
		const target = path.join(profileBackupRoot, residue.name);
		try {
			const sourceStat = operations.lstatSync(residue.path, { throwIfNoEntry: false });
			if (!sourceStat) {
				continue;
			}
			operations.mkdirSync(profileBackupRoot, { recursive: true });
			operations.movePathWithCrossDeviceFallback(residue.path, target);
			repaired.push({ ...residue, repairedTo: target });
		} catch (error) {
			errors.push({
				...residue,
				target,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { repaired, errors };
}

export function cleanupOwnedManagedWorkspace({
	workspaceDir,
	owner,
	protectedRoot,
	operations = { lstatSync, readFileSync, realpathSync, rmSync },
}) {
	if (!owner) {
		return { removed: false, reason: 'not-configured' };
	}
	const rootStat = operations.lstatSync(workspaceDir, { throwIfNoEntry: false });
	if (!rootStat) {
		return { removed: false, reason: 'missing' };
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error(`Managed E2E workspace root is a link or has the wrong type: ${workspaceDir}`);
	}
	const canonicalWorkspace = (operations.realpathSync.native || operations.realpathSync)(workspaceDir);
	const canonicalProtectedRoot = (operations.realpathSync.native || operations.realpathSync)(protectedRoot);
	if (isPathWithin(canonicalWorkspace, canonicalProtectedRoot)
		|| isPathWithin(canonicalProtectedRoot, canonicalWorkspace)) {
		throw new Error(`Managed E2E workspace overlaps the protected root: ${workspaceDir}`);
	}
	const markerPath = path.join(workspaceDir, owner.markerName);
	const markerStat = operations.lstatSync(markerPath, { throwIfNoEntry: false });
	if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.nlink !== 1) {
		throw new Error(`Managed E2E workspace ownership marker is invalid: ${markerPath}`);
	}
	const canonicalMarker = (operations.realpathSync.native || operations.realpathSync)(markerPath);
	if (!isPathWithin(canonicalMarker, canonicalWorkspace)) {
		throw new Error(`Managed E2E workspace ownership marker escaped its root: ${markerPath}`);
	}
	if (operations.readFileSync(markerPath, 'utf8') !== owner.content) {
		throw new Error(`Managed E2E workspace ownership marker has unexpected content: ${markerPath}`);
	}
	operations.rmSync(workspaceDir, { recursive: true, force: false });
	if (operations.lstatSync(workspaceDir, { throwIfNoEntry: false })) {
		throw new Error(`Managed E2E workspace remained after cleanup: ${workspaceDir}`);
	}
	return { removed: true, path: workspaceDir, markerPath };
}

export function runWithGuaranteedCleanup(operation, cleanup) {
	let value;
	let operationError;
	try {
		value = operation();
	} catch (error) {
		operationError = error;
	}

	let cleanupValue;
	let cleanupError;
	try {
		cleanupValue = cleanup();
	} catch (error) {
		cleanupError = error;
	}

	return { value, operationError, cleanupValue, cleanupError };
}

export function selectE2eShard(cases, shardIndex, shardCount) {
	if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
		throw new Error('E2E shard count must be a positive integer.');
	}
	if (!Number.isSafeInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
		throw new Error(`E2E shard index must be between 1 and ${shardCount}.`);
	}
	return cases.filter((_testCase, index) => index % shardCount === shardIndex - 1);
}

export function shouldRetryVscodeBootstrapFailure({ status, output, hasStructuredResults = false }) {
	if (status === 0 || hasStructuredResults) return false;
	const text = String(output || '');
	return vscodeDownloadPattern.test(text)
		&& transientNetworkPattern.test(text)
		&& !vscodeLaunchPattern.test(text);
}