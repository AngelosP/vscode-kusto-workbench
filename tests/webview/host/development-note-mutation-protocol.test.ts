import { describe, expect, it } from 'vitest';

import {
	admitDevelopmentNoteMutationHostMessage,
	admitDevelopmentNoteMutationHostMessageFromEnvelope,
	admitDevelopmentNoteMutationWebviewMessage,
	createDevelopmentNoteMutationHostMessage,
	createDevelopmentNoteMutationWebviewMessage,
	parseDevelopmentNoteMutationHostMessage,
	parseDevelopmentNoteMutationPayload,
	parseDevelopmentNoteMutationWebviewMessage,
} from '../../../src/shared/developmentNoteMutationProtocol';
import { captureRuntimeMessageEnvelope } from '../../../src/shared/runtimeMessageEnvelope';

function entry(id = 'note_exact') {
	return {
		id,
		created: '2026-08-14T00:00:00.000Z',
		updated: '2026-08-14T00:01:00.000Z',
		category: 'usage-note',
		relatedSectionIds: ['query_exact'],
		content: 'Exact content',
		source: 'agent',
	};
}

describe('development-note mutation protocol', () => {
	it('constructs and parses exact add, supersede, and remove requests', () => {
		const add = createDevelopmentNoteMutationHostMessage('request-add', {
			action: 'add', entry: entry('note_add'),
		});
		const supersede = createDevelopmentNoteMutationHostMessage('request-supersede', {
			action: 'supersede', entry: entry('note_replacement'), supersededId: 'note_add',
		});
		const remove = createDevelopmentNoteMutationHostMessage('request-remove', {
			action: 'remove', noteId: 'note_replacement',
		});

		expect(add).toEqual({
			ok: true,
			value: {
				type: 'updateDevNotes', requestId: 'request-add', action: 'add', entry: entry('note_add'),
			},
		});
		expect(supersede).toEqual({
			ok: true,
			value: {
				type: 'updateDevNotes', requestId: 'request-supersede', action: 'supersede',
				entry: entry('note_replacement'), supersededId: 'note_add',
			},
		});
		expect(remove).toEqual({
			ok: true,
			value: { type: 'updateDevNotes', requestId: 'request-remove', action: 'remove', noteId: 'note_replacement' },
		});
		for (const request of [add, supersede, remove]) {
			expect(request.ok).toBe(true);
			if (!request.ok) continue;
			const parsed = parseDevelopmentNoteMutationHostMessage(request.value);
			expect(parsed.ok).toBe(true);
			expect(Object.isFrozen(request.value)).toBe(true);
		}
	});

	it('constructs and parses only the exact correlated response subset', () => {
		const success = createDevelopmentNoteMutationWebviewMessage('request-success', true);
		const failure = createDevelopmentNoteMutationWebviewMessage('request-failure', false, 'Rejected exactly.');

		expect(parseDevelopmentNoteMutationWebviewMessage(success)).toEqual({ ok: true, value: success });
		expect(parseDevelopmentNoteMutationWebviewMessage(failure)).toEqual({ ok: true, value: failure });
		expect(Object.isFrozen(success)).toBe(true);
		expect(Object.isFrozen(success.result)).toBe(true);
		expect(parseDevelopmentNoteMutationWebviewMessage({
			type: 'toolResponse', requestId: 'request-success', result: { success: true }, error: 'forged',
		}).ok).toBe(false);
		expect(parseDevelopmentNoteMutationWebviewMessage({
			type: 'toolResponse', requestId: 'request-failure', result: { success: false, extra: true },
		}).ok).toBe(false);
	});

	it('rejects aliases, extra correlation fields, incomplete entries, and noncanonical arrays', () => {
		expect(parseDevelopmentNoteMutationPayload({
			action: 'supersede', entry: entry(), supersedes: 'legacy-note',
		}).ok).toBe(false);
		expect(parseDevelopmentNoteMutationPayload({
			action: 'remove', noteId: 'note_exact', requestId: 'caller-controlled',
		}).ok).toBe(false);
		expect(parseDevelopmentNoteMutationPayload({ action: 'add', entry: { id: 'partial' } }).ok).toBe(false);

		const relatedSectionIds = ['query_exact'];
		Object.defineProperty(relatedSectionIds, Symbol.iterator, {
			value: () => [][Symbol.iterator](), enumerable: false,
		});
		expect(parseDevelopmentNoteMutationPayload({
			action: 'add', entry: { ...entry(), relatedSectionIds },
		}).ok).toBe(false);
	});

	it('does not invoke accessors and rejects inherited, custom-prototype, and revoked traffic', () => {
		let getterCalls = 0;
		const accessorRequest: Record<string, unknown> = {
			type: 'updateDevNotes', requestId: 'request-accessor', action: 'add',
		};
		Object.defineProperty(accessorRequest, 'entry', {
			enumerable: true,
			get() {
				getterCalls++;
				return entry();
			},
		});
		const accessorAdmission = admitDevelopmentNoteMutationHostMessage(accessorRequest);
		expect(accessorAdmission.recognized).toBe(true);
		if (accessorAdmission.recognized) expect(accessorAdmission.parsed.ok).toBe(false);
		expect(getterCalls).toBe(0);

		const inherited = Object.assign(Object.create({ type: 'updateDevNotes' }), {
			requestId: 'request-inherited', action: 'remove', noteId: 'note_exact',
		});
		const inheritedAdmission = admitDevelopmentNoteMutationHostMessage(inherited);
		expect(inheritedAdmission.recognized).toBe(true);
		if (inheritedAdmission.recognized) expect(inheritedAdmission.parsed.ok).toBe(false);

		const customPrototype = Object.assign(Object.create({ marker: true }), {
			type: 'updateDevNotes', requestId: 'request-prototype', action: 'remove', noteId: 'note_exact',
		});
		const envelope = captureRuntimeMessageEnvelope(customPrototype);
		expect(envelope.ok).toBe(true);
		if (envelope.ok) {
			const rawAdmission = admitDevelopmentNoteMutationHostMessageFromEnvelope(envelope.descriptorSnapshot);
			expect(rawAdmission.recognized).toBe(true);
			if (rawAdmission.recognized) expect(rawAdmission.parsed.ok).toBe(false);
		}

		const customPrototypeResponse = Object.assign(Object.create({ marker: true }), {
			type: 'toolResponse', requestId: 'request-response-prototype', result: { success: true },
		});
		const responseEnvelope = captureRuntimeMessageEnvelope(customPrototypeResponse);
		expect(responseEnvelope.ok).toBe(true);
		if (responseEnvelope.ok) {
			const responseAdmission = admitDevelopmentNoteMutationWebviewMessage(responseEnvelope.value);
			expect(responseAdmission.recognized).toBe(true);
			if (responseAdmission.recognized) {
				expect(responseAdmission.requestId).toBe('request-response-prototype');
				expect(responseAdmission.parsed.ok).toBe(false);
			}
		}

		const revocable = Proxy.revocable({
			type: 'toolResponse', requestId: 'request-revoked', result: { success: true },
		}, {});
		revocable.revoke();
		expect(() => admitDevelopmentNoteMutationWebviewMessage(revocable.proxy)).not.toThrow();

		const nestedArray = Proxy.revocable(['query_exact'], {});
		nestedArray.revoke();
		let nestedResult: ReturnType<typeof parseDevelopmentNoteMutationPayload> | undefined;
		expect(() => {
			nestedResult = parseDevelopmentNoteMutationPayload({
				action: 'add', entry: { ...entry(), relatedSectionIds: nestedArray.proxy },
			});
		}).not.toThrow();
		expect(nestedResult?.ok).toBe(false);
	});

	it('rejects an entry aliased to its shape-varying enclosing request after one snapshot', () => {
		let ownKeysCalls = 0;
		const target: Record<string, unknown> = {
			type: 'updateDevNotes', requestId: 'request-self-entry', action: 'add',
			...entry('note-self-entry'),
		};
		let selfEntry!: Record<string, unknown>;
		selfEntry = new Proxy(target, {
			ownKeys() {
				ownKeysCalls++;
				return ownKeysCalls === 1
					? ['type', 'requestId', 'action', 'entry']
					: ['id', 'created', 'updated', 'category', 'relatedSectionIds', 'content', 'source'];
			},
			getOwnPropertyDescriptor(candidate, key) {
				if (key === 'entry') {
					return { configurable: true, enumerable: true, writable: true, value: selfEntry };
				}
				return Reflect.getOwnPropertyDescriptor(candidate, key);
			},
		});

		expect(admitDevelopmentNoteMutationHostMessage(selfEntry))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(ownKeysCalls).toBe(1);

		let wrappedOwnKeysCalls = 0;
		let shapeVaryingRequest!: Record<string, unknown>;
		let wrappedEntry!: Record<string, unknown>;
		shapeVaryingRequest = new Proxy(target, {
			ownKeys() {
				wrappedOwnKeysCalls++;
				return wrappedOwnKeysCalls === 1
					? ['type', 'requestId', 'action', 'entry']
					: ['id', 'created', 'updated', 'category', 'relatedSectionIds', 'content', 'source'];
			},
			getOwnPropertyDescriptor(candidate, key) {
				if (key === 'entry') {
					return { configurable: true, enumerable: true, writable: true, value: wrappedEntry };
				}
				return Reflect.getOwnPropertyDescriptor(candidate, key);
			},
		});
		wrappedEntry = new Proxy(shapeVaryingRequest, {});
		expect(admitDevelopmentNoteMutationHostMessage(shapeVaryingRequest))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(wrappedOwnKeysCalls).toBe(1);
	});

	it('exposes exact correlation without accepting malformed matching results', () => {
		const malformed = admitDevelopmentNoteMutationWebviewMessage({
			type: 'toolResponse', requestId: 'request-current', result: { success: 'yes' },
		});

		expect(malformed.recognized).toBe(true);
		if (!malformed.recognized) return;
		expect(malformed.requestId).toBe('request-current');
		expect(malformed.parsed.ok).toBe(false);

		const inherited = admitDevelopmentNoteMutationWebviewMessage(Object.assign(
			Object.create({ requestId: 'request-inherited-current' }),
			{ type: 'toolResponse', result: { success: 'yes' } },
		));
		expect(inherited.recognized).toBe(true);
		if (!inherited.recognized) return;
		expect(inherited.requestId).toBe('request-inherited-current');
		expect(inherited.parsed.ok).toBe(false);
	});
});