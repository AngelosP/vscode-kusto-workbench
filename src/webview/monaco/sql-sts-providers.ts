// STS (SqlToolsService) Monaco providers — completions, hover, signature help, diagnostics.
//
// Completions: when STS is connected and ready, we delegate to STS via JSON-RPC
// for full context-aware IntelliSense (columns in SELECT/WHERE/ORDER BY/GROUP BY,
// alias resolution, subqueries, CTEs, etc.). Falls back to local schema-based
// completions when STS is not available.
//
// Hover and signature help also use STS over JSON-RPC.

import { postMessageToHost } from '../shared/webview-messages.js';

const _win = window as any;

// ── STS readiness tracking per boxId ───────────────────────────────────────
const _stsReadyByBoxId: Record<string, boolean> = {};

/** Mark a boxId as STS-ready (called from kw-sql-section when stsConnectionState arrives). */
export function setStsReady(boxId: string, ready: boolean): void {
	_stsReadyByBoxId[boxId] = ready;
}

// ── STS request/resolver (used for hover, signature help) ──────────────────

const _stsResolversById: Record<string, { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout> }> = {};

const STS_TIMEOUT_MS = 60000;

function stsRequest<T>(method: string, params: Record<string, unknown>, timeoutMs: number = STS_TIMEOUT_MS): Promise<T | null> {
	return new Promise((resolve) => {
		const requestId = 'sts_' + Date.now() + '_' + Math.random().toString(16).slice(2);

		const timer = setTimeout(() => {
			delete _stsResolversById[requestId];
			resolve(null);
		}, timeoutMs);

		_stsResolversById[requestId] = {
			resolve: (result: any) => {
				clearTimeout(timer);
				resolve(result);
			},
			timer,
		};

		try {
			postMessageToHost({
				type: 'stsRequest',
				requestId,
				method,
				params,
			} as any);
		} catch {
			clearTimeout(timer);
			delete _stsResolversById[requestId];
			resolve(null);
		}
	});
}

/** Called from message-handler when an stsResponse arrives. */
export function handleStsResponse(requestId: string, result: unknown): void {
	const entry = _stsResolversById[requestId];
	if (entry) {
		delete _stsResolversById[requestId];
		entry.resolve(result);
	}
}

// ── Model URI → boxId mapping ──────────────────────────────────────────────

const _modelUriToBoxId: Record<string, string> = {};

/** Register a Monaco model URI → boxId mapping. */
export function registerStsEditorModel(modelUri: string, boxId: string): void {
	_modelUriToBoxId[modelUri] = boxId;
}

/** Unregister a model URI mapping. */
export function unregisterStsEditorModel(modelUri: string): void {
	delete _modelUriToBoxId[modelUri];
}

function getBoxIdForModel(modelUri: string): string | null {
	return _modelUriToBoxId[modelUri] || null;
}

// ── Diagnostics ────────────────────────────────────────────────────────────

/** Called from message-handler when stsDiagnostics arrives. */
export function handleStsDiagnostics(boxId: string, markers: any[]): void {
	const monaco = _win.monaco;
	if (!monaco?.editor) return;

	// Find the model for this boxId
	let targetModel: any = null;
	for (const [uri, bid] of Object.entries(_modelUriToBoxId)) {
		if (bid === boxId) {
			for (const model of monaco.editor.getModels()) {
				if (model.uri?.toString() === uri) {
					targetModel = model;
					break;
				}
			}
			break;
		}
	}

	if (targetModel) {
		monaco.editor.setModelMarkers(targetModel, 'sql-sts', markers || []);
	}
}

// ── Provider registration ──────────────────────────────────────────────────

let _registered = false;

