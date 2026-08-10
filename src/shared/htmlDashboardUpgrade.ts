import { isSupportedPowerBiDisplayType } from './dashboardCharts';
import {
	compilePortableDashboard,
	type PortableDashboardDataSource,
	type PortableDashboardDiagnostic,
	type PortableDashboardDiagnosticCode,
} from './portableDashboardCompiler';

export { parseKwProvenance } from './portableDashboardCompiler';
export type {
	KwModelDimension,
	KwModelFact,
	KwProvenance,
	KwProvenanceBinding,
} from './portableDashboardCompiler';

export const CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION = 1;

export interface PowerBiUpgradeNoticeState {
	dismissedForSection?: boolean;
	dismissedForVersion?: number;
	dismissedForSignature?: string;
	dismissedAt?: string;
}

export interface HtmlDashboardPowerBiCompatibilityResult {
	needsUpgrade: boolean;
	targetVersion: number;
	reasons: string[];
	signature: string;
	diagnostics: PortableDashboardDiagnostic[];
}

export function getLegacyDashboardWarnings(htmlCode: string): string[] {
	const warnings: string[] = [];
	if (/\bbuild(?:Line|Pie|Bar)Chart\b|<svg\s+xmlns/i.test(htmlCode)) {
		warnings.push('Legacy or manual chart rendering detected. When touching this dashboard, upgrade exportable visuals to provenance chart bindings plus KustoWorkbench.renderChart(bindingId).');
	}
	if (/bindHtml\(\s*['"][^'"]*(?:chart|trend|pie|bar|line|by-os|daily)[^'"]*['"]/i.test(htmlCode)) {
		warnings.push('Potential preview-only chart rendering via bindHtml() detected. Exportable charts should use data-kw-bind targets backed by provenance display specs and KustoWorkbench.renderChart().');
	}
	if (/bindHtml\(\s*['"][^'"]*(?:table|tbody|rows|breakdown|status|detail|details)[^'"]*['"]/i.test(htmlCode) || /\.toTable\s*\(/i.test(htmlCode)) {
		warnings.push('Potential preview-only table rendering detected. Exportable tables and repeated tables, especially visual cells such as stacked status bars, should use provenance table specs plus KustoWorkbench.renderTable(bindingId) or KustoWorkbench.renderRepeatedTable(bindingId).');
	}
	if (/\bKustoWorkbench\.(?:onDataReady|getData)\s*\(/i.test(htmlCode)
		&& /\bdata-role\s*=/i.test(htmlCode)
		&& /(?:\.(?:innerHTML|textContent)\s*=|insertAdjacentHTML\s*\(|appendChild\s*\(|createElement\s*\(|querySelector\s*\(\s*['"]\[data-role=)/i.test(htmlCode)) {
		warnings.push('Potential preview-only data-role rendering detected. Data-driven content rendered into unbound data-role elements will not be included in Power BI export; use data-kw-bind targets backed by provenance display specs plus KustoWorkbench.bind(), renderChart(), renderTable(), or renderRepeatedTable().');
	}
	if (/document\.getElementById\s*\(|querySelector\(\s*['"]#/i.test(htmlCode)) {
		warnings.push('ID-based DOM binding detected. Dashboard data values should bind through data-kw-bind plus KustoWorkbench.bind(), renderChart(), renderTable(), or renderRepeatedTable() so Power BI export can resolve them.');
	}
	return warnings;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(value => value.trim().length > 0))];
}

const BINDING_COMPATIBILITY_CODES = new Set<PortableDashboardDiagnosticCode>([
	'missing-binding',
	'missing-display',
	'missing-display-type',
	'hidden-target',
	'invalid-target',
	'duplicate-target',
	'overlapping-target',
	'unsupported-display',
	'invalid-display',
]);

export function findUnsupportedPowerBiBindings(htmlCode: string): string[] {
	return compilePortableDashboard({ htmlCode }).diagnostics
		.filter(diagnostic => BINDING_COMPATIBILITY_CODES.has(diagnostic.code))
		.map(diagnostic => diagnostic.message);
}

function getUnsupportedDisplayTypeFromCompatibilityReason(reason: string): string | undefined {
	const match = reason.match(/^.+\s\(([^:()\s]+)\)$/);
	if (!match) return undefined;
	const type = match[1];
	return isSupportedPowerBiDisplayType(type) ? undefined : type;
}

export function getKnownUnsupportedPowerBiCompatibilityReasons(reasons: readonly string[]): string[] {
	return uniqueStrings(reasons.filter(reason => !!getUnsupportedDisplayTypeFromCompatibilityReason(reason)));
}

export function getKnownUnsupportedPowerBiDisplayTypes(reasons: readonly string[]): string[] {
	return uniqueStrings(reasons.map(reason => getUnsupportedDisplayTypeFromCompatibilityReason(reason) || ''));
}

function isActionablePowerBiCompatibilityReason(reason: string): boolean {
	const normalized = reason.toLowerCase();
	return normalized.includes('missing application/kw-provenance')
		|| normalized.includes('older than the current power bi export contract')
		|| normalized.includes('not supported by the portable dashboard contract')
		|| normalized.includes('missing data-kw-bind target')
		|| normalized.includes('missing provenance binding')
		|| normalized.includes('binding keys must be non-empty')
		|| normalized.includes('missing display')
		|| normalized.includes('missing display type')
		|| normalized.includes('target must')
		|| normalized.includes('target is hidden')
		|| normalized.includes('target overlaps')
		|| normalized.includes('expected exactly one data-kw-bind target')
		|| normalized.includes('invalid source schema')
		|| normalized.includes('invalid slicer spec')
		|| normalized.includes('provenance version must')
		|| normalized.includes('invalid spec')
		|| normalized.includes('invalid chart spec')
		|| normalized.includes('invalid top')
		|| normalized.includes('invalid repeattop')
		|| normalized.includes('missing column')
		|| normalized.includes('non-numeric column')
		|| normalized.includes('collides with')
		|| normalized.includes('legacy or manual chart rendering')
		|| normalized.includes('preview-only chart rendering')
		|| normalized.includes('preview-only table rendering')
		|| normalized.includes('preview-only data-role rendering')
		|| normalized.includes('id-based dom binding');
}

export function canOfferHtmlDashboardPowerBiUpgrade(
	status: Pick<HtmlDashboardPowerBiCompatibilityResult, 'needsUpgrade' | 'reasons' | 'diagnostics'>,
): boolean {
	const diagnosticReasons = new Set(status.diagnostics.map(diagnostic => diagnostic.message));
	const legacyReasons = status.reasons.filter(reason => !diagnosticReasons.has(reason));
	return status.needsUpgrade
		&& !status.diagnostics.some(diagnostic => diagnostic.code === 'unsupported-display')
		&& (
			status.diagnostics.length > 0
			|| legacyReasons.some(isActionablePowerBiCompatibilityReason)
		);
}

function compatibilitySignature(htmlCode: string, reasons: string[]): string {
	const source = `${CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION}\n${reasons.join('\n')}\n${htmlCode}`;
	let hash = 2166136261;
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function analyzeHtmlDashboardPowerBiCompatibility(
	htmlCode: string,
	dataSources?: readonly PortableDashboardDataSource[],
): HtmlDashboardPowerBiCompatibilityResult {
	const compilation = compilePortableDashboard({ htmlCode, dataSources });
	const reasons = compilation.diagnostics.map(diagnostic => diagnostic.message);
	reasons.push(...getLegacyDashboardWarnings(htmlCode));
	const uniqueReasons = uniqueStrings(reasons);
	return {
		needsUpgrade: uniqueReasons.length > 0,
		targetVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
		reasons: uniqueReasons,
		signature: compatibilitySignature(htmlCode, uniqueReasons),
		diagnostics: [...compilation.diagnostics],
	};
}