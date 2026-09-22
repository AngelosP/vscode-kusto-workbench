import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const version = '24.21.0';
const target = 'win-x64';
const expectedSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const outputDirectory = join(root, 'dist', 'mcp-connector', 'runtime');
const archive = `node-v${version}-${target}.zip`;
const metadataPath = join(outputDirectory, 'runtime.json');

mkdirSync(outputDirectory, { recursive: true });
rmSync(join(outputDirectory, archive), { force: true });

const metadata = {
	schemaVersion: 1,
	version,
	target,
	archive,
	sha256: expectedSha256,
	downloadUrl: `https://nodejs.org/dist/v${version}/${archive}`,
};
mkdirSync(dirname(metadataPath), { recursive: true });
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`[mcp-connector] Generated Node ${version} ${target} runtime metadata (${expectedSha256.slice(0, 12)}...).`);