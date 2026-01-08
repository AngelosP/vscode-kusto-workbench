// Script to bundle the kusto worker for use in VS Code webviews
import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function bundleKustoWorker() {
    const outfile = path.join(projectRoot, 'dist', 'monaco', 'kusto.worker.bundle.js');
    
    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    
    try {
        await esbuild.build({
            entryPoints: [path.join(projectRoot, 'node_modules/@kusto/monaco-kusto/release/esm/kusto.worker.js')],
            bundle: true,
            format: 'iife',
            platform: 'browser',
            outfile: outfile,
            define: {
                // Define global = self for Node.js libraries that expect global
                'global': 'self',
                // Prevent process references
                'process.env.NODE_ENV': '"production"',
            },
            // Stub out Node.js built-ins
            alias: {
                'fs': path.join(projectRoot, 'scripts/empty-module.js'),
                'path': path.join(projectRoot, 'scripts/empty-module.js'),
            },
            // Add banner to set up worker environment before any code runs
            banner: {
                js: `// Monaco-Kusto Worker Bundle
// Set up globals expected by bundled libraries
if (typeof global === 'undefined') { self.global = self; }
if (typeof window === 'undefined') { self.window = self; }
`
            },
            logLevel: 'info',
            // Resolve monaco-editor from node_modules
            nodePaths: [path.join(projectRoot, 'node_modules')],
        });
        console.log('Kusto worker bundled successfully to:', outfile);
    } catch (error) {
        console.error('Failed to bundle kusto worker:', error);
        process.exit(1);
    }
}

bundleKustoWorker();
