// Generates 3 .pbiviz files for A/B/C testing in Power BI Desktop:
//   A) hand-built-visual.pbiviz  — our custom ZIP builder (DEFLATE)
//   B) jszip-visual.pbiviz       — JSZip (same lib as real pbiviz tools)
//   C) minimal-visual.pbiviz     — absolute minimum viable visual via JSZip
//
// Run: node scripts/test-pbiviz-ab.mjs
// Then import each into PBI Desktop: Visualizations → ⋯ → Import a visual from a file

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { deflateRawSync } from 'zlib';
import JSZip from 'jszip';

const outDir = join(process.env.USERPROFILE || '', 'Downloads', 'pbiviz-ab-test');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// ── Shared icon ────────────────────────────────────────────────────────────
const ICON_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAMklEQVR4nGJ5K8PAwMDAwMDwn4GB4T8DA8N/BgaG/0iAkYGBgZGBgYGJgYGBmWoGAgAFYwX/uB5HPAAAAABJRU5ErkJggg==';

// ── Shared capabilities ────────────────────────────────────────────────────
const capabilities = {
	dataRoles: [
		{ displayName: 'Category', name: 'category', kind: 0 },
		{ displayName: 'Values', name: 'measure', kind: 1 },
	],
	dataViewMappings: [{
		categorical: {
			categories: { for: { in: 'category' }, dataReductionAlgorithm: { top: { count: 30000 } } },
			values: { select: [{ bind: { to: 'measure' } }] },
		},
	}],
};

// ── Generate Visual JS matching webpack plugin template output ─────────────
function makeVisualJs(guid, label) {
	return `var ${guid};
(() => {
"use strict";
function Visual(options) {
	this._target = options.element;
	this._target.style.cssText = "overflow:auto;width:100%;height:100%;background:#ff0000;color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:20px;font-weight:bold;padding:20px;box-sizing:border-box;";
	this._target.innerText = "LOADED: ${label}";
}
Visual.prototype.update = function(options) {
	this._target.style.background = "#00aa00";
	var msg = "UPDATE CALLED";
	if (options && options.dataViews && options.dataViews[0]) {
		var dv = options.dataViews[0];
		if (dv.categorical && dv.categorical.categories && dv.categorical.categories[0]) {
			var vals = dv.categorical.categories[0].values || [];
			msg = "GOT " + vals.length + " rows: " + vals.slice(0,5).join(", ");
		} else {
			msg = "DATA BUT NO CATEGORIES - keys: " + Object.keys(dv).join(",");
		}
	} else {
		msg = "NO DATAVIEWS";
	}
	this._target.innerText = msg;
};
Visual.prototype.destroy = function() {};
var powerbiKey = "powerbi";
var powerbi = window[powerbiKey];
var ${guid}Plugin = {
	name: "${guid}",
	displayName: "Test Visual (${label})",
	class: "Visual",
	apiVersion: "5.3.0",
	create: function(options) {
		if (Visual) {
			return new Visual(options);
		}
		throw "Visual instance not found";
	},
	custom: true
};
if (typeof powerbi !== "undefined") {
	powerbi.visuals = powerbi.visuals || {};
	powerbi.visuals.plugins = powerbi.visuals.plugins || {};
	powerbi.visuals.plugins["${guid}"] = ${guid}Plugin;
}
if (typeof window !== "undefined") {
	window["${guid}"] = ${guid}Plugin;
}
${guid} = ${guid}Plugin;
})();`;
}

// ── Build pbiviz.json + package.json objects ───────────────────────────────
function makePbivizContent(guid, label) {
	const visualJs = makeVisualJs(guid, label);

	const visualData = {
		name: guid,
		displayName: `Test Visual (${label})`,
		guid: guid,
		visualClassName: 'Visual',
		version: '1.0.0.0',
		description: `Test visual: ${label}`,
		supportUrl: '',
		gitHubUrl: '',
	};
	const authorData = { name: 'Test', email: 'test@test.com' };

	const pbivizJson = {
		visual: visualData,
		author: authorData,
		apiVersion: '5.3.0',
		style: 'style/visual.less',
		stringResources: [],
		capabilities: capabilities,
		content: {
			js: visualJs,
			css: '',
			iconBase64: ICON_BASE64,
		},
		visualEntryPoint: '',
		externalJS: [],
		assets: { icon: 'assets/icon.png' },
	};

	const packageJson = {
		version: visualData.version,
		author: authorData,
		resources: [
			{ resourceId: 'rId0', sourceType: 5, file: `resources/${guid}.pbiviz.json` },
		],
		visual: visualData,
		metadata: { pbivizjson: { resourceId: 'rId0' } },
	};

	return { visualJs, pbivizJson, packageJson, guid };
}

