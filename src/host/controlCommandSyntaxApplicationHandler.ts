import { getErrorMessage } from './queryEditorUtils';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import {
	isControlCommandSyntaxWebviewMessageType,
	parseControlCommandSyntaxWebviewMessage,
	type ControlCommandSyntaxHostMessage,
	type ControlCommandSyntaxRequestMessage,
} from '../shared/controlCommandSyntaxProtocol';

const CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type ControlCommandSyntaxCacheEntry = {
	timestamp: number;
	syntax: string;
	withArgs: string[];
	error?: string;
};

export interface ControlCommandSyntaxApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type ControlCommandSyntaxApplicationHandlerOptions = {
	postMessage: (message: ControlCommandSyntaxHostMessage) => Thenable<boolean>;
	fetchLearn?: typeof fetch;
	now?: () => number;
};

export class HostControlCommandSyntaxApplicationHandler implements ControlCommandSyntaxApplicationHandler {
	private readonly controlCommandSyntaxCache = new Map<string, ControlCommandSyntaxCacheEntry>();
	private readonly fetchLearn: typeof fetch;
	private readonly now: () => number;
	private disposed = false;

	constructor(private readonly options: ControlCommandSyntaxApplicationHandlerOptions) {
		this.fetchLearn = options.fetchLearn ?? fetch;
		this.now = options.now ?? Date.now;
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (!isControlCommandSyntaxWebviewMessageType(message)) return undefined;
		const parsed = parseControlCommandSyntaxWebviewMessage(message);
		if (!parsed.ok) return Promise.resolve();
		return this.handleFetchControlCommandSyntax(parsed.value);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.controlCommandSyntaxCache.clear();
	}

	private postMessage(message: ControlCommandSyntaxHostMessage): void {
		if (this.disposed) return;
		this.options.postMessage(message);
	}

	private decodeHtmlEntities(text: string): string {
		try {
			return String(text || '')
				.replace(/&nbsp;/gi, ' ')
				.replace(/&lt;/gi, '<')
				.replace(/&gt;/gi, '>')
				.replace(/&amp;/gi, '&')
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, "'")
				.replace(/&#x27;/gi, "'");
		} catch {
			return String(text || '');
		}
	}

	private extractControlCommandSyntaxFromLearnHtml(html: string): string {
		try {
			const source = String(html || '');
			if (!source.trim()) return '';

			let preBlock = '';
			try {
				const match = source.match(/<h2[^>]*>\s*Syntax\s*<\/h2>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
				if (match?.[1]) preBlock = String(match[1]);
			} catch {
				preBlock = '';
			}

			if (!preBlock) {
				try {
					const match = source.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
					if (match?.[1]) preBlock = String(match[1]);
				} catch {
					preBlock = '';
				}
			}

			if (!preBlock) return '';
			const withoutTags = preBlock
				.replace(/<code[^>]*>/gi, '')
				.replace(/<\/code>/gi, '')
				.replace(/<[^>]+>/g, '');
			const decoded = this.decodeHtmlEntities(withoutTags);
			const normalized = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
			const lines = normalized.split('\n');
			while (lines.length && !String(lines[0] || '').trim()) lines.shift();
			while (lines.length && !String(lines[lines.length - 1] || '').trim()) lines.pop();
			return lines.join('\n').trim();
		} catch {
			return '';
		}
	}

	private extractWithArgsFromSyntax(syntax: string): string[] {
		try {
			const source = String(syntax || '');
			if (!source) return [];
			const match = source.match(/\bwith\s*\(([\s\S]*?)\)/i);
			if (!match?.[1]) return [];
			const inside = String(match[1]);
			const withArgs: string[] = [];
			const seen = new Set<string>();
			for (const argumentMatch of inside.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
				const name = String(argumentMatch[1] || '').trim();
				if (!name) continue;
				const lower = name.toLowerCase();
				if (seen.has(lower)) continue;
				seen.add(lower);
				withArgs.push(name);
			}
			return withArgs;
		} catch {
			return [];
		}
	}

	private async handleFetchControlCommandSyntax(message: ControlCommandSyntaxRequestMessage): Promise<void> {
		if (this.disposed) return;
		const { requestId, commandLower, href } = message;

		try {
			const now = this.now();
			const cached = this.controlCommandSyntaxCache.get(commandLower);
			if (cached && (now - cached.timestamp) < CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS) {
				this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: true, syntax: cached.syntax, withArgs: cached.withArgs });
				return;
			}

			const url = new URL(href, 'https://learn.microsoft.com/en-us/kusto/');
			url.searchParams.set('view', 'azure-data-explorer');
			const response = await this.fetchLearn(url.toString(), { method: 'GET' });
			if (this.disposed) return;
			if (!response.ok) throw new Error(`Failed to fetch control command syntax (HTTP ${response.status})`);
			const html = await response.text();
			if (this.disposed) return;
			const syntax = this.extractControlCommandSyntaxFromLearnHtml(html);
			const withArgs = this.extractWithArgsFromSyntax(syntax);
			this.controlCommandSyntaxCache.set(commandLower, { timestamp: this.now(), syntax, withArgs });
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: true, syntax, withArgs });
		} catch (error) {
			if (this.disposed) return;
			this.controlCommandSyntaxCache.set(commandLower, {
				timestamp: this.now(), syntax: '', withArgs: [], error: getErrorMessage(error),
			});
			this.postMessage({ type: 'controlCommandSyntaxResult', requestId, commandLower, ok: false, syntax: '', withArgs: [] });
		}
	}
}