/** Register STS-powered Monaco providers for the 'sql' language. Call once. */
export function registerStsProviders(): void {
	if (_registered) return;
	const monaco = _win.monaco;
	if (!monaco?.languages) return;
	_registered = true;

	// ── Completion provider (STS-first, local fallback) ───────────────────
	// When STS is connected, delegate to SqlToolsService for full context-aware
	// IntelliSense. STS results are merged with local schema data (columns/tables)
	// because STS may return only keywords if its schema cache isn't fully loaded.

	monaco.languages.registerCompletionItemProvider('sql', {
		triggerCharacters: ['.', ' '],
		async provideCompletionItems(model: any, position: any) {
			const boxId = getBoxIdForModel(model.uri?.toString() || '');
			if (!boxId) return { suggestions: [] };

			const word = model.getWordUntilPosition(position);
			const range = {
				startLineNumber: position.lineNumber,
				endLineNumber: position.lineNumber,
				startColumn: word.startColumn,
				endColumn: word.endColumn,
			};

			const textBeforeCursor = model.getValueInRange({
				startLineNumber: 1, startColumn: 1,
				endLineNumber: position.lineNumber, endColumn: position.column,
			});

			const schema = _win.schemaByBoxId?.[boxId] as {
				tables?: string[];
				views?: string[];
				columnsByTable?: Record<string, Record<string, string>>;
			} | undefined;

			const suggestions: any[] = [];

			// ── Try STS first ─────────────────────────────────────────────────
			// STS provides context-aware completions (keywords in the right order,
			// system functions, etc.). We always supplement with local schema data
			// because STS's schema cache may not be fully loaded.
			let stsItemCount = 0;
			let stsHasSchemaObjects = false;
			if (_stsReadyByBoxId[boxId]) {
				try {
					const stsResult = await stsRequest<{ items?: any[] }>('textDocument/completion', {
						boxId,
						line: position.lineNumber,
						column: position.column,
					}, 10000);

					const items = Array.isArray(stsResult) ? stsResult : (stsResult?.items || []);
					stsItemCount = items.length;

					// Check if STS returned any schema objects (columns, tables, views)
					// LSP kinds: 5=Field (column), 7=Class (table), 8=Interface (view), 9=Module (schema)
					stsHasSchemaObjects = items.some((item: any) =>
						item.kind === 5 || item.kind === 7 || item.kind === 8 || item.kind === 9
					);

					if (items.length > 0) {
						for (const item of items) {
							suggestions.push({
								label: typeof item.label === 'string' ? item.label : String(item.label),
								kind: _mapStsCompletionKind(monaco, item.kind),
								detail: item.detail || '',
								documentation: item.documentation || undefined,
								insertText: item.insertText || (typeof item.label === 'string' ? item.label : String(item.label)),
								filterText: item.filterText || undefined,
								sortText: item.sortText || undefined,
								range,
							});
						}
					}
				} catch {
					// STS failed — fall through to local provider
				}
			}

			// ── Supplement with local schema data ─────────────────────────────
			// Always add local schema objects when STS didn't provide them.
			// This handles the case where STS is connected but its schema cache
			// isn't fully loaded yet (returns only keywords, no tables/columns).
			if (!stsHasSchemaObjects && schema) {
				const seenLabels = new Set(suggestions.map((s: any) => String(s.label).toLowerCase()));

				// Helper: add item if not already present from STS
				const addIfNew = (item: any) => {
					const key = String(item.label).toLowerCase();
					if (!seenLabels.has(key)) {
						seenLabels.add(key);
						suggestions.push(item);
					}
				};

				// ── Schema-dot context: "SalesLT." or "dbo." → tables or alias → columns ──
				const dotMatch = textBeforeCursor.match(/\b(\w+)\.\s*$/);
				if (dotMatch) {
					const prefix = dotMatch[1];

					// Schema-qualified tables (e.g. "SalesLT." → Product, ProductCategory...)
					if (schema.tables) {
						const schemaPrefix = prefix.toLowerCase() + '.';
						for (const fqTable of schema.tables) {
							if (fqTable.toLowerCase().startsWith(schemaPrefix)) {
								const shortName = fqTable.substring(prefix.length + 1);
								addIfNew({ label: shortName, kind: monaco.languages.CompletionItemKind.Class, detail: 'Table', insertText: shortName, sortText: '0_' + shortName, range });
							}
						}
					}
					if (schema.views) {
						const schemaPrefix = prefix.toLowerCase() + '.';
						for (const fqView of schema.views) {
							if (fqView.toLowerCase().startsWith(schemaPrefix)) {
								const shortName = fqView.substring(prefix.length + 1);
								addIfNew({ label: shortName, kind: monaco.languages.CompletionItemKind.Interface, detail: 'View', insertText: shortName, sortText: '0_' + shortName, range });
							}
						}
					}

					// Alias resolution: "p." → columns of the table aliased as "p"
					if (schema.columnsByTable) {
						const resolvedTable = resolveAlias(textBeforeCursor, prefix, schema.tables || []);
						if (resolvedTable) {
							const cols = schema.columnsByTable[resolvedTable];
							if (cols) {
								for (const [colName, colType] of Object.entries(cols)) {
									addIfNew({ label: colName, kind: monaco.languages.CompletionItemKind.Field, detail: colType || 'Column', insertText: colName, sortText: '0_' + colName, range });
								}
							}
						}
					}
				}

				// ── FROM/JOIN context → tables and views ──────────────────────────
				const isObjectContext = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE)\s+$/i.test(textBeforeCursor);
				if (isObjectContext) {
					if (schema.tables) {
						for (const t of schema.tables) {
							addIfNew({ label: t, kind: monaco.languages.CompletionItemKind.Class, detail: 'Table', insertText: t, sortText: '0_' + t, range });
						}
					}
					if (schema.views) {
						for (const v of schema.views) {
							addIfNew({ label: v, kind: monaco.languages.CompletionItemKind.Interface, detail: 'View', insertText: v, sortText: '0_' + v, range });
						}
					}
					// Schema names
					const schemas = new Set<string>();
					for (const t of (schema.tables || []).concat(schema.views || [])) {
						const dot = t.indexOf('.');
						if (dot > 0) schemas.add(t.substring(0, dot));
					}
					for (const s of schemas) {
						addIfNew({ label: s, kind: monaco.languages.CompletionItemKind.Module, detail: 'Schema', insertText: s, sortText: '0_' + s, range });
					}
				}

				// ── Column context (SELECT, WHERE, ORDER BY, GROUP BY, HAVING, SET, ON) ──
				// Resolve columns from referenced tables in the query
				if (!dotMatch && !isObjectContext && schema.columnsByTable) {
					const fullText = model.getValue();
					const referencedTables = _extractReferencedTables(fullText, schema.tables || []);
					for (const tableName of referencedTables) {
						const cols = schema.columnsByTable[tableName];
						if (cols) {
							for (const [colName, colType] of Object.entries(cols)) {
								addIfNew({ label: colName, kind: monaco.languages.CompletionItemKind.Field, detail: `${colType} (${tableName.split('.').pop()})`, insertText: colName, sortText: '0_' + colName, range });
							}
						}
					}

					// Also add tables/views with lower priority
					if (schema.tables) {
						for (const t of schema.tables) {
							addIfNew({ label: t, kind: monaco.languages.CompletionItemKind.Class, detail: 'Table', insertText: t, sortText: 'z_' + t, range });
						}
					}
				}
			}

			// ── Fallback: if no STS and no schema, return SQL keywords ─────────
			if (suggestions.length === 0) {
				for (const kw of SQL_KEYWORDS) {
					suggestions.push({ label: kw, kind: monaco.languages.CompletionItemKind.Keyword, detail: 'Keyword', insertText: kw, range });
				}
				if (schema?.tables) {
					for (const t of schema.tables) {
						suggestions.push({ label: t, kind: monaco.languages.CompletionItemKind.Class, detail: 'Table', insertText: t, sortText: 'z_' + t, range });
					}
				}
			}

			return { suggestions };
		},
	});

	// Hover provider
	monaco.languages.registerHoverProvider('sql', {
		async provideHover(model: any, position: any) {
			const boxId = getBoxIdForModel(model.uri?.toString() || '');
			if (!boxId) return null;

			const result = await stsRequest<{ contents?: string; range?: any }>('textDocument/hover', {
				boxId,
				line: position.lineNumber,
				column: position.column,
			});

			if (!result?.contents) return null;

			return {
				contents: [{ value: result.contents }],
				range: result.range || undefined,
			};
		},
	});

	// Signature help provider
	monaco.languages.registerSignatureHelpProvider('sql', {
		signatureHelpTriggerCharacters: ['(', ','],
		async provideSignatureHelp(model: any, position: any) {
			const boxId = getBoxIdForModel(model.uri?.toString() || '');
			if (!boxId) return null;

			const result = await stsRequest<{
				signatures?: any[];
				activeSignature?: number;
				activeParameter?: number;
			}>('textDocument/signatureHelp', {
				boxId,
				line: position.lineNumber,
				column: position.column,
			});

			if (!result?.signatures?.length) return null;

			return {
				value: {
					signatures: result.signatures.map((sig: any) => ({
						label: sig.label,
						documentation: sig.documentation ? { value: sig.documentation } : undefined,
						parameters: (sig.parameters || []).map((p: any) => ({
							label: p.label,
							documentation: p.documentation ? { value: p.documentation } : undefined,
						})),
					})),
					activeSignature: result.activeSignature ?? 0,
					activeParameter: result.activeParameter ?? 0,
				},
				dispose() { /* no-op */ },
			};
		},
	});
}

