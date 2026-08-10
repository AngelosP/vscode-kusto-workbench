import {
	parse,
	Parser,
	type DefaultTreeAdapterMap,
	type DefaultTreeAdapterTypes,
} from 'parse5';

import {
	isSupportedPowerBiDisplayType,
	isValidDashboardChartDisplay,
	type DashboardChartDisplay,
	type PreAggregate,
} from './dashboardCharts';
import {
	isTableCellBarColumn,
	isTableCellFormattedColumn,
	isValidRepeatedTableDisplay,
	isValidTableDisplay,
	repeatedTableRepeatColumns,
	tableAggregateNeedsColumn,
	type RepeatedTableDisplay,
	type TableColumnSpec,
	type TableDisplay,
} from './dashboardTables';
import {
	dashboardAggregateNeedsColumn,
	dashboardTooltipAggregateNeedsColumn,
	isValidDashboardAggregate,
	normalizeDashboardAggregate,
	type DashboardTooltipSpec,
} from './dashboardTooltips';

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

export interface PortableDashboardColumn {
	name: string;
	type: string;
}

export interface PortableDashboardDataSource {
	sectionId: string;
	columns: readonly PortableDashboardColumn[];
}

export type PortableDashboardDiagnosticCode =
	| 'missing-provenance'
	| 'invalid-provenance'
	| 'unsupported-version'
	| 'missing-target'
	| 'missing-binding'
	| 'invalid-binding-key'
	| 'missing-display'
	| 'missing-display-type'
	| 'hidden-target'
	| 'invalid-target'
	| 'duplicate-target'
	| 'overlapping-target'
	| 'unsupported-display'
	| 'invalid-display'
	| 'invalid-dimension'
	| 'invalid-source-schema'
	| 'missing-data-source'
	| 'missing-column'
	| 'non-numeric-column'
	| 'column-collision';

export interface PortableDashboardDiagnostic {
	code: PortableDashboardDiagnosticCode;
	severity: 'error';
	message: string;
	bindingKey?: string;
	role?: string;
	columnName?: string;
	displayType?: string;
}

export interface PortableDashboardScalarDisplay {
	type: 'scalar';
	agg: string;
	column?: string;
	format?: string;
}

export interface PortableDashboardPivotDisplay {
	type: 'pivot';
	rows: string[];
	pivotBy: string;
	pivotValues: string[];
	value: string;
	agg: string;
	format?: string;
	total?: boolean;
	preAggregate?: PreAggregate;
}

export type PortableDashboardDisplay =
	| PortableDashboardScalarDisplay
	| TableDisplay
	| RepeatedTableDisplay
	| PortableDashboardPivotDisplay
	| DashboardChartDisplay;

export interface PortableDashboardSourceRange {
	startOffset: number;
	startTagEndOffset: number;
	endTagStartOffset?: number;
	endOffset: number;
}

export interface PortableDashboardTarget {
	tagName: string;
	hidden: boolean;
	source: PortableDashboardSourceRange;
	tableSource?: PortableDashboardSourceRange;
}

export interface PortableDashboardBindingIr {
	key: string;
	display: PortableDashboardDisplay;
	targets: readonly PortableDashboardTarget[];
	admitted: boolean;
}

export interface PortableDashboardIr {
	version: 1;
	sourceVersion: number;
	provenanceSource: PortableDashboardSourceRange;
	fact: KwModelFact;
	dimensions: readonly KwModelDimension[];
	bindings: readonly PortableDashboardBindingIr[];
}

export interface PortableDashboardCompilation {
	provenance: KwProvenance | null;
	ir: PortableDashboardIr | null;
	diagnostics: readonly PortableDashboardDiagnostic[];
}

export interface CompilePortableDashboardInput {
	htmlCode: string;
	dataSources?: readonly PortableDashboardDataSource[];
}

interface DataKwBindTargetElement {
	tagName: string;
	openTag: string;
	source?: PortableDashboardSourceRange;
	tableSource?: PortableDashboardSourceRange;
	element: DefaultTreeAdapterTypes.Element;
	hasReparentedSourceContent: boolean;
	hasFormBoundaryToken: boolean;
}

interface KwProvenanceParseResult {
	provenance: KwProvenance | null;
	invalidMessage?: string;
}

interface PortableDashboardHtmlAnalysis {
	provenanceJson: string | null;
	provenanceSource: PortableDashboardSourceRange | null;
	targets: Map<string, DataKwBindTargetElement[]>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isPortableDashboardDataSource(value: unknown): value is PortableDashboardDataSource {
	return isObjectRecord(value)
		&& isNonEmptyText(value.sectionId)
		&& Array.isArray(value.columns)
		&& value.columns.every(column =>
			isObjectRecord(column)
			&& isNonEmptyText(column.name)
			&& typeof column.type === 'string');
}

function sourceRange(element: DefaultTreeAdapterTypes.Element): PortableDashboardSourceRange | undefined {
	const location = element.sourceCodeLocation;
	const startTag = location?.startTag;
	if (!location || !startTag) return undefined;
	return {
		startOffset: location.startOffset,
		startTagEndOffset: startTag.endOffset,
		...(location.endTag ? { endTagStartOffset: location.endTag.startOffset } : {}),
		endOffset: location.endOffset,
	};
}

function elementAttribute(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
	return element.attrs.find(attribute => attribute.name.toLowerCase() === name)?.value;
}

function nodeSourceOffsets(node: DefaultTreeAdapterTypes.Node): { startOffset: number; endOffset: number } | undefined {
	if (!('sourceCodeLocation' in node) || !node.sourceCodeLocation) return undefined;
	return {
		startOffset: node.sourceCodeLocation.startOffset,
		endOffset: node.sourceCodeLocation.endOffset,
	};
}

function isDomDescendantOf(
	node: DefaultTreeAdapterTypes.Node,
	ancestor: DefaultTreeAdapterTypes.Element,
): boolean {
	let current: DefaultTreeAdapterTypes.Node | null = 'parentNode' in node ? node.parentNode : null;
	while (current) {
		if (current === ancestor) return true;
		current = 'parentNode' in current ? current.parentNode : null;
	}
	return false;
}

function isDomAncestorOf(
	node: DefaultTreeAdapterTypes.Node,
	descendant: DefaultTreeAdapterTypes.Element,
): boolean {
	return 'tagName' in node && isDomDescendantOf(descendant, node as DefaultTreeAdapterTypes.Element);
}

type ParserTagToken = Parameters<Parser<DefaultTreeAdapterMap>['onStartTag']>[0];

class PortableDashboardParser extends Parser<DefaultTreeAdapterMap> {
	readonly formBoundaryTokenRanges: Array<{ startOffset: number; endOffset: number }> = [];

	private recordFormBoundary(token: ParserTagToken): void {
		if (token.tagName === 'form' && token.location) {
			this.formBoundaryTokenRanges.push({
				startOffset: token.location.startOffset,
				endOffset: token.location.endOffset,
			});
		}
	}

	override onStartTag(token: ParserTagToken): void {
		this.recordFormBoundary(token);
		super.onStartTag(token);
	}

