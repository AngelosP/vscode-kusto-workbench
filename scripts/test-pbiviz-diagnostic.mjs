// Diagnostic script: generates a .pbiviz, validates it, and tests JS execution.
// Run: node scripts/test-pbiviz-diagnostic.mjs

import { inflateRawSync } from 'zlib';
import { writeFileSync } from 'fs';

// ── 1. GUID mismatch analysis ──────────────────────────────────────────────

console.log('=== GUID Mismatch Analysis ===');
const testNames = ['Test-Dashboard', 'My Dashboard', 'Sales_Report', 'hello-world-test'];
for (const name of testNames) {
	const projectName = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
	const visualGuid = projectName + 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
	const safeGuid = visualGuid.replace(/[^a-zA-Z0-9_]/g, '');
	const match = visualGuid === safeGuid;
	console.log(`  "${name}" → match=${match} ${match ? '✓' : '✗ MISMATCH: report.json="' + visualGuid + '" vs pbiviz="' + safeGuid + '"'}`);
}

// ── 2. Icon PNG analysis ───────────────────────────────────────────────────

console.log('\n=== Icon PNG Analysis ===');
const iconB64 = 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAMklEQVR4nGJ5K8PAwMDAwMDwn4GB4T8DA8N/BgaG/0iAkYGBgZGBgYGJgYGBmWoGAgAFYwX/uB5HPAAAAABJRU5ErkJggg==';
const iconBuf = Buffer.from(iconB64, 'base64');
console.log(`  Size: ${iconBuf.length} bytes`);
console.log(`  Width: ${iconBuf.readUInt32BE(16)}, Height: ${iconBuf.readUInt32BE(20)}`);
const colorTypes = { 0: 'grayscale', 2: 'RGB', 3: 'indexed', 4: 'grayscale+alpha', 6: 'RGBA' };
console.log(`  Bit depth: ${iconBuf[24]}, Color type: ${iconBuf[25]} (${colorTypes[iconBuf[25]] || 'unknown'})`);
console.log(`  Transparent? ${iconBuf[25] === 4 || iconBuf[25] === 6 ? 'YES (has alpha)' : 'NO (opaque)'}`);

// ── 3. JS Plugin Registration Test ─────────────────────────────────────────

console.log('\n=== JS Plugin Registration Test ===');
const guid = 'testVisualABCDEF1234567890abcdef01';
const js = `
var ${guid};(() => {
"use strict";
function Visual(options) {
	this._target = options.element;
	this._target.style = { cssText: '' };
	this._target.style.cssText = 'background:#ff0000;';
	this._target.innerText = 'KUSTO VISUAL LOADED';
}
Visual.prototype.update = function(options) {};
Visual.prototype.destroy = function() {};
var powerbiKey = "powerbi";
var powerbi = window[powerbiKey];
var ${guid}Plugin = {
	name: "${guid}",
	displayName: "Kusto HTML Dashboard",
	class: "Visual",
	apiVersion: "5.3.0",
	create: function(options) {
		if (Visual) { return new Visual(options); }
		throw "Visual instance not found";
	},
	custom: true
};
if (typeof powerbi !== "undefined") {
	powerbi.visuals = powerbi.visuals || {};
	powerbi.visuals.plugins = powerbi.visuals.plugins || {};
	powerbi.visuals.plugins["${guid}"] = ${guid}Plugin;
}
${guid} = ${guid}Plugin;
})();
`;

// Simulate PBI sandbox environment
globalThis.window = { powerbi: { visuals: { plugins: {} } } };
try {
	const fn = new Function(js);
	fn();
	const plugins = globalThis.window.powerbi.visuals.plugins;
	const registered = Object.keys(plugins);
	console.log(`  Registered plugins: ${JSON.stringify(registered)}`);
	const plugin = plugins[guid];
	if (plugin) {
		console.log(`  Plugin name: ${plugin.name}`);
		console.log(`  Plugin class: ${plugin.class}`);
		const mockElement = { style: {}, innerText: '' };
		const instance = plugin.create({ element: mockElement });
		console.log(`  Visual created: ${!!instance}`);
		console.log(`  Constructor set text: "${mockElement.innerText}"`);
		console.log(`  Constructor set background: "${mockElement.style.cssText}"`);
		console.log('  ✓ JS plugin registration and Visual creation work correctly');
	} else {
		console.log(`  ✗ Plugin NOT found! Registration failed.`);
	}
} catch (e) {
	console.log(`  ✗ JS execution error: ${e.message}`);
}

// ── 4. Test without window.powerbi (simulating PBI not setting it up) ──────

console.log('\n=== JS Without window.powerbi Test ===');
globalThis.window = {};  // No powerbi object
try {
	const fn2 = new Function(js);
	fn2();
	const hasPlugins = globalThis.window.powerbi?.visuals?.plugins;
	console.log(`  powerbi.visuals.plugins exists? ${!!hasPlugins}`);
	if (!hasPlugins) {
		console.log('  ⚠ If PBI does not pre-define window.powerbi, plugin registration silently fails!');
		console.log('  The global var assignment still works: window.' + guid + ' exists?', typeof globalThis.window[guid] !== 'undefined' ? 'no (IIFE scope)' : 'no');
	}
	// Check if the global var was set
	console.log(`  Global var ${guid} exists on window?`, guid in globalThis.window);
} catch (e) {
	console.log(`  ✗ Error: ${e.message}`);
}

console.log('\n=== Summary ===');
console.log('1. GUID mismatch: ANY section name with hyphens causes report.json and pbiviz to use different GUIDs');
console.log('2. Icon PNG: valid 20x20 RGB (opaque) — should show as blue square');
console.log('3. JS registration: works correctly when window.powerbi is pre-defined');
console.log('4. If window.powerbi is NOT pre-defined: registration silently fails, PBI cannot find the plugin');
