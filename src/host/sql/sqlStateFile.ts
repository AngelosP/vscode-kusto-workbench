import * as crypto from 'crypto';
import * as fs from 'fs';

export async function quarantineCorruptSqlStateFile(filePath: string): Promise<string | undefined> {
	const quarantinePath = `${filePath}.corrupt-${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
	try {
		await fs.promises.rename(filePath, quarantinePath);
		return quarantinePath;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
		throw error;
	}
}