	override onEndTag(token: ParserTagToken): void {
		this.recordFormBoundary(token);
		super.onEndTag(token);
	}
}

function analyzePortableDashboardHtml(htmlCode: string): PortableDashboardHtmlAnalysis {
	const parser = new PortableDashboardParser({ sourceCodeLocationInfo: true, scriptingEnabled: true });
	parser.tokenizer.write(htmlCode, true);
	const document = parser.document;
	const targets = new Map<string, DataKwBindTargetElement[]>();
	const locatedNodes: DefaultTreeAdapterTypes.Node[] = [];
	const formBoundaryTokenRanges = parser.formBoundaryTokenRanges;
	let provenanceJson: string | null = null;
	let provenanceSource: PortableDashboardSourceRange | null = null;

	const visit = (node: DefaultTreeAdapterTypes.Node, tableSource?: PortableDashboardSourceRange): void => {
		if (nodeSourceOffsets(node)) locatedNodes.push(node);
		if (!('tagName' in node)) {
			if ('childNodes' in node) node.childNodes.forEach(child => visit(child, tableSource));
			return;
		}
		const element = node as DefaultTreeAdapterTypes.Element;
		const range = sourceRange(element);
		const nextTableSource = element.tagName === 'table' ? range : tableSource;
		if (range && provenanceJson === null && element.tagName === 'script'
			&& elementAttribute(element, 'type')?.toLowerCase() === 'application/kw-provenance'
			&& range.endTagStartOffset !== undefined) {
			provenanceJson = htmlCode.slice(range.startTagEndOffset, range.endTagStartOffset);
			provenanceSource = range;
		}
		const key = elementAttribute(element, 'data-kw-bind');
		if (key !== undefined) {
			const existing = targets.get(key) ?? [];
			existing.push({
				tagName: element.tagName,
				openTag: range ? htmlCode.slice(range.startOffset, range.startTagEndOffset) : `<${element.tagName}>`,
				...(range ? { source: range } : {}),
				...(element.tagName === 'tbody' && nextTableSource ? { tableSource: nextTableSource } : {}),
				element,
				hasReparentedSourceContent: false,
				hasFormBoundaryToken: false,
			});
			targets.set(key, existing);
		}
		element.childNodes.forEach(child => visit(child, nextTableSource));
	};

	visit(document);
	for (const targetElements of targets.values()) {
		for (const target of targetElements) {
			const source = target.source;
			if (!source || source.endTagStartOffset === undefined) continue;
			const endTagStartOffset = source.endTagStartOffset;
			target.hasFormBoundaryToken = formBoundaryTokenRanges.some(range =>
				range.endOffset > source.startTagEndOffset
				&& range.startOffset < endTagStartOffset);
			target.hasReparentedSourceContent = locatedNodes.some(node => {
				if (node === target.element) return false;
				const nodeSource = nodeSourceOffsets(node);
				if (!nodeSource) return false;
				if (isDomDescendantOf(node, target.element)) {
					return nodeSource.startOffset < source.startTagEndOffset
						|| nodeSource.endOffset > endTagStartOffset;
				}
				if (isDomAncestorOf(node, target.element)) {
					if (!('tagName' in node)) return false;
					const ancestorSource = sourceRange(node as DefaultTreeAdapterTypes.Element);
					if (!ancestorSource) return false;
					const startTagIntersects = ancestorSource.startOffset < endTagStartOffset
						&& ancestorSource.startTagEndOffset > source.startTagEndOffset;
					const endTagIntersects = ancestorSource.endTagStartOffset !== undefined
						&& ancestorSource.endTagStartOffset < endTagStartOffset
						&& ancestorSource.endOffset > source.startTagEndOffset;
					return startTagIntersects || endTagIntersects;
				}
				return nodeSource.endOffset > source.startTagEndOffset
					&& nodeSource.startOffset < endTagStartOffset;
			});
		}
	}
	return { provenanceJson, provenanceSource, targets };
}

function parseKwProvenanceResult(
	htmlCode: string,
	analysis = analyzePortableDashboardHtml(htmlCode),
): KwProvenanceParseResult {
	try {
		if (analysis.provenanceJson === null) return { provenance: null };
		const json: unknown = JSON.parse(analysis.provenanceJson);
		if (!isObjectRecord(json)) return { provenance: null, invalidMessage: 'Dashboard provenance must be a JSON object.' };
		const model = json.model;
		const bindings = json.bindings;
		if (!isObjectRecord(model) || !isObjectRecord(model.fact) || !isNonEmptyText(model.fact.sectionId)) {
			return { provenance: null, invalidMessage: 'Dashboard provenance model.fact.sectionId is required.' };
		}
		if (model.fact.sectionName !== undefined && typeof model.fact.sectionName !== 'string') {
			return { provenance: null, invalidMessage: 'Dashboard provenance model.fact.sectionName must be a string.' };
		}
		if (!isObjectRecord(bindings)) return { provenance: null, invalidMessage: 'Dashboard provenance bindings must be an object.' };
		let version = 1;
		if (json.version !== undefined) {
			if (typeof json.version !== 'number' || !Number.isFinite(json.version)) {
				return { provenance: null, invalidMessage: 'Dashboard provenance version must be a finite number.' };
			}
			version = json.version;
		}
		const normalizedBindings = Object.fromEntries(
			Object.entries(bindings).map(([key, binding]) => [key, isObjectRecord(binding) ? binding : {}]),
		) as Record<string, KwProvenanceBinding>;
		return {
			provenance: {
				version,
				model: model as KwProvenance['model'],
				bindings: normalizedBindings,
			},
		};
	} catch {
		return { provenance: null, invalidMessage: 'Dashboard provenance contains invalid JSON.' };
	}
}

export function parseKwProvenance(htmlCode: string): KwProvenance | null {
	return parseKwProvenanceResult(htmlCode).provenance;
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

const NON_RENDERED_PORTABLE_ANCESTOR_TAGS = new Set([
	'head', 'title', 'script', 'style', 'template', 'noscript', 'noembed',
	'noframes', 'xmp', 'iframe', 'plaintext', 'textarea', 'select', 'optgroup',
	'option', 'datalist', 'canvas',
]);

function hasElementAttribute(element: DefaultTreeAdapterTypes.Element, name: string): boolean {
	return element.attrs.some(attribute => attribute.name.toLowerCase() === name);
}

function isStaticallyHiddenElement(element: DefaultTreeAdapterTypes.Element): boolean {
	if (hasElementAttribute(element, 'hidden')) return true;
	if (elementAttribute(element, 'aria-hidden')?.trim().toLowerCase() === 'true') return true;
	if (elementAttribute(element, 'class')?.split(/\s+/).some(name => name.toLowerCase() === 'pbi-hidden')) return true;
	const style = elementAttribute(element, 'style') || '';
	if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\b/i.test(style)) return true;
	if (element.tagName === 'dialog' && !hasElementAttribute(element, 'open')) return true;
	return false;
}

function isHiddenPortableTarget(target: DataKwBindTargetElement): boolean {
	let current: DefaultTreeAdapterTypes.Node | null = target.element;
	while (current) {
		if ('tagName' in current) {
			const element = current as DefaultTreeAdapterTypes.Element;
			if (isStaticallyHiddenElement(element)) return true;
			if (current !== target.element && NON_RENDERED_PORTABLE_ANCESTOR_TAGS.has(element.tagName)) return true;
		}
		current = 'parentNode' in current ? current.parentNode : null;
	}
	return isHiddenDataKwBindTarget(target.openTag);
}

function isRepeatedTableContainerTag(tagName: string): boolean {
	return !['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'].includes(tagName.toLowerCase());
}

const NON_RENDERED_PORTABLE_TARGET_TAGS = new Set([
	'base', 'basefont', 'bgsound', 'head', 'html', 'link', 'meta', 'title',
	'script', 'style', 'template', 'noscript', 'noembed', 'noframes', 'xmp',
	'iframe', 'plaintext', 'textarea', 'select', 'optgroup', 'option', 'datalist',
	'canvas',
]);

function isRenderedPortableTargetTag(tagName: string): boolean {
	return !NON_RENDERED_PORTABLE_TARGET_TAGS.has(tagName.toLowerCase());
}

function isVisibleRepeatedTableTarget(target: DataKwBindTargetElement): boolean {
	return isRenderedPortableTargetTag(target.tagName)
		&& isRepeatedTableContainerTag(target.tagName)
		&& !isHiddenPortableTarget(target);
}

function sourceRangesOverlap(left: PortableDashboardSourceRange, right: PortableDashboardSourceRange): boolean {
	return left.startOffset < right.endOffset && right.startOffset < left.endOffset;
}

function overlappingTargetDiagnostics(
	provenance: KwProvenance,
	targets: Map<string, DataKwBindTargetElement[]>,
	provenanceSource: PortableDashboardSourceRange,
): PortableDashboardDiagnostic[] {
	const diagnostics: PortableDashboardDiagnostic[] = [];
	const bindingTargets = Object.entries(provenance.bindings).flatMap(([bindingKey, binding]) => {
		const targetElements = targets.get(bindingKey) ?? [];
		const display = binding.display as { type?: unknown } | undefined;
		const displayType = typeof display?.type === 'string' ? display.type : '';
		return targetElements.length === 1
			? [{ bindingKey, displayType, target: targetElements[0] }]
			: [];
	});
	for (const bindingTarget of bindingTargets) {
		if (bindingTarget.target.source && sourceRangesOverlap(bindingTarget.target.source, provenanceSource)) {
			diagnostics.push(diagnostic(
				'overlapping-target',
				`${bindingTarget.bindingKey} (${bindingTarget.displayType || 'binding'}: target overlaps provenance block)`,
				{ bindingKey: bindingTarget.bindingKey, displayType: bindingTarget.displayType || undefined },
			));
		}
	}
	for (let leftIndex = 0; leftIndex < bindingTargets.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < bindingTargets.length; rightIndex++) {
			const left = bindingTargets[leftIndex];
			const right = bindingTargets[rightIndex];
			if (!left.target.source || !right.target.source
				|| !sourceRangesOverlap(left.target.source, right.target.source)) continue;
			diagnostics.push(diagnostic(
				'overlapping-target',
				`${left.bindingKey} (${left.displayType || 'binding'}: target overlaps binding ${right.bindingKey})`,
				{ bindingKey: left.bindingKey, displayType: left.displayType || undefined },
			));
			diagnostics.push(diagnostic(
				'overlapping-target',
				`${right.bindingKey} (${right.displayType || 'binding'}: target overlaps binding ${left.bindingKey})`,
				{ bindingKey: right.bindingKey, displayType: right.displayType || undefined },
			));
		}
	}
	return diagnostics;
}

