/**
 * Message Protocol Contract Tests
 *
 * Verifies that the host ↔ webview postMessage protocol stays in sync.
 * This catches protocol drift at test time — when one side adds/removes a
 * message type but the other side isn't updated.
 *
 * NOT behavioral tests — those live in message-handler.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { OutgoingWebviewMessage } from '../../../src/webview/shared/webview-messages';

// ─── Type-level helpers ──────────────────────────────────────────────────────
// These force a compile error if the union discriminants change.

type ExtractType<T> = T extends { type: infer U } ? U : never;

type IncomingType = ExtractType<IncomingWebviewMessage>;
type OutgoingType = ExtractType<OutgoingWebviewMessage>;
type IncomingPublishToPowerBIMessage = Extract<IncomingWebviewMessage, { type: 'publishToPowerBI' }>;
type OutgoingPublishToPowerBIMessage = Extract<OutgoingWebviewMessage, { type: 'publishToPowerBI' }>;

// Compile-time check: if a type literal is not a valid discriminant, tsc errors.
function assertIncomingType(_t: IncomingType): void { /* type-only */ }
function assertOutgoingType(_t: OutgoingType): void { /* type-only */ }

function readWorkspaceFile(relativePath: string): string {
	return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function extractTypeDiscriminants(relativePath: string, typeName: string): string[] {
	const source = readWorkspaceFile(relativePath);
	const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const aliases = new Map<string, ts.TypeNode>();
	sourceFile.forEachChild(node => {
		if (ts.isTypeAliasDeclaration(node)) {
			aliases.set(node.name.text, node.type);
		}
	});
	const root = aliases.get(typeName);
	if (!root) {
		throw new Error(`Type alias ${typeName} not found in ${relativePath}`);
	}
	return [...new Set(collectDiscriminants(root, aliases))].sort();
}

function collectDiscriminants(typeNode: ts.TypeNode, aliases: Map<string, ts.TypeNode>, seen = new Set<string>()): string[] {
	if (ts.isParenthesizedTypeNode(typeNode)) {
		return collectDiscriminants(typeNode.type, aliases, seen);
	}
	if (ts.isUnionTypeNode(typeNode)) {
		return typeNode.types.flatMap(t => collectDiscriminants(t, aliases, seen));
	}
	if (ts.isIntersectionTypeNode(typeNode)) {
		return typeNode.types.flatMap(t => collectDiscriminants(t, aliases, seen));
	}
	if (ts.isTypeLiteralNode(typeNode)) {
		return typeNode.members.flatMap(member => {
			if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name) || member.name.text !== 'type') {
				return [];
			}
			if (ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) {
				return [member.type.literal.text];
			}
			return [];
		});
	}
	if (ts.isTypeReferenceNode(typeNode)) {
		const aliasName = typeNode.typeName.getText();
		if ((aliasName === 'Readonly' || aliasName === 'Omit' || aliasName === 'Pick')
			&& typeNode.typeArguments?.[0]) {
			return collectDiscriminants(typeNode.typeArguments[0], aliases, seen);
		}
		if (seen.has(aliasName)) {
			return [];
		}
		const alias = aliases.get(aliasName);
		if (!alias) {
			return [];
		}
		const nextSeen = new Set(seen);
		nextSeen.add(aliasName);
		return collectDiscriminants(alias, aliases, nextSeen);
	}
	return [];
}

function extractMessageHandlerCaseLabels(): string[] {
	const source = readWorkspaceFile('src/webview/core/message-handler.ts');
	const labels = [...source.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(match => match[1]);
	return [...new Set(labels)].sort();
}

function extractSqlSectionRouterCaseLabels(): string[] {
	const source = readWorkspaceFile('src/webview/core/sql-section-message-router.ts');
	const labels = [...source.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(match => match[1]);
	return [...new Set(labels)].sort();
}

type HostMessageSenderExtraction = Readonly<{
	types: readonly string[];
	dynamicSites: readonly string[];
}>;

const HOST_MESSAGE_ARGUMENT_BY_METHOD = new Map<string, number>([
	['postMessage', 0],
	['postToAllWebviews', 0],
	['postMessageContained', 0],
	['postMessageRequired', 0],
	['postMessageRequiredContained', 0],
	['deliverMessage', 0],
	['postSqlOwnerMessageAllowed', 2],
	['postSqlOwnerMessageProtection', 3],
	['postSqlConnectionMessageAllowed', 2],
	['postSqlConnectionMessageProtection', 2],
	['postConnectMessageWithRetry', 2],
	['postProtectedMessageWithRetry', 2],
]);
const HOST_MESSAGE_ARGUMENT_BY_LOCAL_FUNCTION = new Map<string, number>([
	['postWebviewMessage', 0],
	['deliverWebviewMessage', 0],
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isSatisfiesExpression(current)
		|| ts.isNonNullExpression(current)) {
		current = current.expression;
	}
	return current;
}

function getObjectLiteralMessageType(expression: ts.Expression): string | undefined {
	const candidate = unwrapExpression(expression);
	if (!ts.isObjectLiteralExpression(candidate)) return undefined;
	for (const property of candidate.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
			? property.name.text
			: undefined;
		if (name !== 'type') continue;
		const value = unwrapExpression(property.initializer);
		if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
	}
	return undefined;
}

function getNestedMessageType(object: ts.ObjectLiteralExpression): string | undefined {
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
			? property.name.text
			: undefined;
		if (name !== 'message') continue;
		return getObjectLiteralMessageType(property.initializer);
	}
	return undefined;
}

function resolveLocalMessageType(
	expression: ts.Expression,
	call: ts.CallExpression,
	sourceFile: ts.SourceFile,
): string | undefined {
	const direct = getObjectLiteralMessageType(expression);
	if (direct) return direct;
	const candidate = unwrapExpression(expression);
	if (!ts.isIdentifier(candidate)) return undefined;
	let scope: ts.Node = call;
	while (scope.parent
		&& !ts.isFunctionLike(scope)
		&& !ts.isSourceFile(scope)) {
		scope = scope.parent;
	}
	let nearestExpression: ts.Expression | undefined;
	let nearestPosition = -1;
	const consider = (name: ts.Identifier, expression: ts.Expression, position: number): void => {
		if (name.text !== candidate.text || position >= call.getStart(sourceFile) || position <= nearestPosition) return;
		nearestExpression = expression;
		nearestPosition = position;
	};
	const visit = (node: ts.Node): void => {
		if (node !== scope && ts.isFunctionLike(node)) return;
		if (node.getStart(sourceFile) >= call.getStart(sourceFile)) return;
		if (ts.isVariableDeclaration(node)
			&& ts.isIdentifier(node.name)
			&& node.name.text === candidate.text
			&& node.initializer) {
			consider(node.name, node.initializer, node.getStart(sourceFile));
		}
		if (ts.isBinaryExpression(node)
			&& node.operatorToken.kind === ts.SyntaxKind.EqualsToken
			&& ts.isIdentifier(node.left)) {
			consider(node.left, node.right, node.getStart(sourceFile));
		}
		node.forEachChild(visit);
	};
	scope.forEachChild(visit);
	return nearestExpression ? getObjectLiteralMessageType(nearestExpression) : undefined;
}

function getContainingFunctionName(node: ts.Node): string {
	for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
		if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) {
			return current.name.getText();
		}
		if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
			&& ts.isVariableDeclaration(current.parent)
			&& ts.isIdentifier(current.parent.name)) {
			return current.parent.name.text;
		}
	}
	return '<module>';
}

