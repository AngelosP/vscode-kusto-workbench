// Generate a single test .pbiviz using JSZip with the new webpack-format JS.
// Run: node scripts/test-pbiviz-webpack-format.mjs
// Then import into PBI Desktop to test.

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import JSZip from 'jszip';

const outDir = join(process.env.USERPROFILE || '', 'Downloads', 'pbiviz-ab-test');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const ICON_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAMklEQVR4nGJ5K8PAwMDAwMDwn4GB4T8DA8N/BgaG/0iAkYGBgZGBgYGJgYGBmWoGAgAFYwX/uB5HPAAAAABJRU5ErkJggg==';

const guid = 'webpackFormatTestF1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6';

// This JS matches the exact webpack output format from `pbiviz package` v7.0.3
const visualJs = `var ${guid};(()=>{"use strict";var e={0:(e,t)=>{function i(e){this._target=e.element,this._target.style.cssText="overflow:auto;width:100%;height:100%;background:#ff0000;color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:20px;font-weight:bold;padding:20px;box-sizing:border-box;",this._target.innerText="WEBPACK FORMAT VISUAL LOADED"}i.prototype.update=function(e){this._target.style.background="#00aa00";var t="UPDATE CALLED";if(e&&e.dataViews&&e.dataViews[0]){var i=e.dataViews[0];if(i.categorical&&i.categorical.categories&&i.categorical.categories[0]){var a=i.categorical.categories[0].values||[];t="GOT "+a.length+" rows: "+a.slice(0,5).join(", ")}else t="DATA BUT NO CATEGORIES - keys: "+Object.keys(i).join(",")}else t="NO DATAVIEWS";this._target.innerText=t},i.prototype.destroy=function(){},t.b=i}},t={};function i(a){var s=t[a];if(void 0!==s)return s.exports;var o=t[a]={exports:{}};return e[a](o,o.exports,i),o.exports}i.d=(e,t)=>{for(var a in t)i.o(t,a)&&!i.o(e,a)&&Object.defineProperty(e,a,{enumerable:!0,get:t[a]})},i.o=(e,t)=>Object.prototype.hasOwnProperty.call(e,t),i.r=e=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})};var a={};(()=>{i.r(a),i.d(a,{default:()=>o});var e=i(0),t=window.powerbi,s={name:"${guid}",displayName:"Webpack Format Test",class:"Visual",apiVersion:"5.3.0",create:t=>{if(e.b)return new e.b(t);throw"Visual instance not found"},createModalDialog:(e,t,i)=>{const a=globalThis.dialogRegistry;e in a&&new a[e](t,i)},custom:!0};void 0!==t&&(t.visuals=t.visuals||{},t.visuals.plugins=t.visuals.plugins||{},t.visuals.plugins["${guid}"]=s);const o=s})(),${guid}=a})();`;

const pbivizJson = {
	visual: {
		name: 'webpackFormatTest',
		displayName: 'Webpack Format Test',
		guid: guid,
		visualClassName: 'Visual',
		version: '1.0.0.0',
		description: 'Test visual with webpack bundle format',
		supportUrl: '',
		gitHubUrl: '',
	},
	author: { name: 'Test', email: 'test@test.com' },
	apiVersion: '5.3.0',
	style: 'style/visual.less',
	stringResources: {},
	capabilities: {
		dataRoles: [
			{ displayName: 'Category', name: 'category', kind: 'Grouping' },
			{ displayName: 'Values', name: 'measure', kind: 'Measure' },
		],
		dataViewMappings: [{
			categorical: {
				categories: { for: { in: 'category' }, dataReductionAlgorithm: { top: {} } },
				values: { select: [{ bind: { to: 'measure' } }] },
			},
		}],
		privileges: [],
	},
	content: { js: visualJs, css: '', iconBase64: ICON_BASE64 },
	visualEntryPoint: '',
	externalJS: [],
	assets: { icon: 'assets/icon.png' },
};

const packageJson = {
	version: '1.0.0.0',
	author: { name: 'Test', email: 'test@test.com' },
	resources: [{ resourceId: 'rId0', sourceType: 5, file: `resources/${guid}.pbiviz.json` }],
	visual: pbivizJson.visual,
	metadata: { pbivizjson: { resourceId: 'rId0' } },
};

// Build with JSZip using STORE compression (matching webpack plugin default: compression: 0)
const zip = new JSZip();
zip.file('package.json', JSON.stringify(packageJson));
zip.folder('resources').file(`${guid}.pbiviz.json`, JSON.stringify(pbivizJson));
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });

const outPath = join(outDir, `${guid}.1.0.0.0.pbiviz`);
writeFileSync(outPath, buf);
console.log(`Wrote: ${outPath} (${buf.length} bytes)`);
console.log('');
console.log('Also copying the ground truth visual for side-by-side testing:');

// Copy ground truth
import { copyFileSync } from 'fs';
const groundTruthSrc = join(process.env.TEMP, 'groundTruthVisual', 'dist', 'groundTruthVisual044E53497E424622A1C83A4657013BFD.1.0.0.0.pbiviz');
const groundTruthDst = join(outDir, 'groundTruthVisual044E53497E424622A1C83A4657013BFD.1.0.0.0.pbiviz');
try {
	copyFileSync(groundTruthSrc, groundTruthDst);
	console.log(`Copied ground truth to: ${groundTruthDst}`);
} catch (e) {
	console.log('Ground truth not found at expected location');
}

console.log('');
console.log('Import both into PBI Desktop:');
console.log('  F) webpackFormatTest... = our new webpack-format JS');
console.log('  GT) groundTruthVisual... = built by official pbiviz package');
console.log('');
console.log('If GT works and F does not: remaining diff is in the JS or pbiviz.json');
console.log('If BOTH work: we fixed it!');
