import { isSupportedPowerBiDisplayType, isValidDashboardChartDisplay, type PreAggregate } from './dashboardCharts';
import { isValidRepeatedTableDisplay, isValidTableDisplay } from './dashboardTables';

export const CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION = 1;

export interface KwModelFact { sectionId: string; sectionName: string }
export interface KwModelDimension { column: string; label?: string; mode?: 'dropdown' | 'list' | 'between' }

export interface KwProvenanceBinding {
	display?: unknown;
}

export interface KwProvenance {
	version: number;
	model: { fact: KwModelFact; dimensions?: KwModelDimension[] };
	bindings: Record<string, KwProvenanceBinding>;
}

export interface PowerBiUpgradeNoticeState {
	dismissedForVersion?: number;
	dismissedForSignature?: string;
	dismissedAt?: string;
}

export interface HtmlDashboardPowerBiCompatibilityResult {
	needsUpgrade: boolean;
	targetVersion: number;
	reasons: string[];
	signature: string;
}

interface DataKwBindTargetElement {
	tagName: string;
	openTag: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

export function parseKwProvenance(htmlCode: string): KwProvenance | null {
	try {
		const match = htmlCode.match(/<script\s+type\s*=\s*["']application\/kw-provenance["'][^>]*>([\s\S]*?)<\/script>/i);
		if (!match) return null;
		const json = JSON.parse(match[1]);
		if (!isObjectRecord(json)) return null;
		const model = json.model;
		const bindings = json.bindings;
		if (!isObjectRecord(model) || !isObjectRecord(model.fact) || !isNonEmptyText(model.fact.sectionId)) return null;
		if (!isObjectRecord(bindings)) return null;
		return {
			version: typeof json.version === 'number' && Number.isFinite(json.version) ? json.version : 1,
			model: model as KwProvenance['model'],
			bindings: bindings as Record<string, KwProvenanceBinding>,
		};
	} catch {
		return null;
	}
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
	if (/document\.getElementById\s*\(|querySelector\(\s*['"]#/i.test(htmlCode)) {
		warnings.push('ID-based DOM binding detected. Dashboard data values should bind through data-kw-bind plus KustoWorkbench.bind(), renderChart(), renderTable(), or renderRepeatedTable() so Power BI export can resolve them.');
	}
	return warnings;
}

function stripNonRenderedHtmlBlocks(html: string): string {
	return html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<template\b[\s\S]*?<\/template>|<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

function isHiddenDataKwBindTarget(openTag: string): boolean {
	if (/\shidden(?:\s|=|>)/i.test(openTag)) return true;
	if (/\baria-hidden\s*=\s*(["'])true\1/i.test(openTag)) return true;
	const classMatch = openTag.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
	if (classMatch && /(?:^|\s)pbi-hidden(?:\s|$)/i.test(classMatch[2])) return true;
	const styleMatch = openTag.match(/\bstyle\s*=\s*(["'])(.*?)\1/i);
	if (styleMatch && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(styleMatch[2])) return true;
	return false;
}

function bindingAttributePattern(key: string): string {
	return `data-kw-bind\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`;
}

function hasBoundContainerElement(html: string, bindAttr: string): boolean {
	const re = new RegExp(
		`<([a-zA-Z][a-zA-Z0-9:-]*)\\b[^>]*?\\b${bindAttr}[^>]*>[\\s\\S]*?<\/\\1>`, 'i',
	);
	return re.test(html);
}

function matchTableElement(html: string, bindAttr: string): boolean {
	const onTableRe = new RegExp(
		`(<table\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(<\/table>)`, 'i',
	);
	if (onTableRe.test(html)) return true;

	const onTbodyRe = new RegExp(
		`(<table\\b[^>]*>)((?:(?!<table\\b)[\\s\\S])*?)(<tbody\\b[^>]*?\\b${bindAttr}[^>]*>)([\\s\\S]*?)(<\/tbody>)((?:(?!<table\\b)[\\s\\S])*?)(<\/table>)`, 'i',
	);
	return onTbodyRe.test(html);
}

function isRepeatedTableContainerTag(tagName: string): boolean {
	return !['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'].includes(tagName.toLowerCase());
}

function isVisibleRepeatedTableTarget(target: DataKwBindTargetElement): boolean {
	return isRepeatedTableContainerTag(target.tagName) && !isHiddenDataKwBindTarget(target.openTag);
}

function findDataKwBindTargetElements(htmlCode: string): Map<string, DataKwBindTargetElement[]> {
	const targets = new Map<string, DataKwBindTargetElement[]>();
	const renderedHtml = stripNonRenderedHtmlBlocks(htmlCode);
	const targetPattern = /<([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*\bdata-kw-bind\s*=\s*(["'])(.*?)\2[^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = targetPattern.exec(renderedHtml)) !== null) {
		const key = match[3];
		const existing = targets.get(key) ?? [];
		existing.push({ tagName: match[1].toLowerCase(), openTag: match[0] });
		targets.set(key, existing);
	}
	return targets;
}

function isValidScalarDisplay(display: unknown): boolean {
	if (!isObjectRecord(display) || display.type !== 'scalar') return false;
	if (display.agg !== undefined && !isNonEmptyText(display.agg)) return false;
	if (aggregateRequiresColumn(display.agg) && !isNonEmptyText(display.column)) return false;
	if (display.column !== undefined && typeof display.column !== 'string') return false;
	if (display.format !== undefined && typeof display.format !== 'string') return false;
	return true;
}

function aggregateRequiresColumn(agg: unknown): boolean {
	return String(agg || 'COUNT').toUpperCase() !== 'COUNT';
}

function isValidPreAggregateSpec(value: unknown): value is PreAggregate {
	if (!isObjectRecord(value) || !isObjectRecord(value.compute)) return false;
	const groupBy = value.groupBy;
	const validGroupBy = isNonEmptyText(groupBy) || (Array.isArray(groupBy) && groupBy.length > 0 && groupBy.every(isNonEmptyText));
	if (!validGroupBy || !isNonEmptyText(value.compute.name) || !isNonEmptyText(value.compute.agg)) return false;
	if (aggregateRequiresColumn(value.compute.agg) && !isNonEmptyText(value.compute.column)) return false;
	if (value.compute.column !== undefined && typeof value.compute.column !== 'string') return false;
	return true;
}

function isValidPivotDisplay(display: unknown): boolean {
	if (!isObjectRecord(display) || display.type !== 'pivot') return false;
	if (!Array.isArray(display.rows) || display.rows.length === 0 || !display.rows.every(isNonEmptyText)) return false;
	if (!isNonEmptyText(display.pivotBy)) return false;
	if (!Array.isArray(display.pivotValues) || display.pivotValues.length === 0 || !display.pivotValues.every(value => typeof value === 'string')) return false;
	if (!isNonEmptyText(display.agg)) return false;
	if (aggregateRequiresColumn(display.agg) && !isNonEmptyText(display.value)) return false;
	if (display.value !== undefined && typeof display.value !== 'string') return false;
	if (display.format !== undefined && typeof display.format !== 'string') return false;
	if (display.total !== undefined && typeof display.total !== 'boolean') return false;
	if (display.preAggregate !== undefined && !isValidPreAggregateSpec(display.preAggregate)) return false;
	return true;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(value => value.trim().length > 0))];
}

export function findUnsupportedPowerBiBindings(htmlCode: string): string[] {
	const provenance = parseKwProvenance(htmlCode);
	if (!provenance) return [];
	const renderedTargetElements = findDataKwBindTargetElements(htmlCode);
	const renderedHtml = stripNonRenderedHtmlBlocks(htmlCode);
	const unsupported: string[] = [];

	for (const [key, targets] of renderedTargetElements) {
		const binding = provenance.bindings[key];
		if (!binding) {
			unsupported.push(`${key} (missing provenance binding)`);
			continue;
		}
		if (!binding.display) {
			unsupported.push(`${key} (missing display)`);
			continue;
		}
		const display = binding.display as { type?: unknown };
		const type = typeof display.type === 'string' ? display.type : '';
		if (!type) {
			unsupported.push(`${key} (missing display type)`);
			continue;
		}
		if (targets.length > 0 && targets.every(target => isHiddenDataKwBindTarget(target.openTag))) {
			unsupported.push(`${key} (${type}: target is hidden; bind exportable content to a visible data-kw-bind element)`);
			continue;
		}
		const bindAttr = bindingAttributePattern(key);
		if ((type === 'table' || type === 'pivot') && !matchTableElement(renderedHtml, bindAttr)) {
			unsupported.push(`${key} (${type}: target must be table or tbody inside table)`);
		} else if (type === 'repeatedTable' && !hasBoundContainerElement(renderedHtml, bindAttr)) {
			unsupported.push(`${key} (${type}: target must be container element)`);
		} else if (type === 'repeatedTable' && targets.some(target => !isVisibleRepeatedTableTarget(target))) {
			unsupported.push(`${key} (${type}: target must be a visible non-table container element)`);
		} else if ((type === 'scalar' || type === 'bar' || type === 'pie' || type === 'line') && !hasBoundContainerElement(renderedHtml, bindAttr)) {
			unsupported.push(`${key} (${type}: target must be container element)`);
		}
	}

	for (const [key, binding] of Object.entries(provenance.bindings)) {
		if (!renderedTargetElements.has(key)) continue;
		const display = binding.display as { type?: unknown } | undefined;
		const type = typeof display?.type === 'string' ? display.type : '';
		const top = (display as { top?: unknown } | undefined)?.top;
		if (type && !isSupportedPowerBiDisplayType(type)) {
			unsupported.push(`${key} (${type})`);
		} else if (type === 'scalar' && !isValidScalarDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if (type === 'table' && top !== undefined && (typeof top !== 'number' || !Number.isInteger(top) || top <= 0 || !isObjectRecord((display as { orderBy?: unknown }).orderBy))) {
			unsupported.push(`${key} (${type}: invalid top)`);
		} else if (type === 'table' && !isValidTableDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if (type === 'repeatedTable' && (display as { repeatTop?: unknown } | undefined)?.repeatTop !== undefined) {
			const repeatTop = (display as { repeatTop?: unknown; repeatOrderBy?: unknown }).repeatTop;
			if (typeof repeatTop !== 'number' || !Number.isInteger(repeatTop) || repeatTop <= 0 || !isObjectRecord((display as { repeatOrderBy?: unknown }).repeatOrderBy)) {
				unsupported.push(`${key} (${type}: invalid repeatTop)`);
			} else if (!isValidRepeatedTableDisplay(display)) {
				unsupported.push(`${key} (${type}: invalid spec)`);
			}
		} else if (type === 'repeatedTable' && !isValidRepeatedTableDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if (type === 'pivot' && !isValidPivotDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid spec)`);
		} else if ((type === 'bar' || type === 'pie' || type === 'line') && !isValidDashboardChartDisplay(display)) {
			unsupported.push(`${key} (${type}: invalid chart spec)`);
		}
	}

	return uniqueStrings(unsupported);
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
		|| normalized.includes('missing data-kw-bind target')
		|| normalized.includes('missing provenance binding')
		|| normalized.includes('missing display')
		|| normalized.includes('missing display type')
		|| normalized.includes('target must')
		|| normalized.includes('target is hidden')
		|| normalized.includes('invalid spec')
		|| normalized.includes('invalid chart spec')
		|| normalized.includes('invalid top')
		|| normalized.includes('invalid repeattop')
		|| normalized.includes('legacy or manual chart rendering')
		|| normalized.includes('preview-only chart rendering')
		|| normalized.includes('preview-only table rendering')
		|| normalized.includes('id-based dom binding');
}

export function canOfferHtmlDashboardPowerBiUpgrade(status: Pick<HtmlDashboardPowerBiCompatibilityResult, 'needsUpgrade' | 'reasons'>): boolean {
	return status.needsUpgrade
		&& getKnownUnsupportedPowerBiCompatibilityReasons(status.reasons).length === 0
		&& status.reasons.some(isActionablePowerBiCompatibilityReason);
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

export function analyzeHtmlDashboardPowerBiCompatibility(htmlCode: string): HtmlDashboardPowerBiCompatibilityResult {
	const reasons: string[] = [];
	const provenance = parseKwProvenance(htmlCode);
	if (!provenance) {
		reasons.push('Missing application/kw-provenance block. Ask Kusto Workbench to make this dashboard exportable to Power BI.');
	} else {
		if (provenance.version < CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION) {
			reasons.push(`Dashboard provenance version ${provenance.version} is older than the current Power BI export contract version ${CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION}.`);
		}

		const renderedTargets = findDataKwBindTargetElements(htmlCode);
		for (const bindingKey of Object.keys(provenance.bindings)) {
			if (!renderedTargets.has(bindingKey)) {
				reasons.push(`${bindingKey} (missing data-kw-bind target)`);
			}
		}
		reasons.push(...findUnsupportedPowerBiBindings(htmlCode));
	}

	reasons.push(...getLegacyDashboardWarnings(htmlCode));
	const uniqueReasons = uniqueStrings(reasons);
	return {
		needsUpgrade: uniqueReasons.length > 0,
		targetVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
		reasons: uniqueReasons,
		signature: compatibilitySignature(htmlCode, uniqueReasons),
	};
}