// ── SQL Keywords (static, same as any SQL editor) ─────────────────────────

const SQL_KEYWORDS = [
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
	'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'ALTER',
	'DROP', 'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'PROCEDURE',
	'FUNCTION', 'TRIGGER', 'AS', 'ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
	'FULL', 'OUTER', 'CROSS', 'UNION', 'ALL', 'DISTINCT', 'TOP', 'ORDER',
	'BY', 'ASC', 'DESC', 'GROUP', 'HAVING', 'LIKE', 'BETWEEN', 'EXISTS',
	'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BEGIN', 'DECLARE', 'EXEC',
	'EXECUTE', 'IF', 'WHILE', 'RETURN', 'WITH', 'OVER', 'PARTITION',
	'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
	'FIRST_VALUE', 'LAST_VALUE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
	'CAST', 'CONVERT', 'COALESCE', 'ISNULL', 'NULLIF', 'IIF',
	'GETDATE', 'SYSDATETIME', 'DATEADD', 'DATEDIFF', 'DATEPART',
	'LEN', 'SUBSTRING', 'REPLACE', 'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER',
	'CONCAT', 'STRING_AGG', 'STUFF', 'CHARINDEX', 'PATINDEX',
	'TRUNCATE', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'GRANT', 'REVOKE',
	'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT',
	'CHECK', 'UNIQUE', 'IDENTITY', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY',
	'MERGE', 'MATCHED', 'OUTPUT', 'INSERTED', 'DELETED', 'EXCEPT', 'INTERSECT',
	'PIVOT', 'UNPIVOT', 'APPLY', 'TABLESAMPLE', 'OPTION', 'MAXRECURSION',
	'GO', 'USE', 'PRINT', 'RAISERROR', 'THROW', 'TRY', 'CATCH',
	'NVARCHAR', 'VARCHAR', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
	'BIT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY',
	'DATE', 'DATETIME', 'DATETIME2', 'TIME', 'UNIQUEIDENTIFIER', 'XML',
];

