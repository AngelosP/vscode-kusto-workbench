import { describe, expect, it, vi } from 'vitest';

import { publishOwnedFileText } from '../../../src/host/ownedFilePublication';

function faultingHandle(options: { rollbackFails?: boolean } = {}) {
	let bytes = Buffer.from('BASELINE', 'utf8');
	let syncCalls = 0;
	return {
		handle: {
			stat: vi.fn(async () => ({ dev: 7, ino: 11 })),
			readFile: vi.fn(async () => bytes.toString('utf8')),
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
				if (syncCalls === 1 || (options.rollbackFails && syncCalls === 2)) throw new Error(`sync failure ${syncCalls}`);
			}),
		} as any,
		text: () => bytes.toString('utf8'),
	};
}

describe('publishOwnedFileText', () => {
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
});
