import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapDirectory = join(root, 'external-mcp-bootstrap');
const mainPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bootstrapPackagePath = join(bootstrapDirectory, 'package.json');
const bootstrapPackage = JSON.parse(readFileSync(bootstrapPackagePath, 'utf8'));
bootstrapPackage.version = String(mainPackage.version || '0.0.0').replace(/-.+$/, '');
writeFileSync(bootstrapPackagePath, `${JSON.stringify(bootstrapPackage, null, 2)}\n`, 'utf8');

const outputPath = join(root, 'dist', 'mcp-connector', 'kusto-workbench-mcp-bootstrap.vsix');
mkdirSync(dirname(outputPath), { recursive: true });
const vsceEntry = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const result = spawnSync(process.execPath, [
	vsceEntry,
	'package',
	'--no-dependencies',
	'-o',
	outputPath,
], { cwd: bootstrapDirectory, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Bootstrap VSIX packaging failed with exit code ${result.status}.`);
console.log(`[mcp-connector] Packaged startup bootstrap: ${outputPath}`);
