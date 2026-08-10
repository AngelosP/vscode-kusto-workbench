import { canonicalizePowerBiKustoClusterUrl } from '../shared/kustoClusterUrls';
import type { PortableDashboardCompilation } from '../shared/portableDashboardCompiler';
import {
	extractHtmlBackground,
	generateCultureTmdl,
	generateDatabaseTmdl,
	generateDefinitionPbir,
	generateDefinitionPbism,
	generateHtmlContentVisualJson,
	generateHtmlMeasureTmdl,
	generateModelTmdl,
	generatePbirPageJson,
	generatePbirPagesJson,
	generatePbirReportJson,
	generatePbirVersionJson,
	generatePlatformFile,
	generateSlicerVisualJson,
	generateTableTmdl,
	defaultPowerBiArtifactIdSource,
	normalizePowerBiDataMode,
	patchCssForPbiVisual,
	resolveCssVariables,
	resolveFactTableSlicers,
	sanitizeName,
	validatePowerBiHtmlBindings,
	type PowerBiArtifactIdSource,
	type PowerBiExportInput,
} from './powerBiExport';

export interface PowerBiProjectArtifact {
	readonly path: string;
	readonly bytes: Readonly<Uint8Array>;
}

export interface PowerBiProjectArtifactManifest {
	readonly projectName: string;
	readonly reportFolder: string;
	readonly semanticModelFolder: string;
	readonly artifacts: readonly PowerBiProjectArtifact[];
}

export interface FabricDefinitionPart {
	readonly path: string;
	readonly payload: string;
	readonly payloadType: 'InlineBase64';
}

const MEASURES_TABLE_NAME = '_KW_HtmlMeasures';
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i;

