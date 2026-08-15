export type RuntimeMessageEnvelopeDescriptorSnapshot = Readonly<{
	input: object;
	descriptors: PropertyDescriptorMap;
	prototype: object | null;
}>;

export type RuntimeMessageEnvelopeCaptureResult =
	| Readonly<{
		ok: true;
		value: Record<string, unknown> & { type: string };
		descriptorSnapshot: RuntimeMessageEnvelopeDescriptorSnapshot;
	}>
	| Readonly<{ ok: false; error: string }>;

const descriptorSnapshots = new WeakMap<object, RuntimeMessageEnvelopeDescriptorSnapshot>();

type RuntimeProxyDetector = (input: unknown) => boolean;

const runtimeProxyDetector = (() => {
	try {
		const runtimeProcess = (globalThis as typeof globalThis & {
			process?: { getBuiltinModule?: (specifier: string) => unknown };
		}).process;
		const util = runtimeProcess?.getBuiltinModule?.('node:util') as {
			types?: { isProxy?: RuntimeProxyDetector };
		} | undefined;
		return typeof util?.types?.isProxy === 'function'
			? util.types.isProxy.bind(util.types)
			: undefined;
	} catch {
		return undefined;
	}
})();

export function isRuntimeProxy(input: unknown): boolean {
	if (!runtimeProxyDetector) return false;
	try {
		return runtimeProxyDetector(input);
	} catch {
		return true;
	}
}

export function getRuntimeMessageEnvelopeDescriptorSnapshot(
	input: unknown,
): RuntimeMessageEnvelopeDescriptorSnapshot | undefined {
	if (!input || (typeof input !== 'object' && typeof input !== 'function')) return undefined;
	return descriptorSnapshots.get(input as object);
}

export function captureRuntimeMessageEnvelope(input: unknown): RuntimeMessageEnvelopeCaptureResult {
	if (!input || typeof input !== 'object') {
		return { ok: false, error: 'Message envelope must be an object.' };
	}
	try {
		if (Array.isArray(input)) return { ok: false, error: 'Message envelope must not be an array.' };
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const prototype = Object.getPrototypeOf(input);
		const typeDescriptor = Reflect.get(descriptors, 'type') as PropertyDescriptor | undefined;
		if (!typeDescriptor
			|| !typeDescriptor.enumerable
			|| !Object.prototype.hasOwnProperty.call(typeDescriptor, 'value')
			|| typeof typeDescriptor.value !== 'string') {
			return { ok: false, error: 'Message type must be an own enumerable string data property.' };
		}
		const captured = Object.create(null) as Record<string, unknown> & { type: string };
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!descriptor.enumerable) continue;
			if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return { ok: false, error: 'Message fields must be enumerable string data properties.' };
			}
			Object.defineProperty(captured, key, {
				value: descriptor.value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		const descriptorSnapshot = { input, descriptors, prototype };
		descriptorSnapshots.set(captured, descriptorSnapshot);
		return {
			ok: true,
			value: captured,
			descriptorSnapshot,
		};
	} catch {
		return { ok: false, error: 'Message envelope could not be captured.' };
	}
}