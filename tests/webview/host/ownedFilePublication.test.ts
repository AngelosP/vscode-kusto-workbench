import { describe, expect, it, vi } from 'vitest';

import { publishOwnedFileText } from '../../../src/host/ownedFilePublication';

const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

function faultingHandle(options: {
	rollbackFails?: boolean;
	baseline?: Buffer;
	failFirstSync?: boolean;
	onReadFile?: () => void;
} = {}) {
	let bytes = Buffer.from(options.baseline ?? Buffer.from('BASELINE', 'utf8'));
	let syncCalls = 0;
	const failFirstSync = options.failFirstSync ?? true;
	return {
		handle: {
			stat: vi.fn(async () => ({ dev: 7, ino: 11 })),
			readFile: vi.fn(async () => {
				const text = bytes.toString('utf8');
				options.onReadFile?.();
				return text;
			}),
			truncate: vi.fn(async (length: number) => {
				if (length === 0) bytes = Buffer.alloc(0);
				else if (bytes.length > length) bytes = bytes.subarray(0, length);
				else if (bytes.length < length) bytes = Buffer.concat([bytes, Buffer.alloc(length - bytes.length)]);
			}),
			write: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
				const chunk = buffer.subarray(offset, offset + length);
				const required = position + chunk.length;
				if (bytes.length < required) bytes = Buffer.concat([bytes, Buffer.alloc(required - bytes.length)]);
				chunk.copy(bytes, position);
				return { bytesWritten: chunk.length, buffer };
			}),
			sync: vi.fn(async () => {
				syncCalls++;
				if ((failFirstSync && syncCalls === 1) || (options.rollbackFails && syncCalls === 2)) throw new Error(`sync failure ${syncCalls}`);
			}),
		} as any,
		text: () => bytes.toString('utf8'),
		bytes: () => Buffer.from(bytes),
	};
}

describe('publishOwnedFileText', () => {
	it('keeps complete JSON visible when a publication shrinks before its final truncate', async () => {
		const baseline = JSON.stringify({ value: 'long original result' });
		const next = JSON.stringify({ value: 'new' });
		const fixture = faultingHandle({ baseline, failFirstSync: false });
		const write = fixture.handle.write.getMockImplementation()!;
		const observed: string[] = [];
		fixture.handle.write.mockImplementation(async (...args: Parameters<typeof write>) => {
			expect(() => JSON.parse(fixture.text())).not.toThrow();
			const result = await write(...args);
			observed.push(fixture.text());
			expect(() => JSON.parse(fixture.text())).not.toThrow();
			return result;
		});
		await publishOwnedFileText(fixture.handle, { device: 7, inode: 11 }, baseline, next);
		expect(fixture.text()).toBe(next);
		expect(observed).toHaveLength(1);
		expect(observed[0].trimEnd()).toBe(next);
		expect(fixture.handle.truncate).toHaveBeenCalledExactlyOnceWith(Buffer.byteLength(next));
	});

	it('restores exact baseline bytes when publication fails after truncation', async () => {
		const fixture = faultingHandle();

		await expect(publishOwnedFileText(
			fixture.handle,
			{ device: 7, inode: 11 },
			'BASELINE',
			'REPLACEMENT',
		)).rejects.toThrow('sync failure 1');

		expect(fixture.text()).toBe('BASELINE');
		expect(fixture.handle.sync).toHaveBeenCalledTimes(2);
	});

	it('reports both publication and rollback failures', async () => {
		const fixture = faultingHandle({ rollbackFails: true });

		await expect(publishOwnedFileText(
			fixture.handle,
			{ device: 7, inode: 11 },
			'BASELINE',
			'REPLACEMENT',
		)).rejects.toMatchObject({ name: 'AggregateError' });
	});

	it('publishes BOM-less expected text while preserving the exact single BOM prefix', async () => {
		const fixture = faultingHandle({
			baseline: Buffer.concat([BOM_BYTES, Buffer.from('BASELINE', 'utf8')]),
			failFirstSync: false,
		});

		await publishOwnedFileText(
			fixture.handle,
			{ device: 7, inode: 11 },
			'BASELINE',
			'REPLACEMENT',
		);

		const expectedBytes = Buffer.concat([BOM_BYTES, Buffer.from('REPLACEMENT', 'utf8')]);
		expect(fixture.bytes().equals(expectedBytes)).toBe(true);
		expect(fixture.bytes().subarray(3, 6).equals(BOM_BYTES)).toBe(false);
		expect(fixture.handle.sync).toHaveBeenCalledTimes(1);
	});

	it('restores the exact original BOM bytes when publication fails', async () => {
		const originalBytes = Buffer.concat([BOM_BYTES, Buffer.from('BASELINE', 'utf8')]);
		const fixture = faultingHandle({ baseline: originalBytes });

		await expect(publishOwnedFileText(
			fixture.handle,
			{ device: 7, inode: 11 },
			'BASELINE',
			'REPLACEMENT',
		)).rejects.toThrow('sync failure 1');

		expect(fixture.bytes().equals(originalBytes)).toBe(true);
		expect(fixture.handle.sync).toHaveBeenCalledTimes(2);
	});

	it('rejects without truncating or writing when authority retires during the baseline read', async () => {
		let current = true;
		const fixture = faultingHandle({
			failFirstSync: false,
			onReadFile: () => { current = false; },
		});
		const isCurrent = vi.fn(async () => current);

		await expect(publishOwnedFileText(
			fixture.handle,
			{ device: 7, inode: 11 },
			'BASELINE',
			'REPLACEMENT',
			isCurrent,
		)).rejects.toThrow('The owned file publication authority retired before publication.');

		expect(fixture.handle.readFile).toHaveBeenCalledTimes(1);
		expect(isCurrent).toHaveBeenCalledTimes(1);
		expect(isCurrent.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.handle.readFile.mock.invocationCallOrder[0]);
		expect(fixture.handle.truncate).not.toHaveBeenCalled();
		expect(fixture.handle.write).not.toHaveBeenCalled();
		expect(fixture.handle.sync).not.toHaveBeenCalled();
		expect(fixture.text()).toBe('BASELINE');
	});

	it('rejects a foreign BOM baseline without stripping or bypassing the comparison', async () => {
		const foreignBytes = Buffer.concat([BOM_BYTES, Buffer.from('FOREIGN', 'utf8')]);
		const fixture = faultingHandle({ baseline: foreignBytes, failFirstSync: false });
		const isCurrent = vi.fn(async () => true);

		await expect(publishOwnedFileText(
			fixture.handle,
			{ device: 7, inode: 11 },
			'BASELINE',
			'REPLACEMENT',
			isCurrent,
		)).rejects.toThrow('The owned file changed before publication.');

		expect(isCurrent).not.toHaveBeenCalled();
		expect(fixture.handle.truncate).not.toHaveBeenCalled();
		expect(fixture.handle.write).not.toHaveBeenCalled();
		expect(fixture.bytes().equals(foreignBytes)).toBe(true);
	});
});
