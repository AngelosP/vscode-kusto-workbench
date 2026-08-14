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
import type { KustoSchemaData } from '../../../src/shared/kustoSchemaProtocol';

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
	['postSqlStsMessageContained', 0],
	['postProtectedStsMessageWithRetry', 2],
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

function extractStringArrayVariable(relativePath: string, variableName: string): string[] {
	const source = readWorkspaceFile(relativePath);
	const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let values: string[] | undefined;
	const visit = (node: ts.Node): void => {
		if (values || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)
			|| node.name.text !== variableName || !node.initializer) {
			ts.forEachChild(node, visit);
			return;
		}
		const initializer = unwrapExpression(node.initializer);
		if (!ts.isArrayLiteralExpression(initializer)) {
			throw new Error(`${variableName} must be an array literal.`);
		}
		values = initializer.elements.map(element => {
			const value = unwrapExpression(element as ts.Expression);
			if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
				throw new Error(`${variableName} must contain only string literals.`);
			}
			return value.text;
		});
	};
	visit(sourceFile);
	if (!values) throw new Error(`Variable ${variableName} not found in ${relativePath}.`);
	return values;
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
		extractPostMessageTypes('src/host/sqlSchemaRequestApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlConnectionsProjectionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoConnectionsProjectionApplicationHandler.ts'),
		extractPostMessageTypes('src/host/sqlEditorLifecycleApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoSchemaRequestApplicationHandler.ts'),
		extractPostMessageTypes('src/host/kustoExecutionCoordinator.ts'),
		extractPostMessageTypes('src/host/compatSidecarPersistCoordinator.ts'),
		extractPostMessageTypes('src/host/sql/sqlEditorLifecycleCoordinator.ts'),
		extractPostMessageTypes('src/host/mainWebviewStartupGateway.ts'),
		extractPostMessageTypes('src/host/tutorials/embeddedTutorialWebviewHost.ts'),
		extractPostMessageTypes('src/host/tutorials/tutorialWebviewSession.ts'),
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
	'src/host/artifactCsvSaveApplicationHandler.ts::postMessage::postMessage::52:22',
	'src/host/comparisonPreparationApplicationHandler.ts::waitForSqlComparisonAdmission::postMessage::628:25',
	'src/host/controlCommandSyntaxApplicationHandler.ts::postMessage::postMessage::56:3',
	'src/host/copilotInlineCompletionApplicationHandler.ts::postMessage::postMessage::69:18',
	'src/host/dashboardApplicationHandler.ts::postMessage::postMessage::98:10',
	'src/host/editingPreferencesApplicationHandler.ts::updatePreference::postMessage::75:10',
	'src/host/editingPreferencesApplicationHandler.ts::updatePreference::postToAllWebviews::73:10',
	'src/host/editorCursorStatusApplicationHandler.ts::postMessage::postMessage::83:10',
	'src/host/kqlLanguageRequestApplicationHandler.ts::postMessage::postMessage::48:3',
	'src/host/kustoConnectionOnboardingApplicationHandler.ts::testConnectionFromWebview::postMessage::189:4',
	'src/host/kustoConnectionsProjectionApplicationHandler.ts::publishSnapshot::postMessage::122:4',
	'src/host/kustoExecutionCoordinator.ts::deliver::postMessage::453:33',
	'src/host/mainWebviewStartupGateway.ts::deliver::postMessage::286:33',
	'src/host/pythonExecutionApplicationHandler.ts::postMessage::postMessage::93:10',
	'src/host/queryEditorProvider.ts::<module>::postMessage::381:27',
	'src/host/queryEditorProvider.ts::<module>::postMessage::513:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::519:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::524:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::531:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::534:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::537:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::540:28',
	'src/host/queryEditorProvider.ts::<module>::postMessage::555:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::561:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::566:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::583:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::591:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::597:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::611:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::619:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::634:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::647:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::682:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::692:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::699:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::708:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::716:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::739:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::744:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::772:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::780:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::804:29',
	'src/host/queryEditorProvider.ts::<module>::postMessage::819:29',
	'src/host/queryEditorProvider.ts::initializeWebviewPanel::postMessage::898:15',
	'src/host/queryEditorProvider.ts::postMessage::postMessage::1287:21',
	'src/host/querySharingApplicationHandler.ts::postMessage::postMessage::36:22',
	'src/host/resourceUriApplicationHandler.ts::postMessage::postMessage::56:3',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postConnectMessageWithRetry::postMessageRequiredContained::1806:13',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postConnectMessageWithRetry::postMessageRequiredContained::1810:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postMessageContained::postMessageRequiredContained::2080:8',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postMessageRequiredContained::postMessageRequired::2107:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postProtectedMessageWithRetry::postMessageRequiredContained::1718:13',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postProtectedMessageWithRetry::postMessageRequiredContained::1722:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postProtectedStsMessageWithRetry::postProtectedMessageWithRetry::1736:10',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::postSqlStsMessageContained::postMessageContained::2097:3',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::publishOwnerChangeWithRetry::postMessageRequiredContained::1820:13',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::publishOwnerChangeWithRetry::postMessageRequiredContained::1831:27',
	'src/host/sql/sqlEditorLifecycleCoordinator.ts::replayOwnerChange::postMessageRequiredContained::1860:14',
	'src/host/sqlConnectionsProjectionApplicationHandler.ts::publishSnapshot::postMessage::138:28',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::deliverMessage::postMessage::146:31',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::deliverTerminalMessage::postMessage::164:31',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::postSqlConnectionMessageAllowed::postMessage::218:31',
	'src/host/sqlDatabaseDiscoveryApplicationHandler.ts::postSqlConnectionMessageProtection::postMessage::287:31',
	'src/host/sqlSectionExecutionApplicationHandler.ts::postSqlOwnerMessageAllowed::postMessage::250:21',
	'src/host/sqlSectionExecutionApplicationHandler.ts::postSqlOwnerMessageProtection::postMessage::266:22',
	'src/host/tutorials/embeddedTutorialWebviewHost.ts::postMessage::postMessage::109:16',
	'src/host/tutorials/embeddedTutorialWebviewHost.ts::show::postMessage::62:29',
	'src/host/tutorials/tutorialWebviewSession.ts::postMessage::postMessage::242:10',
	'src/host/tutorials/tutorialWebviewSession.ts::postMessage::postMessage::245:9',
	'src/host/urlContentApplicationHandler.ts::postMessage::postMessage::111:3',
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
	'mainWebviewDispatcherReady',
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
	'mainWebviewDispatcherReady',
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
	'error',
	'hideEmbeddedTutorialViewer',
	'kustoPublicationStage',
	'kustoPublicationCommit',
	'kustoPublicationRevoke',
	'showEmbeddedTutorialViewer',
	'snapshot',
	'tutorialContent',
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

