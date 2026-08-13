import { describe, expect, it } from 'vitest';

import {
	admitEditingPreferencesHostMessage,
	admitEditingPreferencesWebviewMessage,
	isEditingPreferencesHostMessageType,
	isEditingPreferencesWebviewMessageType,
	parseEditingPreferencesHostMessage,
	parseEditingPreferencesWebviewMessage,
} from '../../src/shared/editingPreferences.js';

function canonicalDelivery(revision = 7) {
	return {
		type: 'editingPreferencesData' as const,
		revision,
		caretDocsEnabled: false,
		caretDocsEnabledUserSet: true,
		autoTriggerAutocompleteEnabled: true,
		autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabled: false,
		copilotInlineCompletionsEnabledUserSet: true,
	};
}

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

describe('editing preferences protocol', () => {
	it('snapshots all setters and freezes one stable host delivery without normalizing values', () => {
		for (const request of [
			{ type: 'setCaretDocsEnabled' as const, enabled: false },
			{ type: 'setAutoTriggerAutocompleteEnabled' as const, enabled: true },
			{ type: 'setCopilotInlineCompletionsEnabled' as const, enabled: false },
		]) {
			const parsed = parseEditingPreferencesWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) expect(parsed.value).not.toBe(request);
		}

		const delivery = canonicalDelivery();
		const parsed = parseEditingPreferencesHostMessage(delivery);
		expect(parsed).toEqual({ ok: true, value: delivery });
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.value).not.toBe(delivery);
		expect(Object.isFrozen(parsed.value)).toBe(true);
		const reparsed = parseEditingPreferencesHostMessage(parsed.value);
		expect(reparsed.ok && reparsed.value).toBe(parsed.value);
	});

	it('accepts revision zero and exact boolean combinations', () => {
		const delivery = canonicalDelivery(0);
		delivery.caretDocsEnabled = true;
		delivery.caretDocsEnabledUserSet = false;
		delivery.autoTriggerAutocompleteEnabled = false;
		delivery.autoTriggerAutocompleteEnabledUserSet = true;
		delivery.copilotInlineCompletionsEnabled = true;
		delivery.copilotInlineCompletionsEnabledUserSet = false;

		expect(parseEditingPreferencesHostMessage(delivery)).toEqual({ ok: true, value: delivery });
	});

	it('claims malformed setters and deliveries with exact scalar validation', () => {
		for (const malformed of [
			{ type: 'setCaretDocsEnabled', enabled: 0 },
			{ type: 'setAutoTriggerAutocompleteEnabled', enabled: 'false' },
			{ type: 'setCopilotInlineCompletionsEnabled', enabled: null },
		]) {
			expect(admitEditingPreferencesWebviewMessage(malformed))
				.toMatchObject({ recognized: true, parsed: { ok: false } });
		}

		const delivery = canonicalDelivery();
		for (const malformed of [
			{ ...delivery, revision: -1 },
			{ ...delivery, revision: 1.5 },
			{ ...delivery, revision: Number.NaN },
			{ ...delivery, revision: Number.POSITIVE_INFINITY },
			{ ...delivery, revision: Number.MAX_SAFE_INTEGER + 1 },
			{ ...delivery, caretDocsEnabled: 'false' },
			{ ...delivery, caretDocsEnabledUserSet: 1 },
			{ ...delivery, autoTriggerAutocompleteEnabled: null },
			{ ...delivery, autoTriggerAutocompleteEnabledUserSet: 'yes' },
			{ ...delivery, copilotInlineCompletionsEnabled: [] },
			{ ...delivery, copilotInlineCompletionsEnabledUserSet: {} },
		]) {
			expect(admitEditingPreferencesHostMessage(malformed))
				.toMatchObject({ recognized: true, parsed: { ok: false } });
		}
	});

	it('rejects inherited, non-enumerable, and accessor fields without invoking getters', () => {
		const request = { type: 'setCaretDocsEnabled', enabled: true };
		for (const key of ['type', 'enabled']) {
			const inherited = inheritField(request, key);
			expect(isEditingPreferencesWebviewMessageType(inherited)).toBe(true);
			expect(parseEditingPreferencesWebviewMessage(inherited)).toMatchObject({ ok: false });
		}

		const nonEnumerable = canonicalDelivery();
		Object.defineProperty(nonEnumerable, 'revision', { value: 7, enumerable: false });
		expect(parseEditingPreferencesHostMessage(nonEnumerable)).toMatchObject({ ok: false });

		let getterCalls = 0;
		const accessor = canonicalDelivery() as Record<string, unknown>;
		Object.defineProperty(accessor, 'caretDocsEnabled', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});
		expect(parseEditingPreferencesHostMessage(accessor)).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);
	});

	it('captures descriptor-stable proxies without property reads', () => {
		const delivery = canonicalDelivery();
		let typeInspections = 0;
		let propertyReads = 0;
		const proxy = new Proxy(delivery, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});

		const admitted = admitEditingPreferencesHostMessage(proxy);
		expect(typeInspections).toBe(1);
		expect(propertyReads).toBe(0);
		expect(admitted.recognized).toBe(true);
		if (!admitted.recognized) throw new Error('Expected recognized delivery.');
		expect(admitted.parsed.ok).toBe(true);
		if (!admitted.parsed.ok) throw new Error(admitted.parsed.error);
		expect(Object.is(admitted.parsed.value, proxy)).toBe(false);
		expect(admitted.parsed.value).toEqual(delivery);
		expect(Object.isFrozen(admitted.parsed.value)).toBe(true);
	});

	it('fails closed on arrays, callables, descriptor traps, revoked proxies, and bounded prototypes', () => {
		const request = { type: 'setCaretDocsEnabled' as const, enabled: true };
		expect(admitEditingPreferencesWebviewMessage(Object.assign([], request)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitEditingPreferencesWebviewMessage(Object.assign(() => undefined, request)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });

		const descriptorTrap = new Proxy(canonicalDelivery(), {
			getOwnPropertyDescriptor() {
				throw new Error('descriptor trap');
			},
		});
		const revoked = Proxy.revocable(canonicalDelivery(), {});
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

		expect(() => admitEditingPreferencesHostMessage(descriptorTrap)).not.toThrow();
		expect(admitEditingPreferencesHostMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(() => admitEditingPreferencesHostMessage(revoked.proxy)).not.toThrow();
		expect(admitEditingPreferencesHostMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitEditingPreferencesHostMessage(cyclicProxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isEditingPreferencesHostMessageType(createUnboundedProxy())).toBe(true);
		expect(prototypeReads).toBe(16);
	});

	it('does not claim unrelated traffic', () => {
		expect(admitEditingPreferencesWebviewMessage({ type: 'getConnections' })).toEqual({ recognized: false });
		expect(admitEditingPreferencesHostMessage({ type: 'connectionsData' })).toEqual({ recognized: false });
		expect(parseEditingPreferencesWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseEditingPreferencesHostMessage({ type: 'setCaretDocsEnabled' })).toMatchObject({ ok: false });
	});
});