function uniqueGeneratedContentMarker(htmlCode: string): string {
	let index = 0;
	let marker = '';
	do {
		marker = `KW_PORTABLE_GENERATED_PROBE_${index++}`;
	} while (htmlCode.includes(marker));
	return marker;
}

function representativeGeneratedContent(displayType: string, targetTagName: string, marker: string): {
	html: string;
	textMarker?: string;
} {
	if (displayType === 'scalar') {
		return { html: marker, textMarker: marker };
	}
	if (displayType === 'bar' || displayType === 'pie' || displayType === 'line') {
		return { html: `<svg data-kw-portable-marker="${marker}"></svg>` };
	}
	if (displayType === 'repeatedTable') {
		return { html: `<section data-kw-portable-marker="${marker}"></section>` };
	}
	if (displayType === 'table' || displayType === 'pivot') {
		return targetTagName === 'tbody'
			? { html: `<tr data-kw-portable-marker="${marker}"><td></td></tr>` }
			: { html: `<thead></thead><tbody><tr data-kw-portable-marker="${marker}"><td></td></tr></tbody>` };
	}
	return { html: `<span data-kw-portable-marker="${marker}"></span>` };
}

function collectBoundDomElements(
	node: DefaultTreeAdapterTypes.Node,
	bindingKey: string,
	results: DefaultTreeAdapterTypes.Element[] = [],
): DefaultTreeAdapterTypes.Element[] {
	if ('tagName' in node) {
		const element = node as DefaultTreeAdapterTypes.Element;
		if (elementAttribute(element, 'data-kw-bind') === bindingKey) results.push(element);
	}
	if ('childNodes' in node) node.childNodes.forEach(child => collectBoundDomElements(child, bindingKey, results));
	return results;
}

