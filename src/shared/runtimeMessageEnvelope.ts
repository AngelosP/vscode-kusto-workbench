export type RuntimeMessageEnvelopeDescriptorSnapshot = Readonly<{
	input: object;
	descriptors: PropertyDescriptorMap;
}>;

export type RuntimeMessageEnvelopeCaptureResult =
	| Readonly<{
		ok: true;
		value: Record<string, unknown> & { type: string };
		descriptorSnapshot: RuntimeMessageEnvelopeDescriptorSnapshot;
	}>
	| Readonly<{ ok: false; error: string }>;

export function captureRuntimeMessageEnvelope(input: unknown): RuntimeMessageEnvelopeCaptureResult {
	if (!input || typeof input !== 'object') {
		return { ok: false, error: 'Message envelope must be an object.' };
	}
	try {
		if (Array.isArray(input)) return { ok: false, error: 'Message envelope must not be an array.' };
		const descriptors = Object.getOwnPropertyDescriptors(input);
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
		return {
			ok: true,
			value: captured,
			descriptorSnapshot: { input, descriptors },
		};
	} catch {
		return { ok: false, error: 'Message envelope could not be captured.' };
	}
}