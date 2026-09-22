import * as vscode from 'vscode';
import type { CanonicalWorkbenchToolContribution } from '../shared/externalMcpCatalog';
import type { WorkbenchMcpToolDefinition } from './workbenchMcpBridge';
import { DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION } from './schemaIndexUtils';

const GET_SCHEMA_REGISTERED_NAME = 'kusto-workbench_get-schema';
const REFRESH_SCHEMA_REGISTERED_NAME = 'kusto-workbench_refresh-schema';
const FALLBACK_SCHEMA_TOKEN_BUDGET = 8_192;

interface RegisteredLanguageModelTool {
	name: string;
	description: string;
	inputSchema?: object;
}

type TokenCounterModel = Pick<vscode.LanguageModelChat, 'countTokens' | 'maxInputTokens'>;

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function buildWorkbenchMcpToolDefinitions(
	contributions: readonly CanonicalWorkbenchToolContribution[],
	registeredTools: readonly RegisteredLanguageModelTool[],
): WorkbenchMcpToolDefinition[] {
	const publicNames = new Set<string>();
	return contributions.map(contribution => {
		const registered = registeredTools.find(tool => tool.name === contribution.name);
		if (!registered) throw new Error(`Workbench tool is not registered: ${contribution.name}`);
		if (!registered.inputSchema) throw new Error(`Registered Workbench tool has no input schema: ${contribution.name}`);
		if (registered.description !== contribution.modelDescription
			|| JSON.stringify(registered.inputSchema) !== JSON.stringify(contribution.inputSchema)) {
			throw new Error(`Workbench tool metadata does not match its live registration: ${contribution.name}`);
		}
		if (!contribution.toolReferenceName || publicNames.has(contribution.toolReferenceName)) {
			throw new Error(`Workbench tool reference name is missing or duplicated: ${contribution.toolReferenceName || contribution.name}`);
		}
		publicNames.add(contribution.toolReferenceName);
		return {
			name: contribution.toolReferenceName,
			registeredName: contribution.name,
			...(contribution.displayName ? { title: contribution.displayName } : {}),
			description: contribution.modelDescription,
			inputSchema: contribution.inputSchema as Record<string, unknown>,
		};
	});
}

export async function createWorkbenchToolTokenizationOptions(
	registeredName: string,
	modelFamily: string | undefined,
	token: vscode.CancellationToken,
	selectModels: (selector: vscode.LanguageModelChatSelector) => Thenable<readonly TokenCounterModel[]>,
): Promise<vscode.LanguageModelToolTokenizationOptions | undefined> {
	if (registeredName !== GET_SCHEMA_REGISTERED_NAME && registeredName !== REFRESH_SCHEMA_REGISTERED_NAME) return undefined;
	let model: TokenCounterModel | undefined;
	try {
		const preferred = modelFamily ? await selectModels({ vendor: 'copilot', family: modelFamily }) : [];
		model = preferred[0] ?? (await selectModels({ vendor: 'copilot' }))[0];
	} catch {
		model = undefined;
	}
	if (!model || model.maxInputTokens <= 0) {
		return { tokenBudget: FALLBACK_SCHEMA_TOKEN_BUDGET, countTokens: async text => estimateTokens(text) };
	}
	return {
		tokenBudget: Math.max(1, Math.floor(model.maxInputTokens * DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION)),
		countTokens: async (text, countToken) => {
			try {
				return await model.countTokens(text, countToken ?? token);
			} catch {
				return estimateTokens(text);
			}
		},
	};
}