function domRoot(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Node {
	let current = node;
	while ('parentNode' in current && current.parentNode) current = current.parentNode;
	return current;
}

function normalizedDomNode(
	node: DefaultTreeAdapterTypes.Node,
	maskedTarget: DefaultTreeAdapterTypes.Element,
): unknown {
	if ('tagName' in node) {
		const element = node as DefaultTreeAdapterTypes.Element;
		const attributes = element.attrs.map(attribute => ({
			name: attribute.name,
			value: attribute.value,
			namespace: attribute.namespace || '',
			prefix: attribute.prefix || '',
		})).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		return {
			kind: 'element',
			tagName: element.tagName,
			namespaceURI: element.namespaceURI,
			attributes,
			children: element === maskedTarget
				? ['__KW_PORTABLE_TARGET_CHILDREN__']
				: element.childNodes.map(child => normalizedDomNode(child, maskedTarget)),
			...(element.tagName === 'template' && element !== maskedTarget
				? { templateContent: normalizedDomNode((element as DefaultTreeAdapterTypes.Template).content, maskedTarget) }
				: {}),
		};
	}
	if (node.nodeName === '#text') return { kind: 'text', value: node.value };
	if (node.nodeName === '#comment') return { kind: 'comment', data: node.data };
	if (node.nodeName === '#documentType') {
		return { kind: 'doctype', name: node.name, publicId: node.publicId, systemId: node.systemId };
	}
	if ('childNodes' in node) {
		return {
			kind: node.nodeName,
			children: node.childNodes.map(child => normalizedDomNode(child, maskedTarget)),
		};
	}
	return { kind: 'unknown' };
}

function normalizedDomSnapshot(
	root: DefaultTreeAdapterTypes.Node,
	maskedTarget: DefaultTreeAdapterTypes.Element,
): string {
	return JSON.stringify(normalizedDomNode(root, maskedTarget));
}

function generatedContentRemainsInsideTarget(
	htmlCode: string,
	bindingKey: string,
	displayType: string,
	target: DataKwBindTargetElement,
): boolean {
	const source = target.source;
	if (!source || source.endTagStartOffset === undefined) return false;
	const marker = uniqueGeneratedContentMarker(htmlCode);
	const representative = representativeGeneratedContent(displayType, target.tagName, marker);
	const markerStartOffset = source.startTagEndOffset;
	const markerEndOffset = markerStartOffset + representative.html.length;
	const candidateHtml = htmlCode.slice(0, source.startTagEndOffset)
		+ representative.html
		+ htmlCode.slice(source.endTagStartOffset);
	const document = parse(candidateHtml, { sourceCodeLocationInfo: true, scriptingEnabled: true });
	const candidateTargets = collectBoundDomElements(document, bindingKey);
	const markers: DefaultTreeAdapterTypes.Node[] = [];
	const visit = (node: DefaultTreeAdapterTypes.Node): void => {
		if ('tagName' in node) {
			const element = node as DefaultTreeAdapterTypes.Element;
			const nodeSource = nodeSourceOffsets(element);
			if (elementAttribute(element, 'data-kw-portable-marker') === marker
				&& nodeSource
				&& nodeSource.startOffset >= markerStartOffset
				&& nodeSource.endOffset <= markerEndOffset) markers.push(element);
		} else if ('value' in node && representative.textMarker && node.value.includes(representative.textMarker)) {
			const nodeSource = nodeSourceOffsets(node);
			if (nodeSource
				&& nodeSource.endOffset > markerStartOffset
				&& nodeSource.startOffset < markerEndOffset) markers.push(node);
		}
		if ('childNodes' in node) node.childNodes.forEach(visit);
	};
	visit(document);
	return candidateTargets.length === 1
		&& markers.length === 1
		&& isDomDescendantOf(markers[0], candidateTargets[0])
		&& normalizedDomSnapshot(domRoot(target.element), target.element)
			=== normalizedDomSnapshot(document, candidateTargets[0]);
}

function aggregateRequiresColumn(agg: unknown): boolean {
	return dashboardAggregateNeedsColumn(agg || 'COUNT');
}

function isValidPreAggregateSpec(value: unknown): value is PreAggregate {
	if (!isObjectRecord(value) || !isObjectRecord(value.compute)) return false;
	const groupBy = value.groupBy;
	const validGroupBy = isNonEmptyText(groupBy) || (Array.isArray(groupBy) && groupBy.length > 0 && groupBy.every(isNonEmptyText));
	if (!validGroupBy || !isNonEmptyText(value.compute.name) || !isValidDashboardAggregate(value.compute.agg)) return false;
	if (aggregateRequiresColumn(value.compute.agg) && !isNonEmptyText(value.compute.column)) return false;
	if (value.compute.column !== undefined && typeof value.compute.column !== 'string') return false;
	return true;
}

export function isValidPortableScalarDisplay(display: unknown): display is PortableDashboardScalarDisplay {
	if (!isObjectRecord(display) || display.type !== 'scalar') return false;
	if (display.agg !== undefined && !isValidDashboardAggregate(display.agg)) return false;
	if (aggregateRequiresColumn(display.agg) && !isNonEmptyText(display.column)) return false;
	if (display.column !== undefined && typeof display.column !== 'string') return false;
	if (display.format !== undefined && typeof display.format !== 'string') return false;
	return true;
}

export function isValidPortablePivotDisplay(display: unknown): display is PortableDashboardPivotDisplay {
	if (!isObjectRecord(display) || display.type !== 'pivot') return false;
	if (!Array.isArray(display.rows) || display.rows.length === 0 || !display.rows.every(isNonEmptyText)) return false;
	if (!isNonEmptyText(display.pivotBy)) return false;
	if (!Array.isArray(display.pivotValues) || display.pivotValues.length === 0 || !display.pivotValues.every(value => typeof value === 'string')) return false;
	if (!isValidDashboardAggregate(display.agg)) return false;
	if (aggregateRequiresColumn(display.agg) && !isNonEmptyText(display.value)) return false;
	if (display.value !== undefined && typeof display.value !== 'string') return false;
	if (display.format !== undefined && typeof display.format !== 'string') return false;
	if (display.total !== undefined && typeof display.total !== 'boolean') return false;
	if (display.preAggregate !== undefined && !isValidPreAggregateSpec(display.preAggregate)) return false;
	return true;
}

function describeInvalidChartValue(value: unknown, label: string): string | undefined {
	if (!isObjectRecord(value)) return `missing ${label}`;
	if (!isNonEmptyText(value.agg)) return `missing ${label} aggregation`;
	if (aggregateRequiresColumn(value.agg) && !isNonEmptyText(value.column)) return `missing ${label} column`;
	if (value.column !== undefined && typeof value.column !== 'string') return `invalid ${label} column`;
	if (value.format !== undefined && typeof value.format !== 'string') return `invalid ${label} format`;
	return undefined;
}

function describeInvalidDashboardChartDisplay(display: unknown): string {
	if (!isObjectRecord(display)) return 'invalid chart spec';
	const type = typeof display.type === 'string' ? display.type : '';
	if (type === 'pie') {
		if (!isNonEmptyText(display.groupBy)) return 'invalid chart spec: missing groupBy';
		const valueReason = describeInvalidChartValue(display.value, 'value');
		return valueReason ? `invalid chart spec: ${valueReason}` : 'invalid chart spec';
	}
	if (type === 'bar') {
		if (!isNonEmptyText(display.groupBy)) return 'invalid chart spec: missing groupBy';
		const hasSegments = display.segments !== undefined;
		const hasThresholdBands = display.thresholdBands !== undefined;
		const hasColorRules = display.colorRules !== undefined;
		if (display.value === undefined && !hasSegments && !hasThresholdBands && !hasColorRules) {
			return 'invalid chart spec: missing value';
		}
		if ((hasThresholdBands || hasColorRules) && display.value === undefined) return 'invalid chart spec: missing value';
		if (display.value !== undefined && !hasSegments) {
			const valueReason = describeInvalidChartValue(display.value, 'value');
			if (valueReason) return `invalid chart spec: ${valueReason}`;
		}
	}
	if (type === 'line') {
		if (!isNonEmptyText(display.xAxis)) return 'invalid chart spec: missing xAxis';
		if (!Array.isArray(display.series) || display.series.length === 0) return 'invalid chart spec: missing series';
	}
	return 'invalid chart spec';
}

function normalizeDisplay(display: unknown): PortableDashboardDisplay | undefined {
	if (!isObjectRecord(display)) return undefined;
	if (display.type === 'scalar' && isValidPortableScalarDisplay(display)) {
		return normalizeDisplayAggregates({ ...display, agg: typeof display.agg === 'string' ? display.agg : 'COUNT' });
	}
	if (display.type === 'table' && isValidTableDisplay(display)) return normalizeDisplayAggregates(display);
	if (display.type === 'repeatedTable' && isValidRepeatedTableDisplay(display)) return normalizeDisplayAggregates(display);
	if (display.type === 'pivot' && isValidPortablePivotDisplay(display)) return normalizeDisplayAggregates(display);
	if (isValidDashboardChartDisplay(display)) return normalizeDisplayAggregates(display);
	return undefined;
}

function normalizeDisplayAggregates<T extends PortableDashboardDisplay>(display: T): T {
	const normalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(normalize);
		if (!isObjectRecord(value)) return value;
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
			key,
			key === 'agg' && typeof nested === 'string' ? normalizeDashboardAggregate(nested) : normalize(nested),
		]));
	};
	return normalize(display) as T;
}