// ── CRC-32 ─────────────────────────────────────────────────────────────────
function crc32(buf) {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i];
		for (let j = 0; j < 8; j++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
		}
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Hand-built ZIP with DEFLATE ────────────────────────────────────────────
function buildDeflateZip(entries) {
	const parts = [];
	const centralDirectory = [];
	let offset = 0;

	for (const entry of entries) {
		const pathBuf = Buffer.from(entry.path, 'utf8');
		const isDirectory = entry.path.endsWith('/');
		const uncompressedData = entry.data;
		const crc = crc32(uncompressedData);
		const shouldDeflate = !isDirectory && uncompressedData.length > 0;
		const compressedData = shouldDeflate ? deflateRawSync(uncompressedData) : uncompressedData;
		const method = shouldDeflate ? 8 : 0;

		const local = Buffer.alloc(30 + pathBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressedData.length, 18);
		local.writeUInt32LE(uncompressedData.length, 22);
		local.writeUInt16LE(pathBuf.length, 26);
		local.writeUInt16LE(0, 28);
		pathBuf.copy(local, 30);

		const cd = Buffer.alloc(46 + pathBuf.length);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt16LE(0, 12);
		cd.writeUInt16LE(0, 14);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(compressedData.length, 20);
		cd.writeUInt32LE(uncompressedData.length, 24);
		cd.writeUInt16LE(pathBuf.length, 28);
		cd.writeUInt16LE(0, 30);
		cd.writeUInt16LE(0, 32);
		cd.writeUInt16LE(0, 34);
		cd.writeUInt16LE(0, 36);
		cd.writeUInt32LE(isDirectory ? 0x10 : 0, 38);
		cd.writeUInt32LE(offset, 42);
		pathBuf.copy(cd, 46);
		centralDirectory.push(cd);

		parts.push(local, compressedData);
		offset += local.length + compressedData.length;
	}

	const cdOffset = offset;
	let cdSize = 0;
	for (const cd of centralDirectory) {
		parts.push(cd);
		cdSize += cd.length;
	}

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdOffset, 16);
	eocd.writeUInt16LE(0, 20);
	parts.push(eocd);

	return Buffer.concat(parts);
}

// ═══════════════════════════════════════════════════════════════════════════
// A) Hand-built DEFLATE ZIP
// ═══════════════════════════════════════════════════════════════════════════
console.log('=== A: Hand-built DEFLATE ZIP ===');
const guidA = 'handBuiltVisual' + 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
const contentA = makePbivizContent(guidA, 'HandBuilt');
const entriesA = [
	{ path: 'package.json', data: Buffer.from(JSON.stringify(contentA.packageJson), 'utf8') },
	{ path: 'resources/', data: Buffer.alloc(0) },
	{ path: `resources/${guidA}.pbiviz.json`, data: Buffer.from(JSON.stringify(contentA.pbivizJson), 'utf8') },
];
const zipA = buildDeflateZip(entriesA);
const pathA = join(outDir, `${guidA}.1.0.0.0.pbiviz`);
writeFileSync(pathA, zipA);
console.log(`  Wrote: ${pathA} (${zipA.length} bytes)`);

// ═══════════════════════════════════════════════════════════════════════════
// B) JSZip (same library as real powerbi-visuals-webpack-plugin)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== B: JSZip (matching real pbiviz tools) ===');
const guidB = 'jszipVisual' + 'B1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4BBBB';
const contentB = makePbivizContent(guidB, 'JSZip');
const zip = new JSZip();
zip.file('package.json', JSON.stringify(contentB.packageJson));
zip.folder('resources').file(`${guidB}.pbiviz.json`, JSON.stringify(contentB.pbivizJson));
const zipBBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
const pathB = join(outDir, `${guidB}.1.0.0.0.pbiviz`);
writeFileSync(pathB, zipBBuf);
console.log(`  Wrote: ${pathB} (${zipBBuf.length} bytes)`);

