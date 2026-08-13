import { describe, expect, it } from 'vitest';

import {
	admitSqlStsEditorLanguageHostMessage,
	admitSqlStsEditorLanguageWebviewMessage,
	parseSqlStsEditorLanguageHostMessage,
	parseSqlStsEditorLanguageWebviewMessage,
} from '../../src/shared/sqlStsEditorLanguageProtocol.js';

describe('SQL STS editor-language protocol', () => {
	it('admits all five request shapes and preserves nested ownership identity', () => {
		const params = {
			boxId: 'sql-1', sectionInstanceId: 'instance-1', line: 1, column: 2,
			ownerToken: 'owner-1', targetGeneration: 0,
		};
		const expectedOwner = {
			connectionId: 'connection-1', database: 'Db', targetSignature: 'server\nDb',
			principalFingerprint: 'principal-1', revocationGeneration: 0,
		};
		const messages = [
			{ type: 'stsRequest', requestId: 'request-1', method: 'future/method', params },
			{ type: 'stsDidOpen', boxId: 'sql-1', sectionInstanceId: 'instance-1', text: '' },
			{ type: 'stsDidChange', boxId: 'sql-1', sectionInstanceId: 'instance-1', text: '' },
			{ type: 'stsDidClose', boxId: 'sql-1', sectionInstanceId: 'instance-1' },
			{
				type: 'stsConnect', boxId: 'sql-1', sectionInstanceId: 'instance-1',
				sqlConnectionId: 'connection-1', database: 'Db', targetGeneration: 0, expectedOwner,
			},
		] as const;

		for (const message of messages) {
			const parsed = parseSqlStsEditorLanguageWebviewMessage(message);
			expect(parsed).toMatchObject({ ok: true, value: message });
			expect(parsed.ok && parsed.value).not.toBe(message);
		}
		const request = parseSqlStsEditorLanguageWebviewMessage(messages[0]);
		expect(request.ok && request.value.type === 'stsRequest' && request.value.params).toBe(params);
		const connect = parseSqlStsEditorLanguageWebviewMessage(messages[4]);
		expect(connect.ok && connect.value.type === 'stsConnect' && connect.value.expectedOwner).toBe(expectedOwner);
	});

	it('keeps response results and marker records opaque while validating their containers', () => {
		const result = new Proxy({ items: [{ label: 'opaque' }] }, {
			get() { throw new Error('opaque result was inspected'); },
		});
		let markerReads = 0;
		const marker = Object.defineProperty({}, 'message', {
			enumerable: true,
			get() { markerReads++; return 'opaque marker'; },
		});
		const response = parseSqlStsEditorLanguageHostMessage({
			type: 'stsResponse', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			requestId: 'request-1', result, ownerToken: 'owner-1', targetGeneration: 0,
		});
		const diagnostics = parseSqlStsEditorLanguageHostMessage({
			type: 'stsDiagnostics', boxId: 'sql-1', sectionInstanceId: 'instance-1', markers: [marker],
		});

		expect(response.ok && response.value.type === 'stsResponse' && response.value.result).toBe(result);
		expect(diagnostics.ok && diagnostics.value.type === 'stsDiagnostics' && diagnostics.value.markers[0]).toBe(marker);
		expect(markerReads).toBe(0);
		expect(parseSqlStsEditorLanguageHostMessage({
			type: 'stsResponse', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			requestId: 'request-2', result: null, ownerToken: 'owner-1', targetGeneration: 0,
		})).toMatchObject({ ok: true, value: { result: null } });
		expect(parseSqlStsEditorLanguageHostMessage({
			type: 'stsDiagnostics', boxId: 'sql-1', sectionInstanceId: 'instance-1', markers: [],
		})).toMatchObject({ ok: true, value: { markers: [] } });
	});

	it('admits canonical ready and generation-less empty-error connection states', () => {
		expect(parseSqlStsEditorLanguageHostMessage({
			type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			state: 'ready', ownerToken: 'owner-1', connectionId: 'connection-1',
			database: 'Db', targetGeneration: 0,
		})).toMatchObject({ ok: true, value: { state: 'ready', targetGeneration: 0 } });
		expect(parseSqlStsEditorLanguageHostMessage({
			type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			state: 'error', error: '',
		})).toEqual({
			ok: true,
			value: {
				type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: 'instance-1',
				state: 'error', error: '',
			},
		});
	});

	it('rejects malformed request ownership, positions, and expected-owner proofs', () => {
		const request = {
			type: 'stsRequest', requestId: 'request-1', method: 'textDocument/hover',
			params: {
				boxId: 'sql-1', sectionInstanceId: 'instance-1', line: 1, column: 1,
				ownerToken: 'owner-1', targetGeneration: 1,
			},
		};
		const connect = {
			type: 'stsConnect', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			sqlConnectionId: 'connection-1', database: 'Db', targetGeneration: 1,
			expectedOwner: {
				connectionId: 'connection-1', database: 'Db', targetSignature: 'signature',
				principalFingerprint: 'principal', revocationGeneration: 1,
			},
		};

		for (const malformed of [
			{ ...request, params: { ...request.params, ownerToken: ['owner-1'] } },
			{ ...request, params: { ...request.params, targetGeneration: '1' } },
			{ ...request, params: { ...request.params, line: 0 } },
			{ ...request, params: { ...request.params, column: Number.NaN } },
			{ ...connect, expectedOwner: { ...connect.expectedOwner, revocationGeneration: -1 } },
			{ ...connect, expectedOwner: { ...connect.expectedOwner, principalFingerprint: [] } },
			Object.assign([], request),
			Object.assign(() => undefined, request),
		]) {
			expect(parseSqlStsEditorLanguageWebviewMessage(malformed).ok).toBe(false);
		}

		const inheritedExpectedOwner = Object.create({ expectedOwner: connect.expectedOwner });
		Object.assign(inheritedExpectedOwner, { ...connect, expectedOwner: undefined });
		delete inheritedExpectedOwner.expectedOwner;
		expect(parseSqlStsEditorLanguageWebviewMessage(inheritedExpectedOwner).ok).toBe(false);
	});

	it('rejects malformed response ownership and connection-state branches', () => {
		const response = {
			type: 'stsResponse', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			requestId: 'request-1', result: null, ownerToken: 'owner-1', targetGeneration: 1,
		};
		const ready = {
			type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: 'instance-1',
			state: 'ready', ownerToken: 'owner-1', connectionId: 'connection-1',
			database: 'Db', targetGeneration: 1,
		};

		for (const malformed of [
			{ ...response, ownerToken: ['owner-1'] },
			{ ...response, targetGeneration: '1' },
			{ ...ready, state: ['ready'] },
			{ ...ready, connectionId: 42 },
			{ ...ready, error: 'mixed' },
			{ ...ready, state: 'error', error: '', ownerToken: 'owner-1' },
			{ ...ready, state: 'error', error: '', ownerToken: undefined, connectionId: undefined, database: undefined },
			{ ...ready, state: 'unknown' },
		]) {
			expect(parseSqlStsEditorLanguageHostMessage(malformed).ok).toBe(false);
		}
	});

	it('rejects sparse, inherited, accessor, primitive, and huge sparse marker containers', () => {
		const message = {
			type: 'stsDiagnostics', boxId: 'sql-1', sectionInstanceId: 'instance-1', markers: [] as unknown[],
		};
		const sparse = new Array(1);
		const inherited = new Array(1);
		const inheritedPrototype = Object.create(Array.prototype);
		inheritedPrototype[0] = { message: 'inherited' };
		Object.setPrototypeOf(inherited, inheritedPrototype);
		const accessor: unknown[] = [];
		Object.defineProperty(accessor, '0', { enumerable: true, get: () => ({ message: 'accessor' }) });
		accessor.length = 1;
		const hugeSparse: unknown[] = [];
		hugeSparse.length = 0xffff_ffff;

		for (const markers of [sparse, inherited, accessor, [42], null, hugeSparse]) {
			expect(parseSqlStsEditorLanguageHostMessage({ ...message, markers }).ok).toBe(false);
		}
	});

	it('classifies malformed known traffic without invoking property getters', () => {
		let reads = 0;
		const request = {
			type: 'stsDidOpen', boxId: 'sql-1', sectionInstanceId: 'instance-1', text: 'SELECT 1',
		};
		const proxy = new Proxy(request, {
			get() { reads++; throw new Error('getter invoked'); },
		});
		const admitted = admitSqlStsEditorLanguageWebviewMessage(proxy);
		expect(admitted).toMatchObject({ recognized: true, parsed: { ok: true } });
		expect(reads).toBe(0);

		const inheritedType = Object.create({ type: 'stsResponse' });
		Object.assign(inheritedType, {
			boxId: 'sql-1', sectionInstanceId: 'instance-1', requestId: 'request-1',
			result: null, ownerToken: 'owner-1', targetGeneration: 1,
		});
		const inheritedAdmission = admitSqlStsEditorLanguageHostMessage(inheritedType);
		expect(inheritedAdmission).toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitSqlStsEditorLanguageHostMessage({ type: 'unrelated' })).toEqual({ recognized: false });
	});
});
