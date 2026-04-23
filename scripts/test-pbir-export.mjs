// Quick script to generate a test PBIR export and inspect each file.
// Run with: node scripts/test-pbir-export.mjs

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

const dir = join(process.env.USERPROFILE || '', 'Downloads', 'pbir-test-export');
if (existsSync(dir)) rmSync(dir, { recursive: true });

function write(rel, content) {
	const full = join(dir, rel);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, content, 'utf8');
	console.log(`WROTE: ${rel} (${content.length} bytes)`);
}

const projectName = 'TestReport';
const reportFolder = `${projectName}.Report`;
const modelFolder = `${projectName}.SemanticModel`;
const pageName = 'ReportPage1';

// .pbip
write(`${projectName}.pbip`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json",
	version: "1.0",
	artifacts: [{ report: { path: reportFolder } }],
}, null, 2));

// .gitignore
write('.gitignore', '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n');

// definition.pbir
write(`${reportFolder}/definition.pbir`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
	version: "4.0",
	datasetReference: { byPath: { path: `../${modelFolder}` } },
}, null, 2));

// version.json
write(`${reportFolder}/definition/version.json`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json",
	version: "2.0.0",
}, null, 2));

// report.json
write(`${reportFolder}/definition/report.json`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.2.0/schema.json",
	themeCollection: { baseTheme: { name: "CY24SU06", reportVersionAtImport: { visual: "2.8.0", report: "3.2.0", page: "2.3.1" }, type: "SharedResources" } },
	settings: { useStylableVisualContainerHeader: true, exportDataMode: "AllowSummarized", defaultDrillFilterOtherVisuals: true, allowChangeFilterTypes: true, useEnhancedTooltips: true, useDefaultAggregateDisplayName: true },
}, null, 2));

// pages.json
write(`${reportFolder}/definition/pages/pages.json`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json",
	pageOrder: [pageName],
	activePageName: pageName,
}, null, 2));

// page.json
write(`${reportFolder}/definition/pages/${pageName}/page.json`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json",
	name: pageName,
	displayName: "Dashboard",
	displayOption: "FitToPage",
	height: 720,
	width: 1280,
}, null, 2));

// visual.json — minimal table visual
write(`${reportFolder}/definition/pages/${pageName}/visuals/v1/visual.json`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/1.0.0/schema.json",
	name: "v1",
	position: { x: 20, y: 20, z: 0, width: 600, height: 400 },
	visual: {
		visualType: "tableEx",
		query: {
			queryState: {
				Values: {
					projections: [{
						field: { Column: { Expression: { SourceRef: { Source: "t" } }, Property: "Region" } },
						queryRef: "TestTable.Region",
					}],
				},
			},
		},
	},
}, null, 2));

// definition.pbism
write(`${modelFolder}/definition.pbism`, JSON.stringify({
	"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
	version: "4.2",
	settings: {},
}, null, 2));

// .platform files
function genPlatform(type, displayName) {
	const uuid = Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join('');
	const logicalId = `${uuid.substring(0,8)}-${uuid.substring(8,12)}-${uuid.substring(12,16)}-${uuid.substring(16,20)}-${uuid.substring(20)}`;
	return JSON.stringify({
		"$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
		metadata: { type, displayName },
		config: { version: "2.0", logicalId },
	}, null, 2);
}
write(`${reportFolder}/.platform`, genPlatform("Report", projectName));
write(`${modelFolder}/.platform`, genPlatform("SemanticModel", projectName));

// model.tmdl
write(`${modelFolder}/definition/model.tmdl`, `model Model
\tculture: en-US
\tdefaultPowerBIDataSourceVersion: powerBI_V3
\tsourceQueryCulture: en-US
\tdataAccessOptions
\t\tlegacyRedirects
\t\treturnErrorValuesAsNull

annotation PBI_ProTooling = ["DevMode"]

ref cultureInfo en-US
`);

// database.tmdl
write(`${modelFolder}/definition/database.tmdl`, `database\n\tcompatibilityLevel: 1600\n`);

// cultures/en-US.tmdl
write(`${modelFolder}/definition/cultures/en-US.tmdl`, `cultureInfo en-US\n`);

// table.tmdl
write(`${modelFolder}/definition/tables/TestTable.tmdl`, `table TestTable
\tlineageTag: abc123

\tcolumn Region
\t\tdataType: string
\t\tlineageTag: def456
\t\tsummarizeBy: none
\t\tsourceColumn: Region

\tcolumn Sales
\t\tdataType: int64
\t\tlineageTag: ghi789
\t\tsummarizeBy: none
\t\tsourceColumn: Sales

\tpartition TestTable = m
\t\tmode: import
\t\tsource =
\t\t\tlet
\t\t\t\tSource = #table(type table [Region = text, Sales = number], {{"East", 100}, {"West", 200}})
\t\t\tin
\t\t\t\tSource
`);

console.log(`\nDone! Open ${join(dir, projectName + '.pbip')} in Power BI Desktop.`);
console.log(`Files are in: ${dir}`);
