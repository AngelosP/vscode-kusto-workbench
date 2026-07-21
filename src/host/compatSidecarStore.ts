import * as crypto from 'crypto';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import * as vscode from 'vscode';

import type { KqlxFileV1, KqlxStateV1 } from './kqlxFormat';

export type CompatSidecarRepair = Readonly<{
	file: KqlxFileV1;
	inputText: string;
	text: string;
}>;

export interface CompatSidecarStoreOptions {
	compatUri: vscode.Uri;
	parse: (text: string) => KqlxFileV1 | undefined;
	isLinked: (sidecarUri: vscode.Uri, file: KqlxFileV1) => boolean;
	sanitizeFresh: (state: KqlxStateV1) => Promise<KqlxStateV1>;
	publishFresh: <T>(state: KqlxStateV1, publish: (sanitized: KqlxStateV1) => Promise<T>) => Promise<T>;
	buildFile: (state: KqlxStateV1) => KqlxFileV1;
	stringify: (file: KqlxFileV1) => string;
}

export class CompatSidecarStore {
	private writeTail: Promise<void> = Promise.resolve();

	constructor(private readonly options: CompatSidecarStoreOptions) {}

	async buildFresh(state: KqlxStateV1): Promise<KqlxFileV1> {
		return this.options.buildFile(await this.options.sanitizeFresh(state));
	}

	async writeFresh(
		uri: vscode.Uri,
		state: KqlxStateV1,
		expectedCurrentText?: string,
	): Promise<{ file: KqlxFileV1; text: string }> {
		return this.serialize(() => this.options.publishFresh(state, sanitized => this.withLock(uri, async () => {
			const baselineText = await this.readText(uri);
			if (expectedCurrentText !== undefined && baselineText !== expectedCurrentText) throw this.changedError();
			const file = this.options.buildFile(sanitized);
			const text = this.options.stringify(file);
			if (await this.readText(uri) !== baselineText) throw this.changedError();
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			return { file, text };
		})));
	}

	async repair(uri: vscode.Uri): Promise<CompatSidecarRepair | undefined> {
		return this.serialize(async () => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const currentText = await this.readText(uri);
				const parsed = this.options.parse(currentText);
				if (!parsed || !this.options.isLinked(uri, parsed)) return undefined;
				const publication = await this.options.publishFresh(parsed.state, sanitized => this.withLock(uri, async () => {
					if (await this.readText(uri) !== currentText) return { raced: true as const };
					const file = this.options.buildFile(sanitized);
					const text = this.options.stringify(file);
					if (text !== currentText) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
					return { raced: false as const, value: { file, inputText: currentText, text } };
				}));
				if (publication.raced) continue;
				return publication.value;
			}
			return undefined;
		});
	}

	async writeRecovery(uri: vscode.Uri, state: KqlxStateV1): Promise<vscode.Uri> {
		const recoveryUri = uri.with({ path: `${uri.path}.recovery-${Date.now()}-${crypto.randomUUID()}.json` });
		return this.serialize(() => this.options.publishFresh(state, sanitized => this.withLock(uri, async () => {
			const file = this.options.buildFile(sanitized);
			await vscode.workspace.fs.writeFile(recoveryUri, new TextEncoder().encode(this.options.stringify(file)));
			return recoveryUri;
		})));
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

	private async withLock<T>(uri: vscode.Uri, work: () => Promise<T>): Promise<T> {
		if (uri.scheme !== 'file') return work();
		const lockTarget = `${uri.fsPath}.write`;
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(lockTarget)));
		const release = await lockfile.lock(lockTarget, {
			realpath: false,
			stale: 30_000,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try { return await work(); }
		finally { await release(); }
	}

	private async readText(uri: vscode.Uri): Promise<string> {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	}

	private changedError(): Error {
		return new Error('The companion sidecar changed in another window. Reopen it before saving metadata.');
	}
}