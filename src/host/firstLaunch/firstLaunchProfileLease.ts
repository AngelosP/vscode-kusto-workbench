import * as fs from 'fs/promises';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import * as vscode from 'vscode';

const LEASE_TARGET_FILENAME = 'first-launch-setup.lease';
const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_STALE_MS = 90_000;
const LEASE_WAIT_MS = 30 * 60_000;
const LEASE_RETRY_MS = 200;

export interface FirstLaunchLeaseHandle {
	release(): Promise<void>;
}

export interface FirstLaunchProfileLeaseLike {
	acquire(): Promise<FirstLaunchLeaseHandle | undefined>;
	waitForRelease(): Promise<boolean>;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code?: unknown }).code || '')
		: undefined;
}

export class FirstLaunchProfileLease implements FirstLaunchProfileLeaseLike {
	private readonly targetPath: string | undefined;

	constructor(globalStorageUri: vscode.Uri) {
		this.targetPath = globalStorageUri.scheme === 'file'
			? path.join(globalStorageUri.fsPath, LEASE_TARGET_FILENAME)
			: undefined;
	}

	async acquire(): Promise<FirstLaunchLeaseHandle | undefined> {
		if (!this.targetPath) {
			return { release: async () => undefined };
		}
		await fs.mkdir(path.dirname(this.targetPath), { recursive: true });
		let compromised: Error | undefined;
		try {
			const release = await lockfile.lock(this.targetPath, {
				realpath: false,
				stale: LEASE_STALE_MS,
				update: LEASE_HEARTBEAT_MS,
				retries: 0,
				onCompromised: error => { compromised = error; },
			});
			let released = false;
			return {
				release: async () => {
					if (released) return;
					released = true;
					await release();
					if (compromised) throw compromised;
				},
			};
		} catch (error) {
			if (errorCode(error) === 'ELOCKED') {
				return undefined;
			}
			throw error;
		}
	}

	async waitForRelease(): Promise<boolean> {
		if (!this.targetPath) return true;
		const deadline = Date.now() + LEASE_WAIT_MS;
		while (Date.now() < deadline) {
			const locked = await lockfile.check(this.targetPath, {
				realpath: false,
				stale: LEASE_STALE_MS,
			});
			if (!locked) return true;
			await delay(LEASE_RETRY_MS);
		}
		return false;
	}
}