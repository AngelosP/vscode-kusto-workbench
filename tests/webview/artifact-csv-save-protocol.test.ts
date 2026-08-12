import { describe, expect, it } from 'vitest';

import {
	admitArtifactCsvSaveHostMessage,
	admitArtifactCsvSaveWebviewMessage,
	isArtifactCsvSaveHostMessageType,
	isArtifactCsvSaveWebviewMessageType,
	parseArtifactCsvSaveHostMessage,
	parseArtifactCsvSaveWebviewMessage,
} from '../../src/shared/artifactCsvSaveProtocol.js';

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

describe('artifact CSV save protocol', () => {
	it('snapshots all five canonical messages without normalizing exact values', () => {
		const webviewMessages = [
			{
				type: 'requestArtifactCsvSave', requestId: ' export-1 ', boxId: ' query-1 ',
				artifactId: ' artifact-1 ', suggestedFileName: '',
			},
			{
				type: 'artifactCsvSaveData', requestId: 'nonce-1', boxId: 'query-1',
				artifactId: 'artifact-1', accepted: true, csv: '',
			},
			{
				type: 'artifactCsvSaveData', requestId: 'nonce-2', boxId: 'query-2',
				artifactId: 'artifact-2', accepted: false,
			},
			{ type: 'cancelArtifactCsvSaveIntent', requestId: 'export-2' },
		] as const;
		const hostMessages = [
			{
				type: 'requestArtifactCsvSaveData', requestId: 'nonce-1', exportId: 'export-1',
				boxId: 'query-1', artifactId: 'artifact-1',
			},
			{ type: 'cancelArtifactCsvSave', exportId: 'export-2' },
		] as const;

		for (const message of webviewMessages) {
			const parsed = parseArtifactCsvSaveWebviewMessage(message);
			expect(parsed).toEqual({ ok: true, value: message });
			if (parsed.ok) expect(parsed.value).not.toBe(message);
		}
		for (const message of hostMessages) {
			const parsed = parseArtifactCsvSaveHostMessage(message);
			expect(parsed).toEqual({ ok: true, value: message });
			if (parsed.ok) expect(parsed.value).not.toBe(message);
		}
	});

	it('preserves optional filename behavior and requires exclusive transfer branches', () => {
		const request = {
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1',
			artifactId: 'artifact-1', suggestedFileName: undefined,
		} as const;
		expect(parseArtifactCsvSaveWebviewMessage(request)).toEqual({
			ok: true,
			value: {
				type: 'requestArtifactCsvSave', requestId: 'export-1',
				boxId: 'query-1', artifactId: 'artifact-1',
			},
		});
		expect(parseArtifactCsvSaveWebviewMessage({ ...request, suggestedFileName: 42 }))
			.toMatchObject({ ok: false });
		expect(parseArtifactCsvSaveWebviewMessage({
			type: 'artifactCsvSaveData', requestId: 'nonce-1', boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true,
		})).toMatchObject({ ok: false });
		expect(parseArtifactCsvSaveWebviewMessage({
			type: 'artifactCsvSaveData', requestId: 'nonce-1', boxId: 'query-1',
			artifactId: 'artifact-1', accepted: false, csv: undefined,
		})).toMatchObject({ ok: false });
	});

	it('accepts null-prototype records and ignores inherited forbidden fields', () => {
		const request = Object.assign(Object.create(null), {
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1',
			artifactId: 'artifact-1',
		});
		const rejected = Object.assign(Object.create({ csv: 'inherited' }), {
			type: 'artifactCsvSaveData', requestId: 'nonce-1', boxId: 'query-1',
			artifactId: 'artifact-1', accepted: false,
		});

		expect(parseArtifactCsvSaveWebviewMessage(request)).toEqual({ ok: true, value: { ...request } });
		expect(parseArtifactCsvSaveWebviewMessage(rejected)).toEqual({
			ok: true,
			value: {
				type: 'artifactCsvSaveData', requestId: 'nonce-1', boxId: 'query-1',
				artifactId: 'artifact-1', accepted: false,
			},
		});
	});

	it('claims inherited, non-enumerable, and accessor required fields without invoking accessors', () => {
		const request = {
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1', artifactId: 'artifact-1',
		};
		for (const key of ['type', 'requestId', 'boxId', 'artifactId']) {
			const inherited = inheritField(request, key);
			expect(isArtifactCsvSaveWebviewMessageType(inherited)).toBe(true);
			expect(parseArtifactCsvSaveWebviewMessage(inherited)).toMatchObject({ ok: false });
		}

		const challenge = {
			type: 'requestArtifactCsvSaveData', requestId: 'nonce-1', exportId: 'export-1',
			boxId: 'query-1', artifactId: 'artifact-1',
		};
		for (const key of ['type', 'requestId', 'exportId', 'boxId', 'artifactId']) {
			expect(parseArtifactCsvSaveHostMessage(inheritField(challenge, key))).toMatchObject({ ok: false });
		}

		let getterCalls = 0;
		const accessor = { ...request };
		Object.defineProperty(accessor, 'boxId', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});
		const nonEnumerable = { ...challenge };
		Object.defineProperty(nonEnumerable, 'artifactId', { value: 'artifact-1', enumerable: false });
		expect(parseArtifactCsvSaveWebviewMessage(accessor)).toMatchObject({ ok: false });
		expect(parseArtifactCsvSaveHostMessage(nonEnumerable)).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);
	});

	it('atomically snapshots proxies without property reads and claims callables', () => {
		const request = {
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1', artifactId: 'artifact-1',
		} as const;
		let typeInspections = 0;
		let propertyReads = 0;
		const proxy = new Proxy(request, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});

		expect(admitArtifactCsvSaveWebviewMessage(proxy)).toEqual({
			recognized: true, parsed: { ok: true, value: request },
		});
		expect(typeInspections).toBe(1);
		expect(propertyReads).toBe(0);
		expect(admitArtifactCsvSaveWebviewMessage(Object.assign(() => undefined, request)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitArtifactCsvSaveHostMessage(Object.assign(() => undefined, {
			type: 'cancelArtifactCsvSave', exportId: 'export-1',
		}))).toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('fails closed on descriptor traps, revoked proxies, and bounded prototype inspection', () => {
		const request = {
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1', artifactId: 'artifact-1',
		};
		const descriptorTrap = new Proxy(request, {
			getOwnPropertyDescriptor() {
				throw new Error('descriptor trap');
			},
		});
		const revoked = Proxy.revocable(request, {});
		revoked.revoke();
		let cyclicProxy: object;
		cyclicProxy = new Proxy({}, { getPrototypeOf: () => cyclicProxy });
		let prototypeReads = 0;
		const createUnboundedProxy = (): object => new Proxy({}, {
			getPrototypeOf() {
				prototypeReads++;
				return createUnboundedProxy();
			},
		});

		expect(() => admitArtifactCsvSaveWebviewMessage(descriptorTrap)).not.toThrow();
		expect(admitArtifactCsvSaveWebviewMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(() => admitArtifactCsvSaveWebviewMessage(revoked.proxy)).not.toThrow();
		expect(admitArtifactCsvSaveWebviewMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitArtifactCsvSaveWebviewMessage(cyclicProxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isArtifactCsvSaveHostMessageType(createUnboundedProxy())).toBe(true);
		expect(prototypeReads).toBe(16);
	});

	it('claims malformed known messages and does not claim unrelated traffic', () => {
		const transfer = {
			type: 'artifactCsvSaveData', requestId: 'nonce-1', boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv: 'Name\nalpha',
		} as const;
		for (const malformed of [
			Object.assign([], transfer),
			{ ...transfer, requestId: '' },
			{ ...transfer, boxId: ['query-1'] },
			{ ...transfer, artifactId: null },
			{ ...transfer, accepted: 'yes' },
		]) {
			expect(isArtifactCsvSaveWebviewMessageType(malformed)).toBe(true);
			expect(parseArtifactCsvSaveWebviewMessage(malformed)).toMatchObject({ ok: false });
		}
		const challenge = {
			type: 'requestArtifactCsvSaveData', requestId: 'nonce-1', exportId: 'export-1',
			boxId: 'query-1', artifactId: 'artifact-1',
		} as const;
		for (const malformed of [
			Object.assign([], challenge),
			{ ...challenge, requestId: [] },
			{ ...challenge, exportId: '   ' },
			{ ...challenge, boxId: 1 },
		]) {
			expect(isArtifactCsvSaveHostMessageType(malformed)).toBe(true);
			expect(parseArtifactCsvSaveHostMessage(malformed)).toMatchObject({ ok: false });
		}

		expect(isArtifactCsvSaveWebviewMessageType({ type: 'executePython' })).toBe(false);
		expect(isArtifactCsvSaveHostMessageType({ type: 'pythonResult' })).toBe(false);
		expect(parseArtifactCsvSaveWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseArtifactCsvSaveHostMessage({ type: 'requestArtifactCsvSave' })).toMatchObject({ ok: false });
	});
});