function diagnostic(
	code: PortableDashboardDiagnosticCode,
	message: string,
	details: Partial<Pick<PortableDashboardDiagnostic, 'bindingKey' | 'role' | 'columnName' | 'displayType'>> = {},
): PortableDashboardDiagnostic {
	return { code, severity: 'error', message, ...details };
}

function uniqueDiagnostics(diagnostics: PortableDashboardDiagnostic[]): PortableDashboardDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter(item => {
		const key = `${item.code}\u0000${item.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function preAggregateOutputColumns(preAggregate: PreAggregate): Set<string> {
	const groupBy = Array.isArray(preAggregate.groupBy) ? preAggregate.groupBy : [preAggregate.groupBy];
	return new Set([...groupBy, preAggregate.compute.name]);
}

function tableValueColumnTypes(groupBy: string[], columns: TableColumnSpec[], sourceTypes: Map<string, string>): Map<string, string> {
	const types = new Map<string, string>();
	for (const columnName of groupBy) types.set(columnName, sourceTypes.get(columnName) ?? '');
	for (const column of columns) {
		if (isTableCellBarColumn(column)) continue;
		types.set(column.name, column.agg ? 'real' : (sourceTypes.get(column.name) ?? ''));
	}
	return types;
}

function columnKey(name: string): string {
	return name.trim().toLowerCase();
}

function isNumericKustoType(type: string): boolean {
	const normalized = (type || '').toLowerCase();
	return normalized === 'long' || normalized === 'int' || normalized === 'real'
		|| normalized === 'double' || normalized === 'decimal';
}

function validateSourceColumns(
	provenance: KwProvenance,
	targets: Map<string, DataKwBindTargetElement[]>,
	dataSources: readonly PortableDashboardDataSource[],
): PortableDashboardDiagnostic[] {
	const factDataSource = dataSources.find(dataSource => dataSource.sectionId === provenance.model.fact.sectionId);
	if (!factDataSource) return [];
	const factColumns = new Set(factDataSource.columns.map(column => column.name));
	const factColumnTypes = new Map(factDataSource.columns.map(column => [column.name, column.type]));
	const diagnostics: PortableDashboardDiagnostic[] = [];

	const addMissing = (bindingKey: string, columnName: unknown, role: string, allowedColumns: Set<string>) => {
		if (!isNonEmptyText(columnName) || allowedColumns.has(columnName)) return;
		diagnostics.push(diagnostic(
			'missing-column',
			`${bindingKey} (${role}: missing column ${columnName})`,
			{ bindingKey, role, columnName },
		));
	};
	const requireFactColumn = (bindingKey: string, columnName: unknown, role: string) => {
		addMissing(bindingKey, columnName, role, factColumns);
	};
	const requireNumericCellFormatColumn = (bindingKey: string, column: TableColumnSpec, role: string, rowColumnTypes: Map<string, string>) => {
		if (!isTableCellFormattedColumn(column)) return;
		const columnName = column.cellFormat.valueColumn ?? column.name;
		const columnType = rowColumnTypes.get(columnName);
		if (columnType === undefined) {
			diagnostics.push(diagnostic(
				'missing-column',
				`${bindingKey} (${role}: missing column ${columnName})`,
				{ bindingKey, role, columnName },
			));
		} else if (!isNumericKustoType(columnType)) {
			diagnostics.push(diagnostic(
				'non-numeric-column',
				`${bindingKey} (${role}: non-numeric column ${columnName})`,
				{ bindingKey, role, columnName },
			));
		}
	};
	const requireTooltipColumns = (
		bindingKey: string,
		tooltip: DashboardTooltipSpec | undefined,
		role: string,
		sourceColumns: Set<string>,
		rowColumns: Set<string>,
	) => {
		if (!tooltip) return;
		for (let fieldIndex = 0; fieldIndex < tooltip.fields.length; fieldIndex++) {
			const field = tooltip.fields[fieldIndex];
			const fieldRole = `${role}.tooltip.fields[${fieldIndex}].column`;
			if (field.agg) {
				if (dashboardTooltipAggregateNeedsColumn(field.agg)) addMissing(bindingKey, field.column, fieldRole, sourceColumns);
			} else {
				addMissing(bindingKey, field.column, fieldRole, rowColumns);
			}
		}
	};
	const preAggregateColumnTypes = (preAggregate: PreAggregate): Map<string, string> => {
		const groupBy = Array.isArray(preAggregate.groupBy) ? preAggregate.groupBy : [preAggregate.groupBy];
		const types = new Map<string, string>();
		for (const columnName of groupBy) types.set(columnName, factColumnTypes.get(columnName) ?? '');
		types.set(preAggregate.compute.name, 'real');
		return types;
	};
	const validatePreAggregate = (bindingKey: string, preAggregate: PreAggregate | undefined): Set<string> | undefined => {
		if (!preAggregate) return undefined;
		const groupBy = Array.isArray(preAggregate.groupBy) ? preAggregate.groupBy : [preAggregate.groupBy];
		for (const columnName of groupBy) requireFactColumn(bindingKey, columnName, 'preAggregate.groupBy');
		const computeNameKey = columnKey(preAggregate.compute.name);
		const groupByCollision = groupBy.find(columnName => columnKey(columnName) === computeNameKey);
		const factCollision = factDataSource.columns.find(column => columnKey(column.name) === computeNameKey);
		if (groupByCollision) {
			diagnostics.push(diagnostic(
				'column-collision',
				`${bindingKey} (preAggregate.compute.name: collides with groupBy column ${groupByCollision})`,
				{ bindingKey, role: 'preAggregate.compute.name', columnName: preAggregate.compute.name },
			));
		} else if (factCollision) {
			diagnostics.push(diagnostic(
				'column-collision',
				`${bindingKey} (preAggregate.compute.name: collides with fact column ${factCollision.name})`,
				{ bindingKey, role: 'preAggregate.compute.name', columnName: preAggregate.compute.name },
			));
		}
		if (aggregateRequiresColumn(preAggregate.compute.agg)) {
			requireFactColumn(bindingKey, preAggregate.compute.column, 'preAggregate.compute.column');
		}
		return preAggregateOutputColumns(preAggregate);
	};

	const dimensions = Array.isArray(provenance.model.dimensions) ? provenance.model.dimensions : [];
	for (let index = 0; index < dimensions.length; index++) {
		const dimension = dimensions[index];
		if (isObjectRecord(dimension) && isNonEmptyText(dimension.column) && !factColumns.has(dimension.column)) {
			diagnostics.push(diagnostic(
				'missing-column',
				`model.dimensions[${index}] (slicer: missing column ${dimension.column})`,
				{ role: `model.dimensions[${index}].column`, columnName: dimension.column },
			));
		}
	}

	for (const [bindingKey, binding] of Object.entries(provenance.bindings)) {
		if (!targets.has(bindingKey)) continue;
		const display = normalizeDisplay(binding.display);
		if (!display) continue;
		if (display.type === 'scalar') {
			if (aggregateRequiresColumn(display.agg)) requireFactColumn(bindingKey, display.column, 'column');
		} else if (display.type === 'table') {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			const outputColumnTypes = display.preAggregate ? preAggregateColumnTypes(display.preAggregate) : factColumnTypes;
			const rowColumnTypes = tableValueColumnTypes(display.groupBy, display.columns, outputColumnTypes);
			const rowColumns = new Set(rowColumnTypes.keys());
			requireTooltipColumns(bindingKey, display.tooltip, 'display', outputColumns, rowColumns);
			for (const columnName of display.groupBy) addMissing(bindingKey, columnName, 'groupBy', outputColumns);
			for (let columnIndex = 0; columnIndex < display.columns.length; columnIndex++) {
				const column = display.columns[columnIndex];
				if (isTableCellBarColumn(column)) {
					for (let segmentIndex = 0; segmentIndex < column.cellBar.segments.length; segmentIndex++) {
						const segment = column.cellBar.segments[segmentIndex];
						if (tableAggregateNeedsColumn(segment.agg)) {
							addMissing(bindingKey, segment.column, `columns[${columnIndex}].cellBar.segments[${segmentIndex}].column`, outputColumns);
						}
					}
					continue;
				}
				const sourceColumn = column.sourceColumn || column.name;
				if (column.agg) {
					if (tableAggregateNeedsColumn(column.agg)) addMissing(bindingKey, sourceColumn, 'column', outputColumns);
				} else {
					addMissing(bindingKey, column.name, 'column', outputColumns);
				}
				requireNumericCellFormatColumn(bindingKey, column, `columns[${columnIndex}].cellFormat.valueColumn`, rowColumnTypes);
			}
			if (display.orderBy) {
				const orderColumns = new Set([...display.groupBy, ...display.columns.filter(column => !isTableCellBarColumn(column)).map(column => column.name)]);
				addMissing(bindingKey, display.orderBy.column, 'orderBy', orderColumns);
			}
		} else if (display.type === 'repeatedTable') {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			const outputColumnTypes = display.preAggregate ? preAggregateColumnTypes(display.preAggregate) : factColumnTypes;
			for (const columnName of display.repeatBy) addMissing(bindingKey, columnName, 'repeatBy', outputColumns);
			const repeatColumns = repeatedTableRepeatColumns(display);
			for (let columnIndex = 0; columnIndex < repeatColumns.length; columnIndex++) {
				const column = repeatColumns[columnIndex];
				if (column.agg) {
					if (tableAggregateNeedsColumn(column.agg)) {
						addMissing(bindingKey, column.sourceColumn || column.name, `repeatColumns[${columnIndex}].column`, outputColumns);
					}
				} else {
					addMissing(bindingKey, column.name, `repeatColumns[${columnIndex}].column`, outputColumns);
				}
			}
			if (display.repeatOrderBy) {
				const orderColumns = new Set([...display.repeatBy, ...repeatColumns.map(column => column.name)]);
				addMissing(bindingKey, display.repeatOrderBy.column, 'repeatOrderBy', orderColumns);
			}
			for (const columnName of display.table.groupBy) addMissing(bindingKey, columnName, 'table.groupBy', outputColumns);
			for (let columnIndex = 0; columnIndex < display.table.columns.length; columnIndex++) {
				const column = display.table.columns[columnIndex];
				if (isTableCellBarColumn(column)) {
					for (let segmentIndex = 0; segmentIndex < column.cellBar.segments.length; segmentIndex++) {
						const segment = column.cellBar.segments[segmentIndex];
						if (tableAggregateNeedsColumn(segment.agg)) {
							addMissing(bindingKey, segment.column, `table.columns[${columnIndex}].cellBar.segments[${segmentIndex}].column`, outputColumns);
						}
					}
					continue;
				}
				const sourceColumn = column.sourceColumn || column.name;
				if (column.agg) {
					if (tableAggregateNeedsColumn(column.agg)) {
						addMissing(bindingKey, sourceColumn, `table.columns[${columnIndex}].column`, outputColumns);
					}
				} else {
					addMissing(bindingKey, column.name, `table.columns[${columnIndex}].column`, outputColumns);
				}
			}
			const innerRowColumnTypes = tableValueColumnTypes(display.table.groupBy, display.table.columns, outputColumnTypes);
			const innerRowColumns = new Set(innerRowColumnTypes.keys());
			requireTooltipColumns(bindingKey, display.table.tooltip, 'table', outputColumns, innerRowColumns);
			if (display.table.orderBy) {
				const orderColumns = new Set([...display.table.groupBy, ...display.table.columns.filter(column => !isTableCellBarColumn(column)).map(column => column.name)]);
				addMissing(bindingKey, display.table.orderBy.column, 'table.orderBy', orderColumns);
			}
			for (let columnIndex = 0; columnIndex < display.table.columns.length; columnIndex++) {
				requireNumericCellFormatColumn(bindingKey, display.table.columns[columnIndex], `table.columns[${columnIndex}].cellFormat.valueColumn`, innerRowColumnTypes);
			}
		} else if (display.type === 'pivot') {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			for (const columnName of display.rows) addMissing(bindingKey, columnName, 'rows', outputColumns);
			addMissing(bindingKey, display.pivotBy, 'pivotBy', outputColumns);
			if (aggregateRequiresColumn(display.agg)) addMissing(bindingKey, display.value, 'value', outputColumns);
		} else {
			const preColumns = validatePreAggregate(bindingKey, display.preAggregate);
			const outputColumns = preColumns ?? factColumns;
			if (display.type === 'bar') {
				requireTooltipColumns(bindingKey, display.tooltip, 'display', outputColumns, new Set([display.groupBy]));
				addMissing(bindingKey, display.groupBy, 'groupBy', outputColumns);
				if (display.segments) {
					for (let segmentIndex = 0; segmentIndex < display.segments.length; segmentIndex++) {
						const segment = display.segments[segmentIndex];
						if (aggregateRequiresColumn(segment.agg)) {
							addMissing(bindingKey, segment.column, `segments[${segmentIndex}].column`, outputColumns);
						}
					}
				} else if (display.value && aggregateRequiresColumn(display.value.agg)) {
					addMissing(bindingKey, display.value.column, 'value.column', outputColumns);
				}
			} else if (display.type === 'pie') {
				requireTooltipColumns(bindingKey, display.tooltip, 'display', outputColumns, new Set([display.groupBy]));
				addMissing(bindingKey, display.groupBy, 'groupBy', outputColumns);
				if (aggregateRequiresColumn(display.value.agg)) {
					addMissing(bindingKey, display.value.column, 'value.column', outputColumns);
				}
			} else {
				requireTooltipColumns(bindingKey, display.tooltip, 'display', outputColumns, new Set([display.xAxis]));
				addMissing(bindingKey, display.xAxis, 'xAxis', outputColumns);
				for (const series of display.series) {
					if (aggregateRequiresColumn(series.agg)) addMissing(bindingKey, series.column, 'series.column', outputColumns);
				}
			}
		}
	}

	return diagnostics;
}

function displayDiagnostics(
	htmlCode: string,
	provenance: KwProvenance,
	targets: Map<string, DataKwBindTargetElement[]>,
): PortableDashboardDiagnostic[] {
	const diagnostics: PortableDashboardDiagnostic[] = [];
	for (const [key, targetElements] of targets) {
		const binding = provenance.bindings[key];
		if (!binding) {
			diagnostics.push(diagnostic('missing-binding', `${key} (missing provenance binding)`, { bindingKey: key }));
			continue;
		}
		if (!binding.display) {
			diagnostics.push(diagnostic('missing-display', `${key} (missing display)`, { bindingKey: key }));
			continue;
		}
		const display = binding.display as { type?: unknown };
		const type = typeof display.type === 'string' ? display.type : '';
		if (!type) {
			diagnostics.push(diagnostic('missing-display-type', `${key} (missing display type)`, { bindingKey: key }));
			continue;
		}
		if (targetElements.length !== 1) {
			diagnostics.push(diagnostic(
				'duplicate-target',
				`${key} (${type}: expected exactly one data-kw-bind target, found ${targetElements.length})`,
				{ bindingKey: key, displayType: type },
			));
			continue;
		}
		const target = targetElements[0];
		const diagnosticCountBeforeTargetChecks = diagnostics.length;
		if (!target.source) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target has no unique authored source range)`,
				{ bindingKey: key, displayType: type },
			));
			continue;
		}
		if (target.hasFormBoundaryToken) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target source contains form boundary tokens)`,
				{ bindingKey: key, displayType: type },
			));
			continue;
		}
		if (target.hasReparentedSourceContent) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target source content is reparented outside target)`,
				{ bindingKey: key, displayType: type },
			));
			continue;
		}
		if (!isRenderedPortableTargetTag(target.tagName)) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target must be rendered container element)`,
				{ bindingKey: key, displayType: type },
			));
			continue;
		}
		if (isHiddenPortableTarget(target)) {
			diagnostics.push(diagnostic(
				'hidden-target',
				`${key} (${type}: target is hidden; bind exportable content to a visible data-kw-bind element)`,
				{ bindingKey: key, displayType: type },
			));
			continue;
		}
		const validTableTarget = target.source.endTagStartOffset !== undefined
			&& (target.tagName === 'table'
				|| (target.tagName === 'tbody' && target.tableSource?.endTagStartOffset !== undefined));
		if ((type === 'table' || type === 'pivot') && !validTableTarget) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target must be table or tbody inside table)`,
				{ bindingKey: key, displayType: type },
			));
		} else if (type === 'repeatedTable' && target.source.endTagStartOffset === undefined) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target must be container element)`,
				{ bindingKey: key, displayType: type },
			));
		} else if (type === 'repeatedTable' && targetElements.some(target => !isVisibleRepeatedTableTarget(target))) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target must be a visible non-table container element)`,
				{ bindingKey: key, displayType: type },
			));
		} else if ((type === 'scalar' || type === 'bar' || type === 'pie' || type === 'line') && target.source.endTagStartOffset === undefined) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: target must be container element)`,
				{ bindingKey: key, displayType: type },
			));
		}
		if (diagnostics.length === diagnosticCountBeforeTargetChecks
			&& isSupportedPowerBiDisplayType(type)
			&& !generatedContentRemainsInsideTarget(htmlCode, key, type, target)) {
			diagnostics.push(diagnostic(
				'invalid-target',
				`${key} (${type}: generated output does not remain inside target)`,
				{ bindingKey: key, displayType: type },
			));
		}
	}

	for (const [key, binding] of Object.entries(provenance.bindings)) {
		if (!targets.has(key)) continue;
		const display = binding.display as { type?: unknown; top?: unknown; repeatTop?: unknown; orderBy?: unknown; repeatOrderBy?: unknown } | undefined;
		const type = typeof display?.type === 'string' ? display.type : '';
		if (type && !isSupportedPowerBiDisplayType(type)) {
			diagnostics.push(diagnostic('unsupported-display', `${key} (${type})`, { bindingKey: key, displayType: type }));
		} else if (type === 'scalar' && !isValidPortableScalarDisplay(display)) {
			diagnostics.push(diagnostic('invalid-display', `${key} (${type}: invalid spec)`, { bindingKey: key, displayType: type }));
		} else if (type === 'table' && display?.top !== undefined
			&& (typeof display.top !== 'number' || !Number.isInteger(display.top) || display.top <= 0 || !isObjectRecord(display.orderBy))) {
			diagnostics.push(diagnostic('invalid-display', `${key} (${type}: invalid top)`, { bindingKey: key, displayType: type }));
		} else if (type === 'table' && !isValidTableDisplay(display)) {
			diagnostics.push(diagnostic('invalid-display', `${key} (${type}: invalid spec)`, { bindingKey: key, displayType: type }));
		} else if (type === 'repeatedTable' && display?.repeatTop !== undefined
			&& (typeof display.repeatTop !== 'number' || !Number.isInteger(display.repeatTop) || display.repeatTop <= 0 || !isObjectRecord(display.repeatOrderBy))) {
			diagnostics.push(diagnostic('invalid-display', `${key} (${type}: invalid repeatTop)`, { bindingKey: key, displayType: type }));
		} else if (type === 'repeatedTable' && !isValidRepeatedTableDisplay(display)) {
			diagnostics.push(diagnostic('invalid-display', `${key} (${type}: invalid spec)`, { bindingKey: key, displayType: type }));
		} else if (type === 'pivot' && !isValidPortablePivotDisplay(display)) {
			diagnostics.push(diagnostic('invalid-display', `${key} (${type}: invalid spec)`, { bindingKey: key, displayType: type }));
		} else if ((type === 'bar' || type === 'pie' || type === 'line') && !isValidDashboardChartDisplay(display)) {
			diagnostics.push(diagnostic(
				'invalid-display',
				`${key} (${type}: ${describeInvalidDashboardChartDisplay(display)})`,
				{ bindingKey: key, displayType: type },
			));
		}
	}
	return diagnostics;
}

export function compilePortableDashboard(input: CompilePortableDashboardInput): PortableDashboardCompilation {
	const htmlAnalysis = analyzePortableDashboardHtml(input.htmlCode);
	const parsed = parseKwProvenanceResult(input.htmlCode, htmlAnalysis);
	const provenance = parsed.provenance;
	if (!provenance) {
		return {
			provenance: null,
			ir: null,
			diagnostics: [parsed.invalidMessage
				? diagnostic('invalid-provenance', parsed.invalidMessage)
				: diagnostic(
					'missing-provenance',
					'Missing application/kw-provenance block. Ask Kusto Workbench to make this dashboard exportable to Power BI.',
				)],
		};
	}

	const targets = htmlAnalysis.targets;
	const diagnostics: PortableDashboardDiagnostic[] = [];
	const rawDataSources: readonly unknown[] = Array.isArray(input.dataSources) ? input.dataSources : [];
	const dataSources: PortableDashboardDataSource[] = [];
	if (input.dataSources !== undefined && !Array.isArray(input.dataSources)) {
		diagnostics.push(diagnostic('invalid-source-schema', 'dataSources (invalid source schema)'));
	}
	for (let index = 0; index < rawDataSources.length; index++) {
		const dataSource = rawDataSources[index];
		if (isPortableDashboardDataSource(dataSource)) {
			dataSources.push(dataSource);
		} else {
			diagnostics.push(diagnostic('invalid-source-schema', `dataSources[${index}] (invalid source schema)`));
		}
	}
	if (input.dataSources !== undefined
		&& !diagnostics.some(item => item.code === 'invalid-source-schema')
		&& !dataSources.some(dataSource => dataSource.sectionId === provenance.model.fact.sectionId)) {
		diagnostics.push(diagnostic(
			'missing-data-source',
			`model.fact (missing data source ${provenance.model.fact.sectionId})`,
			{ role: 'model.fact.sectionId' },
		));
	}
	if (provenance.version !== 1) {
		const message = provenance.version < 1
			? `Dashboard provenance version ${provenance.version} is older than the current Power BI export contract version 1.`
			: `Dashboard provenance version ${provenance.version} is not supported by the portable dashboard contract version 1.`;
		diagnostics.push(diagnostic('unsupported-version', message));
	}
	const bindingKeys = Object.keys(provenance.bindings);
	if (bindingKeys.some(bindingKey => bindingKey.trim().length === 0)) {
		diagnostics.push(diagnostic(
			'invalid-binding-key',
			'Dashboard provenance binding keys must be non-empty strings.',
		));
	}
	for (const bindingKey of bindingKeys) {
		if (!targets.has(bindingKey)) {
			diagnostics.push(diagnostic(
				'missing-target',
				`${bindingKey} (missing data-kw-bind target)`,
				{ bindingKey },
			));
		}
	}
	diagnostics.push(...overlappingTargetDiagnostics(provenance, targets, htmlAnalysis.provenanceSource!));
	if (provenance.model.dimensions !== undefined && !Array.isArray(provenance.model.dimensions)) {
		diagnostics.push(diagnostic('invalid-dimension', 'model.dimensions (invalid dimensions spec)'));
	} else if (Array.isArray(provenance.model.dimensions)) {
		for (let index = 0; index < provenance.model.dimensions.length; index++) {
			const dimension = provenance.model.dimensions[index];
			if (!isObjectRecord(dimension)
				|| !isNonEmptyText(dimension.column)
				|| (dimension.label !== undefined && typeof dimension.label !== 'string')
				|| (dimension.mode !== undefined && dimension.mode !== 'dropdown' && dimension.mode !== 'list' && dimension.mode !== 'between')) {
				diagnostics.push(diagnostic(
					'invalid-dimension',
					`model.dimensions[${index}] (invalid slicer spec)`,
					{ role: `model.dimensions[${index}]` },
				));
			}
		}
	}
	diagnostics.push(...displayDiagnostics(input.htmlCode, provenance, targets));
	if (input.dataSources !== undefined) diagnostics.push(...validateSourceColumns(provenance, targets, dataSources));
	const unique = uniqueDiagnostics(diagnostics);
	const fatalDiagnosticCodes = new Set<PortableDashboardDiagnosticCode>([
		'invalid-provenance', 'unsupported-version', 'invalid-dimension', 'invalid-source-schema', 'missing-data-source',
		'invalid-binding-key',
	]);
	const hasFatalDiagnostic = unique.some(item => fatalDiagnosticCodes.has(item.code));
	const rejectedBindings = new Set(unique.flatMap(item => item.bindingKey ? [item.bindingKey] : []));
	const factDataSource = dataSources.find(dataSource => dataSource.sectionId === provenance.model.fact.sectionId);
	const factColumns = factDataSource ? new Set(factDataSource.columns.map(column => column.name)) : undefined;
	const dimensions = Array.isArray(provenance.model.dimensions)
		? provenance.model.dimensions.filter(dimension =>
			isObjectRecord(dimension)
			&& isNonEmptyText(dimension.column)
			&& (!factColumns || factColumns.has(dimension.column)),
		).map(dimension => ({
			column: dimension.column,
			...(typeof dimension.label === 'string' ? { label: dimension.label } : {}),
			...(dimension.mode === 'dropdown' || dimension.mode === 'list' || dimension.mode === 'between' ? { mode: dimension.mode } : {}),
		}))
		: [];
	const bindings: PortableDashboardBindingIr[] = [];
	for (const [key, binding] of Object.entries(provenance.bindings)) {
		const display = normalizeDisplay(binding.display);
		if (!display) continue;
		const bindingTargets = (targets.get(key) ?? []).map(target => ({
			tagName: target.tagName,
			hidden: isHiddenPortableTarget(target),
			...(target.source ? { source: { ...target.source } } : {}),
			...(target.tableSource ? { tableSource: { ...target.tableSource } } : {}),
		})).filter((target): target is PortableDashboardTarget => target.source !== undefined);
		bindings.push({
			key,
			display,
			targets: bindingTargets,
			admitted: bindingTargets.length > 0 && !rejectedBindings.has(key),
		});
	}

	return {
		provenance,
		ir: provenance.version === 1 && !hasFatalDiagnostic ? {
			version: 1,
			sourceVersion: provenance.version,
			provenanceSource: { ...htmlAnalysis.provenanceSource! },
			fact: {
				sectionId: provenance.model.fact.sectionId,
				sectionName: isNonEmptyText(provenance.model.fact.sectionName)
					? provenance.model.fact.sectionName
					: provenance.model.fact.sectionId,
			},
			dimensions,
			bindings,
		} : null,
		diagnostics: unique,
	};
}

export function portableDashboardIrToProvenance(ir: PortableDashboardIr): KwProvenance {
	return {
		version: ir.version,
		model: {
			fact: { ...ir.fact },
			...(ir.dimensions.length > 0 ? { dimensions: ir.dimensions.map(dimension => ({ ...dimension })) } : {}),
		},
		bindings: Object.fromEntries(
			ir.bindings.filter(binding => binding.admitted).map(binding => [binding.key, { display: binding.display }]),
		),
	};
}

export class PortableDashboardAdmissionError extends Error {
	readonly diagnostics: readonly PortableDashboardDiagnostic[];

	constructor(message: string, diagnostics: readonly PortableDashboardDiagnostic[]) {
		super(message);
		this.name = 'PortableDashboardAdmissionError';
		this.diagnostics = diagnostics.map(diagnostic => ({ ...diagnostic }));
	}
}