function getCallSite(node: ts.Node, sourceFile: ts.SourceFile): string {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return `${position.line + 1}:${position.character + 1}`;
}

function extractPostMessageTypes(relativePath: string): HostMessageSenderExtraction {
	const source = readWorkspaceFile(relativePath);
	const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const types = new Set<string>();
	const dynamicSites = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isObjectLiteralExpression(node)) {
			const nestedMessageType = getNestedMessageType(node);
			if (nestedMessageType) types.add(nestedMessageType);
		}
		if (ts.isCallExpression(node)) {
			let method = '';
			let argumentIndex: number | undefined;
			if (ts.isPropertyAccessExpression(node.expression)) {
				method = node.expression.name.text;
				const receiver = node.expression.expression.getText(sourceFile);
				if (node.expression.expression.kind === ts.SyntaxKind.ThisKeyword || receiver === 'this.options') {
					argumentIndex = HOST_MESSAGE_ARGUMENT_BY_METHOD.get(method);
				} else if (method === 'postToAllWebviews') {
					argumentIndex = HOST_MESSAGE_ARGUMENT_BY_METHOD.get(method);
				} else if (method === 'postMessage' && /webview/i.test(node.expression.expression.getText(sourceFile))) {
					argumentIndex = 0;
				}
			} else if (ts.isIdentifier(node.expression)) {
				method = node.expression.text;
				argumentIndex = HOST_MESSAGE_ARGUMENT_BY_LOCAL_FUNCTION.get(method);
			}
			if (argumentIndex !== undefined) {
				const argument = node.arguments[argumentIndex];
				const type = argument && resolveLocalMessageType(argument, node, sourceFile);
				if (type) {
					types.add(type);
				} else {
					dynamicSites.add(
						`${relativePath}::${getContainingFunctionName(node)}::${method}::${getCallSite(node, sourceFile)}`,
					);
				}
			}
		}
		node.forEachChild(visit);
	};
	sourceFile.forEachChild(visit);
	return {
		types: [...types].sort(),
		dynamicSites: [...dynamicSites].sort(),
	};
}

function extractMainWebviewHostMessages(): HostMessageSenderExtraction {
	const extractions = [
		extractPostMessageTypes('src/host/queryEditorProvider.ts'),
		extractPostMessageTypes('src/host/artifactCsvSaveApplicationHandler.ts'),
		extractPostMessageTypes('src/host/dashboardApplicationHandler.ts'),
		extractPostMessageTypes('src/host/pythonExecutionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/querySharingApplicationHandler.ts'),
		extractPostMessageTypes('src/host/urlContentApplicationHandler.ts'),
		extractPostMessageTypes('src/host/controlCommandSyntaxApplicationHandler.ts'),
		extractPostMessageTypes('src/host/resourceUriApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotContentOpenApplicationHandler.ts'),
		extractPostMessageTypes('src/host/informationNotificationApplicationHandler.ts'),
		extractPostMessageTypes('src/host/cachedValuesOpenApplicationHandler.ts'),
		extractPostMessageTypes('src/host/editorCursorStatusApplicationHandler.ts'),
		extractPostMessageTypes('src/host/editingPreferencesApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoConnectionIntakeApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoConnectionOnboardingApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlConnectionOnboardingApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlFavoritesApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoFavoritesApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlDatabaseDiscoveryApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kqlLanguageRequestApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlLastSelectionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/developmentNoteMutationApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotInlineCompletionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotAvailabilityApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotWriteQueryPreparationApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotConversationClearApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotHistoryRemovalApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotChatFirstTimeApplicationHandler.ts'),
		extractPostMessageTypes('src/host/workbenchToolSessionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoConnectionBrowsingApplicationHandler.ts'),
		extractPostMessageTypes('src/host/copilotQueryWorkflowApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoSectionExecutionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/comparisonPreparationApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlSectionExecutionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoExecutionCoordinator.ts'),
		extractPostMessageTypes('src/host/sql/sqlEditorLifecycleCoordinator.ts'),
		extractPostMessageTypes('src/host/kqlxEditorProvider.ts'),
		extractPostMessageTypes('src/host/kqlCompatEditorProvider.ts'),
		extractPostMessageTypes('src/host/mdCompatEditorProvider.ts'),
		extractPostMessageTypes('src/host/sqlCompatEditorProvider.ts'),
	];
	return {
		types: [...new Set(extractions.flatMap(extraction => extraction.types))].sort(),
		dynamicSites: [...new Set(extractions.flatMap(extraction => extraction.dynamicSites))].sort(),
	};
}

const REVIEWED_DYNAMIC_HOST_MESSAGE_SITES = [
	'src/host/artifactCsvSaveApplicationHandler.ts::postMessage::postMessage::49:10',
	'src/host/comparisonPreparationApplicationHandler.ts::waitForSqlComparisonAdmission::postMessage::627:25',
	'src/host/controlCommandSyntaxApplicationHandler.ts::postMessage::postMessage::50:3',
	'src/host/dashboardApplicationHandler.ts::postMessage::postMessage::102:10',
	'src/host/editingPreferencesApplicationHandler.ts::updatePreference::postMessage::68:10',
	'src/host/editingPreferencesApplicationHandler.ts::updatePreference::postToAllWebviews::66:10',
	'src/host/editorCursorStatusApplicationHandler.ts::postMessage::postMessage::83:10',
	'src/host/kqlCompatEditorProvider.ts::requestFinalPersist::postMessage::620:57',
	'src/host/kqlLanguageRequestApplicationHandler.ts::postMessage::postMessage::42:3',
	'src/host/kqlxEditorProvider.ts::deliverWebviewMessage::postMessage::1233:34',
	'src/host/kqlxEditorProvider.ts::postWebviewMessage::postMessage::1222:10',
	'src/host/kqlxEditorProvider.ts::resolveCustomTextEditor::postMessage::3608:19',
	'src/host/kustoConnectionOnboardingApplicationHandler.ts::testConnectionFromWebview::postMessage::189:4',
	'src/host/kustoExecutionCoordinator.ts::deliver::postMessage::453:33',
	'src/host/pythonExecutionApplicationHandler.ts::postMessage::postMessage::89:10',
	'src/host/queryEditorProvider.ts::<module>::postMessage::361:27',
	'src/host/queryEditorProvider.ts::<module>::postMessage::482:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::488:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::492:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::497:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::500:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::503:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::506:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::521:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::527:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::532:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::549:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::557:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::563:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::572:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::583:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::604:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::611:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::620:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::628:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::651:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::656:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::682:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::690:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::714:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::729:29',
	'src/host/queryEditorProvider.ts::postMessage::postMessage::1235:21',
	'src/host/querySharingApplicationHandler.ts::postMessage::postMessage::32:10',
	'src/host/resourceUriApplicationHandler.ts::postMessage::postMessage::50:3',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postConnectMessageWithRetry::postMessageRequiredContained::1758:13',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postConnectMessageWithRetry::postMessageRequiredContained::1762:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postMessageContained::postMessageRequiredContained::2030:8',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postMessageRequiredContained::postMessageRequired::2040:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postProtectedMessageWithRetry::postMessageRequiredContained::1695:13',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postProtectedMessageWithRetry::postMessageRequiredContained::1699:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::publishOwnerChangeWithRetry::postMessageRequiredContained::1772:13',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::publishOwnerChangeWithRetry::postMessageRequiredContained::1783:27',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::replayOwnerChange::postMessageRequiredContained::1812:14',
	'src/host/sqlCompatEditorProvider.ts::requestFinalPersist::postMessage::488:57',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::deliverMessage::postMessage::143:31',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::deliverTerminalMessage::postMessage::161:31',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::postSqlConnectionMessageAllowed::postMessage::215:31',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::postSqlConnectionMessageProtection::postMessage::284:31',
	'src/host/sqlSectionExecutionApplicationHandler.ts::postSqlOwnerMessageAllowed::postMessage::250:21',
	'src/host/sqlSectionExecutionApplicationHandler.ts::postSqlOwnerMessageProtection::postMessage::266:22',
	'src/host/urlContentApplicationHandler.ts::postMessage::postMessage::79:3',
	'src/host/workbenchToolSessionApplicationHandler.ts::activate::postMessage::88:15',
] as const;

