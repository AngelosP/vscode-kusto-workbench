import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');
const pkgPath = join(rootDir, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const version = typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';

const outDir = join(rootDir, 'out', 'releases');
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, `vscode-kusto-workbench-${version}.vsix`);

const spawnResult = (() => {
	// On some Windows installations (including this one), `npx` is exposed as a PowerShell
	// script (npx.ps1) rather than npx.cmd, which Node cannot execute directly.
	if (process.platform === 'win32') {
		const psExe = process.env.ComSpec ? 'pwsh' : 'pwsh';
		const escapedOutFile = outFile.replace(/'/g, "''");
		const command = `npx @vscode/vsce package -o '${escapedOutFile}'`;
		return spawnSync(psExe, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
			stdio: 'inherit'
		});
	}

	return spawnSync('npx', ['@vscode/vsce', 'package', '-o', outFile], { stdio: 'inherit' });
})();

if (spawnResult.error) {
	console.error('[vsix] Failed to run packaging command:', spawnResult.error);
}

process.exit(typeof spawnResult.status === 'number' ? spawnResult.status : 1);
