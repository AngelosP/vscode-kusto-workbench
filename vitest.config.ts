import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		include: ['tests/webview/**/*.test.ts'],
		globals: true,
	},
	plugins: [
		{
			name: 'esbuild-decorators',
			enforce: 'pre',
			async transform(code, id) {
				if (!id.endsWith('.ts') || id.includes('node_modules')) return;
				// Use esbuild to handle experimentalDecorators
				const result = await transformWithEsbuild(code, id, {
					target: 'es2022',
					loader: 'ts',
					tsconfigRaw: {
						compilerOptions: {
							experimentalDecorators: true,
							useDefineForClassFields: false,
						},
					},
				});
				return { code: result.code, map: result.map };
			},
		},
	],
});
