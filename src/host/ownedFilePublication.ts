import * as fs from 'fs';

export type OwnedFileIdentity = Readonly<{
	device: number;
	inode: number;
}>;

async function replaceHandleBytes(handle: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
	await handle.truncate(0);
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
		if (bytesWritten <= 0) throw new Error('The owned file write made no progress.');
		offset += bytesWritten;
	}
	await handle.truncate(bytes.length);
	await handle.sync();
}

export async function publishOwnedFileText(
	handle: fs.promises.FileHandle,
	expectedIdentity: OwnedFileIdentity,
	expectedText: string | undefined,
	nextText: string,
): Promise<void> {
	const stat = await handle.stat();
	if (stat.dev !== expectedIdentity.device || (expectedIdentity.inode !== 0 && stat.ino !== expectedIdentity.inode)) {
		throw new Error('The owned file changed physical identity before publication.');
	}
	const baseline = await handle.readFile({ encoding: 'utf8' });
	if (expectedText !== undefined && baseline !== expectedText) throw new Error('The owned file changed before publication.');
	try {
		await replaceHandleBytes(handle, Buffer.from(nextText, 'utf8'));
	} catch (publicationError) {
		try {
			await replaceHandleBytes(handle, Buffer.from(baseline, 'utf8'));
		} catch (rollbackError) {
			throw new AggregateError(
				[publicationError, rollbackError],
				'The owned file publication failed and its original bytes could not be restored.',
			);
		}
		throw publicationError;
	}
}
