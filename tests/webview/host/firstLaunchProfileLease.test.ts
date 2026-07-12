import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { FirstLaunchProfileLease } from '../../../src/host/firstLaunch/firstLaunchProfileLease.js';

const cleanupDirectories: string[] = [];

describe('FirstLaunchProfileLease', () => {
	afterEach(async () => {
		await Promise.all(cleanupDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	});

	it('allows only one profile-wide owner until the lease is released', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusto-first-launch-'));
		cleanupDirectories.push(directory);
		const first = new FirstLaunchProfileLease(vscode.Uri.file(directory));
		const second = new FirstLaunchProfileLease(vscode.Uri.file(directory));

		const firstHandle = await first.acquire();
		expect(firstHandle).toBeDefined();
		await expect(second.acquire()).resolves.toBeUndefined();

		await firstHandle!.release();
		const secondHandle = await second.acquire();
		expect(secondHandle).toBeDefined();
		await secondHandle!.release();
	});

	it('grants exactly one owner under simultaneous contention', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusto-first-launch-'));
		cleanupDirectories.push(directory);
		const leases = Array.from({ length: 8 }, () => new FirstLaunchProfileLease(vscode.Uri.file(directory)));

		const handles = await Promise.all(leases.map(lease => lease.acquire()));

		expect(handles.filter(Boolean)).toHaveLength(1);
		await handles.find(Boolean)!.release();
	});

	it('reclaims a stale atomic lock directory', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusto-first-launch-'));
		cleanupDirectories.push(directory);
		const staleLockDirectory = path.join(directory, 'first-launch-setup.lease.lock');
		await fs.mkdir(staleLockDirectory);
		const old = new Date(Date.now() - 120_000);
		await fs.utimes(staleLockDirectory, old, old);

		const handle = await new FirstLaunchProfileLease(vscode.Uri.file(directory)).acquire();

		expect(handle).toBeDefined();
		await handle!.release();
	});
});