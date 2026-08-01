import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import * as vscode from 'vscode';
import { isDeepStrictEqual } from 'util';

import type { KqlxFileV1, KqlxStateV1 } from './kqlxFormat';
import { hasAmbiguousCompatIdlessSections } from './compatSidecarFormat';
import { publishOwnedFileText } from './ownedFilePublication';

export type CompatSidecarRepair = Readonly<{
	file: KqlxFileV1;
	inputText: string;
	text: string;
	identity?: CompatSidecarFileIdentity;
}>;

export type CompatSidecarFileIdentity = Readonly<{
	device: number;
	inode: number;
	realPathKey: string;
}>;

export type CompatSidecarSnapshot = Readonly<{
	text: string;
	identity?: CompatSidecarFileIdentity;
}>;

export class CompatSidecarCasError extends Error {
	constructor(message = 'The companion sidecar changed in another window. Reopen it before saving metadata.') {
		super(message);
		this.name = 'CompatSidecarCasError';
	}
}

export const isCompatSidecarCasError = (error: unknown): error is CompatSidecarCasError =>
	error instanceof CompatSidecarCasError;

export const compatSidecarFileIdentityEquals = (
	left: CompatSidecarFileIdentity | undefined,
	right: CompatSidecarFileIdentity | undefined,
): boolean => {
	if (!left || !right) return left === right;
	if (left.inode !== 0 && right.inode !== 0) return left.device === right.device && left.inode === right.inode;
	return left.realPathKey === right.realPathKey;
};

