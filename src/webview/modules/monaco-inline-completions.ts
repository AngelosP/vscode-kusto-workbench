// This file is intentionally empty — inline completions remain in monaco.ts.
// DELETE THIS FILE. It exists only because the extraction script created it
// and the terminal policy prevents deletion.
export {};

// --- Copilot inline completions Provider ---
// Uses an async provider that awaits the LLM response. The provider
// intentionally does NOT hook token.onCancellationRequested — Monaco
// aggressively cancels manual triggers, which would kill the pending
// request before the response arrives. Instead we let the promise
// resolve naturally and Monaco renders the items if it's still interested.

let __kustoInlineCompletionRequestId = 0;
// Content widget for the inline completion spinner.
const __kustoInlineSpinnerWidgets: Record<string, any> = {};

// CSS for the spinner — inject once.
try {
	const spinnerStyle = document.createElement('style');
	spinnerStyle.textContent = `
		@keyframes kusto-inline-ghost-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
		.kusto-inline-spinner-widget {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			pointer-events: none;
			z-index: 1;
			padding: 0 4px;
			animation: kusto-inline-ghost-pulse 1.2s ease-in-out infinite;
		}
		.kusto-inline-spinner-icon {
			display: inline-block;
			width: 14px;
			height: 14px;
			color: var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.7));
		}
		.kusto-inline-spinner-icon svg {
			width: 100%;
			height: 100%;
		}
		.kusto-inline-spinner-label {
			font-size: 11px;
			color: var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.7));
			font-style: italic;
			white-space: nowrap;
		}
	`;
	document.head.appendChild(spinnerStyle);
} catch { /* ignore */ }

const __kustoShowInlineSpinner = (editor: any, boxId: string, lineNumber: number, column: number) => {
	try {
		__kustoHideInlineSpinner(editor, boxId);
		const domNode = document.createElement('div');
		domNode.className = 'kusto-inline-spinner-widget';
		domNode.innerHTML = '<span class="kusto-inline-spinner-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1C5.2 1 3 3.2 3 6v6c0 .3.1.6.4.8.2.2.5.2.8.1l1.3-.7 1.3.7c.3.2.7.2 1 0L8 12.2l.2.7c.3.2.7.2 1 0l1.3-.7 1.3.7c.3.1.6.1.8-.1.3-.2.4-.5.4-.8V6c0-2.8-2.2-5-5-5zm-2 6.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm4 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/></svg></span>';
		const widget = {
			getId: () => 'kusto-inline-spinner-' + boxId,
			getDomNode: () => domNode,
			getPosition: () => ({
				position: { lineNumber, column },
				preference: [2, 1]
			}),
		};
		editor.addContentWidget(widget);
		__kustoInlineSpinnerWidgets[boxId] = widget;
	} catch { /* ignore */ }
};
const __kustoHideInlineSpinner = (editor: any, boxId: string) => {
	try {
		const existing = __kustoInlineSpinnerWidgets[boxId];
		if (existing) {
			editor.removeContentWidget(existing);
			delete __kustoInlineSpinnerWidgets[boxId];
		}
	} catch { /* ignore */ }
};

// The result handler is still needed for main.ts message dispatch.
// It resolves the pending promise.
_win.__kustoHandleInlineCompletionResult = (requestId: string, completions: any[]) => {
	const pending = copilotInlineCompletionRequests[requestId];
	if (!pending || typeof pending.resolve !== 'function') return;
	delete copilotInlineCompletionRequests[requestId];
	pending.resolve(completions || []);
};

monaco.languages.registerInlineCompletionsProvider('kusto', {
	provideInlineCompletions: async function (model: any, position: any, context: any, _token: any) {
		try {
			const isManualTrigger = context && context.triggerKind === 1;

			// Check if automatic inline completions are enabled
			if (!isManualTrigger && typeof copilotInlineCompletionsEnabled !== 'undefined' && !copilotInlineCompletionsEnabled) {
				return { items: [] };
			}

			// Don't provide completions if we're in a comment
			const lineContent = model.getLineContent(position.lineNumber);
			const textBeforeOnLine = lineContent.substring(0, position.column - 1);
			if (textBeforeOnLine.includes('//')) {
				return { items: [] };
			}

			// Get text before and after cursor
			const fullText = model.getValue();
			const offset = model.getOffsetAt(position);
			const textBefore = fullText.substring(0, offset);
			const textAfter = fullText.substring(offset);

			// Don't trigger if editor is empty
			if (!textBefore.trim() && !textAfter.trim()) {
				return { items: [] };
			}

			const requestId = 'inline_' + (++__kustoInlineCompletionRequestId) + '_' + Date.now();

			// Find the boxId and editor
			let boxId = '';
			let editorForModel: any = null;
			try {
				const modelUri = model.uri ? model.uri.toString() : '';
				if (typeof queryEditorBoxByModelUri !== 'undefined' && modelUri) {
					boxId = queryEditorBoxByModelUri[modelUri] || '';
				}
				if (boxId && queryEditors) {
					editorForModel = queryEditors[boxId] || null;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Show spinner
			if (editorForModel && boxId) {
				__kustoShowInlineSpinner(editorForModel, boxId, position.lineNumber, position.column);
			}

			// Create promise that resolves when the extension host responds.
			// IMPORTANT: we do NOT hook token.onCancellationRequested — Monaco
			// aggressively cancels especially for manual triggers, which would
			// delete the pending request before the LLM can respond.
			const completionPromise = new Promise<any[]>((resolve) => {
				const timeoutId = setTimeout(() => {
					delete copilotInlineCompletionRequests[requestId];
					resolve([]);
				}, 10000);

				copilotInlineCompletionRequests[requestId] = {
					resolve: (completions: any) => {
						clearTimeout(timeoutId);
						resolve(completions);
					}
				};
			});

			// Send request to extension host
			try {
				postMessageToHost({
					type: 'requestCopilotInlineCompletion',
					requestId,
					boxId,
					textBefore,
					textAfter
				});
			} catch (err) {
				delete copilotInlineCompletionRequests[requestId];
				if (editorForModel && boxId) __kustoHideInlineSpinner(editorForModel, boxId);
				return { items: [] };
			}

			// Await response
			const completions = await completionPromise;

			// Hide spinner
			if (editorForModel && boxId) {
				__kustoHideInlineSpinner(editorForModel, boxId);
			}

			if (!completions || !Array.isArray(completions) || completions.length === 0) {
				return { items: [] };
			}

			// Convert to Monaco inline completion items
			const items = completions.map(c => ({
				insertText: c.insertText || '',
				range: new monaco.Range(
					position.lineNumber,
					position.column,
					position.lineNumber,
					position.column
				)
			})).filter(item => item.insertText);

			return { items };
		} catch {
			return { items: [] };
		}
	},
	freeInlineCompletions: function () {
		// No cleanup needed
	}
});
