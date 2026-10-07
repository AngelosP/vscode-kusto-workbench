import * as fs from 'fs';

export type OwnedFileIdentity = Readonly<{
	device: number | string;
	inode: number | string;
}>;

export type OwnedFileTextCodec = Readonly<{
	decode(bytes: Uint8Array): string | PromiseLike<string>;
	encode(text: string): Uint8Array | PromiseLike<Uint8Array>;
}>;

async function ownedFileIdentityMatches(
	handle: fs.promises.FileHandle,
	expectedIdentity: OwnedFileIdentity,
): Promise<boolean> {
	if (typeof expectedIdentity.device === 'string' || typeof expectedIdentity.inode === 'string') {
		const stat = await handle.stat({ bigint: true });
		return stat.dev.toString() === String(expectedIdentity.device)
			&& (String(expectedIdentity.inode) === '0' || stat.ino.toString() === String(expectedIdentity.inode));
	}
	const stat = await handle.stat();
	return stat.dev === expectedIdentity.device
		&& (expectedIdentity.inode === 0 || stat.ino === expectedIdentity.inode);
}

async function replaceHandleBytes(handle: fs.promises.FileHandle, bytes: Buffer, writeBytes = bytes): Promise<void> {
	let offset = 0;
	while (offset < writeBytes.length) {
		const { bytesWritten } = await handle.write(writeBytes, offset, writeBytes.length - offset, offset);
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
	isCurrent: () => boolean | Promise<boolean> = () => true,
	codec?: OwnedFileTextCodec,
): Promise<void> {
	if (!await ownedFileIdentityMatches(handle, expectedIdentity)) {
		throw new Error('The owned file changed physical identity before publication.');
	}
	const baselineBytes = Buffer.from(await handle.readFile());
	const baseline = codec ? await codec.decode(baselineBytes) : baselineBytes.toString('utf8');
	const hasBom = baseline.startsWith('\uFEFF');
	if (expectedText !== undefined && baseline !== expectedText
		&& (!hasBom || baseline.slice(1) !== expectedText)) throw new Error('The owned file changed before publication.');
	const encodedText = hasBom && !nextText.startsWith('\uFEFF') ? '\uFEFF' + nextText : nextText;
	const nextBytes = codec ? Buffer.from(await codec.encode(nextText)) : Buffer.from(encodedText, 'utf8');
	if (codec && await codec.decode(nextBytes) !== nextText) throw new Error('The saved file encoding cannot represent the result text without loss.');
	const padding = Math.max(0, baselineBytes.length - nextBytes.length);
	const writeBytes = padding === 0 ? nextBytes : codec
		? Buffer.from(await codec.encode(nextText + ' '.repeat(padding)))
		: Buffer.concat([nextBytes, Buffer.alloc(padding, 0x20)]);
	if (!writeBytes.subarray(0, nextBytes.length).equals(nextBytes)) {
		throw new Error('The saved file encoding cannot safely preserve a shrinking text publication.');
	}
	if (!await isCurrent()) throw new Error('The owned file publication authority retired before publication.');
	try {
		await replaceHandleBytes(handle, nextBytes, writeBytes);
	} catch (publicationError) {
		try {
			await replaceHandleBytes(handle, baselineBytes);
		} catch (rollbackError) {
			throw new AggregateError(
				[publicationError, rollbackError],
				'The owned file publication failed and its original bytes could not be restored.',
			);
		}
		throw publicationError;
	}
}