const normalizePhysicalPath = (value: string): string => {
	const normalized = path.normalize(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export async function readCompatSidecarSnapshot(uri: vscode.Uri): Promise<CompatSidecarSnapshot> {
	if (uri.scheme !== 'file') {
		return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
	}
	const handle = await fs.promises.open(uri.fsPath, 'r');
	try {
		const [stat, text, realPath] = await Promise.all([
			handle.stat(),
			handle.readFile({ encoding: 'utf8' }),
			fs.promises.realpath(uri.fsPath).catch(() => uri.fsPath),
		]);
		return {
			text,
			identity: { device: stat.dev, inode: stat.ino, realPathKey: normalizePhysicalPath(realPath) },
		};
	} finally {
		await handle.close();
	}
}

const sidecarLockKeys = (uri: vscode.Uri, identity?: CompatSidecarFileIdentity): string[] => {
	const pathKey = uri.scheme === 'file'
		? `path:${normalizePhysicalPath(uri.fsPath)}`
		: `uri:${uri.toString()}`;
	const keys = [pathKey];
	if (identity?.inode) keys.push(`inode:${identity.device}:${identity.inode}`);
	else if (identity?.realPathKey && identity.realPathKey !== normalizePhysicalPath(uri.fsPath)) {
		keys.push(`realpath:${identity.realPathKey}`);
	}
	return [...new Set(keys)].sort();
};

export async function withCompatSidecarLock<T>(
	uri: vscode.Uri,
	expectedIdentity: CompatSidecarFileIdentity | undefined,
	work: () => Promise<T>,
): Promise<T> {
	if (uri.scheme !== 'file') return work();
	const lockRoot = path.join(os.tmpdir(), 'vscode-kusto-workbench-sidecar-locks');
	await fs.promises.mkdir(lockRoot, { recursive: true });
	const releases: Array<() => Promise<void>> = [];
	try {
		for (const key of sidecarLockKeys(uri, expectedIdentity)) {
			const digest = crypto.createHash('sha256').update(key).digest('hex');
			const release = await lockfile.lock(path.join(lockRoot, `${digest}.write`), {
				realpath: false,
				stale: 30_000,
				update: 5_000,
				retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
			});
			releases.push(release);
		}
		if (expectedIdentity) {
			const current = await readCompatSidecarSnapshot(uri);
			if (!compatSidecarFileIdentityEquals(expectedIdentity, current.identity)) {
				throw new CompatSidecarCasError('The companion sidecar changed physical identity before publication.');
			}
		}
		return await work();
	} finally {
		for (const release of releases.reverse()) await release();
	}
}

export async function writeCompatSidecarTextOwned(
	uri: vscode.Uri,
	text: string,
	expectedIdentity?: CompatSidecarFileIdentity,
	expectedText?: string,
): Promise<CompatSidecarFileIdentity | undefined> {
	if (uri.scheme !== 'file' || !expectedIdentity) {
		if (uri.scheme !== 'file') {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			return undefined;
		}
		let handle: fs.promises.FileHandle | undefined;
		let created = false;
		let createdIdentity: CompatSidecarFileIdentity | undefined;
		let verifiedIdentity: CompatSidecarFileIdentity | undefined;
		try {
			handle = await fs.promises.open(uri.fsPath, 'wx');
			created = true;
			const createdStat = await handle.stat();
			createdIdentity = {
				device: createdStat.dev,
				inode: createdStat.ino,
				realPathKey: normalizePhysicalPath(await fs.promises.realpath(uri.fsPath).catch(() => uri.fsPath)),
			};
			await handle.writeFile(text, { encoding: 'utf8' });
			await handle.sync();
			await handle.close();
			handle = undefined;
			const published = await readCompatSidecarSnapshot(uri);
			if (!compatSidecarFileIdentityEquals(createdIdentity, published.identity) || published.text !== text) {
				throw new CompatSidecarCasError('The companion sidecar changed while it was being created.');
			}
			verifiedIdentity = published.identity;
		} catch (error) {
			if (created && createdIdentity) {
				await handle?.close().catch(() => undefined);
				handle = undefined;
				try {
					const current = await readCompatSidecarSnapshot(uri);
					if (compatSidecarFileIdentityEquals(createdIdentity, current.identity)) {
						await fs.promises.unlink(uri.fsPath);
					}
				} catch {
					// The pathname no longer names the file created by this operation.
				}
			}
			if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
				throw new CompatSidecarCasError('The companion sidecar appeared while it was being created.');
			}
			throw error;
		} finally {
			await handle?.close().catch(() => undefined);
		}
		return verifiedIdentity;
	}
	const handle = await fs.promises.open(uri.fsPath, 'r+');
	try {
		const stat = await handle.stat();
		const currentIdentity: CompatSidecarFileIdentity = {
			device: stat.dev,
			inode: stat.ino,
			realPathKey: normalizePhysicalPath(await fs.promises.realpath(uri.fsPath).catch(() => uri.fsPath)),
		};
		if (!compatSidecarFileIdentityEquals(expectedIdentity, currentIdentity)) {
			throw new CompatSidecarCasError('The companion sidecar changed physical identity before publication.');
		}
		await publishOwnedFileText(handle, expectedIdentity, expectedText, text);
		const published = await readCompatSidecarSnapshot(uri);
		if (!compatSidecarFileIdentityEquals(expectedIdentity, published.identity) || published.text !== text) {
			throw new CompatSidecarCasError('The companion sidecar changed physical identity during publication.');
		}
		return published.identity;
	} finally {
		await handle.close();
	}
}

export interface CompatSidecarStoreOptions {
	compatUri: vscode.Uri;
	parse: (text: string) => KqlxFileV1 | undefined;
	isLinked: (sidecarUri: vscode.Uri, file: KqlxFileV1) => boolean;
	sanitizeFresh: (state: KqlxStateV1) => Promise<KqlxStateV1>;
	publishFresh: <T>(state: KqlxStateV1, publish: (sanitized: KqlxStateV1) => Promise<T>) => Promise<T>;
	buildFile: (state: KqlxStateV1, baseFile?: KqlxFileV1) => KqlxFileV1;
	stringify: (file: KqlxFileV1) => string;
}

export class CompatSidecarStore {
	private writeTail: Promise<void> = Promise.resolve();

	constructor(private readonly options: CompatSidecarStoreOptions) {}

	async buildFresh(state: KqlxStateV1, baseFile?: KqlxFileV1): Promise<KqlxFileV1> {
		const file = this.options.buildFile(await this.options.sanitizeFresh(state), baseFile);
		return baseFile && isDeepStrictEqual(file, baseFile) ? baseFile : file;
	}

	async writeFresh(
		uri: vscode.Uri,
		state: KqlxStateV1,
		expectedCurrentText?: string,
		expectedIdentity?: CompatSidecarFileIdentity,
	): Promise<{ file: KqlxFileV1; text: string; identity?: CompatSidecarFileIdentity }> {
		return this.serialize(async () => {
			const baseline = await readCompatSidecarSnapshot(uri);
			const baselineText = baseline.text;
			if (expectedIdentity && !compatSidecarFileIdentityEquals(expectedIdentity, baseline.identity)) {
				throw new CompatSidecarCasError('The companion sidecar changed physical identity before publication.');
			}
			if (expectedCurrentText !== undefined && baselineText !== expectedCurrentText) throw this.changedError();
			const parsedBaseline = this.options.parse(baselineText);
			const baselineFile = parsedBaseline && this.options.isLinked(uri, parsedBaseline) ? parsedBaseline : undefined;
			const candidate = this.options.buildFile(state, baselineFile);
			return this.options.publishFresh(candidate.state, sanitized => withCompatSidecarLock(uri, baseline.identity, async () => {
				const locked = await readCompatSidecarSnapshot(uri);
				if (!compatSidecarFileIdentityEquals(baseline.identity, locked.identity) || locked.text !== baselineText) throw this.changedError();
				const file = this.options.buildFile(sanitized, candidate);
				const text = this.options.stringify(file);
				const beforeWrite = await readCompatSidecarSnapshot(uri);
				if (!compatSidecarFileIdentityEquals(baseline.identity, beforeWrite.identity) || beforeWrite.text !== baselineText) throw this.changedError();
				await writeCompatSidecarTextOwned(uri, text, baseline.identity, baselineText);
				return { file, text, identity: baseline.identity };
			}));
		});
	}

	async repair(uri: vscode.Uri, expectedIdentity?: CompatSidecarFileIdentity): Promise<CompatSidecarRepair | undefined> {
		return this.serialize(async () => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const baseline = await readCompatSidecarSnapshot(uri);
				if (expectedIdentity && !compatSidecarFileIdentityEquals(expectedIdentity, baseline.identity)) {
					throw new CompatSidecarCasError('The companion sidecar changed physical identity before repair.');
				}
				const currentText = baseline.text;
				const parsed = this.options.parse(currentText);
				if (!parsed || !this.options.isLinked(uri, parsed)) return undefined;
				const candidate = this.options.buildFile(parsed.state, parsed);
				let publication: { raced: true } | { raced: false; value: CompatSidecarRepair };
				try {
					publication = await this.options.publishFresh(candidate.state, sanitized => withCompatSidecarLock(uri, baseline.identity, async () => {
					const locked = await readCompatSidecarSnapshot(uri);
					if (!compatSidecarFileIdentityEquals(baseline.identity, locked.identity) || locked.text !== currentText) return { raced: true as const };
					const file = this.options.buildFile(sanitized, candidate);
					const text = this.options.stringify(file);
					if (text !== currentText) await writeCompatSidecarTextOwned(uri, text, baseline.identity, currentText);
					return { raced: false as const, value: { file, inputText: currentText, text, identity: baseline.identity } };
					}));
				} catch (error) {
					if (isCompatSidecarCasError(error)) continue;
					throw error;
				}
				if (publication.raced) continue;
				return publication.value;
			}
			return undefined;
		});
	}

	async writeRecovery(uri: vscode.Uri, state: KqlxStateV1): Promise<vscode.Uri> {
		const recoveryUri = uri.with({ path: `${uri.path}.recovery-${Date.now()}-${crypto.randomUUID()}.json` });
		return this.serialize(async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				let baselineText: string | undefined;
				let baselineFile: KqlxFileV1 | undefined;
				let baselineIdentity: CompatSidecarFileIdentity | undefined;
				try {
					const baseline = await readCompatSidecarSnapshot(uri);
					baselineText = baseline.text;
					baselineIdentity = baseline.identity;
					const parsed = this.options.parse(baselineText);
					if (parsed && this.options.isLinked(uri, parsed) && !hasAmbiguousCompatIdlessSections(parsed)) baselineFile = parsed;
				} catch { /* no baseline */ }
				const candidate = this.options.buildFile(state, baselineFile);
				let publication: { raced: true } | { raced: false; value: vscode.Uri };
				try {
					publication = await this.options.publishFresh(candidate.state, sanitized => withCompatSidecarLock(uri, baselineIdentity, async () => {
					let lockedText: string | undefined;
					let lockedIdentity: CompatSidecarFileIdentity | undefined;
					try {
						const locked = await readCompatSidecarSnapshot(uri);
						lockedText = locked.text;
						lockedIdentity = locked.identity;
					} catch { /* absent */ }
					if (!compatSidecarFileIdentityEquals(baselineIdentity, lockedIdentity) || lockedText !== baselineText) return { raced: true as const };
					const file = this.options.buildFile(sanitized, candidate);
					await writeCompatSidecarTextOwned(recoveryUri, this.options.stringify(file));
					return { raced: false as const, value: recoveryUri };
					}));
				} catch (error) {
					if (isCompatSidecarCasError(error)) continue;
					throw error;
				}
				if (!publication.raced) return publication.value;
			}
			throw this.changedError();
		});
	}

	async drain(): Promise<void> {
		await this.writeTail;
	}

	private async serialize<T>(work: () => Promise<T>): Promise<T> {
		let result!: T;
		const run = this.writeTail.catch(() => undefined).then(async () => { result = await work(); });
		this.writeTail = run.then(() => undefined, () => undefined);
		await run;
		return result;
	}

	private changedError(): Error {
		return new CompatSidecarCasError();
	}
}