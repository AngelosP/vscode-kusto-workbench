import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
	admitPowerBiPublishHostMessage,
	admitPowerBiPublishHostMessageFromEnvelope,
	admitPowerBiPublishWebviewMessage,
	admitPowerBiPublishWebviewMessageFromEnvelope,
	createPublishToPowerBIAckMessage,
	createPublishToPowerBIFailureResultMessage,
	createPublishToPowerBISuccessResultMessage,
} from '../../src/shared/powerBiPublishProtocol';
import { captureRuntimeMessageEnvelope } from '../../src/shared/runtimeMessageEnvelope';

function canonicalSuccess() {
	return {
		type: 'publishToPowerBIResult' as const,
		requestId: 'publish-1',
		boxId: 'html-1',
		ok: true as const,
		reportUrl: 'https://app.powerbi.com/reports/report-1',
		scheduleConfigured: true,
		initialRefreshTriggered: false,
		dataMode: 'import' as const,
		semanticModelId: 'model-1',
		reportId: 'report-1',
		workspaceId: 'workspace-1',
		reportName: 'Operations',
		workspaceName: 'Analytics',
	};
}

function canonicalFailure() {
	return {
		type: 'publishToPowerBIResult' as const,
		requestId: 'publish-1',
		boxId: 'html-1',
		ok: false as const,
		error: 'Publish failed.',
	};
}

function canonicalAck() {
	return {
		type: 'publishToPowerBIAck' as const,
		requestId: 'publish-1',
		accepted: true,
	};
}

