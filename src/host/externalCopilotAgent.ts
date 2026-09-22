import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const AGENT_FILE_NAME = 'kusto-workbench.agent.md';
const MANAGED_MARKER_PREFIX = '<!-- Managed by Kusto Workbench. Source SHA-256: ';
const MANAGED_MARKER_PATTERN = /\n<!-- Managed by Kusto Workbench\. Source SHA-256: ([a-f0-9]{64}) -->\r?\n?$/;
const ANY_MANAGED_MARKER_PATTERN = /<!-- Managed by Kusto Workbench\. Source SHA-256: [a-f0-9]{64} -->/;

export type CopilotCliAgentStatus = 'installed' | 'current' | 'updated';

export interface CopilotCliAgentResult {
	readonly changed: boolean;
	readonly status: CopilotCliAgentStatus;
	readonly agentPath: string;
	readonly rollback?: () => Promise<void>;
}

export interface ManagedExternalCustomizationResult {
	readonly changed: boolean;
	readonly status: CopilotCliAgentStatus;
	readonly path: string;
	readonly rollback?: () => Promise<void>;
}

function sha256(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizedSourceContent(sourceContent: string): string {
	return `${sourceContent.trimEnd()}\n`;
}

export function createManagedCopilotCliAgentContent(sourceContent: string): string {
	const normalized = normalizedSourceContent(sourceContent);
	return `${normalized}\n${MANAGED_MARKER_PREFIX}${sha256(normalized)} -->\n`;
}

export function resolveCopilotHomeDirectory(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	userHomeDirectory = homedir(),
): string {
	return environment.COPILOT_HOME?.trim() || join(userHomeDirectory, '.copilot');
}

function inspectManagedAgent(content: string): { managed: boolean; unchanged: boolean } {
	const marker = MANAGED_MARKER_PATTERN.exec(content);
	if (!marker) return { managed: ANY_MANAGED_MARKER_PATTERN.test(content), unchanged: false };
	const sourceContent = content.slice(0, marker.index);
	return { managed: true, unchanged: sha256(sourceContent) === marker[1] };
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

function changedDuringMessage(artifactName: string, path: string, action: string): string {
	return `The ${artifactName} at ${path} changed during ${action} and the concurrent file was left untouched.`;
}

async function stageContent(path: string, content: string): Promise<string> {
	const staged = `${path}.${randomUUID()}.tmp`;
	await writeFile(staged, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	return staged;
}

async function publishExclusive(staged: string, destination: string): Promise<void> {
	await link(staged, destination);
}

async function quarantineExpected(
	path: string,
	expected: string,
	artifactName: string,
	action: string,
): Promise<string> {
	const quarantine = `${path}.${randomUUID()}.quarantine`;
	try {
		await rename(path, quarantine);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(changedDuringMessage(artifactName, path, action));
		}
		throw error;
	}
	const quarantined = await readFile(quarantine, 'utf8');
	if (quarantined === expected) return quarantine;
	try {
		await link(quarantine, path);
		await rm(quarantine);
	} catch (restoreError) {
		throw new AggregateError(
			[restoreError],
			`${changedDuringMessage(artifactName, path, action)} Prior bytes remain at ${quarantine}.`,
		);
	}
	throw new Error(changedDuringMessage(artifactName, path, action));
}

async function restoreKnownQuarantine(
	quarantine: string,
	path: string,
	artifactName: string,
	action: string,
): Promise<void> {
	if (await readOptional(path) !== undefined) {
		await rm(quarantine, { force: true });
		return;
	}
	try {
		await link(quarantine, path);
		await rm(quarantine);
	} catch (restoreError) {
		if ((restoreError as NodeJS.ErrnoException).code === 'EEXIST') {
			await rm(quarantine, { force: true });
			return;
		}
		throw new AggregateError(
			[restoreError],
			`${changedDuringMessage(artifactName, path, action)} Prior managed bytes remain at ${quarantine}.`,
		);
	}
}

async function replaceManagedContent(options: {
	path: string;
	expected: string;
	desired: string;
	artifactName: string;
	action: string;
	beforeCommit?: () => Promise<void>;
}): Promise<void> {
	const staged = await stageContent(options.path, options.desired);
	let quarantine: string | undefined;
	try {
		quarantine = await quarantineExpected(
			options.path,
			options.expected,
			options.artifactName,
			options.action,
		);
		await options.beforeCommit?.();
		try {
			await publishExclusive(staged, options.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new Error(changedDuringMessage(options.artifactName, options.path, options.action));
			}
			throw error;
		}
		await rm(quarantine, { force: true }).catch(() => undefined);
		quarantine = undefined;
	} catch (error) {
		if (quarantine) {
			await restoreKnownQuarantine(
				quarantine,
				options.path,
				options.artifactName,
				options.action,
			);
		}
		throw error;
	} finally {
		await rm(staged, { force: true });
	}
}

export async function reconcileManagedExternalCustomization(options: {
	readonly path: string;
	readonly sourceContent: string;
	readonly artifactName: string;
	readonly beforeCommit?: () => Promise<void>;
}): Promise<ManagedExternalCustomizationResult> {
	const artifactPath = options.path;
	const desired = createManagedCopilotCliAgentContent(options.sourceContent);
	await mkdir(dirname(artifactPath), { recursive: true });
	const previous = await readOptional(artifactPath);
	if (previous === undefined) {
		const staged = await stageContent(artifactPath, desired);
		try {
			await publishExclusive(staged, artifactPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				return reconcileManagedExternalCustomization(options);
			}
			throw error;
		} finally {
			await rm(staged, { force: true });
		}
		return {
			changed: true,
			status: 'installed',
			path: artifactPath,
			rollback: async () => {
				await removeManagedExternalCustomization({
					path: artifactPath,
					artifactName: options.artifactName,
				});
			},
		};
	}
	const inspected = inspectManagedAgent(previous);
	if (!inspected.managed) {
		throw new Error(`The existing ${options.artifactName} at ${artifactPath} is not managed by Kusto Workbench and was not modified.`);
	}
	if (!inspected.unchanged) {
		throw new Error(`The existing ${options.artifactName} at ${artifactPath} is user-edited and was not modified.`);
	}
	if (previous === desired) return { changed: false, status: 'current', path: artifactPath };

	await replaceManagedContent({
		path: artifactPath,
		expected: previous,
		desired,
		artifactName: options.artifactName,
		action: 'update',
		beforeCommit: options.beforeCommit,
	});
	return {
		changed: true,
		status: 'updated',
		path: artifactPath,
		rollback: async () => {
			await replaceManagedContent({
				path: artifactPath,
				expected: desired,
				desired: previous,
				artifactName: options.artifactName,
				action: 'rollback',
			});
		},
	};
}

export async function removeManagedExternalCustomization(options: {
	readonly path: string;
	readonly artifactName: string;
	readonly beforeCommit?: () => Promise<void>;
}): Promise<{ removed: boolean; path: string }> {
	const artifactPath = options.path;
	const content = await readOptional(artifactPath);
	if (content === undefined) return { removed: false, path: artifactPath };
	const inspected = inspectManagedAgent(content);
	if (!inspected.managed) {
		throw new Error(`The ${options.artifactName} at ${artifactPath} is not managed by Kusto Workbench and was not removed.`);
	}
	if (!inspected.unchanged) {
		throw new Error(`The ${options.artifactName} at ${artifactPath} is user-edited and was not removed.`);
	}
	const quarantine = await quarantineExpected(artifactPath, content, options.artifactName, 'removal');
	try {
		await options.beforeCommit?.();
		if (await readOptional(artifactPath) !== undefined) {
			throw new Error(changedDuringMessage(options.artifactName, artifactPath, 'removal'));
		}
		await rm(quarantine);
	} catch (error) {
		await restoreKnownQuarantine(quarantine, artifactPath, options.artifactName, 'removal');
		throw error;
	}
	return { removed: true, path: artifactPath };
}

export async function reconcileCopilotCliAgent(options: {
	readonly sourceContent: string;
	readonly copilotHomeDirectory?: string;
}): Promise<CopilotCliAgentResult> {
	const copilotHomeDirectory = options.copilotHomeDirectory ?? resolveCopilotHomeDirectory();
	const managed = await reconcileManagedExternalCustomization({
		path: join(copilotHomeDirectory, 'agents', AGENT_FILE_NAME),
		sourceContent: options.sourceContent,
		artifactName: 'Copilot CLI agent',
	});
	return {
		changed: managed.changed,
		status: managed.status,
		agentPath: managed.path,
		...(managed.rollback ? { rollback: managed.rollback } : {}),
	};
}

export async function removeCopilotCliAgent(options: {
	readonly copilotHomeDirectory?: string;
} = {}): Promise<{ removed: boolean; agentPath: string }> {
	const copilotHomeDirectory = options.copilotHomeDirectory ?? resolveCopilotHomeDirectory();
	const removed = await removeManagedExternalCustomization({
		path: join(copilotHomeDirectory, 'agents', AGENT_FILE_NAME),
		artifactName: 'Copilot CLI agent',
	});
	return { removed: removed.removed, agentPath: removed.path };
}