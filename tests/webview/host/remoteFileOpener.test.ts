import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	deriveLocalFilename,
	deriveSidecarCompanionUrl,
	fetchRemoteContent,
	fetchGitHubContent,
	parseContentDisposition,
	redactRemoteUrlForLog,
	readRemoteTextBody,
	remoteSnapshotChildUri,
	RemoteSnapshotLeaseStore,
	RemoteSnapshotLifecycle,
	RemoteSnapshotLifecycleTaskRunner,
	remoteContentSnapshotId,
	remoteSnapshotDirectoryPath,
	remoteSnapshotTabInputUris,
	sanitizeRemoteFilename,
} from '../../../src/host/remoteFileOpener';

const tempDirectories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('redactRemoteUrlForLog', () => {
	it('redacts credentials, paths, query values, fragments, and reversible share identifiers', () => {
		const input = 'GET https://user:password@contoso.sharepoint.com/:u:/r/sites/team/SECRET_PATH/file.sqlx?token=abc123&download=1#access_token=secret';
		const output = redactRemoteUrlForLog(input);

		expect(output).toMatch(/https:\/\/contoso\.sharepoint\.com\/\[remote:[0-9a-f]{12}\]/);
		expect(output).not.toContain('user');
		expect(output).not.toContain('password');
		expect(output).not.toContain('SECRET_PATH');
		expect(output).not.toContain('abc123');
		expect(output).not.toContain('secret');
	});

	it('does not expose a Graph share identifier derived from the original URL', () => {
		const shareId = 'u!' + Buffer.from('https://contoso.sharepoint.com/:u:/s/team/CAPABILITY').toString('base64url');
		const output = redactRemoteUrlForLog(`GET https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem`);

		expect(output).toContain('https://graph.microsoft.com/[remote:');
		expect(output).not.toContain(shareId);
		expect(output).not.toContain('CAPABILITY');
	});
});

describe('remote snapshot filenames', () => {
	it.each([
		[
			'https://files.example/session.kql.json?token=abc123&download=1',
			'https://files.example/session.kql?token=abc123&download=1',
		],
		[
			'https://files.example/path/session.csl.json?sig=secret#preview',
			'https://files.example/path/session.csl?sig=secret#preview',
		],
	])('derives the query companion URL without changing credentials or fragments', (sidecarUrl, expected) => {
		expect(deriveSidecarCompanionUrl(sidecarUrl)).toBe(expected);
	});

	it.each(['../session.kqlx', '..\\session.kqlx', '.', '..', 'C:session.kqlx', '\\\\server\\share.sqlx'])(
		'rejects unsafe basename %j', filename => {
			expect(() => sanitizeRemoteFilename(filename)).toThrow('unsafe');
		},
	);

	it('resolves only an immediate child of the immutable snapshot', () => {
		const snapshot = vscode.Uri.file(path.join(process.cwd(), 'remote-files', 'source', 'snapshot'));
		expect(path.resolve(remoteSnapshotChildUri(snapshot, 'report.sqlx').fsPath))
			.toBe(path.resolve(snapshot.fsPath, 'report.sqlx'));
		expect(() => remoteSnapshotChildUri(snapshot, '../session.kqlx')).toThrow('unsafe');
	});

	it('rejects encoded URL and Content-Disposition traversal at derivation', () => {
		expect(() => deriveLocalFilename(
			'https://files.example/%2e%2e%2f%2e%2e%2fsession.kqlx', '.kqlx',
		)).toThrow('unsafe');
		const dispositionName = parseContentDisposition("attachment; filename*=UTF-8''..%2F..%2Fsession.kqlx");
		expect(() => sanitizeRemoteFilename(dispositionName!)).toThrow('unsafe');
	});
});

describe('readRemoteTextBody', () => {
	it('reads a response at the byte limit', async () => {
		await expect(readRemoteTextBody(new Response('test'), 4)).resolves.toBe('test');
	});

	it('rejects an oversized declared content length before buffering', async () => {
		const response = new Response('small', { headers: { 'content-length': '100' } });
		await expect(readRemoteTextBody(response, 10)).rejects.toThrow('10-byte size limit');
	});

	it('rejects a streaming body that exceeds an absent or dishonest length header', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('1234'));
				controller.enqueue(new TextEncoder().encode('5'));
				controller.close();
			},
		});
		await expect(readRemoteTextBody(new Response(body), 4)).rejects.toThrow('4-byte size limit');
	});
});

describe('fetchGitHubContent', () => {
	it('rejects an oversized successful GitHub body through the streaming limit', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('small', {
			status: 200,
			headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
		})));

		await expect(fetchGitHubContent('https://raw.githubusercontent.com/owner/repo/main/report.sqlx'))
			.rejects.toThrow('16777216-byte size limit');
	});

	it('keeps the request deadline active while a successful body stalls', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					signal?.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
				},
			});
			return new Response(body, { status: 200 });
		}));

		const outcome = fetchGitHubContent('https://raw.githubusercontent.com/owner/repo/main/report.sqlx').then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(15_000);

		await expect(outcome).resolves.toEqual(expect.objectContaining({ message: 'body aborted' }));
	});
});

