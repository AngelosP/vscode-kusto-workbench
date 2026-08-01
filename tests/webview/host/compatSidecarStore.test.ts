import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildCompatSidecarFile, type CompatSidecarFormat } from '../../../src/host/compatSidecarFormat';
import {
	CompatSidecarStore,
	readCompatSidecarSnapshot,
	withCompatSidecarLock,
	writeCompatSidecarTextOwned,
} from '../../../src/host/compatSidecarStore';
import { parseKqlxText, stringifyKqlxFile } from '../../../src/host/kqlxFormat';

afterEach(() => vi.restoreAllMocks());

describe('CompatSidecarStore lossless baseline', () => {
	it('uses exclusive creation when no sidecar baseline exists', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-exclusive-create-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		try {
			fs.writeFileSync(sidecarPath, 'EXTERNAL', 'utf8');
			await expect(writeCompatSidecarTextOwned(vscode.Uri.file(sidecarPath), 'LOCAL'))
				.rejects.toThrow(/appeared while it was being created/);
			expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('EXTERNAL');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('removes a partially created sidecar when exclusive publication fails', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-create-failure-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		const originalOpen = fs.promises.open.bind(fs.promises);
		try {
			vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
				const handle = await originalOpen(...args as [any, any]);
				if (String(args[0]) === sidecarPath && args[1] === 'wx') {
					(handle as any).writeFile = async () => {
						await handle.write(Buffer.from('PARTIAL', 'utf8'), 0, 7, 0);
						throw new Error('injected creation failure');
					};
				}
				return handle;
			});

			await expect(writeCompatSidecarTextOwned(vscode.Uri.file(sidecarPath), 'LOCAL'))
				.rejects.toThrow('injected creation failure');
			expect(fs.existsSync(sidecarPath)).toBe(false);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('preserves a same-path replacement when failed creation cleanup loses ownership', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-create-retarget-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		const displacedPath = path.join(tmpDir, 'partial.kql.json');
		const originalOpen = fs.promises.open.bind(fs.promises);
		try {
			vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
				const handle = await originalOpen(...args as [any, any]);
				if (String(args[0]) === sidecarPath && args[1] === 'wx') {
					(handle as any).writeFile = async () => {
						await handle.write(Buffer.from('PARTIAL', 'utf8'), 0, 7, 0);
						fs.renameSync(sidecarPath, displacedPath);
						fs.writeFileSync(sidecarPath, 'EXTERNAL_REPLACEMENT', 'utf8');
						throw new Error('injected creation retarget');
					};
				}
				return handle;
			});

			await expect(writeCompatSidecarTextOwned(vscode.Uri.file(sidecarPath), 'LOCAL'))
				.rejects.toThrow('injected creation retarget');
			expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('EXTERNAL_REPLACEMENT');
			expect(fs.readFileSync(displacedPath, 'utf8')).toBe('PARTIAL');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('serializes absent-file creation with a writer that observes the new inode', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-create-inode-race-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		const sidecarUri = vscode.Uri.file(sidecarPath);
		const originalOpen = fs.promises.open.bind(fs.promises);
		let markCreated!: () => void;
		let releaseCreator!: () => void;
		const created = new Promise<void>(resolve => { markCreated = resolve; });
		const creatorGate = new Promise<void>(resolve => { releaseCreator = resolve; });
		try {
			let paused = false;
			vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
				const handle = await originalOpen(...args as [any, any]);
				if (!paused && String(args[0]) === sidecarPath && args[1] === 'wx') {
					paused = true;
					markCreated();
					await creatorGate;
				}
				return handle;
			});

			const creator = withCompatSidecarLock(sidecarUri, undefined, () =>
				writeCompatSidecarTextOwned(sidecarUri, 'CREATOR'),
			);
			await created;
			const observed = await readCompatSidecarSnapshot(sidecarUri);
			const competitor = withCompatSidecarLock(sidecarUri, observed.identity, () =>
				writeCompatSidecarTextOwned(sidecarUri, 'COMPETITOR', observed.identity, observed.text),
			);
			releaseCreator();

			const outcomes = await Promise.allSettled([creator, competitor]);
			expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
			expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('CREATOR');
		} finally {
			releaseCreator();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('restores exact sidecar bytes after a post-truncate update failure', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-update-failure-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		const originalOpen = fs.promises.open.bind(fs.promises);
		try {
			fs.writeFileSync(sidecarPath, 'BASELINE', 'utf8');
			const baseline = await readCompatSidecarSnapshot(vscode.Uri.file(sidecarPath));
			let syncCalls = 0;
			vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
				const handle = await originalOpen(...args as [any, any]);
				if (String(args[0]) === sidecarPath && args[1] === 'r+') {
					const originalSync = handle.sync.bind(handle);
					(handle as any).sync = async () => {
						syncCalls++;
						await originalSync();
						if (syncCalls === 1) throw new Error('injected update failure');
					};
				}
				return handle;
			});

			await expect(writeCompatSidecarTextOwned(
				vscode.Uri.file(sidecarPath), 'REPLACEMENT', baseline.identity, baseline.text,
			)).rejects.toThrow('injected update failure');
			expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('BASELINE');
			expect(syncCalls).toBe(2);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('rejects pathname replacement after opening the original sidecar handle', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-post-open-retarget-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		const displacedPath = path.join(tmpDir, 'displaced.kql.json');
		const originalOpen = fs.promises.open.bind(fs.promises);
		try {
			fs.writeFileSync(sidecarPath, 'BASELINE', 'utf8');
			const baseline = await readCompatSidecarSnapshot(vscode.Uri.file(sidecarPath));
			let retargeted = false;
			vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
				const handle = await originalOpen(...args as [any, any]);
				if (!retargeted && String(args[0]) === sidecarPath && args[1] === 'r+') {
					const originalSync = handle.sync.bind(handle);
					(handle as any).sync = async () => {
						await originalSync();
						fs.renameSync(sidecarPath, displacedPath);
						fs.writeFileSync(sidecarPath, 'EXTERNAL_REPLACEMENT', 'utf8');
						retargeted = true;
					};
				}
				return handle;
			});

			await expect(writeCompatSidecarTextOwned(vscode.Uri.file(sidecarPath), 'LOCAL', baseline.identity))
				.rejects.toThrow(/physical identity during publication/);
			expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('EXTERNAL_REPLACEMENT');
			expect(fs.readFileSync(displacedPath, 'utf8')).toBe('LOCAL');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('serializes hard-link aliases by physical sidecar identity', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-hardlink-lock-'));
		const primaryPath = path.join(tmpDir, 'sample.kql.json');
		const aliasPath = path.join(tmpDir, 'alias.kql.json');
		const compatUri = vscode.Uri.file(path.join(tmpDir, 'sample.kql'));
		const baseline = stringifyKqlxFile({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql', name: 'Baseline' },
			] },
		} as any);
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		const createStore = () => new CompatSidecarStore({
			compatUri,
			parse: value => {
				const parsed = parseKqlxText(value);
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});
		try {
			fs.writeFileSync(primaryPath, baseline, 'utf8');
			fs.linkSync(primaryPath, aliasPath);
			const writes = await Promise.allSettled([
				createStore().writeFresh(vscode.Uri.file(primaryPath), {
					sections: [{ id: 'query_1', type: 'query', name: 'Primary winner' }],
				}),
				createStore().writeFresh(vscode.Uri.file(aliasPath), {
					sections: [{ id: 'query_1', type: 'query', name: 'Alias winner' }],
				}),
			]);

			expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
			expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1);
			const savedName = JSON.parse(fs.readFileSync(primaryPath, 'utf8')).state.sections[0].name;
			expect(['Primary winner', 'Alias winner']).toContain(savedName);
			expect(fs.readFileSync(aliasPath, 'utf8')).toBe(fs.readFileSync(primaryPath, 'utf8'));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('rejects a byte-identical symlink retarget before publication', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-symlink-retarget-'));
		const firstPath = path.join(tmpDir, 'first.json');
		const secondPath = path.join(tmpDir, 'second.json');
		const aliasPath = path.join(tmpDir, 'alias.json');
		const compatUri = vscode.Uri.file(path.join(tmpDir, 'sample.kql'));
		const baseline = stringifyKqlxFile({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql', name: 'Baseline' },
			] },
		} as any);
		let markPublication!: () => void;
		let releasePublication!: () => void;
		const publicationStarted = new Promise<void>(resolve => { markPublication = resolve; });
		const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		try {
			fs.writeFileSync(firstPath, baseline, 'utf8');
			fs.writeFileSync(secondPath, baseline, 'utf8');
			fs.symlinkSync(firstPath, aliasPath, 'file');
			const store = new CompatSidecarStore({
				compatUri,
				parse: value => {
					const parsed = parseKqlxText(value);
					return parsed.ok ? parsed.file : undefined;
				},
				isLinked: () => true,
				sanitizeFresh: async state => state,
				publishFresh: async (state, publish) => {
					markPublication();
					await publicationGate;
					return publish(state);
				},
				buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
				stringify: stringifyKqlxFile,
			});
			const write = store.writeFresh(vscode.Uri.file(aliasPath), {
				sections: [{ id: 'query_1', type: 'query', name: 'Must not publish' }],
			});
			await publicationStarted;
			fs.unlinkSync(aliasPath);
			fs.symlinkSync(secondPath, aliasPath, 'file');
			releasePublication();

			await expect(write).rejects.toThrow(/physical identity/);
			expect(fs.readFileSync(firstPath, 'utf8')).toBe(baseline);
			expect(fs.readFileSync(secondPath, 'utf8')).toBe(baseline);
		} finally {
			releasePublication();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('rejects a byte-identical physical replacement of the accepted sidecar baseline', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-accepted-identity-'));
		const sidecarPath = path.join(tmpDir, 'sample.kql.json');
		const displacedPath = path.join(tmpDir, 'accepted.kql.json');
		const compatUri = vscode.Uri.file(path.join(tmpDir, 'sample.kql'));
		const sidecarUri = vscode.Uri.file(sidecarPath);
		const baselineText = stringifyKqlxFile({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql', name: 'Baseline' },
			] },
		} as any);
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		try {
			fs.writeFileSync(sidecarPath, baselineText, 'utf8');
			const accepted = await readCompatSidecarSnapshot(sidecarUri);
			fs.renameSync(sidecarPath, displacedPath);
			fs.writeFileSync(sidecarPath, baselineText, 'utf8');
			const store = new CompatSidecarStore({
				compatUri,
				parse: value => {
					const parsed = parseKqlxText(value);
					return parsed.ok ? parsed.file : undefined;
				},
				isLinked: () => true,
				sanitizeFresh: async state => state,
				publishFresh: async (state, publish) => publish(state),
				buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
				stringify: stringifyKqlxFile,
			});

			await expect(store.writeFresh(sidecarUri, {
				sections: [{ id: 'query_1', type: 'query', name: 'LOCAL_EDIT' }],
			}, accepted.text, accepted.identity)).rejects.toThrow(/physical identity/);
			expect(fs.readFileSync(sidecarPath, 'utf8')).toBe(baselineText);
			expect(fs.readFileSync(displacedPath, 'utf8')).toBe(baselineText);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('retries recovery after a typed symlink identity conflict', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-recovery-retarget-'));
		const firstPath = path.join(tmpDir, 'first.json');
		const secondPath = path.join(tmpDir, 'second.json');
		const aliasPath = path.join(tmpDir, 'alias.json');
		const compatUri = vscode.Uri.file(path.join(tmpDir, 'sample.kql'));
		const baseline = (marker: string) => stringifyKqlxFile({
			kind: 'kqlx', version: 1, futureRoot: marker, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql', name: 'Baseline' },
			] },
		} as any);
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		let publications = 0;
		try {
			fs.writeFileSync(firstPath, baseline('first'), 'utf8');
			fs.writeFileSync(secondPath, baseline('second'), 'utf8');
			fs.symlinkSync(firstPath, aliasPath, 'file');
			const store = new CompatSidecarStore({
				compatUri,
				parse: value => {
					const parsed = parseKqlxText(value);
					return parsed.ok ? parsed.file : undefined;
				},
				isLinked: () => true,
				sanitizeFresh: async state => state,
				publishFresh: async (state, publish) => {
					publications++;
					if (publications === 1) {
						fs.unlinkSync(aliasPath);
						fs.symlinkSync(secondPath, aliasPath, 'file');
					}
					return publish(state);
				},
				buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
				stringify: stringifyKqlxFile,
			});

			const recoveryUri = await store.writeRecovery(vscode.Uri.file(aliasPath), {
				sections: [{ id: 'query_1', type: 'query', name: 'Recovered' }],
			});

			expect(publications).toBe(2);
			const recovery = JSON.parse(fs.readFileSync(recoveryUri.fsPath, 'utf8'));
			expect(recovery.futureRoot).toBe('second');
			expect(recovery.state.sections[0].name).toBe('Recovered');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('repairs an exact ambiguous id-less baseline without dropping root extensions', async () => {
		const compatUri = vscode.Uri.parse('untitled:/work/sample.kql');
		const sidecarUri = vscode.Uri.parse('untitled:/work/sample.kql.json');
		let text = stringifyKqlxFile({
			kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: { sections: [
				{ type: 'query', linkedQueryPath: 'sample.kql', futureMarker: 'first' },
				{ type: 'query', futureMarker: 'second' },
			] },
		} as any);
		vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async () => new TextEncoder().encode(text));
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (_uri, bytes) => {
			text = new TextDecoder().decode(bytes);
		});
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		const store = new CompatSidecarStore({
			compatUri,
			parse: value => {
				const parsed = parseKqlxText(value);
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});

		const repaired = await store.repair(sidecarUri);

		expect(repaired?.file.futureRoot).toEqual({ keep: true });
		expect(repaired?.file.state.sections.map(section => (section as any).futureMarker)).toEqual(['first', 'second']);
		expect(repaired?.file.state.sections.every(section => !!String((section as any).id || ''))).toBe(true);
	});

	it.each([
		['KQL', 'query', ['query', 'copilotQuery'], 'kqlx', 'sample.kql'],
		['SQL', 'sql', ['sql'], 'sqlx', 'sample.sql'],
	] as const)('materializes an unchanged future-compatible %s sidecar over its exact baseline', async (
		_label, primaryKind, acceptedPrimaryKinds, sidecarKind, primaryName,
	) => {
		const compatUri = vscode.Uri.parse(`untitled:/work/${primaryName}`);
		const format: CompatSidecarFormat = { primaryKind, acceptedPrimaryKinds, sidecarKind };
		const baseline = {
			kind: sidecarKind, version: 1, futureRoot: { keep: true }, state: {
				futureState: 'preserved', sections: [
					{
						id: 'primary_1', type: primaryKind, linkedQueryPath: primaryName,
						name: 'Primary', futurePrimary: { keep: true },
					},
					{ id: 'future_1', type: 'future-section', payload: ['opaque'] },
				],
			},
		} as any;
		const store = new CompatSidecarStore({
			compatUri,
			parse: () => baseline,
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});

		const materialized = await store.buildFresh({
			sections: [
				{ id: 'primary_1', type: primaryKind, query: 'primary text', name: 'Primary' } as any,
			],
		}, baseline);

		expect(materialized).toEqual(baseline);
		expect(stringifyKqlxFile(materialized)).toBe(stringifyKqlxFile(baseline));
	});

	it.each([
		['KQL', 'query', ['query', 'copilotQuery'], 'kqlx', 'sample.kql'],
		['SQL', 'sql', ['sql'], 'sqlx', 'sample.sql'],
	] as const)('preserves future %s sidecar data under the locked write baseline', async (
		_label, primaryKind, acceptedPrimaryKinds, sidecarKind, primaryName,
	) => {
		const compatUri = vscode.Uri.parse(`untitled:/work/${primaryName}`);
		const sidecarUri = vscode.Uri.parse(`untitled:/work/${primaryName}.json`);
		const format: CompatSidecarFormat = { primaryKind, acceptedPrimaryKinds, sidecarKind };
		let text = stringifyKqlxFile({
			kind: sidecarKind,
			version: 1,
			futureRoot: { producer: 2 },
			state: {
				futureState: ['keep'],
				sections: [
					{
						id: 'primary_1', type: primaryKind, linkedQueryPath: primaryName,
						name: 'Before', futurePrimarySetting: { mode: 'future' },
					},
					{ id: 'future_1', type: 'future-section', payload: { nested: true } },
				],
			},
		} as any);
		vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async () => new TextEncoder().encode(text));
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (_uri, bytes) => {
			text = new TextDecoder().decode(bytes);
		});
		const store = new CompatSidecarStore({
			compatUri,
			parse: value => {
				const parsed = parseKqlxText(value, { allowedKinds: [sidecarKind], defaultKind: sidecarKind });
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});

		await store.writeFresh(sidecarUri, {
			sections: [{ id: 'primary_1', type: primaryKind, name: 'After' } as any],
		});
		const saved = JSON.parse(text);

		expect(saved.futureRoot).toEqual({ producer: 2 });
		expect(saved.state.futureState).toEqual(['keep']);
		expect(saved.state.sections.map((section: any) => section.id)).toEqual(['primary_1', 'future_1']);
		expect(saved.state.sections[0]).toMatchObject({
			id: 'primary_1', type: primaryKind, name: 'After', linkedQueryPath: primaryName,
			futurePrimarySetting: { mode: 'future' },
		});
		expect(saved.state.sections[1]).toEqual({
			id: 'future_1', type: 'future-section', payload: { nested: true },
		});
	});

	it('retries recovery enrichment when the sidecar changes during sanitation', async () => {
		const compatUri = vscode.Uri.parse('untitled:/work/sample.kql');
		const sidecarUri = vscode.Uri.parse('untitled:/work/sample.kql.json');
		const baseline = (marker: string) => stringifyKqlxFile({
			kind: 'kqlx', version: 1, futureRoot: marker, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql' },
			] },
		} as any);
		const reads = [baseline('A'), baseline('B'), baseline('B'), baseline('B')];
		vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async () =>
			new TextEncoder().encode(reads.shift() ?? baseline('B')),
		);
		let recoveryText = '';
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (_uri, bytes) => {
			recoveryText = new TextDecoder().decode(bytes);
		});
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		const store = new CompatSidecarStore({
			compatUri,
			parse: text => {
				const parsed = parseKqlxText(text);
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});

		await store.writeRecovery(sidecarUri, {
			sections: [{ id: 'query_1', type: 'query', name: 'Draft' }],
		});

		expect(JSON.parse(recoveryText).futureRoot).toBe('B');
	});

	it('does not enrich recovery from an ambiguous reordered id-less baseline', async () => {
		const compatUri = vscode.Uri.parse('untitled:/work/sample.kql');
		const sidecarUri = vscode.Uri.parse('untitled:/work/sample.kql.json');
		const reorderedBaseline = stringifyKqlxFile({
			kind: 'kqlx', version: 1, futureRoot: 'external', state: { sections: [
				{ type: 'query', name: 'Second', futureMarker: 'external-second' },
				{ type: 'query', linkedQueryPath: 'sample.kql', name: 'First', futureMarker: 'external-first' },
			] },
		} as any);
		vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(new TextEncoder().encode(reorderedBaseline));
		let recoveryText = '';
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (_uri, bytes) => {
			recoveryText = new TextDecoder().decode(bytes);
		});
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		const store = new CompatSidecarStore({
			compatUri,
			parse: text => {
				const parsed = parseKqlxText(text);
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});

		await store.writeRecovery(sidecarUri, { sections: [
			{ id: 'compat_1_query', type: 'query', name: 'First', futureMarker: 'local-first' } as any,
			{ id: 'compat_2_query', type: 'query', name: 'Second', futureMarker: 'local-second' } as any,
		] });

		const recovery = JSON.parse(recoveryText);
		expect(recovery.futureRoot).toBeUndefined();
		expect(recovery.state.sections.map((section: any) => section.futureMarker)).toEqual(['local-first', 'local-second']);
	});

	it('treats mixed id-less query and copilotQuery recovery as ambiguous', async () => {
		const compatUri = vscode.Uri.parse('untitled:/work/sample.kql');
		const sidecarUri = vscode.Uri.parse('untitled:/work/sample.kql.json');
		const baseline = stringifyKqlxFile({
			kind: 'kqlx', version: 1, futureRoot: 'must-not-inherit', state: { sections: [
				{ type: 'query', linkedQueryPath: 'sample.kql', futureMarker: 'query' },
				{ type: 'copilotQuery', futureMarker: 'copilot' },
			] },
		} as any);
		vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(new TextEncoder().encode(baseline));
		let recoveryText = '';
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (_uri, bytes) => {
			recoveryText = new TextDecoder().decode(bytes);
		});
		const format: CompatSidecarFormat = {
			primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx',
		};
		const store = new CompatSidecarStore({
			compatUri,
			parse: text => {
				const parsed = parseKqlxText(text);
				return parsed.ok ? parsed.file : undefined;
			},
			isLinked: () => true,
			sanitizeFresh: async state => state,
			publishFresh: async (state, publish) => publish(state),
			buildFile: (state, baseFile) => buildCompatSidecarFile(compatUri, state, format, baseFile),
			stringify: stringifyKqlxFile,
		});

		await store.writeRecovery(sidecarUri, { sections: [
			{ id: 'local_1', type: 'query', futureMarker: 'local-1' } as any,
			{ id: 'local_2', type: 'query', futureMarker: 'local-2' } as any,
		] });

		const recovery = JSON.parse(recoveryText);
		expect(recovery.futureRoot).toBeUndefined();
		expect(recovery.state.sections.map((section: any) => section.futureMarker)).toEqual(['local-1', 'local-2']);
	});
});
