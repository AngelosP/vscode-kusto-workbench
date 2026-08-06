import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostInformationNotificationApplicationHandler } from '../../../src/host/informationNotificationApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function showInfoMessage(message = '  Keep\tthis text exactly.  '): IncomingWebviewMessage {
	return { type: 'showInfo', message };
}

describe('HostInformationNotificationApplicationHandler', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const handler = new HostInformationNotificationApplicationHandler();
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it('passes the exact message text to one native information notification', () => {
		const handler = new HostInformationNotificationApplicationHandler();
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

		expect(handler.handleMessage(showInfoMessage())).toBe(true);

		expect(showInformationMessage).toHaveBeenCalledOnce();
		expect(showInformationMessage).toHaveBeenCalledWith('  Keep\tthis text exactly.  ');
	});

	it('does not await or adopt the native notification thenable', () => {
		const handler = new HostInformationNotificationApplicationHandler();
		const then = vi.fn();
		const neverSettlingThenable = { then } as vscode.Thenable<string | undefined>;
		vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(neverSettlingThenable);

		expect(handler.handleMessage(showInfoMessage())).toBe(true);
		expect(then).not.toHaveBeenCalled();
	});

	it('preserves synchronous native throws', () => {
		const handler = new HostInformationNotificationApplicationHandler();
		const failure = new Error('notification failed synchronously');
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
			.mockImplementationOnce(() => { throw failure; });

		expect(() => handler.handleMessage(showInfoMessage())).toThrow(failure);
		expect(showInformationMessage).toHaveBeenCalledOnce();
	});

	it('allows an accepted notification to continue across disposal and suppresses later requests', () => {
		const handler = new HostInformationNotificationApplicationHandler();
		const pendingNotification = new Promise<string | undefined>(() => undefined);
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
			.mockReturnValue(pendingNotification);

		expect(handler.handleMessage(showInfoMessage('accepted'))).toBe(true);
		handler.dispose();
		handler.dispose();
		expect(handler.handleMessage(showInfoMessage('suppressed'))).toBe(true);

		expect(showInformationMessage).toHaveBeenCalledOnce();
		expect(showInformationMessage).toHaveBeenCalledWith('accepted');
	});
});