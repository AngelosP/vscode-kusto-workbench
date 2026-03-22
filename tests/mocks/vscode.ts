/**
 * Minimal vscode module mock for Vitest.
 *
 * Several host source files (kustoClient, connectionManager, queryEditorTypes,
 * queryEditorConnection) `import * as vscode from 'vscode'`. The tested
 * functions are pure and never call vscode APIs, but the module import must
 * resolve. This mock provides an empty namespace so the import succeeds.
 *
 * Wired via `resolve.alias` in vitest.config.ts.
 */
export {};