// ═══════════════════════════════════════════════════════════════════════════
// C) JSZip with STORE (no compression, like the default in webpack plugin)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== C: JSZip STORE (no compression) ===');
const guidC = 'jszipStoreVisual' + 'C1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
const contentC = makePbivizContent(guidC, 'JSZip-STORE');
const zipC = new JSZip();
zipC.file('package.json', JSON.stringify(contentC.packageJson));
zipC.folder('resources').file(`${guidC}.pbiviz.json`, JSON.stringify(contentC.pbivizJson));
const zipCBuf = await zipC.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
const pathC = join(outDir, `${guidC}.1.0.0.0.pbiviz`);
writeFileSync(pathC, zipCBuf);
console.log(`  Wrote: ${pathC} (${zipCBuf.length} bytes)`);

// ═══════════════════════════════════════════════════════════════════════════
// D) JSZip — absolutely minimal: just red box, no data, no capabilities
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== D: Minimal visual (red box, no data roles) ===');
const guidD = 'minimalRedBoxVisual' + 'D1B2C3D4E5F6A1B2C3D4E5F6A1D4';
const minimalJs = `var ${guidD};
(() => {
"use strict";
function Visual(options) {
	var el = options.element;
	el.style.cssText = "width:100%;height:100%;background:red;";
	el.innerHTML = "<h1 style='color:white;padding:20px'>MINIMAL RED BOX</h1>";
}
Visual.prototype.update = function() {};
Visual.prototype.destroy = function() {};
var powerbiKey = "powerbi";
var powerbi = window[powerbiKey];
var plugin = {
	name: "${guidD}",
	displayName: "Minimal Red Box",
	class: "Visual",
	apiVersion: "5.3.0",
	create: function(options) { if (Visual) { return new Visual(options); } throw "fail"; },
	custom: true
};
if (typeof powerbi !== "undefined") {
	powerbi.visuals = powerbi.visuals || {};
	powerbi.visuals.plugins = powerbi.visuals.plugins || {};
	powerbi.visuals.plugins["${guidD}"] = plugin;
}
${guidD} = plugin;
})();`;

const minimalPbivizJson = {
	visual: {
		name: guidD, displayName: 'Minimal Red Box', guid: guidD,
		visualClassName: 'Visual', version: '1.0.0.0', description: '', supportUrl: '', gitHubUrl: '',
	},
	author: { name: 'Test', email: 'test@test.com' },
	apiVersion: '5.3.0',
	style: 'style/visual.less',
	stringResources: [],
	capabilities: { dataRoles: [], dataViewMappings: [] },
	content: { js: minimalJs, css: '', iconBase64: ICON_BASE64 },
	visualEntryPoint: '',
	externalJS: [],
	assets: { icon: 'assets/icon.png' },
};

const minimalPackageJson = {
	version: '1.0.0.0',
	author: { name: 'Test', email: 'test@test.com' },
	resources: [{ resourceId: 'rId0', sourceType: 5, file: `resources/${guidD}.pbiviz.json` }],
	visual: minimalPbivizJson.visual,
	metadata: { pbivizjson: { resourceId: 'rId0' } },
};

const zipD = new JSZip();
zipD.file('package.json', JSON.stringify(minimalPackageJson));
zipD.folder('resources').file(`${guidD}.pbiviz.json`, JSON.stringify(minimalPbivizJson));
const zipDBuf = await zipD.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
const pathD = join(outDir, `${guidD}.1.0.0.0.pbiviz`);
writeFileSync(pathD, zipDBuf);
console.log(`  Wrote: ${pathD} (${zipDBuf.length} bytes)`);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n=== Output directory: ${outDir} ===`);
console.log('Import each into PBI Desktop: Visualizations → ⋯ → Import a visual from a file');
console.log('A = hand-built DEFLATE, B = JSZip DEFLATE, C = JSZip STORE, D = minimal red box');
console.log('If B/C/D work but A fails → our ZIP builder is broken');
console.log('If none work → the issue is in our content (JS/capabilities/pbiviz.json structure)');
console.log('If D works but B/C fail → the issue is in capabilities or data roles');