const KNOWN_UNHANDLED_HOST_MESSAGES = new Set<string>();

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Message Protocol Contract', () => {
	it('registers query sections before the explicit main-webview dispatcher starts', () => {
		const source = readWorkspaceFile('src/webview/index.ts');
		expect(source.indexOf("import './sections/kw-query-section.js';")).toBeGreaterThanOrEqual(0);
		expect(source.indexOf("import './sections/kw-query-section.js';"))
			.toBeLessThan(source.indexOf('startMainWebviewMessageDispatcher();'));
	});

	it('uses one explicit main-webview startup gateway instead of provider-local queues or import-order draining', () => {
		const nativeProvider = readWorkspaceFile('src/host/kqlxEditorProvider.ts');
		expect(nativeProvider).toContain('MainWebviewStartupGateway');
		expect(nativeProvider).toContain('isMainWebviewCorrelatedReply(message) || isPendingFinalPersistReply(message)');
		expect(nativeProvider).not.toContain('queuedWebviewMessages');

		for (const providerPath of [
			'src/host/kqlCompatEditorProvider.ts',
			'src/host/sqlCompatEditorProvider.ts',
		]) {
			const provider = readWorkspaceFile(providerPath);
			expect(provider).toContain('MainWebviewStartupGateway');
			expect(provider).toContain('isMainWebviewCorrelatedReply(message) || closeCoordinator.isPendingFinalPersistReply(message)');
			expect(provider).toContain('closeCoordinator.allowRetiredInbound(message)');
			expect(provider).toContain('closeCoordinator.configure(closeFinalization)');
			expect(provider).not.toContain('queuedWebviewMessages');
			expect(provider).not.toContain('waitForFinalPersists()');
			expect(provider).not.toContain('closeRetiredInboundAdmission()');
		}

		const closeCoordinator = readWorkspaceFile('src/host/compatSidecarCloseCoordinator.ts');
		expect(closeCoordinator).toContain('waitForFinalPersists()');
		expect(closeCoordinator).toContain('closeRetiredInboundAdmission()');
		expect(closeCoordinator).toContain('this.options.session.beginClose()');
		expect(closeCoordinator).toContain('this.options.session.settleClose()');
		expect(closeCoordinator).toContain('finalization.drainStore()');

		const main = readWorkspaceFile('src/webview/core/main.ts');
		expect(main).not.toContain('drainBufferedHostMessages');

		const index = readWorkspaceFile('src/webview/index.ts');
		expect(index).toContain('startMainWebviewMessageDispatcher');

		const queryEditorProvider = readWorkspaceFile('src/host/queryEditorProvider.ts');
		expect(queryEditorProvider).toContain('MAIN_WEBVIEW_DISPATCHER_READY_TYPE) return;');
		expect(queryEditorProvider.match(/this\.handlePanelWebviewMessage\(input\)/g)).toHaveLength(2);
	});

	it('keeps compatibility persistence lifecycle traffic on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/compatibilityPersistenceProtocol.ts',
			'CompatibilityPersistenceWebviewMessage',
		)).toEqual([
			'documentReloadResult',
			'persistDocument',
			'requestDocument',
		]);
		expect(extractTypeDiscriminants(
			'src/shared/compatibilityPersistenceProtocol.ts',
			'CompatibilityPersistenceHostMessage',
		)).toEqual([
			'documentData',
			'persistDocumentAck',
			'requestFinalPersist',
		]);

		for (const [providerPath, documentKind] of [
			['src/host/kqlCompatEditorProvider.ts', 'kql'],
			['src/host/sqlCompatEditorProvider.ts', 'sql'],
		] as const) {
			const provider = readWorkspaceFile(providerPath);
			const parserCall = `parseCompatibilityPersistenceWebviewMessage(input, '${documentKind}')`;
			expect(provider).toContain(parserCall);
			expect(provider).toContain('parsed.value.viewSessionId !== viewSessionId');
			expect(provider).toContain('stampCompatibilityPersistenceHostMessage(viewSessionId, message)');
			expect(provider).toContain('compatibilityPersistence,');
			expect(provider.indexOf(parserCall))
				.toBeLessThan(provider.indexOf('closeCoordinator.allowRetiredInbound(parsed.value)'));
		}

		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(webviewMessages).toContain('stampCompatibilityPersistenceWebviewMessage');
		expect(webviewMessages).toContain('compatibilityPersistenceDocumentRequestIds.add');
		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		expect(messageHandler).toContain('parseCompatibilityPersistenceHostMessage(message)');
		expect(messageHandler).toContain('compatibilityPersistenceDocumentRequestIds.has');
		expect(messageHandler.indexOf('parseCompatibilityPersistenceHostMessage(message)'))
			.toBeLessThan(messageHandler.indexOf('parseDocumentViewHostMessage(message)'));

		const html = readWorkspaceFile('src/webview/queryEditor.html');
		const preload = readWorkspaceFile('src/webview/queryEditor.js');
		expect(html).toContain('compatibilityPersistence: {{compatibilityPersistenceJson}}');
		expect(preload).toContain('compatibilityPersistence.initialRequestId = initialRequestId');
		expect(preload).toContain('protocolVersion: compatibilityPersistence.protocolVersion');
		expect(preload).toContain('channel: compatibilityPersistence.channel');

		const closeCoordinator = readWorkspaceFile('src/host/compatSidecarCloseCoordinator.ts');
		const projectionCoordinator = readWorkspaceFile('src/host/compatSidecarProjectionCoordinator.ts');
		const markdownCompatibility = readWorkspaceFile('src/host/mdCompatEditorProvider.ts');
		expect(closeCoordinator).not.toContain('compatibilityPersistenceProtocol');
		expect(closeCoordinator).not.toContain('CompatSidecarProjectionCoordinator');
		expect(projectionCoordinator).toContain('completeReload(result: CompatSidecarReloadResult)');
		expect(projectionCoordinator).toContain('admitPersist(admission: CompatSidecarPersistAdmission)');
		expect(projectionCoordinator).toContain('ensureInitialProjection(requestId?: string)');
		expect(projectionCoordinator).not.toContain('KqlxStateV1');
		expect(projectionCoordinator).not.toContain('vscode');
		expect(markdownCompatibility).not.toContain('compatibilityPersistenceProtocol');
	});

	it('keeps Kusto schema requests and deliveries on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/kustoSchemaProtocol.ts',
			'KustoSchemaWebviewMessage',
		)).toEqual([
			'prefetchSchema',
			'requestCrossClusterSchema',
		]);
		expect(extractTypeDiscriminants(
			'src/shared/kustoSchemaProtocol.ts',
			'KustoSchemaHostMessage',
		)).toEqual([
			'crossClusterSchemaData',
			'crossClusterSchemaError',
			'schemaData',
			'schemaError',
		]);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| KustoSchemaWebviewMessage');
		expect(webviewMessages).toContain('| KustoSchemaWebviewMessage');
		expect(hostTypes).not.toContain("type: 'prefetchSchema'");
		expect(hostTypes).not.toContain("type: 'requestCrossClusterSchema'");
		expect(webviewMessages).not.toContain("type: 'prefetchSchema'");
		expect(webviewMessages).not.toContain("type: 'requestCrossClusterSchema'");
		expect(webviewMessages).toContain('parseKustoSchemaWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/kustoSchemaRequestApplicationHandler.ts');
		expect(requestHandler.indexOf('parseKustoSchemaWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.options.schema.prefetchSchema('));
		expect(requestHandler.indexOf('parseKustoSchemaWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.options.schema.handleCrossClusterSchemaRequest('));

		const schemaService = readWorkspaceFile('src/host/queryEditorSchema.ts');
		expect(schemaService).toContain('postMessage(message: KustoSchemaHostMessage): void;');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseKustoSchemaHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('const incomingType'));
		expect(dispatcher.indexOf('parseKustoSchemaHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('admitKustoSchemaDelivery('));
		expect(dispatcher.indexOf('parseKustoSchemaHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("__kustoTraceCrossCluster('response-received'"));
	});

	it('keeps Kusto database discovery requests and deliveries on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/kustoDatabaseDiscoveryProtocol.ts',
			'KustoDatabaseDiscoveryWebviewMessage',
		)).toEqual(['getDatabases', 'refreshDatabases']);
		expect(extractTypeDiscriminants(
			'src/shared/kustoDatabaseDiscoveryProtocol.ts',
			'KustoDatabaseDiscoveryHostMessage',
		)).toEqual(['databasesData', 'databasesError']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| KustoDatabaseDiscoveryWebviewMessage');
		expect(webviewMessages).toContain('| KustoDatabaseDiscoveryWebviewMessage');
		expect(hostTypes).not.toContain("type: 'getDatabases'");
		expect(hostTypes).not.toContain("type: 'refreshDatabases'");
		expect(webviewMessages).not.toContain("type: 'getDatabases'");
		expect(webviewMessages).not.toContain("type: 'refreshDatabases'");
		expect(webviewMessages).toContain('parseKustoDatabaseDiscoveryWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/kustoConnectionBrowsingApplicationHandler.ts');
		expect(requestHandler.indexOf('parseKustoDatabaseDiscoveryWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.options.sendDatabases('));

		const connectionService = readWorkspaceFile('src/host/queryEditorConnection.ts');
		expect(connectionService).toContain('postMessage(message: KustoDatabaseDiscoveryHostMessage)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseKustoDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('const incomingType'));
		expect(dispatcher.indexOf('parseKustoDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('admitKustoDatabaseDelivery('));
		expect(dispatcher.indexOf('parseKustoDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('updateDatabaseSelect('));

		const testHelpers = readWorkspaceFile('src/webview/core/test-helpers.ts');
		const waiter = testHelpers.slice(testHelpers.indexOf('export async function e2eIdentityRequestDatabases'));
		expect(waiter.indexOf('parseKustoDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(waiter.indexOf('window.clearTimeout(timer)'));
	});

	it('keeps SQL database discovery requests and deliveries on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/sqlDatabaseDiscoveryProtocol.ts',
			'SqlDatabaseDiscoveryWebviewMessage',
		)).toEqual(['getSqlDatabases', 'refreshSqlDatabases']);
		expect(extractTypeDiscriminants(
			'src/shared/sqlDatabaseDiscoveryProtocol.ts',
			'SqlDatabaseDiscoveryHostMessage',
		)).toEqual(['sqlDatabasesData', 'sqlDatabasesError', 'sqlDatabasesLoading']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| SqlDatabaseDiscoveryWebviewMessage');
		expect(webviewMessages).toContain('| SqlDatabaseDiscoveryWebviewMessage');
		expect(hostTypes).not.toContain("type: 'getSqlDatabases'");
		expect(hostTypes).not.toContain("type: 'refreshSqlDatabases'");
		expect(webviewMessages).not.toContain("type: 'getSqlDatabases'");
		expect(webviewMessages).not.toContain("type: 'refreshSqlDatabases'");
		expect(webviewMessages).toContain('parseSqlDatabaseDiscoveryWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/sqlDatabaseDiscoveryApplicationHandler.ts');
		expect(requestHandler.indexOf('parseSqlDatabaseDiscoveryWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.options.lifecycle.adoptTarget('));
		expect(requestHandler).toContain('postMessage: (message: SqlDatabaseDiscoveryHostMessage)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseSqlDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('const incomingType'));
		expect(dispatcher.indexOf('parseSqlDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('routeSqlSectionMessage(message'));

		const router = readWorkspaceFile('src/webview/core/sql-section-message-router.ts');
		expect(router.indexOf('parseSqlDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(router.indexOf("case 'sqlDatabasesLoading':"));
		expect(router.indexOf('parseSqlDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(router.indexOf('session.beginDatabaseRequest('));
		expect(router.indexOf('parseSqlDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(router.indexOf('session.acceptDatabaseResponse('));
		expect(router.indexOf('parseSqlDatabaseDiscoveryHostMessage(message)'))
			.toBeLessThan(router.indexOf('effects.updateDatabases('));
	});

	it('keeps SQL schema requests and deliveries on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/sqlSchemaProtocol.ts',
			'SqlSchemaWebviewMessage',
		)).toEqual(['prefetchSqlSchema']);
		expect(extractTypeDiscriminants(
			'src/shared/sqlSchemaProtocol.ts',
			'SqlSchemaHostMessage',
		)).toEqual(['sqlSchemaData']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| SqlSchemaWebviewMessage');
		expect(webviewMessages).toContain('| SqlSchemaWebviewMessage');
		expect(hostTypes).not.toContain("type: 'prefetchSqlSchema'");
		expect(webviewMessages).not.toContain("type: 'prefetchSqlSchema'");
		expect(webviewMessages).toContain('parseSqlSchemaWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/sqlSchemaRequestApplicationHandler.ts');
		expect(requestHandler.indexOf('parseSqlSchemaWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.options.lifecycle.adoptTarget('));
		expect(requestHandler).toContain('postMessage: (message: SqlSchemaHostMessage)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseSqlSchemaHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('routeSqlSectionMessage(message'));

		const router = readWorkspaceFile('src/webview/core/sql-section-message-router.ts');
		expect(router.indexOf('parseSqlSchemaHostMessage(message)'))
			.toBeLessThan(router.indexOf("case 'sqlSchemaData':"));
		expect(router.indexOf('parseSqlSchemaHostMessage(message)'))
			.toBeLessThan(router.indexOf('effects.setSchema('));
		expect(router.indexOf('parseSqlSchemaHostMessage(message)'))
			.toBeLessThan(router.indexOf('section.setSchemaInfo?.('));
		expect(router).not.toContain('message.schema as');
	});

	it('keeps SQL connections requests and snapshots on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/sqlConnectionsProjectionProtocol.ts',
			'SqlConnectionsProjectionWebviewMessage',
		)).toEqual(['getSqlConnections']);
		expect(extractTypeDiscriminants(
			'src/shared/sqlConnectionsProjectionProtocol.ts',
			'SqlConnectionsProjectionHostMessage',
		)).toEqual(['sqlConnectionsData']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| SqlConnectionsProjectionWebviewMessage');
		expect(webviewMessages).toContain('| SqlConnectionsProjectionWebviewMessage');
		expect(hostTypes).not.toContain("type: 'getSqlConnections'");
		expect(webviewMessages).not.toContain("type: 'getSqlConnections'");
		expect(webviewMessages.indexOf('admitSqlConnectionsProjectionWebviewMessage(message)'))
			.toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));
		expect(webviewMessages.indexOf('captureSqlConnectionsProjectionWebviewMessage('))
			.toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));

		const projectionHandler = readWorkspaceFile('src/host/sqlConnectionsProjectionApplicationHandler.ts');
		expect(projectionHandler.indexOf('admitSqlConnectionsProjectionWebviewMessage(message)'))
			.toBeLessThan(projectionHandler.indexOf('return this.refresh().then('));
		expect(projectionHandler).toContain('postMessage: (message: SqlConnectionsProjectionHostMessage)');
		expect(projectionHandler.indexOf('parseSqlConnectionsProjectionHostMessage(message)'))
			.toBeLessThan(projectionHandler.indexOf('this.options.postMessage(parsed.value)'));

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('admitSqlConnectionsProjectionHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("case 'sqlConnectionsData':"));
		expect(dispatcher.indexOf('captureSqlConnectionsProjectionHostMessage('))
			.toBeLessThan(dispatcher.indexOf("case 'sqlConnectionsData':"));
		expect(dispatcher.indexOf('admitSqlConnectionsProjectionHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('latestSqlConnectionsRevision = revision'));
		expect(dispatcher.indexOf('captureSqlConnectionsProjectionHostMessage('))
			.toBeLessThan(dispatcher.indexOf('latestSqlConnectionsRevision = revision'));
		expect(dispatcher.indexOf('admitSqlConnectionsProjectionHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('setSqlConnections(message.connections)'));
		expect(dispatcher.indexOf('setSqlConnections(message.connections)'))
			.toBeLessThan(dispatcher.indexOf('latestSqlConnectionsRevision = revision'));
		expect(dispatcher.indexOf('resolvePendingSqlResultRestores()'))
			.toBeLessThan(dispatcher.indexOf('latestSqlConnectionsRevision = revision'));

		const state = readWorkspaceFile('src/webview/core/state.ts');
		expect(state).not.toContain('sqlConnections.push(...val)');
	});

	it('keeps Kusto connections requests and snapshots on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/kustoConnectionsProjectionProtocol.ts',
			'KustoConnectionsProjectionWebviewMessage',
		)).toEqual(['getConnections']);
		expect(extractTypeDiscriminants(
			'src/shared/kustoConnectionsProjectionProtocol.ts',
			'KustoConnectionsProjectionHostMessage',
		)).toEqual(['connectionsData']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| KustoConnectionsProjectionWebviewMessage');
		expect(webviewMessages).toContain('| KustoConnectionsProjectionWebviewMessage');
		expect(hostTypes).not.toContain("type: 'getConnections'");
		expect(webviewMessages).not.toContain("type: 'getConnections'");
		expect(webviewMessages.indexOf('const envelope = captureRuntimeMessageEnvelope(msg)'))
			.toBeLessThan(webviewMessages.indexOf('admitKustoConnectionsProjectionWebviewMessage(message)'));
		expect(webviewMessages.indexOf('admitKustoConnectionsProjectionWebviewMessage(message)'))
			.toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));
		expect(webviewMessages.indexOf('captureKustoConnectionsProjectionWebviewMessage('))
			.toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));

		const browsingHandler = readWorkspaceFile('src/host/kustoConnectionBrowsingApplicationHandler.ts');
		expect(browsingHandler.indexOf('admitKustoConnectionsProjectionWebviewMessage(message)'))
			.toBeLessThan(browsingHandler.indexOf('this.options.sendConnectionsData('));

		const projectionHandler = readWorkspaceFile('src/host/kustoConnectionsProjectionApplicationHandler.ts');
		expect(projectionHandler).toContain('postKustoPublication(message: KustoConnectionsData)');
		const publishSnapshot = projectionHandler.slice(projectionHandler.indexOf('private async publishSnapshot'));
		expect(publishSnapshot.indexOf('const captured = this.captureSnapshot(message)'))
			.toBeLessThan(publishSnapshot.indexOf('this.options.postKustoPublication(captured)'));

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('const envelope = captureRuntimeMessageEnvelope(message)'))
			.toBeLessThan(dispatcher.indexOf('admitKustoConnectionsProjectionHostMessage(message)'));
		expect(dispatcher.indexOf('admitKustoConnectionsProjectionHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("case 'connectionsData':"));
		expect(dispatcher.indexOf('captureKustoConnectionsProjectionHostMessage('))
			.toBeLessThan(dispatcher.indexOf("case 'connectionsData':"));
		const stage = dispatcher.slice(
			dispatcher.indexOf("if (message.type === 'kustoPublicationStage')"),
			dispatcher.indexOf("if (message.type === 'kustoPublicationCommit')"),
		);
		expect(stage.indexOf('admitKustoConnectionsProjectionHostMessage(payload)'))
			.toBeLessThan(stage.indexOf('stagedKustoPublications.set('));
		expect(stage.indexOf('captureKustoConnectionsProjectionHostMessage('))
			.toBeLessThan(stage.indexOf('stagedKustoPublications.set('));
		const commit = dispatcher.slice(
			dispatcher.indexOf("if (message.type === 'kustoPublicationCommit')"),
			dispatcher.indexOf("if (message.type === 'kustoPublicationRevoke')"),
		);
		expect(commit.indexOf('captureKustoConnectionsProjectionHostMessage('))
			.toBeLessThan(commit.indexOf('message = attachKustoPublicationId(payload, publicationId)'));

		const connectionsCase = dispatcher.slice(
			dispatcher.indexOf("case 'connectionsData':"),
			dispatcher.indexOf("case 'kustoAuthIdentityChanged':"),
		);
		expect(connectionsCase.indexOf('policyApplication.commit()'))
			.toBeLessThan(connectionsCase.indexOf('updateConnectionSelects()'));
		const rollbackBranch = connectionsCase.slice(
			connectionsCase.indexOf('} catch (error) {'),
			connectionsCase.indexOf('try { updateConnectionSelects();'),
		);
		expect(rollbackBranch).not.toContain('updateConnectionSelects()');
		expect(connectionsCase.lastIndexOf('resolvePendingKustoResultRestores()'))
			.toBeLessThan(connectionsCase.lastIndexOf('acknowledgeKustoPublication(message, true)'));
		expect(connectionsCase.lastIndexOf('acknowledgeKustoPublication(message, true)'))
			.toBeLessThan(connectionsCase.lastIndexOf('latestConnectionsRevision = revision'));
	});

	it('keeps SQL STS editor-language traffic on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/sqlStsEditorLanguageProtocol.ts',
			'SqlStsEditorLanguageWebviewMessage',
		)).toEqual(['stsConnect', 'stsDidChange', 'stsDidClose', 'stsDidOpen', 'stsRequest']);
		expect(extractTypeDiscriminants(
			'src/shared/sqlStsEditorLanguageProtocol.ts',
			'SqlStsEditorLanguageHostMessage',
		)).toEqual(['stsConnectionState', 'stsDiagnostics', 'stsResponse']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| SqlStsEditorLanguageWebviewMessage');
		expect(webviewMessages).toContain('| SqlStsEditorLanguageWebviewMessage');
		for (const type of ['stsRequest', 'stsDidOpen', 'stsDidChange', 'stsDidClose', 'stsConnect']) {
			expect(hostTypes).not.toContain(`type: '${type}'`);
			expect(webviewMessages).not.toContain(`type: '${type}'`);
		}
		expect(webviewMessages.indexOf('admitSqlStsEditorLanguageWebviewMessage(message)'))
			.toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));

		const providers = readWorkspaceFile('src/webview/monaco/sql-sts-providers.ts');
		expect(providers.indexOf('parseSqlStsEditorLanguageWebviewMessage({'))
			.toBeLessThan(providers.indexOf('return session.requestSts<T>('));

		const section = readWorkspaceFile('src/webview/sections/kw-sql-section.ts');
		const openMethod = section.slice(
			section.indexOf('private _openStsDocumentIfNeeded'),
			section.indexOf('private _connectStsIfReady'),
		);
		expect(openMethod.indexOf('const message = admitSqlStsMessage({'))
			.toBeLessThan(openMethod.indexOf('this.sqlSession.markStsDocumentOpened();'));
		const connectMethod = section.slice(
			section.indexOf('private _connectStsIfReady'),
			section.indexOf('private _disposeEditor'),
		);
		expect(connectMethod.indexOf('const message = admitSqlStsMessage({'))
			.toBeLessThan(connectMethod.indexOf('this._openStsDocumentIfNeeded()'));
		expect(connectMethod.indexOf('const message = admitSqlStsMessage({'))
			.toBeLessThan(connectMethod.indexOf('this.sqlSession.beginStsConnect(target)'));

		const requestHandler = readWorkspaceFile('src/host/sqlEditorLifecycleApplicationHandler.ts');
		expect(requestHandler.indexOf('admitSqlStsEditorLanguageWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.options.lifecycle.handleLanguageRequest('));

		const coordinator = readWorkspaceFile('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		expect(coordinator).toContain('message: SqlStsEditorLanguageHostMessage');
		expect(coordinator.indexOf('parseSqlStsEditorLanguageHostMessage(message)', coordinator.indexOf('private postSqlStsMessageContained')))
			.toBeLessThan(coordinator.indexOf('this.postMessageContained(parsed.value', coordinator.indexOf('private postSqlStsMessageContained')));

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('admitSqlStsEditorLanguageHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('routeSqlSectionMessage(message'));

		const router = readWorkspaceFile('src/webview/core/sql-section-message-router.ts');
		expect(router.indexOf('admitSqlStsEditorLanguageHostMessage(message)'))
			.toBeLessThan(router.indexOf("case 'stsResponse':"));
		expect(router.indexOf('admitSqlStsEditorLanguageHostMessage(message)'))
			.toBeLessThan(router.indexOf('effects.handleStsResponse('));
		expect(router.indexOf('admitSqlStsEditorLanguageHostMessage(message)'))
			.toBeLessThan(router.indexOf('effects.handleStsDiagnostics('));
		expect(router.indexOf('admitSqlStsEditorLanguageHostMessage(message)'))
			.toBeLessThan(router.indexOf('section.setStsReady?.('));
	});

	it('keeps KQL language requests and responses on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/kqlLanguageProtocol.ts',
			'KqlLanguageWebviewMessage',
		)).toEqual(['kqlLanguageRequest']);
		expect(extractTypeDiscriminants(
			'src/shared/kqlLanguageProtocol.ts',
			'KqlLanguageHostMessage',
		)).toEqual(['kqlLanguageResponse']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| KqlLanguageWebviewMessage');
		expect(webviewMessages).toContain('| KqlLanguageWebviewMessage');
		expect(hostTypes).not.toContain("type: 'kqlLanguageRequest'");
		expect(webviewMessages).not.toContain("type: 'kqlLanguageRequest'");
		expect(webviewMessages).toContain('parseKqlLanguageWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/kqlLanguageRequestApplicationHandler.ts');
		expect(requestHandler.indexOf('parseKqlLanguageWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.languageHost.getDiagnostics(params)'));
		expect(requestHandler.indexOf('parseKqlLanguageWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.languageHost.findTableReferences(params)'));
		expect(requestHandler).toContain('postMessage: (message: KqlLanguageHostMessage)');

		const serviceProtocol = readWorkspaceFile('src/host/kqlLanguageService/protocol.ts');
		expect(serviceProtocol).toContain("export * from '../../shared/kqlLanguageProtocol';");
		expect(serviceProtocol).not.toContain('export type KqlLanguageRequestMessage =');
		expect(serviceProtocol).not.toContain('export type KqlLanguageResponseMessage =');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseKqlLanguageHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("case 'kqlLanguageResponse':"));
		expect(dispatcher.indexOf('parseKqlLanguageHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('const r = __kustoKqlLanguageRequestResolversById'));
		expect(dispatcher.indexOf('isKqlLanguageResponseForMethod('))
			.toBeLessThan(dispatcher.indexOf('delete __kustoKqlLanguageRequestResolversById[reqId]'));
	});

	it('keeps control-command syntax requests and results on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/controlCommandSyntaxProtocol.ts',
			'ControlCommandSyntaxWebviewMessage',
		)).toEqual(['fetchControlCommandSyntax']);
		expect(extractTypeDiscriminants(
			'src/shared/controlCommandSyntaxProtocol.ts',
			'ControlCommandSyntaxHostMessage',
		)).toEqual(['controlCommandSyntaxResult']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| ControlCommandSyntaxWebviewMessage');
		expect(webviewMessages).toContain('| ControlCommandSyntaxWebviewMessage');
		expect(hostTypes).not.toContain("type: 'fetchControlCommandSyntax'");
		expect(webviewMessages).not.toContain("type: 'fetchControlCommandSyntax'");
		expect(webviewMessages).toContain('parseControlCommandSyntaxWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/controlCommandSyntaxApplicationHandler.ts');
		expect(requestHandler.indexOf('parseControlCommandSyntaxWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.controlCommandSyntaxCache.get(commandLower)'));
		expect(requestHandler.indexOf('parseControlCommandSyntaxWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf("new URL(href, 'https://learn.microsoft.com/en-us/kusto/')"));
		expect(requestHandler).toContain('postMessage: (message: ControlCommandSyntaxHostMessage)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseControlCommandSyntaxHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("case 'controlCommandSyntaxResult':"));
		expect(dispatcher.indexOf('parseControlCommandSyntaxHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('__kustoControlCommandDocPending[result.commandLower]'));
		expect(dispatcher.indexOf('__kustoControlCommandDocPending[result.commandLower] !== result.requestId'))
			.toBeLessThan(dispatcher.indexOf('__kustoControlCommandDocCache[result.commandLower] ='));
		expect(dispatcher.indexOf('__kustoControlCommandDocPending[result.commandLower] !== result.requestId'))
			.toBeLessThan(dispatcher.indexOf('delete __kustoControlCommandDocPending[result.commandLower]'));
		expect(dispatcher.indexOf('__kustoControlCommandDocPending[result.commandLower] !== result.requestId'))
			.toBeLessThan(dispatcher.indexOf('window.__kustoRefreshActiveCaretDocs()'));
	});

	it('keeps resource URI requests and results on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/resourceUriProtocol.ts',
			'ResourceUriWebviewMessage',
		)).toEqual(['resolveResourceUri']);
		expect(extractTypeDiscriminants(
			'src/shared/resourceUriProtocol.ts',
			'ResourceUriHostMessage',
		)).toEqual(['resolveResourceUriResult']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| ResourceUriWebviewMessage');
		expect(webviewMessages).toContain('| ResourceUriWebviewMessage');
		expect(hostTypes).not.toContain("type: 'resolveResourceUri'");
		expect(webviewMessages).not.toContain("type: 'resolveResourceUri'");
		expect(webviewMessages).toContain('parseResourceUriWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/resourceUriApplicationHandler.ts');
		expect(requestHandler.indexOf('parseResourceUriWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('this.resolvedResourceUriCache.get(cacheKey)'));
		expect(requestHandler.indexOf('parseResourceUriWebviewMessage(message)'))
			.toBeLessThan(requestHandler.indexOf('await this.stat(targetUri)'));
		expect(requestHandler).toContain('postMessage: (message: ResourceUriHostMessage)');

		const markdownProvider = readWorkspaceFile('src/host/mdCompatEditorProvider.ts');
		expect(markdownProvider.indexOf('parseResourceUriWebviewMessage(message)'))
			.toBeLessThan(markdownProvider.indexOf("case 'resolveResourceUri':"));
		expect(markdownProvider.indexOf('parseResourceUriWebviewMessage(message)'))
			.toBeLessThan(markdownProvider.indexOf('vscode.workspace.fs.stat(targetUri)'));
		expect(markdownProvider).toContain('satisfies ResourceUriHostMessage');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('parseResourceUriHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("case 'resolveResourceUriResult':"));
		expect(dispatcher.indexOf('parseResourceUriHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf('__kustoResourceUriRequestResolversById[reqId]'));

		const markdownPersistence = readWorkspaceFile('src/webview/md-editor/md-persistence.ts');
		expect(markdownPersistence.indexOf('parseResourceUriHostMessage(message)'))
			.toBeLessThan(markdownPersistence.indexOf("case 'resolveResourceUriResult':"));
		expect(markdownPersistence.indexOf('parseResourceUriHostMessage(message)'))
			.toBeLessThan(markdownPersistence.indexOf('_resourceResolvers[reqId]'));
	});

	it('keeps URL content requests and deliveries on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/urlContentProtocol.ts',
			'UrlContentWebviewMessage',
		)).toEqual(['fetchUrl']);
		expect(extractTypeDiscriminants(
			'src/shared/urlContentProtocol.ts',
			'UrlContentHostMessage',
		)).toEqual(['urlContent', 'urlError']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| UrlContentWebviewMessage');
		expect(webviewMessages).toContain('| UrlContentWebviewMessage');
		expect(hostTypes).not.toContain("type: 'fetchUrl'");
		expect(webviewMessages).not.toContain("type: 'fetchUrl'");
		expect(webviewMessages).toContain('admitUrlContentWebviewMessage(message)');

		const requestHandler = readWorkspaceFile('src/host/urlContentApplicationHandler.ts');
		const requestAdmission = requestHandler.slice(requestHandler.indexOf('handleMessage('));
		const hostAdmissionIndex = requestAdmission.indexOf('admitUrlContentWebviewMessage(message)');
		const hostIdentityIndex = requestAdmission.indexOf('const boxId = message.boxId.trim()');
		const hostFetchIndex = requestAdmission.indexOf('this.fetchUrl(url.toString()');
		expect(hostAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(hostIdentityIndex).toBeGreaterThanOrEqual(0);
		expect(hostFetchIndex).toBeGreaterThanOrEqual(0);
		expect(hostAdmissionIndex).toBeLessThan(hostIdentityIndex);
		expect(hostAdmissionIndex).toBeLessThan(hostFetchIndex);
		expect(requestHandler).toContain('postMessage: (message: UrlContentHostMessage)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		const dispatcherAdmissionIndex = dispatcher.indexOf('admitUrlContentHostMessage(message)');
		const contentCaseIndex = dispatcher.indexOf("case 'urlContent':");
		const errorCaseIndex = dispatcher.indexOf("case 'urlError':");
		expect(dispatcherAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(contentCaseIndex).toBeGreaterThanOrEqual(0);
		expect(errorCaseIndex).toBeGreaterThanOrEqual(0);
		expect(dispatcherAdmissionIndex).toBeLessThan(contentCaseIndex);
		expect(dispatcherAdmissionIndex).toBeLessThan(errorCaseIndex);

		const urlSection = readWorkspaceFile('src/webview/sections/kw-url-section.ts');
		const listener = urlSection.slice(urlSection.indexOf('private _onMessage'));
		const listenerAdmissionIndex = listener.indexOf('admitUrlContentHostMessage(e.data)');
		const correlationIndex = listener.indexOf('matchesActiveRequest');
		const retirementIndex = listener.indexOf('this._activeFetchRequest = null');
		const artifactIndex = listener.indexOf('this.clearPublishedCsvResult()');
		for (const index of [listenerAdmissionIndex, correlationIndex, retirementIndex, artifactIndex]) {
			expect(index).toBeGreaterThanOrEqual(0);
		}
		expect(listenerAdmissionIndex).toBeLessThan(correlationIndex);
		expect(listenerAdmissionIndex).toBeLessThan(retirementIndex);
		expect(listenerAdmissionIndex).toBeLessThan(artifactIndex);
		expect(urlSection).toContain("postMessageToHost({ type: 'fetchUrl'");
	});

	it('keeps Python execution requests and terminals on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/pythonExecutionProtocol.ts',
			'PythonExecutionWebviewMessage',
		)).toEqual(['executePython']);
		expect(extractTypeDiscriminants(
			'src/shared/pythonExecutionProtocol.ts',
			'PythonExecutionHostMessage',
		)).toEqual(['pythonError', 'pythonResult']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| PythonExecutionWebviewMessage');
		expect(webviewMessages).toContain('| PythonExecutionWebviewMessage');
		expect(hostTypes).not.toContain("type: 'executePython'");
		expect(webviewMessages).not.toContain("type: 'executePython'");
		const wrapperAdmissionIndex = webviewMessages.indexOf('admitPythonExecutionWebviewMessage(message)');
		const captureIndex = webviewMessages.indexOf('const e2eCaptureHostMessage');
		expect(wrapperAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(wrapperAdmissionIndex).toBeLessThan(captureIndex);

		const requestHandler = readWorkspaceFile('src/host/pythonExecutionApplicationHandler.ts');
		const requestAdmission = requestHandler.slice(requestHandler.indexOf('handleMessage('));
		expect(requestAdmission.indexOf('admitPythonExecutionWebviewMessage(message)'))
			.toBeLessThan(requestAdmission.indexOf('const cwd = this.getWorkingDirectory()'));
		expect(requestAdmission.indexOf('admitPythonExecutionWebviewMessage(message)'))
			.toBeLessThan(requestAdmission.indexOf('this.runOnce('));
		expect(requestHandler).toContain('postMessage: (message: PythonExecutionHostMessage)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		const dispatcherAdmissionIndex = dispatcher.indexOf('admitPythonExecutionHostMessage(message)');
		expect(dispatcherAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf('const incomingType'));
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf("case 'pythonResult':"));
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf("case 'pythonError':"));

		const sectionFactory = readWorkspaceFile('src/webview/core/section-factory.ts');
		for (const functionName of ['onPythonResult', 'onPythonError']) {
			const terminalHandler = sectionFactory.slice(sectionFactory.indexOf(`export function ${functionName}`));
			expect(terminalHandler.indexOf('admitPythonExecutionHostMessage(message)'))
				.toBeLessThan(terminalHandler.indexOf('consumePythonExecutionTerminal(boxId)'));
		}
		expect(sectionFactory).not.toContain('function runPythonBox');

		const pythonSection = readWorkspaceFile('src/webview/sections/kw-python-section.ts');
		expect(pythonSection.indexOf('parsePythonExecutionWebviewMessage({'))
			.toBeLessThan(pythonSection.indexOf('reservePythonExecution(request.value.boxId'));
		expect(pythonSection.indexOf('parsePythonExecutionWebviewMessage({'))
			.toBeLessThan(pythonSection.indexOf("this._output = 'Running…'"));
		expect(pythonSection).toContain('postMessageToHost(request.value)');
		expect(pythonSection).not.toContain("vscode.postMessage({ type: 'executePython'");
	});

	it('keeps artifact CSV intents and transfers on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/artifactCsvSaveProtocol.ts',
			'ArtifactCsvSaveWebviewMessage',
		)).toEqual(['artifactCsvSaveData', 'cancelArtifactCsvSaveIntent', 'requestArtifactCsvSave']);
		expect(extractTypeDiscriminants(
			'src/shared/artifactCsvSaveProtocol.ts',
			'ArtifactCsvSaveHostMessage',
		)).toEqual(['cancelArtifactCsvSave', 'requestArtifactCsvSaveData']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| ArtifactCsvSaveWebviewMessage');
		expect(webviewMessages).toContain('| ArtifactCsvSaveWebviewMessage');
		for (const type of ['requestArtifactCsvSave', 'artifactCsvSaveData', 'cancelArtifactCsvSaveIntent']) {
			expect(hostTypes).not.toContain(`type: '${type}'`);
			expect(webviewMessages).not.toContain(`type: '${type}'`);
		}
		const wrapperAdmissionIndex = webviewMessages.indexOf('admitArtifactCsvSaveWebviewMessage(message)');
		const captureIndex = webviewMessages.indexOf('const e2eCaptureHostMessage');
		expect(wrapperAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(wrapperAdmissionIndex).toBeLessThan(captureIndex);

		const handler = readWorkspaceFile('src/host/artifactCsvSaveApplicationHandler.ts');
		const handlerAdmissionIndex = handler.indexOf('admitArtifactCsvSaveWebviewMessage(message)');
		expect(handlerAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('vscode.window.showSaveDialog'));
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('this.pendingArtifactCsvSaves.get(requestId)'));
		expect(handler).toContain('postMessage: (message: ArtifactCsvSaveHostMessage)');
		expect(handler.indexOf('parseArtifactCsvSaveHostMessage(message)'))
			.toBeLessThan(handler.indexOf('this.options.postMessage(parsed.value)'));

		const gateway = readWorkspaceFile('src/host/mainWebviewStartupGateway.ts');
		expect(gateway.indexOf('admitArtifactCsvSaveWebviewMessage(input)'))
			.toBeLessThan(gateway.indexOf('this.options.admitInbound(input)'));

		const dispatcher = readWorkspaceFile('src/webview/core/message-handler.ts')
			.slice(readWorkspaceFile('src/webview/core/message-handler.ts').indexOf('const __kustoDispatchHostMessage'));
		expect(dispatcher.indexOf('admitArtifactCsvSaveHostMessage(message)'))
			.toBeLessThan(dispatcher.indexOf("case 'requestArtifactCsvSaveData':"));

		const exportGate = readWorkspaceFile('src/webview/shared/artifact-csv-export.ts');
		const transfer = exportGate.slice(exportGate.indexOf('export function provideArtifactCsvSaveData'));
		expect(transfer.indexOf('admitArtifactCsvSaveHostMessage(message)'))
			.toBeLessThan(transfer.indexOf('takePending(challenge.exportId)'));
		expect(transfer.indexOf('candidate.sourceBoxId !== challenge.boxId'))
			.toBeLessThan(transfer.indexOf('takePending(challenge.exportId)'));
		expect(transfer.indexOf('candidate.artifactId !== challenge.artifactId'))
			.toBeLessThan(transfer.indexOf('takePending(challenge.exportId)'));
		expect(transfer.indexOf('admitArtifactCsvSaveHostMessage(message)'))
			.toBeLessThan(transfer.indexOf('bindResultArtifactConsumer('));

		const browserShim = readWorkspaceFile('browser-ext/vscode-shim.js');
		expect(browserShim).toContain("from '../src/shared/artifactCsvSaveProtocol.js'");
		const browserDispatch = browserShim.slice(browserShim.indexOf('postMessage: function(message)'));
		expect(browserDispatch.indexOf('admitArtifactCsvSaveWebviewMessage(message)'))
			.toBeLessThan(browserDispatch.indexOf('acceptArtifactCsvData(governedMessage)'));
		expect(browserDispatch.indexOf('admitArtifactCsvSaveWebviewMessage(message)'))
			.toBeLessThan(browserDispatch.indexOf('downloadCsv(message.csv'));
	});

	it('keeps query sharing requests and delivery on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/querySharingProtocol.ts',
			'QuerySharingWebviewMessage',
		)).toEqual(['copyAdeLink', 'shareToClipboard']);
		expect(extractTypeDiscriminants(
			'src/shared/querySharingProtocol.ts',
			'QuerySharingHostMessage',
		)).toEqual(['shareContentReady']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| QuerySharingWebviewMessage');
		expect(webviewMessages).toContain('| QuerySharingWebviewMessage');
		for (const type of ['copyAdeLink', 'shareToClipboard']) {
			expect(hostTypes).not.toContain(`type: '${type}'`);
			expect(webviewMessages).not.toContain(`type: '${type}'`);
		}
		const wrapperAdmissionIndex = webviewMessages.indexOf('admitQuerySharingWebviewMessage(message)');
		const captureIndex = webviewMessages.indexOf('const e2eCaptureHostMessage');
		expect(wrapperAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(wrapperAdmissionIndex).toBeLessThan(captureIndex);

		const handler = readWorkspaceFile('src/host/querySharingApplicationHandler.ts');
		const handlerAdmissionIndex = handler.indexOf('admitQuerySharingWebviewMessage(message)');
		expect(handlerAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('this.options.findConnection('));
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('const htmlParts: string[]'));
		expect(handler).toContain('postMessage: (message: QuerySharingHostMessage)');
		expect(handler.indexOf('parseQuerySharingHostMessage(message)'))
			.toBeLessThan(handler.indexOf('this.options.postMessage(parsed.value)'));
		expect(handler).not.toContain("type: 'showInfo'");
		expect(handler).toContain("showInformationMessage('Azure Data Explorer link copied to clipboard.')");

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		const dispatcherAdmissionIndex = dispatcher.indexOf('admitQuerySharingHostMessage(message)');
		expect(dispatcherAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf("case 'shareContentReady':"));
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf('navigator.clipboard.write('));
	});

	it('keeps Copilot inline-completion requests and results on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/copilotInlineCompletionProtocol.ts',
			'CopilotInlineCompletionWebviewMessage',
		)).toEqual(['requestCopilotInlineCompletion']);
		expect(extractTypeDiscriminants(
			'src/shared/copilotInlineCompletionProtocol.ts',
			'CopilotInlineCompletionHostMessage',
		)).toEqual(['copilotInlineCompletionResult']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| CopilotInlineCompletionWebviewMessage');
		expect(webviewMessages).toContain('| CopilotInlineCompletionWebviewMessage');
		expect(hostTypes).not.toContain("type: 'requestCopilotInlineCompletion'");
		expect(webviewMessages).not.toContain("type: 'requestCopilotInlineCompletion'");
		const wrapperAdmissionIndex = webviewMessages.indexOf('admitCopilotInlineCompletionWebviewMessage(message)');
		expect(wrapperAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(wrapperAdmissionIndex).toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));

		const handler = readWorkspaceFile('src/host/copilotInlineCompletionApplicationHandler.ts');
		const handlerAdmissionIndex = handler.indexOf('admitCopilotInlineCompletionWebviewMessage(message)');
		expect(handlerAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('this.options.assertSqlOwnerToken('));
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('this.options.handleCopilotInlineCompletionRequest('));
		expect(handler).toContain('postMessage: (message: CopilotInlineCompletionHostMessage)');
		expect(handler.indexOf('parseCopilotInlineCompletionHostMessage(message)'))
			.toBeLessThan(handler.indexOf('this.options.postMessage(parsed.value)'));

		const copilot = readWorkspaceFile('src/host/queryEditorCopilot.ts');
		const inlineCopilot = copilot.slice(
			copilot.indexOf('async handleCopilotInlineCompletionRequest('),
			copilot.indexOf('async prepareCopilotWriteQuery('),
		);
		expect(inlineCopilot.indexOf('parseCopilotInlineCompletionHostMessage(result)'))
			.toBeLessThan(inlineCopilot.indexOf('this.host.postMessage(parsed.value)'));
		expect(inlineCopilot).not.toContain("String(message.requestId || '').trim()");
		expect(inlineCopilot).not.toContain("String(message.boxId || '').trim()");

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		const dispatcherAdmissionIndex = dispatcher.indexOf('admitCopilotInlineCompletionHostMessage(message)');
		expect(dispatcherAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf('routeSqlSectionMessage(message'));
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf("case 'copilotInlineCompletionResult':"));

		const sqlRouter = readWorkspaceFile('src/webview/core/sql-section-message-router.ts');
		const router = sqlRouter.slice(sqlRouter.indexOf('export function routeSqlSectionMessage'));
		expect(router.indexOf('admitCopilotInlineCompletionHostMessage(message)'))
			.toBeLessThan(router.indexOf('admitOwnerSensitiveMessage(boxId, message, effects)'));
	});

	it('keeps editing preference setters and delivery on one runtime-validated shared channel', () => {
		expect(extractTypeDiscriminants(
			'src/shared/editingPreferences.ts',
			'EditingPreferencesWebviewMessage',
		)).toEqual([
			'setAutoTriggerAutocompleteEnabled',
			'setCaretDocsEnabled',
			'setCopilotInlineCompletionsEnabled',
		]);
		expect(extractTypeDiscriminants(
			'src/shared/editingPreferences.ts',
			'EditingPreferencesHostMessage',
		)).toEqual(['editingPreferencesData']);

		const hostTypes = readWorkspaceFile('src/host/queryEditorTypes.ts');
		const webviewMessages = readWorkspaceFile('src/webview/shared/webview-messages.ts');
		expect(hostTypes).toContain('| EditingPreferencesWebviewMessage');
		expect(webviewMessages).toContain('| EditingPreferencesWebviewMessage');
		for (const type of [
			'setCaretDocsEnabled',
			'setAutoTriggerAutocompleteEnabled',
			'setCopilotInlineCompletionsEnabled',
		]) {
			expect(hostTypes).not.toContain(`type: '${type}'`);
			expect(webviewMessages).not.toContain(`type: '${type}'`);
		}
		const wrapperAdmissionIndex = webviewMessages.indexOf('admitEditingPreferencesWebviewMessage(message)');
		expect(wrapperAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(wrapperAdmissionIndex).toBeLessThan(webviewMessages.indexOf('const e2eCaptureHostMessage'));

		const handler = readWorkspaceFile('src/host/editingPreferencesApplicationHandler.ts');
		const handlerAdmissionIndex = handler.indexOf('admitEditingPreferencesWebviewMessage(message)');
		expect(handlerAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(handlerAdmissionIndex).toBeLessThan(handler.indexOf('setEditingPreference('));
		expect(handler).not.toContain('!!message.enabled');
		expect(handler.indexOf('parseEditingPreferencesHostMessage(preferences)'))
			.toBeLessThan(handler.indexOf('publisher.postToAllWebviews(parsed.value)'));
		expect(handler.indexOf('parseEditingPreferencesHostMessage(preferences)'))
			.toBeLessThan(handler.indexOf('this.options.postMessage(parsed.value)'));

		const hostPreferences = readWorkspaceFile('src/host/editingPreferences.ts');
		expect(hostPreferences.indexOf('parseEditingPreferencesHostMessage(message)'))
			.toBeLessThan(hostPreferences.indexOf('return parsed.value'));
		const firstLaunch = readWorkspaceFile('src/host/firstLaunch/firstLaunchCoordinator.ts');
		expect(firstLaunch.indexOf('parseEditingPreferencesHostMessage(message)'))
			.toBeLessThan(firstLaunch.indexOf('this.options.broadcastEditingPreferences(parsed.value)'));
		const extension = readWorkspaceFile('src/host/extension.ts');
		expect(extension).toContain('parseEditingPreferencesHostMessage(message)');
		expect(extension).toContain('toolOrchestrator.postToAllWebviews(parsed.value)');

		const messageHandler = readWorkspaceFile('src/webview/core/message-handler.ts');
		const dispatcher = messageHandler.slice(messageHandler.indexOf('const __kustoDispatchHostMessage'));
		const dispatcherAdmissionIndex = dispatcher.indexOf('admitEditingPreferencesHostMessage(message)');
		expect(dispatcherAdmissionIndex).toBeGreaterThanOrEqual(0);
		expect(dispatcherAdmissionIndex).toBeLessThan(dispatcher.indexOf("case 'editingPreferencesData':"));
		const application = readWorkspaceFile('src/webview/core/editing-preferences.ts');
		expect(application.indexOf('parseEditingPreferencesHostMessage(message)'))
			.toBeLessThan(application.indexOf('if (revision < latestRevision)'));
		expect(application.indexOf('parseEditingPreferencesHostMessage(message)'))
			.toBeLessThan(application.indexOf('setCaretDocsEnabled(preferences.caretDocsEnabled)'));
		expect(application.indexOf('applyCaretDocsPresentation(preferences.caretDocsEnabled)'))
			.toBeLessThan(application.indexOf('latestRevision = revision'));
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
			[...new Set([
				...extractTypeDiscriminants('src/host/queryEditorTypes.ts', 'IncomingWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kustoSchemaProtocol.ts', 'KustoSchemaWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kustoDatabaseDiscoveryProtocol.ts', 'KustoDatabaseDiscoveryWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlDatabaseDiscoveryProtocol.ts', 'SqlDatabaseDiscoveryWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlSchemaProtocol.ts', 'SqlSchemaWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kqlLanguageProtocol.ts', 'KqlLanguageWebviewMessage'),
				...extractTypeDiscriminants('src/shared/controlCommandSyntaxProtocol.ts', 'ControlCommandSyntaxWebviewMessage'),
				...extractTypeDiscriminants('src/shared/resourceUriProtocol.ts', 'ResourceUriWebviewMessage'),
				...extractTypeDiscriminants('src/shared/pythonExecutionProtocol.ts', 'PythonExecutionWebviewMessage'),
				...extractTypeDiscriminants('src/shared/urlContentProtocol.ts', 'UrlContentWebviewMessage'),
				...extractTypeDiscriminants('src/shared/artifactCsvSaveProtocol.ts', 'ArtifactCsvSaveWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlStsEditorLanguageProtocol.ts', 'SqlStsEditorLanguageWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlConnectionsProjectionProtocol.ts', 'SqlConnectionsProjectionWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kustoConnectionsProjectionProtocol.ts', 'KustoConnectionsProjectionWebviewMessage'),
				...extractTypeDiscriminants('src/shared/querySharingProtocol.ts', 'QuerySharingWebviewMessage'),
				...extractTypeDiscriminants('src/shared/editingPreferences.ts', 'EditingPreferencesWebviewMessage'),
				...extractTypeDiscriminants('src/shared/copilotInlineCompletionProtocol.ts', 'CopilotInlineCompletionWebviewMessage'),
			])].sort()
		);
	});

	it('OUTGOING_WEBVIEW_MESSAGE_TYPES matches the OutgoingWebviewMessage source union', () => {
		expect([...OUTGOING_WEBVIEW_MESSAGE_TYPES].sort()).toEqual(
			[...new Set([
				...extractTypeDiscriminants('src/webview/shared/webview-messages.ts', 'OutgoingWebviewMessage'),
				...extractTypeDiscriminants('src/shared/documentViewProtocol.ts', 'DocumentViewWebviewMessage'),
				...extractTypeDiscriminants('src/shared/compatibilityPersistenceProtocol.ts', 'CompatibilityPersistenceWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kustoSchemaProtocol.ts', 'KustoSchemaWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kustoDatabaseDiscoveryProtocol.ts', 'KustoDatabaseDiscoveryWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlDatabaseDiscoveryProtocol.ts', 'SqlDatabaseDiscoveryWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlSchemaProtocol.ts', 'SqlSchemaWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kqlLanguageProtocol.ts', 'KqlLanguageWebviewMessage'),
				...extractTypeDiscriminants('src/shared/controlCommandSyntaxProtocol.ts', 'ControlCommandSyntaxWebviewMessage'),
				...extractTypeDiscriminants('src/shared/resourceUriProtocol.ts', 'ResourceUriWebviewMessage'),
				...extractTypeDiscriminants('src/shared/pythonExecutionProtocol.ts', 'PythonExecutionWebviewMessage'),
				...extractTypeDiscriminants('src/shared/urlContentProtocol.ts', 'UrlContentWebviewMessage'),
				...extractTypeDiscriminants('src/shared/artifactCsvSaveProtocol.ts', 'ArtifactCsvSaveWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlStsEditorLanguageProtocol.ts', 'SqlStsEditorLanguageWebviewMessage'),
				...extractTypeDiscriminants('src/shared/sqlConnectionsProjectionProtocol.ts', 'SqlConnectionsProjectionWebviewMessage'),
				...extractTypeDiscriminants('src/shared/kustoConnectionsProjectionProtocol.ts', 'KustoConnectionsProjectionWebviewMessage'),
				...extractTypeDiscriminants('src/shared/querySharingProtocol.ts', 'QuerySharingWebviewMessage'),
				...extractTypeDiscriminants('src/shared/editingPreferences.ts', 'EditingPreferencesWebviewMessage'),
				...extractTypeDiscriminants('src/shared/copilotInlineCompletionProtocol.ts', 'CopilotInlineCompletionWebviewMessage'),
			])].sort()
		);
		expect(extractStringArrayVariable(
			'src/webview/shared/webview-messages.ts',
			'runtimeOutgoingWebviewMessageTypes',
		).sort()).toEqual([...OUTGOING_WEBVIEW_MESSAGE_TYPES].sort());
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

		it('extracts the shared compatibility persist acknowledgement sender', () => {
			const extraction = extractPostMessageTypes('src/host/compatSidecarPersistCoordinator.ts');
			expect(extraction.types).toEqual(['persistDocumentAck']);
			expect(extraction.dynamicSites).toEqual([]);
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

		it('keeps the SQL editor lifecycle handler response-free', () => {
			const extraction = extractPostMessageTypes(
				'src/host/sqlEditorLifecycleApplicationHandler.ts',
			);
			expect(extraction).toEqual({ types: [], dynamicSites: [] });
		});

		it('keeps the Kusto schema request handler response-free', () => {
			const extraction = extractPostMessageTypes(
				'src/host/kustoSchemaRequestApplicationHandler.ts',
			);
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
			expect(extraction.types).toEqual(['shareContentReady']);
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

		it('extracts tutorial senders and their targeted listeners', () => {
			const embeddedHost = extractPostMessageTypes('src/host/tutorials/embeddedTutorialWebviewHost.ts');
			const session = extractPostMessageTypes('src/host/tutorials/tutorialWebviewSession.ts');
			expect(embeddedHost.types).toEqual(expect.arrayContaining([
				'hideEmbeddedTutorialViewer',
				'showEmbeddedTutorialViewer',
			]));
			expect(session.types).toEqual(expect.arrayContaining(['error', 'snapshot', 'tutorialContent']));
			const overlay = readWorkspaceFile('src/webview/tutorials/embedded-tutorial-overlay.ts');
			const viewer = readWorkspaceFile('src/webview/tutorials/kw-tutorial-viewer.ts');
			for (const type of [
				'error', 'hideEmbeddedTutorialViewer', 'showEmbeddedTutorialViewer', 'snapshot', 'tutorialContent',
			]) {
				expect(`${overlay}\n${viewer}`).toMatch(new RegExp(`(?:message\\.)?type === ['"]${type}['"]`));
			}
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

function makeSchemaDataMessage(): KustoSchemaData {
	return {
		type: 'schemaData' as const,
		boxId: 'query_1',
		connectionId: 'conn_1',
		database: 'Logs',
		clusterUrl: 'https://cluster1.kusto.windows.net',
		accountPartition: 'account-1',
		requestToken: 'tok_abc123',
		schema: {
			tables: ['StormEvents', 'PopulationData'],
			columnTypesByTable: {
				StormEvents: { StartTime: 'datetime', State: 'string', EventType: 'string', DamageProperty: 'long' },
				PopulationData: { State: 'string', Population: 'long' },
			},
			functions: [
				{
					name: 'GetTopStorms',
					parametersText: '(n:int)',
					parameters: [{ name: 'n', type: 'int' }],
					body: 'StormEvents | top n by DamageProperty',
				},
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