describe('Power BI publish protocol', () => {
	it('constructs exact frozen success, failure, and acknowledgement messages', () => {
		const success = createPublishToPowerBISuccessResultMessage(
			'publish-1', 'html-1', 'https://app.powerbi.com/reports/report-1',
			true, false, 'import', 'model-1', 'report-1', 'workspace-1',
			'Operations', 'Analytics',
		);
		expect(success).toEqual({ ok: true, value: canonicalSuccess() });
		if (!success.ok) throw new Error(success.error);
		expect(Object.isFrozen(success.value)).toBe(true);
		const directQuery = createPublishToPowerBISuccessResultMessage(
			'publish-2', 'html-1', 'https://app.powerbi.com/reports/report-2',
			true, undefined, 'directQuery', 'model-2', 'report-2', 'workspace-1',
			'Operations', undefined,
		);
		expect(directQuery.ok).toBe(true);
		if (!directQuery.ok) throw new Error(directQuery.error);
		expect(directQuery.value).toHaveProperty('initialRefreshTriggered', undefined);
		expect(directQuery.value).toHaveProperty('workspaceName', undefined);
		expect(Object.isFrozen(directQuery.value)).toBe(true);

		const failure = createPublishToPowerBIFailureResultMessage(
			'publish-1', 'html-1', 'Publish failed.',
		);
		expect(failure).toEqual({ ok: true, value: canonicalFailure() });
		if (!failure.ok) throw new Error(failure.error);
		expect(Object.isFrozen(failure.value)).toBe(true);

		const acknowledgement = createPublishToPowerBIAckMessage('publish-1', false);
		expect(acknowledgement).toEqual({
			ok: true,
			value: { ...canonicalAck(), accepted: false },
		});
		if (!acknowledgement.ok) throw new Error(acknowledgement.error);
		expect(Object.isFrozen(acknowledgement.value)).toBe(true);
	});

	it('rejects malformed result unions without invoking accessors', () => {
		let getterCalls = 0;
		const accessor = canonicalSuccess() as Record<string, unknown>;
		Object.defineProperty(accessor, 'reportId', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'forged';
			},
		});
		const inheritedType = Object.assign(
			Object.create({ type: 'publishToPowerBIResult' }),
			canonicalSuccess(),
		);
		delete inheritedType.type;

		for (const input of [
			{ ...canonicalSuccess(), ok: 'yes' },
			{ ...canonicalSuccess(), scheduleConfigured: 'yes' },
			{ ...canonicalSuccess(), initialRefreshTriggered: 'yes' },
			{ ...canonicalSuccess(), dataMode: 'cached' },
			{ ...canonicalSuccess(), extra: true },
			{ ...canonicalFailure(), reportId: 'report-1' },
			Object.assign(Object.create({ inherited: true }), canonicalSuccess()),
			inheritedType,
			accessor,
			Object.assign([], canonicalSuccess()),
		]) {
			const admission = admitPowerBiPublishHostMessage(input);
			expect(admission.recognized).toBe(true);
			if (admission.recognized) expect(admission.parsed.ok).toBe(false);
		}
		expect(getterCalls).toBe(0);
	});

	it('rejects malformed acknowledgements without invoking accessors', () => {
		let getterCalls = 0;
		const accessor = canonicalAck() as Record<string, unknown>;
		Object.defineProperty(accessor, 'accepted', {
			enumerable: true,
			get() {
				getterCalls++;
				return true;
			},
		});

		for (const input of [
			{ ...canonicalAck(), accepted: 'yes' },
			{ ...canonicalAck(), requestId: '' },
			{ ...canonicalAck(), extra: true },
			Object.assign(Object.create({ inherited: true }), canonicalAck()),
			accessor,
			Object.assign([], canonicalAck()),
		]) {
			const admission = admitPowerBiPublishWebviewMessage(input);
			expect(admission.recognized).toBe(true);
			if (admission.recognized) expect(admission.parsed.ok).toBe(false);
		}
		expect(getterCalls).toBe(0);
	});

	it('uses one-shot descriptor snapshots in both directions', () => {
		const result = canonicalSuccess();
		const resultEnvelope = captureRuntimeMessageEnvelope(result);
		expect(resultEnvelope.ok).toBe(true);
		if (!resultEnvelope.ok) throw new Error(resultEnvelope.error);
		(result as { reportId: string }).reportId = 'forged-after-capture';
		const admittedResult = admitPowerBiPublishHostMessageFromEnvelope(
			resultEnvelope.descriptorSnapshot,
		);
		expect(admittedResult.recognized && admittedResult.parsed.ok).toBe(true);
		if (admittedResult.recognized && admittedResult.parsed.ok) {
			expect(admittedResult.parsed.value.reportId).toBe('report-1');
		}

		const acknowledgement = canonicalAck();
		const ackEnvelope = captureRuntimeMessageEnvelope(acknowledgement);
		expect(ackEnvelope.ok).toBe(true);
		if (!ackEnvelope.ok) throw new Error(ackEnvelope.error);
		acknowledgement.accepted = false;
		const admittedAck = admitPowerBiPublishWebviewMessageFromEnvelope(
			ackEnvelope.descriptorSnapshot,
		);
		expect(admittedAck.recognized && admittedAck.parsed.ok).toBe(true);
		if (admittedAck.recognized && admittedAck.parsed.ok) {
			expect(admittedAck.parsed.value.accepted).toBe(true);
		}
	});

	it('declines unrelated traffic and fails closed for revoked proxies', () => {
		expect(admitPowerBiPublishHostMessage({ type: 'pbiWorkspacesResult' }))
			.toEqual({ recognized: false });
		expect(admitPowerBiPublishWebviewMessage({ type: 'cancelDashboardWorkflow' }))
			.toEqual({ recognized: false });

		const revocable = Proxy.revocable(canonicalAck(), {});
		revocable.revoke();
		const admission = admitPowerBiPublishWebviewMessage(revocable.proxy);
		expect(admission.recognized).toBe(true);
		if (admission.recognized) expect(admission.parsed.ok).toBe(false);
	});

	it('is the sole publish result and acknowledgement contract owner', () => {
		const root = path.resolve(__dirname, '../..');
		const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
		const protocol = read('src/shared/powerBiPublishProtocol.ts');
		const hostTypes = read('src/host/queryEditorTypes.ts');
		const webviewTypes = read('src/webview/shared/webview-messages.ts');
		const handler = read('src/host/dashboardApplicationHandler.ts');
		const startup = read('src/host/mainWebviewStartupGateway.ts');
		const provider = read('src/host/queryEditorProvider.ts');
		const htmlSection = read('src/webview/sections/kw-html-section.ts');
		const dialog = read('src/webview/components/kw-publish-pbi-dialog.ts');

		expect(protocol).toContain("type: 'publishToPowerBIResult'");
		expect(protocol).toContain("type: 'publishToPowerBIAck'");
		expect(hostTypes).toContain('PublishToPowerBIAckMessage');
		expect(webviewTypes).toContain('PowerBiPublishWebviewMessage');
		expect(hostTypes).not.toContain("export type PublishToPowerBIAckMessage = {");
		expect(webviewTypes).not.toContain("| { type: 'publishToPowerBIAck';");
		expect(handler.indexOf('admitPowerBiPublishWebviewMessage(message)')).toBeLessThan(
			handler.indexOf('this.acceptPowerBiPublishAck('),
		);
		expect(startup).toContain('admitPowerBiPublishWebviewMessageFromEnvelope(');
		expect(startup).toContain('admitPowerBiPublishHostMessage(message)');
		expect(provider).toContain('admitPowerBiPublishWebviewMessageFromEnvelope(');
		expect(provider).toContain('admitPowerBiPublishHostMessage(message)');
		expect(htmlSection.indexOf('admitPowerBiPublishHostMessage(e.data)')).toBeLessThan(
			htmlSection.indexOf('const nextPublishInfo: PbiPublishInfo'),
		);
		expect(htmlSection).toContain('createPublishToPowerBIAckMessage(data.requestId, accepted)');
		const dialogIngress = dialog.slice(dialog.indexOf('handleHostMessage(message: any)'));
		expect(dialogIngress.indexOf('admitPowerBiPublishHostMessage(message)')).toBeLessThan(
			dialogIngress.indexOf("this._publishRequestId = '';"),
		);
	});
});