describe('fetchRemoteContent', () => {
	it('keeps the request deadline active while a successful body stalls', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					signal?.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
				},
			});
			return new Response(body, { status: 200 });
		}));

		const outcome = fetchRemoteContent('https://files.example/report.kqlx').then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(15_000);

		await expect(outcome).resolves.toEqual(expect.objectContaining({ message: 'body aborted' }));
	});
});

describe('remoteContentSnapshotId', () => {
	it('is stable for identical content and separates files and sidecar pairs', () => {
		expect(remoteContentSnapshotId(['SELECT 1'])).toBe(remoteContentSnapshotId(['SELECT 1']));
		expect(remoteContentSnapshotId(['SELECT 1'])).not.toBe(remoteContentSnapshotId(['SELECT 2']));
		expect(remoteContentSnapshotId(['ab', 'c'])).not.toBe(remoteContentSnapshotId(['a', 'bc']));
	});
});

describe('remoteSnapshotDirectoryPath', () => {
	it('targets only the containing snapshot directory beneath the remote root', () => {
		const remoteRoot = path.join(process.cwd(), 'storage', 'remote-files');
		const snapshotDir = path.join(remoteRoot, 'source-hash', 'content-hash-uuid');

		expect(remoteSnapshotDirectoryPath(remoteRoot, path.join(snapshotDir, 'report.sqlx'))).toBe(snapshotDir);
		expect(remoteSnapshotDirectoryPath(remoteRoot, path.join(remoteRoot, 'source-hash', 'report.sqlx'))).toBeUndefined();
		expect(remoteSnapshotDirectoryPath(remoteRoot, path.join(`${remoteRoot}-backup`, 'source', 'snapshot', 'report.sqlx'))).toBeUndefined();
	});
});

