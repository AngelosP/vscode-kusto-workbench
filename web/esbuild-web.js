const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');

async function main() {
	const distDir = path.join(__dirname, 'dist');
	await fs.promises.mkdir(distDir, { recursive: true });

	// Bundle server.ts → dist/server.js
	await esbuild.build({
		entryPoints: [path.join(__dirname, 'server.ts')],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		outfile: path.join(distDir, 'server.js'),
		external: [],  // bundle all dependencies into one file for easy deployment
		logLevel: 'info'
	});

	// Copy static web assets to dist/
	const staticFiles = [
		'index.html',
		'viewer.html',
		'vscode-shim.js',
		'viewer-boot.js',
		'read-only-overrides.css'
	];

	for (const file of staticFiles) {
		const src = path.join(__dirname, file);
		const dest = path.join(distDir, file);
		if (fs.existsSync(src)) {
			await fs.promises.copyFile(src, dest);
		}
	}

	console.log('Web build complete.');
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
