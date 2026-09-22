import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import extractZip from 'extract-zip';

const MAX_VSIX_BYTES = 10 * 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');
const pkgPath = join(rootDir, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const version = typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';

const outDir = join(rootDir, 'out', 'releases');
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, `vscode-kusto-workbench-${version}.vsix`);
const temporaryPackage = join(outDir, `.vscode-kusto-workbench-${version}-${randomUUID()}.vsix`);
const vsceEntry = join(rootDir, 'node_modules', '@vscode', 'vsce', 'vsce');
const spawnResult = spawnSync(process.execPath, [vsceEntry, 'package', '-o', temporaryPackage], {
	cwd: rootDir,
	stdio: 'inherit',
});

if (spawnResult.error) {
	console.error('[vsix] Failed to run packaging command:', spawnResult.error);
}

const exitCode = typeof spawnResult.status === 'number' ? spawnResult.status : 1;
if (exitCode !== 0) {
	rmSync(temporaryPackage, { force: true });
	process.exit(exitCode);
}

const inspectionDirectory = mkdtempSync(join(tmpdir(), 'kw-vsix-inspect-'));
try {
	await extractZip(temporaryPackage, { dir: inspectionDirectory });
	const extensionDirectory = join(inspectionDirectory, 'extension');
	const connectorDirectory = join(inspectionDirectory, 'extension', 'dist', 'mcp-connector');
	const runtimeDirectory = join(connectorDirectory, 'runtime');
	const runtimeMetadataPath = join(runtimeDirectory, 'runtime.json');
	const setupBundlePath = join(extensionDirectory, 'dist', 'external-mcp-setup.js');
	const requiredFiles = [
		setupBundlePath,
		join(connectorDirectory, 'connector.cjs'),
		join(connectorDirectory, 'kusto-workbench-mcp-bootstrap.vsix'),
		join(extensionDirectory, 'copilot-instructions', 'external-mcp-client.md'),
		join(extensionDirectory, 'copilot-instructions', 'external-copilot-agent.md'),
		join(extensionDirectory, 'copilot-instructions', 'external-scout-skill.md'),
		runtimeMetadataPath,
	];
	for (const requiredFile of requiredFiles) {
		if (!existsSync(requiredFile) || !statSync(requiredFile).isFile() || statSync(requiredFile).size === 0) {
			throw new Error(`Packaged VSIX is missing required setup asset ${requiredFile.slice(extensionDirectory.length + 1)}.`);
		}
	}
	const setupSyntax = spawnSync(process.execPath, ['--check', setupBundlePath], { encoding: 'utf8' });
	if (setupSyntax.status !== 0) {
		throw new Error(`Packaged external MCP setup bundle is invalid: ${setupSyntax.stderr || setupSyntax.stdout}`);
	}
	const runtimeMetadata = JSON.parse(readFileSync(runtimeMetadataPath, 'utf8'));
	const expectedArchive = `node-v${runtimeMetadata.version}-${runtimeMetadata.target}.zip`;
	if (runtimeMetadata.schemaVersion !== 1
		|| !/^\d+\.\d+\.\d+$/.test(runtimeMetadata.version)
		|| runtimeMetadata.target !== 'win-x64'
		|| runtimeMetadata.archive !== expectedArchive
		|| !/^[a-f0-9]{64}$/i.test(runtimeMetadata.sha256)
		|| runtimeMetadata.downloadUrl !== `https://nodejs.org/dist/v${runtimeMetadata.version}/${expectedArchive}`) {
		throw new Error('Packaged connector runtime metadata is invalid.');
	}
	const forbidden = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.name.toLowerCase() === 'node.exe'
				|| (path.startsWith(`${runtimeDirectory}${sep}`) && entry.name.toLowerCase().endsWith('.zip'))) {
				forbidden.push(path.slice(inspectionDirectory.length + 1));
			}
		}
	};
	visit(extensionDirectory);
	if (forbidden.length > 0) {
		throw new Error(`Packaged VSIX contains forbidden connector runtime payloads: ${forbidden.join(', ')}`);
	}
	const size = statSync(temporaryPackage).size;
	if (size > MAX_VSIX_BYTES) {
		throw new Error(`Packaged VSIX is ${(size / (1024 * 1024)).toFixed(2)} MiB; limit is ${MAX_VSIX_BYTES / (1024 * 1024)} MiB.`);
	}
	const backup = existsSync(outFile) ? `${outFile}.${randomUUID()}.backup` : undefined;
	if (backup) renameSync(outFile, backup);
	try {
		renameSync(temporaryPackage, outFile);
	} catch (error) {
		if (backup && existsSync(backup)) renameSync(backup, outFile);
		throw error;
	}
	if (backup) {
		try {
			rmSync(backup, { force: true });
		} catch (error) {
			console.warn(`[vsix] Verified package was published, but the previous-package backup could not be removed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.log(`[vsix] Verified metadata-only connector runtime; package size ${(size / (1024 * 1024)).toFixed(2)} MiB (${size} bytes).`);
} finally {
	rmSync(inspectionDirectory, { recursive: true, force: true });
	rmSync(temporaryPackage, { force: true });
}