function extractDataTypeComparisons(relativePath: string): string[] {
	const source = readWorkspaceFile(relativePath);
	const labels = [...source.matchAll(/\.data\.type\s*={2,3}\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
	return [...new Set(labels)].sort();
}

function extractMessageTypeComparisons(relativePath: string): string[] {
	const source = readWorkspaceFile(relativePath);
	const labels = [...source.matchAll(/\bmessage\.type\s*={2,3}\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
	return [...new Set(labels)].sort();
}

// ─── Manually maintained type inventories ────────────────────────────────────
// When you add a new message type, add it here too.
// The tests below verify these arrays stay in sync with each other AND catch
// compile errors when discriminants vanish from the union types.

/**
 * Every `type` discriminant in the host's IncomingWebviewMessage union
 * (queryEditorTypes.ts). These are messages the webview sends to the host's
 * main query editor provider.
 */
const INCOMING_WEBVIEW_MESSAGE_TYPES = [
	'fileOpenTrace',
	'getConnections',
	'kustoPublicationAck',
	'kustoSectionOpen',
	'kustoSectionTarget',
	'kustoSectionClose',
	'kustoExecutionStartedAck',
	'editorCursorPositionChanged',
	'getEditorCursorStatusSnapshot',
	'getDatabases',
	'refreshDatabases',
	'saveLastSelection',
	'seeCachedValues',
	'resolveResourceUri',
	'requestAddFavorite',
	'removeFavorite',
	'confirmRemoveFavorite',
	'promptImportConnectionsXml',
	'addConnectionsForClusters',
	'showInfo',
	'showPowerBiPublishHelp',
	'showPowerBiPartialPublishWarning',
	'showPowerBiUnsupportedVisualHelp',
	'saveImportedCsv',
	'requestArtifactCsvSave',
	'artifactCsvSaveData',
	'cancelArtifactCsvSaveIntent',
	'cancelDashboardWorkflow',
	'publishToPowerBIAck',
	'setCaretDocsEnabled',
	'setAutoTriggerAutocompleteEnabled',
	'setCopilotInlineCompletionsEnabled',
	'requestCopilotInlineCompletion',
	'executePython',
	'fetchUrl',
	'cancelQuery',
	'checkCopilotAvailability',
	'prepareCopilotWriteQuery',
	'startCopilotWriteQuery',
	'cancelCopilotWriteQuery',
	'clearCopilotConversation',
	'removeFromCopilotHistory',
	'prepareOptimizeQuery',
	'cancelOptimizeQuery',
	'optimizeQuery',
	'executeQuery',
	'getSqlConnections',
	'sqlSectionOpen',
	'getSqlDatabases',
	'refreshSqlDatabases',
	'retireSqlTarget',
	'saveSqlLastSelection',
	'promptAddSqlConnection',
	'addSqlConnection',
	'testSetSqlAuthOverride',
	'testClearSqlAuthOverride',
	'executeSqlQuery',
	'cancelSqlQuery',
	'prefetchSqlSchema',
	'requestAddSqlFavorite',
	'removeSqlFavorite',
	'copyAdeLink',
	'shareToClipboard',
	'prefetchSchema',
	'requestCrossClusterSchema',
	'promptAddConnection',
	'addConnection',
	'testKustoConnection',
	'importConnectionsFromXml',
	'stsRequest',
	'stsDidOpen',
	'stsDidChange',
	'stsDidClose',
	'stsConnect',
	'kqlLanguageRequest',
	'fetchControlCommandSyntax',
	'openToolResultInEditor',
	'openMarkdownPreview',
	'comparisonBoxEnsured',
	'sqlComparisonAdmissionAck',
	'sqlComparisonRemoved',
	'toolResponse',
	'toolExecutionStarted',
	'toolStateResponse',
	'openCopilotAgent',
	'copilotChatFirstTimeCheck',
	'requestHtmlDashboardUpgradeWithCopilot',
	'showSectionDiff',
	'exportDashboard',
	'getPbiWorkspaces',
	'checkPbiItemExists',
	'publishToPowerBI',
] as const satisfies readonly IncomingType[];

/**
 * Every `type` discriminant in the webview's OutgoingWebviewMessage union
 * (webview-messages.ts). These are messages the webview can send out.
 */
const OUTGOING_WEBVIEW_MESSAGE_TYPES = [
	'fileOpenTrace',
	// Connection & database
	'getConnections',
	'kustoPublicationAck',
	'kustoSectionOpen',
	'kustoSectionTarget',
	'kustoSectionClose',
	'kustoExecutionStartedAck',
	'editorCursorPositionChanged',
	'getEditorCursorStatusSnapshot',
	'getDatabases',
	'refreshDatabases',
	'saveLastSelection',
	'promptAddConnection',
	'addConnection',
	'testKustoConnection',
	'promptImportConnectionsXml',
	'addConnectionsForClusters',
	'importConnectionsFromXml',

	// Favorites
	'requestAddFavorite',
	'removeFavorite',
	'confirmRemoveFavorite',
	'requestAddSqlFavorite',
	'removeSqlFavorite',

	// Info & UI
	'showInfo',
	'showPowerBiPublishHelp',
	'showPowerBiPartialPublishWarning',
	'showPowerBiUnsupportedVisualHelp',
	'seeCachedValues',
	'resolveResourceUri',
	'saveImportedCsv',
	'requestArtifactCsvSave',
	'artifactCsvSaveData',
	'cancelArtifactCsvSaveIntent',
	'cancelDashboardWorkflow',
	'publishToPowerBIAck',
	'exportDashboard',
	'getPbiWorkspaces',
	'checkPbiItemExists',
	'publishToPowerBI',

	// Settings
	'setCaretDocsEnabled',
	'setAutoTriggerAutocompleteEnabled',
	'setCopilotInlineCompletionsEnabled',

	// Query execution
	'executeQuery',
	'cancelQuery',
	'executeSqlQuery',
	'cancelSqlQuery',
	'copyAdeLink',
	'shareToClipboard',

	// SQL connections & schema
	'getSqlConnections',
	'sqlSectionOpen',
	'getSqlDatabases',
	'refreshSqlDatabases',
	'retireSqlTarget',
	'saveSqlLastSelection',
	'promptAddSqlConnection',
	'addSqlConnection',
	'testSetSqlAuthOverride',
	'testClearSqlAuthOverride',
	'prefetchSqlSchema',

	// Comparisons
	'comparisonBoxEnsured',
	'sqlComparisonAdmissionAck',
	'sqlComparisonRemoved',

	// Schema
	'prefetchSchema',
	'requestCrossClusterSchema',
	'stsRequest',
	'stsDidOpen',
	'stsDidChange',
	'stsDidClose',
	'stsConnect',
	'kqlLanguageRequest',
	'fetchControlCommandSyntax',

	// Copilot
	'checkCopilotAvailability',
	'prepareCopilotWriteQuery',
	'startCopilotWriteQuery',
	'cancelCopilotWriteQuery',
	'clearCopilotConversation',
	'removeFromCopilotHistory',
	'requestCopilotInlineCompletion',

	// Optimize
	'prepareOptimizeQuery',
	'cancelOptimizeQuery',
	'optimizeQuery',

	// Python / URL
	'executePython',
	'fetchUrl',

	// Tool responses (agent tools)
	'toolResponse',
	'toolExecutionStarted',
	'toolStateResponse',
	'openToolResultInEditor',
	'openMarkdownPreview',
	'openCopilotAgent',
	'copilotChatFirstTimeCheck',
	'requestHtmlDashboardUpgradeWithCopilot',

	// Section diff
	'showSectionDiff',

	// Provider messages (kqlx, kqlCompat, mdCompat, sqlCompat editors — NOT in IncomingWebviewMessage)
	'requestDocument',
	'persistDocument',
	'documentReloadResult',
	'requestUpgradeToKqlx',
	'requestUpgradeToMdx',
	'requestUpgradeToSqlx',
	'markdownDocumentCommand',
	'markdownDocumentCommandBarrierResult',
] as const satisfies readonly OutgoingType[];

/**
 * OutgoingWebviewMessage types that are handled by editor providers
 * (kqlxEditorProvider, kqlCompatEditorProvider, mdCompatEditorProvider)
 * rather than the main queryEditorProvider. These are NOT in IncomingWebviewMessage.
 */
const PROVIDER_ONLY_OUTGOING_TYPES = new Set([
	'requestDocument',
	'persistDocument',
	'documentReloadResult',
	'requestUpgradeToKqlx',
	'requestUpgradeToMdx',
	'requestUpgradeToSqlx',
	'markdownDocumentCommandBarrierResult',
	'markdownDocumentCommand',
]);

/**
 * Host-supported legacy message types kept for backward compatibility. The
 * current webview uses the shared Copilot messages with `flavor: 'sql'` instead.
 */
const INCOMING_ONLY_WEBVIEW_MESSAGE_TYPES = new Set([
]);

/**
 * Every `case` label in the webview's message-handler.ts switch statement.
 * These are messages the webview expects to RECEIVE from the host.
 */
const MESSAGE_HANDLER_CASE_LABELS = [
	'requestArtifactCsvSaveData',
	'cancelArtifactCsvSave',
	'settingsUpdate',
	'controlCommandSyntaxResult',
	'sqlComparisonAdmission',
	'sqlComparisonAdmissionCommit',
	'sqlComparisonAdmissionRollback',
	'sqlComparisonAdmissionFinalize',
	'sqlComparisonAdmissionComplete',
	'sqlComparisonAdmissionRelease',
	'ensureComparisonBox',
	'persistenceMode',
	'requestFinalPersist',
	'persistDocumentAck',
	'markdownDocumentCommandResult',
	'requestMarkdownCommandBarrier',
	'upgradedToKqlx',
	'enabledKqlxSidecar',
	'enabledSqlSidecar',
	'connectionsData',
	'kustoAuthIdentityChanged',
	'kustoCopilotIdentityChanged',
	'kustoExecutionStarted',
	'editingPreferencesData',
	'updateDevNotes',
	'favoritesData',
	'confirmRemoveFavoriteResult',
	'documentData',
	'revealTextRange',
	'resolveResourceUriResult',
	'kqlLanguageResponse',
	'databasesData',
	'databasesError',
	'importConnectionsXmlText',
	'importConnectionsXmlError',
	'openKustoAddConnectionDialog',
	'kustoConnectionTestStarted',
	'kustoConnectionTestResult',
	'kustoConnectionMutationResult',
	'queryResult',
	'queryError',
	'queryCancelled',
	'ensureResultsVisible',
	'pythonResult',
	'pythonError',
	'urlContent',
	'urlError',
	'schemaData',
	'schemaError',
	'crossClusterSchemaData',
	'crossClusterSchemaError',
	'connectionAdded',
	'sqlConnectionsData',
	'sqlFavoritesData',
	'sqlLeaveNoTraceData',
	'sqlConnectionOwnerChanged',
	'sqlCopilotPolicyChanged',
	'sqlDatabasesData',
	'sqlDatabasesError',
	'sqlDatabasesLoading',
	'sqlConnectionAdded',
	'sqlSchemaData',
	'stsResponse',
	'stsDiagnostics',
	'stsConnectionState',
	'sqlExecutionOwnerState',
	'copilotChatFirstTimeResult',
	'copilotAvailability',
	'optimizeQueryStatus',
	'compareQueryPerformanceWithQuery',
	'optimizeQueryReady',
	'optimizeQueryOptions',
	'optimizeQueryError',
	'copilotWriteQueryOptions',
	'copilotWriteQueryStatus',
	'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting',
	'copilotWriteQueryToolResult',
	'copilotExecutedQuery',
	'copilotGeneralQueryRulesLoaded',
	'copilotUserQuerySnapshot',
	'copilotDevNotesContextLoaded',
	'copilotDevNoteToolCall',
	'copilotClarifyingQuestion',
	'copilotWriteQueryDone',
	'copilotInlineCompletionResult',
	'revealSection',
	'requestToolState',
	'toolAddSection',
	'toolRemoveSection',
	'toolCollapseSection',
	'toolReorderSections',
	'toolConfigureQuerySection',
	'toolCancelKustoExecution',
	'toolCancelKustoCopilot',
	'toolUpdateMarkdownSection',
	'toolConfigureChart',
	'toolConfigureTransformation',
	'toolConfigureHtmlSection',
	'toolGetHtmlDashboardContext',
	'toolConfigureSqlSection',
	'toolCancelSqlExecution',
	'toolCancelSqlCopilot',
	'toolGetSqlSchema',
	'toolDelegateToKustoWorkbenchCopilot',
	'toolDelegateToSqlCopilot',
	'shareContentReady',
	'resetCopilotModelSelection',
	'changedSections',
] as const;

const SQL_SECTION_ROUTER_CASE_LABELS = [
	'sqlConnectionOwnerChanged',
	'sqlDatabasesData',
	'sqlDatabasesError',
	'sqlDatabasesLoading',
	'sqlSchemaData',
	'stsConnectionState',
	'stsDiagnostics',
	'stsResponse',
	'sqlExecutionOwnerState',
] as const;

/**
 * All host→webview message types sent to the MAIN query editor webview.
 * Excludes messages for other webviews (cachedValuesViewer, connectionManagerViewer).
 */
const HOST_TO_WEBVIEW_TYPES = [
	// queryEditorProvider.ts
	'requestArtifactCsvSaveData',
	'cancelArtifactCsvSave',
	'settingsUpdate',
	'requestToolState',
	'queryCancelled',
	'showInfo',
	'shareContentReady',
	'controlCommandSyntaxResult',
	'resolveResourceUriResult',
	'kqlLanguageResponse',
	'pythonResult',
	'pythonError',
	'urlError',
	'urlContent',
	'queryResult',
	'queryError',
	'ensureComparisonBox',
	'sqlComparisonAdmission',
	'sqlComparisonAdmissionCommit',
	'sqlComparisonAdmissionRollback',
	'sqlComparisonAdmissionFinalize',
	'sqlComparisonAdmissionComplete',
	'sqlComparisonAdmissionRelease',
	'kustoAuthIdentityChanged',
	'kustoCopilotIdentityChanged',
	'kustoExecutionStarted',
	'kustoPublicationStage',
	'kustoPublicationCommit',
	'kustoPublicationRevoke',

	// queryEditorCopilot.ts
	'copilotWriteQueryStatus',
	'copilotAvailability',
	'copilotInlineCompletionResult',
	'copilotWriteQueryOptions',
	'copilotWriteQueryDone',
	'copilotChatFirstTimeResult',
	'copilotGeneralQueryRulesLoaded',
	'copilotDevNotesContextLoaded',
	'copilotUserQuerySnapshot',
	'copilotWriteQueryToolResult',
	'copilotExecutedQuery',
	'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting',
	'copilotDevNoteToolCall',
	'copilotClarifyingQuestion',
	'revealSection',
	'ensureResultsVisible',
	'updateDevNotes',
	'optimizeQueryStatus',
	'optimizeQueryOptions',
	'optimizeQueryError',
	'optimizeQueryReady',

	// Query Editor connection application handlers
	'favoritesData',
	'confirmRemoveFavoriteResult',
	'databasesData',
	'databasesError',
	'connectionsData',
	'editingPreferencesData',
	'connectionAdded',
	'openKustoAddConnectionDialog',
	'kustoConnectionTestStarted',
	'kustoConnectionTestResult',
	'kustoConnectionMutationResult',
	'importConnectionsXmlText',
	'importConnectionsXmlError',
	'sqlFavoritesData',

	// SQL connection/schema/queryEditorProvider.ts
	'sqlConnectionsData',
	'sqlLeaveNoTraceData',
	'sqlConnectionOwnerChanged',
	'sqlCopilotPolicyChanged',
	'sqlDatabasesData',
	'sqlDatabasesError',
	'sqlDatabasesLoading',
	'sqlConnectionAdded',
	'sqlSchemaData',
	'stsResponse',
	'stsDiagnostics',
	'stsConnectionState',
	'sqlExecutionOwnerState',

	// queryEditorSchema.ts
	'schemaData',
	'schemaError',
	'crossClusterSchemaData',
	'crossClusterSchemaError',

	// Editor providers (kqlx/kqlCompat/mdCompat) — same webview
	'persistenceMode',
	'requestFinalPersist',
	'persistDocumentAck',
	'markdownDocumentCommandResult',
	'requestMarkdownCommandBarrier',
	'documentData',
	'upgradedToKqlx',
	'enabledKqlxSidecar',
	'enabledSqlSidecar',
	'revealTextRange',
	'changedSections',

	// extension.ts
	'resetCopilotModelSelection',
] as const;

/** Host→webview messages handled directly by a Lit component instead of message-handler.ts. */
const COMPONENT_HANDLED_HOST_TO_WEBVIEW_TYPES = [
	'openPublishPbiDialog',
	'powerBiPublishHelpResult',
	'pbiWorkspacesResult',
	'pbiItemExistsResult',
	'publishToPowerBIResult',
	'powerBiPartialPublishWarningResult',
] as const;

/** Host messages consumed by a targeted window listener outside the generic dispatcher. */
const DIRECT_LISTENER_HOST_TO_WEBVIEW_TYPES = [
	'editorCursorStatusSnapshot',
	'kustoPublicationStage',
	'kustoPublicationCommit',
	'kustoPublicationRevoke',
] as const;

/**
 * Message types handled in message-handler.ts that are part of the tool/comparison
 * framework, sent via kustoWorkbenchTools.sendToWebview() rather than direct
 * queryEditorProvider/queryEditorCopilot/queryEditorConnection/queryEditorSchema
 * postMessage calls. These are excluded from HOST_TO_WEBVIEW_TYPES because they
 * flow through a different dispatch path.
 */
const TOOL_FRAMEWORK_HANDLER_TYPES = new Set([
	'toolAddSection',
	'toolRemoveSection',
	'toolCollapseSection',
	'toolReorderSections',
	'toolConfigureQuerySection',
	'toolCancelKustoExecution',
	'toolCancelKustoCopilot',
	'toolUpdateMarkdownSection',
	'toolConfigureChart',
	'toolConfigureTransformation',
	'toolConfigureHtmlSection',
	'toolGetHtmlDashboardContext',
	'toolConfigureSqlSection',
	'toolCancelSqlExecution',
	'toolCancelSqlCopilot',
	'toolGetSqlSchema',
	'toolDelegateToKustoWorkbenchCopilot',
	'toolDelegateToSqlCopilot',
	'compareQueryPerformanceWithQuery',
]);

/**
 * Host sends `showInfo` to the webview but message-handler.ts has no case for it.
 * This is a known benign inconsistency — VS Code's postMessage is fire-and-forget
 * and the info toast was historically shown differently.
 */
const KNOWN_UNHANDLED_HOST_MESSAGES = new Set([
	'showInfo',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Message Protocol Contract', () => {
	it('registers query sections before the main dispatcher drains buffered document data', () => {
		const source = readWorkspaceFile('src/webview/index.ts');
		expect(source.indexOf("import './sections/kw-query-section.js';")).toBeGreaterThanOrEqual(0);
		expect(source.indexOf("import './sections/kw-query-section.js';"))
			.toBeLessThan(source.indexOf("import './core/main.js';"));
		const main = readWorkspaceFile('src/webview/core/main.ts');
		expect(main.indexOf('kustoEditorSchemaCoordinator.subscribeLifecycle'))
			.toBeLessThan(main.indexOf('drainBufferedHostMessages();'));
	});

	// ─── Compile-time guards ───────────────────────────────────────────────
	// These calls exist solely for the TypeScript compiler to verify that
	// every string literal in our arrays is a valid union discriminant.
	// A missing or renamed type causes a build-time error, not a runtime failure.

	it('INCOMING_WEBVIEW_MESSAGE_TYPES are valid IncomingWebviewMessage discriminants (compile-time)', () => {
		for (const t of INCOMING_WEBVIEW_MESSAGE_TYPES) {
			assertIncomingType(t);
		}
	});

	it('OUTGOING_WEBVIEW_MESSAGE_TYPES are valid OutgoingWebviewMessage discriminants (compile-time)', () => {
		for (const t of OUTGOING_WEBVIEW_MESSAGE_TYPES) {
			assertOutgoingType(t);
		}
	});

	it('INCOMING_WEBVIEW_MESSAGE_TYPES matches the IncomingWebviewMessage source union', () => {
		expect([...INCOMING_WEBVIEW_MESSAGE_TYPES].sort()).toEqual(
			extractTypeDiscriminants('src/host/queryEditorTypes.ts', 'IncomingWebviewMessage')
		);
	});

	it('OUTGOING_WEBVIEW_MESSAGE_TYPES matches the OutgoingWebviewMessage source union', () => {
		expect([...OUTGOING_WEBVIEW_MESSAGE_TYPES].sort()).toEqual(
			[...new Set([
				...extractTypeDiscriminants('src/webview/shared/webview-messages.ts', 'OutgoingWebviewMessage'),
				...extractTypeDiscriminants('src/shared/documentViewProtocol.ts', 'DocumentViewWebviewMessage'),
			])].sort()
		);
	});

	it('handled message inventory matches the generic handler and SQL router cases', () => {
		const routerLabels = new Set<string>(SQL_SECTION_ROUTER_CASE_LABELS);
		const genericLabels = MESSAGE_HANDLER_CASE_LABELS.filter(label => !routerLabels.has(label));
		expect([...genericLabels].sort()).toEqual(extractMessageHandlerCaseLabels());
		expect([...SQL_SECTION_ROUTER_CASE_LABELS].sort()).toEqual(extractSqlSectionRouterCaseLabels());
		expect([...new Set([...genericLabels, ...SQL_SECTION_ROUTER_CASE_LABELS])].sort())
			.toEqual([...MESSAGE_HANDLER_CASE_LABELS].sort());
	});

	// ─── Webview → Host direction ──────────────────────────────────────────

	describe('Webview → Host (OutgoingWebviewMessage ↔ IncomingWebviewMessage)', () => {
		it('publishToPowerBI carries the selected data mode in both directions', () => {
			const basePayload = {
				requestId: 'publish-request-1',
				boxId: 'html_1',
				workspaceId: 'workspace-1',
				reportName: 'Ops Dashboard',
				pageWidth: 1280,
				pageHeight: 720,
				htmlCode: '<main></main>',
				dataSources: [{ name: 'Fact Events', sectionId: 'query_1', clusterUrl: 'https://cluster.example', database: 'db', query: 'FactEvents', columns: [{ name: 'Day', type: 'datetime' }] }],
			};
			const incoming: IncomingPublishToPowerBIMessage = { type: 'publishToPowerBI', ...basePayload, dataMode: 'import' };
			const outgoing: OutgoingPublishToPowerBIMessage = { type: 'publishToPowerBI', ...basePayload, dataMode: 'directQuery' };

			expect(incoming.dataMode).toBe('import');
			expect(outgoing.dataMode).toBe('directQuery');
		});

		it('every outgoing type (excluding provider-only) exists in IncomingWebviewMessage', () => {
			const incoming = new Set<string>(INCOMING_WEBVIEW_MESSAGE_TYPES);
			const missing: string[] = [];
			for (const t of OUTGOING_WEBVIEW_MESSAGE_TYPES) {
				if (!PROVIDER_ONLY_OUTGOING_TYPES.has(t) && !incoming.has(t)) {
					missing.push(t);
				}
			}
			expect(missing, 'Outgoing types missing from IncomingWebviewMessage').toEqual([]);
		});

		it('every IncomingWebviewMessage type exists in OutgoingWebviewMessage', () => {
			const outgoing = new Set<string>(OUTGOING_WEBVIEW_MESSAGE_TYPES);
			const missing: string[] = [];
			for (const t of INCOMING_WEBVIEW_MESSAGE_TYPES) {
				if (!outgoing.has(t) && !INCOMING_ONLY_WEBVIEW_MESSAGE_TYPES.has(t)) {
					missing.push(t);
				}
			}
			expect(missing, 'Incoming types missing from OutgoingWebviewMessage').toEqual([]);
		});

		it('no duplicates in outgoing types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of OUTGOING_WEBVIEW_MESSAGE_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});

		it('no duplicates in incoming types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of INCOMING_WEBVIEW_MESSAGE_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});
	});

	// ─── Host → Webview direction ──────────────────────────────────────────

	describe('Host → Webview (host postMessage types ↔ message-handler cases)', () => {
		it('every direct main-webview host sender is declared in the protocol inventory', () => {
			const extraction = extractMainWebviewHostMessages();
			const declared = new Set<string>([
				...HOST_TO_WEBVIEW_TYPES,
				...COMPONENT_HANDLED_HOST_TO_WEBVIEW_TYPES,
				...DIRECT_LISTENER_HOST_TO_WEBVIEW_TYPES,
			]);
			const missing = extraction.types.filter(type => !declared.has(type));
			expect(missing, 'Direct provider/coordinator senders missing from host protocol inventory').toEqual([]);
			expect(extraction.dynamicSites, 'Dynamic host sender sites require an explicit reviewed allowlist')
				.toEqual([...REVIEWED_DYNAMIC_HOST_MESSAGE_SITES]);
		});

		it('extracts both host-owned Markdown provider senders', () => {
			const extraction = extractPostMessageTypes('src/host/kqlxEditorProvider.ts');
			expect(extraction.types).toEqual(expect.arrayContaining([
				'requestMarkdownCommandBarrier',
				'markdownDocumentCommandResult',
			]));
		});

		it('extracts both artifact CSV save handler senders', () => {
			const extraction = extractPostMessageTypes('src/host/artifactCsvSaveApplicationHandler.ts');
			expect(extraction.types).toEqual(expect.arrayContaining([
				'requestArtifactCsvSaveData',
				'cancelArtifactCsvSave',
			]));
		});

		it('extracts the SQL connection-onboarding acknowledgement', () => {
			const extraction = extractPostMessageTypes('src/host/sqlConnectionOnboardingApplicationHandler.ts');
			expect(extraction.types).toContain('sqlConnectionAdded');
		});

		it('extracts the SQL favorites publication', () => {
			const extraction = extractPostMessageTypes('src/host/sqlFavoritesApplicationHandler.ts');
			expect(extraction.types).toContain('sqlFavoritesData');
		});

		it('extracts SQL database discovery loading and terminals', () => {
			const extraction = extractPostMessageTypes('src/host/sqlDatabaseDiscoveryApplicationHandler.ts');
			expect(extraction.types).toEqual(expect.arrayContaining([
				'sqlDatabasesLoading',
				'sqlDatabasesData',
				'sqlDatabasesError',
			]));
		});

		it('extracts the KQL language request handler terminal', () => {
			const extraction = extractPostMessageTypes('src/host/kqlLanguageRequestApplicationHandler.ts');
			expect(extraction.types).toContain('kqlLanguageResponse');
		});

		it('keeps the SQL last-selection handler response-free', () => {
			const extraction = extractPostMessageTypes('src/host/sqlLastSelectionApplicationHandler.ts');
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('extracts the development-note mutation request', () => {
			const extraction = extractPostMessageTypes('src/host/developmentNoteMutationApplicationHandler.ts');
			expect(extraction.types).toContain('updateDevNotes');
		});

		it('extracts the Copilot inline-completion fallback', () => {
			const extraction = extractPostMessageTypes('src/host/copilotInlineCompletionApplicationHandler.ts');
			expect(extraction.types).toContain('copilotInlineCompletionResult');
		});

		it('keeps the Copilot availability admission handler response-free', () => {
			const extraction = extractPostMessageTypes('src/host/copilotAvailabilityApplicationHandler.ts');
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps the Copilot write-query preparation admission handler response-free', () => {
			const extraction = extractPostMessageTypes(
				'src/host/copilotWriteQueryPreparationApplicationHandler.ts',
			);
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps the Copilot conversation-clear admission handler response-free', () => {
			const extraction = extractPostMessageTypes(
				'src/host/copilotConversationClearApplicationHandler.ts',
			);
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps the Copilot history-removal admission handler response-free', () => {
			const extraction = extractPostMessageTypes(
				'src/host/copilotHistoryRemovalApplicationHandler.ts',
			);
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('extracts the Copilot chat first-time workflow result', () => {
			const extraction = extractPostMessageTypes(
				'src/host/copilotChatFirstTimeApplicationHandler.ts',
			);
			expect(extraction.types).toContain('copilotChatFirstTimeResult');
		});

		it('extracts the Workbench tool-session state request', () => {
			const extraction = extractPostMessageTypes(
				'src/host/workbenchToolSessionApplicationHandler.ts',
			);
			expect(extraction.types).toContain('requestToolState');
		});

		it('keeps the Kusto connection browsing handler response-free', () => {
			const extraction = extractPostMessageTypes(
				'src/host/kustoConnectionBrowsingApplicationHandler.ts',
			);
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('extracts the Copilot query workflow SQL preflight terminals', () => {
			const extraction = extractPostMessageTypes(
				'src/host/copilotQueryWorkflowApplicationHandler.ts',
			);
			expect(extraction.types).toEqual(['copilotWriteQueryDone']);
			expect(extraction.dynamicSites).toEqual([]);
		});

		it('extracts Kusto section execution start and publication messages', () => {
			const extraction = extractPostMessageTypes(
				'src/host/kustoSectionExecutionApplicationHandler.ts',
			);
			expect(extraction.types).toEqual([
				'kustoExecutionStarted',
				'kustoPublicationCommit',
				'kustoPublicationRevoke',
				'kustoPublicationStage',
			]);
			expect(extraction.dynamicSites).toEqual([]);
		});

		it('extracts both Python execution handler terminals', () => {
			const extraction = extractPostMessageTypes('src/host/pythonExecutionApplicationHandler.ts');
			expect(extraction.types).toEqual(expect.arrayContaining([
				'pythonResult',
				'pythonError',
			]));
		});

		it('extracts query-sharing handler responses', () => {
			const extraction = extractPostMessageTypes('src/host/querySharingApplicationHandler.ts');
			expect(extraction.types).toEqual(expect.arrayContaining([
				'showInfo',
				'shareContentReady',
			]));
		});

		it('extracts both URL-content handler terminals', () => {
			const extraction = extractPostMessageTypes('src/host/urlContentApplicationHandler.ts');
			expect(extraction.types).toEqual(expect.arrayContaining([
				'urlContent',
				'urlError',
			]));
		});

		it('extracts the control-command syntax handler result', () => {
			const extraction = extractPostMessageTypes('src/host/controlCommandSyntaxApplicationHandler.ts');
			expect(extraction.types).toContain('controlCommandSyntaxResult');
		});

		it('extracts the resource URI handler result', () => {
			const extraction = extractPostMessageTypes('src/host/resourceUriApplicationHandler.ts');
			expect(extraction.types).toContain('resolveResourceUriResult');
		});

		it('keeps Copilot content opening response-free', () => {
			const extraction = extractPostMessageTypes('src/host/copilotContentOpenApplicationHandler.ts');
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps information notifications response-free', () => {
			const extraction = extractPostMessageTypes('src/host/informationNotificationApplicationHandler.ts');
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps cached-values opening response-free', () => {
			const extraction = extractPostMessageTypes('src/host/cachedValuesOpenApplicationHandler.ts');
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps Copilot agent opening response-free', () => {
			const extraction = extractPostMessageTypes('src/host/copilotAgentOpenApplicationHandler.ts');
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('extracts the development cursor-status snapshot response', () => {
			const extraction = extractPostMessageTypes('src/host/editorCursorStatusApplicationHandler.ts');
			expect(extraction.types).toContain('editorCursorStatusSnapshot');
		});

		it('every host→webview type has a handler case (or is known-unhandled)', () => {
			const cases = new Set<string>([...MESSAGE_HANDLER_CASE_LABELS, ...DIRECT_LISTENER_HOST_TO_WEBVIEW_TYPES]);
			const missing: string[] = [];
			for (const t of HOST_TO_WEBVIEW_TYPES) {
				if (!cases.has(t) && !KNOWN_UNHANDLED_HOST_MESSAGES.has(t)) {
					missing.push(t);
				}
			}
			expect(missing, 'Host types with no message-handler case').toEqual([]);
		});

		it('component-handled host messages are sent by the host and handled by the HTML section', () => {
			const providerMessages = new Set<string>(extractMainWebviewHostMessages().types);
			const htmlSectionMessages = new Set<string>(extractDataTypeComparisons('src/webview/sections/kw-html-section.ts'));
			const publishDialogMessages = new Set<string>(extractMessageTypeComparisons('src/webview/components/kw-publish-pbi-dialog.ts'));
			const missingSenders: string[] = [];
			const missingHandlers: string[] = [];
			const missingDialogHandlers: string[] = [];
			for (const t of COMPONENT_HANDLED_HOST_TO_WEBVIEW_TYPES) {
				if (!providerMessages.has(t)) missingSenders.push(t);
				if (!htmlSectionMessages.has(t)) missingHandlers.push(t);
				if (t !== 'openPublishPbiDialog'
					&& t !== 'powerBiPublishHelpResult'
					&& t !== 'powerBiPartialPublishWarningResult'
					&& !publishDialogMessages.has(t)) missingDialogHandlers.push(t);
			}
			expect(missingSenders, 'Component-handled host types missing from queryEditorProvider senders').toEqual([]);
			expect(missingHandlers, 'Component-handled host types missing from kw-html-section handlers').toEqual([]);
			expect(missingDialogHandlers, 'Power BI reply types missing from kw-publish-pbi-dialog handlers').toEqual([]);
		});

		it('component-handled host messages are not claimed by message-handler cases', () => {
			const cases = new Set<string>(MESSAGE_HANDLER_CASE_LABELS);
			const overlap: string[] = [];
			for (const t of COMPONENT_HANDLED_HOST_TO_WEBVIEW_TYPES) {
				if (cases.has(t)) overlap.push(t);
			}
			expect(overlap, 'Component-handled messages should stay in the component-handled bucket').toEqual([]);
		});

		it('every message-handler case is either a known host type or tool-framework handler', () => {
			const hostTypes = new Set<string>(HOST_TO_WEBVIEW_TYPES);
			const missing: string[] = [];
			for (const c of MESSAGE_HANDLER_CASE_LABELS) {
				if (!hostTypes.has(c) && !TOOL_FRAMEWORK_HANDLER_TYPES.has(c)) {
					missing.push(c);
				}
			}
			expect(missing, 'Handler cases with no known host sender').toEqual([]);
		});

		it('no duplicates in host→webview types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of HOST_TO_WEBVIEW_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});

		it('no duplicates in component-handled host→webview types', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of COMPONENT_HANDLED_HOST_TO_WEBVIEW_TYPES) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});

		it('no duplicates in message-handler case labels', () => {
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const t of MESSAGE_HANDLER_CASE_LABELS) {
				if (seen.has(t)) dupes.push(t);
				seen.add(t);
			}
			expect(dupes).toEqual([]);
		});
	});

	// ─── Bidirectional consistency ─────────────────────────────────────────

	describe('Bidirectional consistency', () => {
		it('tool-framework handler types are NOT in HOST_TO_WEBVIEW_TYPES', () => {
			const hostTypes = new Set<string>(HOST_TO_WEBVIEW_TYPES);
			const overlap: string[] = [];
			for (const t of TOOL_FRAMEWORK_HANDLER_TYPES) {
				if (hostTypes.has(t)) overlap.push(t);
			}
			expect(overlap, 'Tool-framework types should not be in HOST_TO_WEBVIEW_TYPES').toEqual([]);
		});

		it('provider-only outgoing types are NOT in IncomingWebviewMessage', () => {
			const incoming = new Set<string>(INCOMING_WEBVIEW_MESSAGE_TYPES);
			const overlap: string[] = [];
			for (const t of PROVIDER_ONLY_OUTGOING_TYPES) {
				if (incoming.has(t)) overlap.push(t);
			}
			expect(overlap, 'Provider-only types should not be in IncomingWebviewMessage').toEqual([]);
		});

		it('incoming-only message types are NOT in OutgoingWebviewMessage', () => {
			const outgoing = new Set<string>(OUTGOING_WEBVIEW_MESSAGE_TYPES);
			const overlap: string[] = [];
			for (const t of INCOMING_ONLY_WEBVIEW_MESSAGE_TYPES) {
				if (outgoing.has(t)) overlap.push(t);
			}
			expect(overlap, 'Incoming-only types should stay explicit').toEqual([]);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Message Payload Factories & Snapshots
// ═══════════════════════════════════════════════════════════════════════════════

// Factories build valid, deterministic payloads for the most critical messages.
// They serve two purposes:
// 1. Snapshot tests catch unintentional shape drift
// 2. Reusable fixtures for future behavioral tests

function makeQueryResultMessage() {
	return {
		type: 'queryResult' as const,
		boxId: 'query_1',
		result: {
			columns: [
				{ name: 'Timestamp', type: 'datetime' },
				{ name: 'Value', type: 'real' },
			],
			rows: [
				['2025-01-01T00:00:00Z', 42.5],
				['2025-01-02T00:00:00Z', 99.1],
			],
			metadata: {
				executionTime: '00:00:01.234',
				cluster: 'https://cluster1.kusto.windows.net',
				database: 'Logs',
			},
		},
	};
}

function makeConnectionsDataMessage() {
	return {
		type: 'connectionsData' as const,
		connections: [
			{ id: 'conn_1', name: 'Production', clusterUrl: 'https://cluster1.kusto.windows.net' },
			{ id: 'conn_2', name: 'Staging', clusterUrl: 'https://cluster2.kusto.windows.net' },
		],
		lastConnectionId: 'conn_1',
		lastDatabase: 'Logs',
		cachedDatabases: {
			'cluster1.kusto.windows.net': ['Logs', 'Metrics'],
		},
		favorites: [
			{ name: 'Prod Logs', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'Logs' },
		],
		leaveNoTraceClusters: [],
		devNotesEnabled: false,
		copilotChatFirstTimeDismissed: true,
		caretDocsEnabled: true,
		autoTriggerAutocompleteEnabled: true,
		copilotInlineCompletionsEnabled: true,
		caretDocsEnabledUserSet: false,
		autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabledUserSet: false,
		editingPreferencesRevision: 0,
	};
}

function makeFavoritesDataMessage() {
	return {
		type: 'favoritesData' as const,
		favorites: [
			{ name: 'Prod Logs', clusterUrl: 'https://cluster1.kusto.windows.net', database: 'Logs' },
			{ name: 'Dev Metrics', clusterUrl: 'https://cluster2.kusto.windows.net', database: 'Metrics' },
		],
		boxId: 'query_1',
	};
}

function makeSchemaDataMessage() {
	return {
		type: 'schemaData' as const,
		boxId: 'query_1',
		connectionId: 'conn_1',
		database: 'Logs',
		clusterUrl: 'https://cluster1.kusto.windows.net',
		requestToken: 'tok_abc123',
		schema: {
			tables: ['StormEvents', 'PopulationData'],
			columnTypesByTable: {
				StormEvents: { StartTime: 'datetime', State: 'string', EventType: 'string', DamageProperty: 'long' },
				PopulationData: { State: 'string', Population: 'long' },
			},
			functions: [
				{ name: 'GetTopStorms', parameters: '(n:int)', body: 'StormEvents | top n by DamageProperty' },
			],
			rawSchemaJson: { /* opaque blob — shape varies by Kusto version */ },
		},
		schemaMeta: {
			fromCache: false,
			isFailoverToCache: false,
			tablesCount: 2,
			columnsCount: 6,
			functionsCount: 1,
			forceRefresh: false,
		},
	};
}

function makeToolAddSectionMessage() {
	return {
		type: 'toolAddSection' as const,
		requestId: 'req_001',
		input: {
			type: 'query',
			name: 'Top Events',
			query: 'StormEvents | take 10',
			clusterUrl: 'https://cluster1.kusto.windows.net',
			database: 'Logs',
		},
	};
}

function makeToolConfigureChartMessage() {
	return {
		type: 'toolConfigureChart' as const,
		requestId: 'req_002',
		input: {
			sectionId: 'chart_1',
			name: 'Events Over Time',
			chartType: 'line',
			xColumn: 'Timestamp',
			yColumns: ['Count'],
			legendColumn: 'EventType',
			dataSourceId: 'query_1',
		},
	};
}

describe('Message Payload Factories', () => {
	it('queryResult payload shape', () => {
		expect(makeQueryResultMessage()).toMatchSnapshot();
	});

	it('connectionsData payload shape', () => {
		expect(makeConnectionsDataMessage()).toMatchSnapshot();
	});

	it('favoritesData payload shape', () => {
		expect(makeFavoritesDataMessage()).toMatchSnapshot();
	});

	it('schemaData payload shape', () => {
		expect(makeSchemaDataMessage()).toMatchSnapshot();
	});

	it('toolAddSection payload shape', () => {
		expect(makeToolAddSectionMessage()).toMatchSnapshot();
	});

	it('toolConfigureChart payload shape', () => {
		expect(makeToolConfigureChartMessage()).toMatchSnapshot();
	});
});

// ─── Export factories for reuse in other test files ────────────────────────

export {
	makeQueryResultMessage,
	makeConnectionsDataMessage,
	makeFavoritesDataMessage,
	makeSchemaDataMessage,
	makeToolAddSectionMessage,
	makeToolConfigureChartMessage,
};