// ── STS completion kind → Monaco kind mapping ─────────────────────────────
// LSP CompletionItemKind numbers → Monaco CompletionItemKind.
function _mapStsCompletionKind(monaco: any, stsKind: number | undefined): number {
	const k = monaco.languages.CompletionItemKind;
	switch (stsKind) {
		case 1: return k.Text;
		case 2: return k.Method;
		case 3: return k.Function;
		case 4: return k.Constructor;
		case 5: return k.Field;       // Column
		case 6: return k.Variable;
		case 7: return k.Class;       // Table
		case 8: return k.Interface;   // View
		case 9: return k.Module;      // Schema
		case 10: return k.Property;
		case 11: return k.Unit;
		case 12: return k.Value;
		case 13: return k.Enum;
		case 14: return k.Keyword;
		case 15: return k.Snippet;
		case 16: return k.Color;
		case 17: return k.File;
		case 18: return k.Reference;
		case 19: return k.Folder;
		case 20: return k.EnumMember;
		case 21: return k.Constant;
		case 22: return k.Struct;
		case 23: return k.Event;
		case 24: return k.Operator;
		case 25: return k.TypeParameter;
		default: return k.Text;
	}
}

// ── Alias resolver ─────────────────────────────────────────────────────────
// Parses "FROM <table> <alias>" and "JOIN <table> <alias>" to resolve
// "alias." to a table name so we can show columns.

function resolveAlias(textBefore: string, alias: string, tables: string[]): string | null {
	// Match patterns like: FROM SalesLT.Product p, FROM dbo.Users u, JOIN Orders o
	const aliasLower = alias.toLowerCase();
	const pattern = /\b(?:FROM|JOIN)\s+([\w.]+)\s+(?:AS\s+)?(\w+)/gi;
	let m;
	while ((m = pattern.exec(textBefore)) !== null) {
		if (m[2].toLowerCase() === aliasLower) {
			// Find the full table name (could be schema-qualified)
			const ref = m[1];
			// Exact match first
			const exact = tables.find(t => t.toLowerCase() === ref.toLowerCase());
			if (exact) return exact;
			// Try without schema prefix (user typed "Product", actual is "SalesLT.Product")
			const byShort = tables.find(t => {
				const dot = t.lastIndexOf('.');
				return dot >= 0 && t.substring(dot + 1).toLowerCase() === ref.toLowerCase();
			});
			if (byShort) return byShort;
			return ref;
		}
	}
	return null;
}

// ── Table reference extractor ──────────────────────────────────────────────
// Finds all tables referenced in the query (FROM, JOIN, UPDATE, INTO).
// Returns the canonical full table names from the schema.

function _extractReferencedTables(queryText: string, tables: string[]): string[] {
	const found = new Set<string>();
	const pattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([\w.]+)/gi;
	let m;
	while ((m = pattern.exec(queryText)) !== null) {
		const ref = m[1];
		// Exact match
		const exact = tables.find(t => t.toLowerCase() === ref.toLowerCase());
		if (exact) { found.add(exact); continue; }
		// Short name match (user typed "Product", actual is "SalesLT.Product")
		const byShort = tables.find(t => {
			const dot = t.lastIndexOf('.');
			return dot >= 0 && t.substring(dot + 1).toLowerCase() === ref.toLowerCase();
		});
		if (byShort) found.add(byShort);
	}
	return [...found];
}