function comparePaths(left: PowerBiProjectArtifact, right: PowerBiProjectArtifact): number {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function artifact(path: string, content: string): PowerBiProjectArtifact {
	if (!path || path.startsWith('/') || path.includes('\\')) {
		throw new Error(`Invalid Power BI project artifact path: ${path}`);
	}
	const segments = path.split('/');
	if (segments.some(segment => segment === ''
		|| segment === '.'
		|| segment === '..'
		|| segment !== segment.replace(/[ .]+$/g, '')
		|| /[<>:"|?*\u0000-\u001f]/.test(segment)
		|| WINDOWS_RESERVED_NAME.test(segment))) {
		throw new Error(`Invalid Power BI project artifact path: ${path}`);
	}
	const base64Bytes = Buffer.from(content, 'utf8').toString('base64');
	return Object.freeze({
		path,
		get bytes(): Readonly<Uint8Array> {
			return Uint8Array.from(Buffer.from(base64Bytes, 'base64'));
		},
	});
}

function windowsPathKey(path: string): string {
	return path.split('/').map(segment => segment.normalize('NFC').toLowerCase()).join('/');
}

function assertPortableArtifactPaths(artifacts: readonly PowerBiProjectArtifact[]): void {
	const files = new Map<string, string>();
	const directories = new Map<string, string>();
	for (const current of artifacts) {
		const segments = current.path.split('/');
		const fileKey = windowsPathKey(current.path);
		const priorFile = files.get(fileKey);
		if (priorFile) {
			throw new Error(`Power BI project artifact paths collide on Windows: ${priorFile} and ${current.path}`);
		}
		const priorDirectory = directories.get(fileKey);
		if (priorDirectory) {
			throw new Error(`Power BI project artifact file/directory paths collide on Windows: ${current.path} and ${priorDirectory}`);
		}
		for (let length = 1; length < segments.length; length++) {
			const directory = segments.slice(0, length).join('/');
			const directoryKey = windowsPathKey(directory);
			const conflictingFile = files.get(directoryKey);
			if (conflictingFile) {
				throw new Error(`Power BI project artifact file/directory paths collide on Windows: ${conflictingFile} and ${current.path}`);
			}
			directories.set(directoryKey, directory);
		}
		files.set(fileKey, current.path);
	}
}

export function compilePowerBiProjectArtifacts(
	input: PowerBiExportInput,
	portableDashboard: PortableDashboardCompilation,
	idSource: PowerBiArtifactIdSource = defaultPowerBiArtifactIdSource,
): PowerBiProjectArtifactManifest {
	if (!portableDashboard.ir || portableDashboard.diagnostics.length > 0) {
		throw new Error('Power BI project artifacts require an admitted portable dashboard IR.');
	}

	const projectName = input.projectName || sanitizeName(input.sectionName) || 'KustoHtmlDashboard';
	const reportFolder = `${projectName}.Report`;
	const semanticModelFolder = `${projectName}.SemanticModel`;
	const pageName = 'ReportPage1';
	const visualId = idSource.nextHex(20);
	const dataMode = normalizePowerBiDataMode(input.dataMode, 'import');
	for (const dataSource of input.dataSources) {
		canonicalizePowerBiKustoClusterUrl(dataSource.clusterUrl);
	}

	const contentHeight = Math.min(14400, Math.max(720, input.previewHeight || 720));
	const factDataSource = input.dataSources.find(
		dataSource => dataSource.sectionId === portableDashboard.ir!.fact.sectionId,
	) ?? input.dataSources[0];
	const resolvedSlicers = resolveFactTableSlicers(factDataSource, portableDashboard.ir.dimensions);
	const slicerRowHeight = 60;
	const slicerRowMargin = 20;
	const slicerGap = 16;
	const hasSlicers = resolvedSlicers.length > 0;
	const slicerYOffset = hasSlicers ? slicerRowMargin + slicerRowHeight + slicerRowMargin : 0;
	const adjustedContentHeight = hasSlicers ? Math.max(720, contentHeight - 80) : contentHeight;
	const pageHeight = Math.min(14400, adjustedContentHeight + slicerYOffset);

	const resolvedHtml = resolveCssVariables(input.htmlCode);
	const backgroundColor = extractHtmlBackground(resolvedHtml) || undefined;
	const powerBiHtml = patchCssForPbiVisual(resolvedHtml);
	const transformedDashboard = validatePowerBiHtmlBindings(powerBiHtml, input.dataSources);
	const htmlMeasureTmdl = generateHtmlMeasureTmdl(
		powerBiHtml,
		input.dataSources,
		transformedDashboard.ir,
		idSource,
	);

	const artifacts: PowerBiProjectArtifact[] = [
		artifact(`${projectName}.pbip`, JSON.stringify({
			$schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
			version: '1.0',
			artifacts: [{ report: { path: reportFolder } }],
			settings: { enableAutoRecovery: true },
		}, null, 2)),
		artifact('.gitignore', '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n'),
		artifact(`${reportFolder}/.platform`, generatePlatformFile('Report', projectName, idSource)),
		artifact(`${semanticModelFolder}/.platform`, generatePlatformFile('SemanticModel', projectName, idSource)),
		artifact(`${reportFolder}/definition.pbir`, generateDefinitionPbir(semanticModelFolder)),
		artifact(`${reportFolder}/definition/version.json`, generatePbirVersionJson()),
		artifact(`${reportFolder}/definition/report.json`, generatePbirReportJson()),
		artifact(`${reportFolder}/definition/pages/pages.json`, generatePbirPagesJson(pageName)),
		artifact(`${reportFolder}/definition/pages/${pageName}/page.json`, generatePbirPageJson(pageName, pageHeight, backgroundColor)),
		artifact(
			`${reportFolder}/definition/pages/${pageName}/visuals/${visualId}/visual.json`,
			generateHtmlContentVisualJson(visualId, pageHeight, slicerYOffset),
		),
	];

	if (hasSlicers) {
		const pageWidth = 1500;
		const slicerXMargin = 25;
		const availableWidth = pageWidth - 2 * slicerXMargin;
		const slicerWidth = Math.floor(
			(availableWidth - (resolvedSlicers.length - 1) * slicerGap) / resolvedSlicers.length,
		);
		for (let index = 0; index < resolvedSlicers.length; index++) {
			const slicer = resolvedSlicers[index];
			const slicerVisualId = idSource.nextHex(20);
			const x = slicerXMargin + index * (slicerWidth + slicerGap);
			artifacts.push(artifact(
				`${reportFolder}/definition/pages/${pageName}/visuals/${slicerVisualId}/visual.json`,
				generateSlicerVisualJson(slicerVisualId, slicer.tableName, slicer.columnName, {
					x,
					y: slicerRowMargin,
					width: slicerWidth,
					height: slicerRowHeight,
				}, slicer.mode, index + 1, idSource),
			));
		}
	}

	artifacts.push(
		artifact(`${semanticModelFolder}/definition.pbism`, generateDefinitionPbism()),
		artifact(
			`${semanticModelFolder}/definition/model.tmdl`,
			generateModelTmdl(input.dataSources.map(dataSource => sanitizeName(dataSource.name)), [], idSource),
		),
		artifact(`${semanticModelFolder}/definition/database.tmdl`, generateDatabaseTmdl()),
		artifact(`${semanticModelFolder}/definition/cultures/en-US.tmdl`, generateCultureTmdl()),
	);
	for (const dataSource of input.dataSources) {
		artifacts.push(artifact(
			`${semanticModelFolder}/definition/tables/${sanitizeName(dataSource.name)}.tmdl`,
			generateTableTmdl(dataSource, dataMode, idSource),
		));
	}
	artifacts.push(artifact(
		`${semanticModelFolder}/definition/tables/${MEASURES_TABLE_NAME}.tmdl`,
		htmlMeasureTmdl,
	));

	artifacts.sort(comparePaths);
	assertPortableArtifactPaths(artifacts);
	return Object.freeze({
		projectName,
		reportFolder,
		semanticModelFolder,
		artifacts: Object.freeze(artifacts),
	});
}

export function powerBiProjectArtifactsToFabricParts(
	manifest: PowerBiProjectArtifactManifest,
	folder: string,
): FabricDefinitionPart[] {
	const prefix = `${folder}/`;
	return manifest.artifacts
		.filter(artifact => artifact.path.startsWith(prefix))
		.filter(artifact => artifact.path.slice(prefix.length).split('/').at(-1) !== '.platform')
		.map(artifact => ({
			path: artifact.path.slice(prefix.length),
			payload: Buffer.from(artifact.bytes).toString('base64'),
			payloadType: 'InlineBase64',
		}));
}