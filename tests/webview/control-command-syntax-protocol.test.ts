import { describe, expect, it } from 'vitest';

import {
	isControlCommandSyntaxHostMessageType,
	isControlCommandSyntaxWebviewMessageType,
	parseControlCommandSyntaxHostMessage,
	parseControlCommandSyntaxWebviewMessage,
} from '../../src/shared/controlCommandSyntaxProtocol.js';

describe('control-command syntax protocol', () => {
	it('accepts requests and results without normalizing identities or nested values', () => {
		const request = {
			type: 'fetchControlCommandSyntax',
			requestId: ' request-1 ',
			commandLower: ' .SHOW TABLES ',
			href: ' /en-us/kusto/management/show-tables-command ',
		} as const;
		const withArgs = ['HotCache', 'maxRows'];
		const result = {
			type: 'controlCommandSyntaxResult',
			requestId: ' request-1 ',
			commandLower: ' .SHOW TABLES ',
			ok: true,
			syntax: '.show tables with (HotCache=true)',
			withArgs,
		} as const;

		expect(isControlCommandSyntaxWebviewMessageType(request)).toBe(true);
		expect(parseControlCommandSyntaxWebviewMessage(request)).toEqual({ ok: true, value: request });
		expect(isControlCommandSyntaxHostMessageType(result)).toBe(true);
		const parsedResult = parseControlCommandSyntaxHostMessage(result);
		expect(parsedResult).toEqual({ ok: true, value: result });
		if (parsedResult.ok) {
			expect(parsedResult.value).toBe(result);
			expect(parsedResult.value.withArgs).toBe(withArgs);
		}
	});

	it('accepts valid empty syntax and dense empty with-argument arrays', () => {
		for (const result of [
			{
				type: 'controlCommandSyntaxResult', requestId: 'success-1', commandLower: '.show tables',
				ok: true, syntax: '', withArgs: [],
			},
			{
				type: 'controlCommandSyntaxResult', requestId: 'failure-1', commandLower: '.show tables',
				ok: false, syntax: '', withArgs: [],
			},
		] as const) {
			expect(parseControlCommandSyntaxHostMessage(result)).toEqual({ ok: true, value: result });
		}
	});

	it('claims and rejects malformed recognized requests', () => {
		const arrayRequest = Object.assign([], {
			type: 'fetchControlCommandSyntax', requestId: 'array-1', commandLower: '.show tables', href: '/docs',
		});
		for (const request of [
			arrayRequest,
			{ type: 'fetchControlCommandSyntax', requestId: 1, commandLower: '.show tables', href: '/docs' },
			{ type: 'fetchControlCommandSyntax', requestId: '   ', commandLower: '.show tables', href: '/docs' },
			{ type: 'fetchControlCommandSyntax', requestId: 'request-1', commandLower: 42, href: '/docs' },
			{ type: 'fetchControlCommandSyntax', requestId: 'request-1', commandLower: '', href: '/docs' },
			{ type: 'fetchControlCommandSyntax', requestId: 'request-1', commandLower: '.show tables', href: null },
			{ type: 'fetchControlCommandSyntax', requestId: 'request-1', commandLower: '.show tables', href: '   ' },
		]) {
			expect(isControlCommandSyntaxWebviewMessageType(request)).toBe(true);
			expect(parseControlCommandSyntaxWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('claims and rejects malformed recognized results, including sparse arrays', () => {
		const arrayResult = Object.assign([], {
			type: 'controlCommandSyntaxResult', requestId: 'array-1', commandLower: '.show tables',
			ok: true, syntax: '', withArgs: [],
		});
		const sparseWithArgs = new Array<unknown>(1);
		const inheritedWithArgs = new Array<unknown>(1);
		const inheritedPrototype = Object.create(Array.prototype) as unknown[];
		inheritedPrototype[0] = 'HotCache';
		Object.setPrototypeOf(inheritedWithArgs, inheritedPrototype);
		for (const result of [
			arrayResult,
			{ type: 'controlCommandSyntaxResult', requestId: 1, commandLower: '.show tables', ok: true, syntax: '', withArgs: [] },
			{ type: 'controlCommandSyntaxResult', requestId: '   ', commandLower: '.show tables', ok: true, syntax: '', withArgs: [] },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '', ok: true, syntax: '', withArgs: [] },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: 'yes', syntax: '', withArgs: [] },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: true, syntax: 42, withArgs: [] },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: true, syntax: '', withArgs: null },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: true, syntax: '', withArgs: ['HotCache', 42] },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: true, syntax: '', withArgs: sparseWithArgs },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: true, syntax: '', withArgs: inheritedWithArgs },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: false, syntax: 'injected', withArgs: [] },
			{ type: 'controlCommandSyntaxResult', requestId: 'request-1', commandLower: '.show tables', ok: false, syntax: '', withArgs: ['HotCache'] },
		]) {
			expect(isControlCommandSyntaxHostMessageType(result)).toBe(true);
			expect(parseControlCommandSyntaxHostMessage(result)).toMatchObject({ ok: false });
		}
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isControlCommandSyntaxWebviewMessageType({ type: 'getConnections' })).toBe(false);
		expect(isControlCommandSyntaxHostMessageType({ type: 'schemaData' })).toBe(false);
		expect(parseControlCommandSyntaxWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseControlCommandSyntaxWebviewMessage({ type: 'controlCommandSyntaxResult' }))
			.toMatchObject({ ok: false });
		expect(parseControlCommandSyntaxHostMessage([])).toMatchObject({ ok: false });
		expect(parseControlCommandSyntaxHostMessage({ type: 'fetchControlCommandSyntax' }))
			.toMatchObject({ ok: false });
	});
});