describe('RemoteSnapshotLeaseStore', () => {
	it('atomically creates and leases a brand-new snapshot', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-create-'));
		tempDirectories.push(remoteRoot);
		const snapshotDir = path.join(remoteRoot, 'source-hash', 'new-snapshot');
		fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
		const owner = new RemoteSnapshotLeaseStore(remoteRoot, 'window-a');

		await owner.createAndAcquire(snapshotDir);
		expect(fs.existsSync(snapshotDir)).toBe(true);

		await owner.release(snapshotDir);
		expect(fs.existsSync(snapshotDir)).toBe(false);
	});

	it('preserves a snapshot leased by another window and removes it after release', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-snapshot-'));
		tempDirectories.push(remoteRoot);
		const snapshotDir = path.join(remoteRoot, 'source-hash', 'content-hash-uuid');
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.writeFileSync(path.join(snapshotDir, 'report.sqlx'), 'SELECT 1', 'utf8');
		const owner = new RemoteSnapshotLeaseStore(remoteRoot, 'window-a');
		const cleaner = new RemoteSnapshotLeaseStore(remoteRoot, 'window-b');

		await owner.acquire(snapshotDir);
		await cleaner.cleanupAbandonedSnapshots();
		expect(fs.existsSync(snapshotDir)).toBe(true);

		await owner.release(snapshotDir);
		expect(fs.existsSync(snapshotDir)).toBe(false);
		await cleaner.dispose();
	});

	it('does not delete while another window has a pending claim behind the gate', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-handoff-'));
		tempDirectories.push(remoteRoot);
		const sourceName = 'source-hash';
		const snapshotName = 'content-hash-uuid';
		const snapshotDir = path.join(remoteRoot, sourceName, snapshotName);
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.writeFileSync(path.join(snapshotDir, 'report.sqlx'), 'SELECT 1', 'utf8');
		const owner = new RemoteSnapshotLeaseStore(remoteRoot, 'window-a');
		const claimant = new RemoteSnapshotLeaseStore(remoteRoot, 'window-b');
		await owner.acquire(snapshotDir);

		const gateTarget = path.join(remoteRoot, '.leases', sourceName, `${snapshotName}.gate`);
		const releaseGate = await lockfile.lock(gateTarget, { realpath: false, stale: 30_000, retries: 0 });
		try {
			const claiming = claimant.acquire(snapshotDir);
			const claimLock = path.join(remoteRoot, '.leases', sourceName, snapshotName, 'window-b.claim.lock');
			await vi.waitFor(() => expect(fs.existsSync(claimLock)).toBe(true));
			const releasing = owner.release(snapshotDir);

			await releaseGate();
			await Promise.all([claiming, releasing]);
			expect(fs.existsSync(snapshotDir)).toBe(true);
		} finally {
			try { await releaseGate(); } catch { /* already released */ }
		}

		await claimant.release(snapshotDir);
		expect(fs.existsSync(snapshotDir)).toBe(false);
	});

	it('does not report a lease acquired when deletion already owns claim admission', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-claim-race-'));
		tempDirectories.push(remoteRoot);
		const snapshotDir = path.join(remoteRoot, 'source-hash', 'content-hash-uuid');
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.writeFileSync(path.join(snapshotDir, 'report.sqlx'), 'SELECT 1', 'utf8');
		const cleaner = new RemoteSnapshotLeaseStore(remoteRoot, 'window-a') as any;
		const claimant = new RemoteSnapshotLeaseStore(remoteRoot, 'window-b');
		let scanStarted!: () => void;
		let finishScan!: () => void;
		const scanning = new Promise<void>(resolve => { scanStarted = resolve; });
		const scanBarrier = new Promise<void>(resolve => { finishScan = resolve; });
		cleaner.hasLiveReader = vi.fn(async () => {
			scanStarted();
			await scanBarrier;
			return false;
		});

		const cleaning = cleaner.cleanupAbandonedSnapshots();
		await scanning;
		const claimOutcome = claimant.acquire(snapshotDir).then(
			() => undefined,
			(error: unknown) => error,
		);
		finishScan();
		await cleaning;

		expect(fs.existsSync(snapshotDir)).toBe(false);
		await expect(claimOutcome).resolves.toEqual(expect.objectContaining({ message: 'Remote snapshot no longer exists.' }));
		await claimant.dispose();
		await cleaner.dispose();
	});

	it('does not collect abandoned snapshots as part of lifecycle readiness', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-startup-'));
		tempDirectories.push(remoteRoot);
		const snapshotDir = path.join(remoteRoot, 'source-hash', 'old-snapshot');
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.writeFileSync(path.join(snapshotDir, 'report.sqlx'), 'SELECT 1', 'utf8');
		const lifecycle = new RemoteSnapshotLifecycle(vscode.Uri.file(remoteRoot), 60_000);

		await lifecycle.ready();

		expect(fs.existsSync(snapshotDir)).toBe(true);
		lifecycle.dispose();
	});

	it('creates a new file-backed snapshot before invoking its action', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-lifecycle-create-'));
		tempDirectories.push(remoteRoot);
		const sourceDir = vscode.Uri.file(path.join(remoteRoot, 'source-hash'));
		fs.mkdirSync(sourceDir.fsPath, { recursive: true });
		const lifecycle = new RemoteSnapshotLifecycle(vscode.Uri.file(remoteRoot), 60_000);
		let createdPath = '';

		await lifecycle.withSnapshot(sourceDir, ['SELECT 1'], async snapshotDir => {
			createdPath = snapshotDir.fsPath;
			expect(fs.statSync(snapshotDir.fsPath).isDirectory()).toBe(true);
		});

		expect(fs.existsSync(createdPath)).toBe(true);
		lifecycle.dispose();
	});
});

describe('remoteSnapshotTabInputUris', () => {
	it('returns both sides of a restored diff tab', () => {
		const original = vscode.Uri.file('C:/storage/remote-files/source/snapshot/original.sqlx');
		const modified = vscode.Uri.file('C:/storage/remote-files/source/snapshot/modified.sqlx');

		expect(remoteSnapshotTabInputUris(new vscode.TabInputTextDiff(original, modified)))
			.toEqual([original, modified]);
	});
});

describe('remote snapshot lifecycle disposal', () => {
	it('suppresses claims admitted after lifecycle disposal', async () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remote-disposed-'));
		tempDirectories.push(remoteRoot);
		const snapshotDir = path.join(remoteRoot, 'source-hash', 'content-hash');
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.writeFileSync(path.join(snapshotDir, 'report.sqlx'), 'SELECT 1', 'utf8');
		const lifecycle = new RemoteSnapshotLifecycle(vscode.Uri.file(remoteRoot), 60_000) as any;
		await lifecycle.ready();
		const acquire = vi.spyOn(lifecycle.leaseStore, 'acquire');

		lifecycle.dispose();
		await lifecycle.claimTabInput(new vscode.TabInputCustom(vscode.Uri.file(path.join(snapshotDir, 'report.sqlx'))));

		expect(acquire).not.toHaveBeenCalled();
	});

	it('cancels queued lifecycle retries on disposal', async () => {
		vi.useFakeTimers();
		const runner = new RemoteSnapshotLifecycleTaskRunner();
		const task = vi.fn().mockRejectedValue(new Error('claim failed'));

		runner.run('Remote snapshot tab claim', task);
		await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
		runner.dispose();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(task).toHaveBeenCalledOnce();
	});
});
