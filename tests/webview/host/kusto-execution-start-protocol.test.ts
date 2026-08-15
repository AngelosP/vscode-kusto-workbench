import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { KustoExecutionReservation } from '../../../src/shared/kustoExecution';
import {
	admitKustoExecutionStartHostMessage,
	admitKustoExecutionStartHostMessageFromEnvelope,
	admitKustoExecutionStartWebviewMessage,
	admitKustoExecutionStartWebviewMessageFromEnvelope,
	createKustoExecutionStartedAckMessage,
	createKustoExecutionStartedMessage,
} from '../../../src/shared/kustoExecutionStartProtocol';
import { captureRuntimeMessageEnvelope } from '../../../src/shared/runtimeMessageEnvelope';

const RESERVATION: KustoExecutionReservation = Object.freeze({
	engine: 'kusto',
	boxId: 'query-1',
	sectionInstanceId: 'instance-1',
	targetGeneration: 7,
	connectionId: 'connection-1',
	database: 'Samples',
	executionId: 'execution-1',
	producer: 'copilot',
	copilotRequestId: 'copilot-1',
	query: 'reservation query',
	reservationSequence: 11,
});

function canonicalStart() {
	return {
		type: 'kustoExecutionStarted' as const,
		...RESERVATION,
		query: 'print Value=1',
		expectedPredecessorExecutionId: 'manual-current',
	};
}

function canonicalAck() {
	return {
		type: 'kustoExecutionStartedAck' as const,
		boxId: RESERVATION.boxId,
		executionId: RESERVATION.executionId,
		sectionInstanceId: RESERVATION.sectionInstanceId,
		targetGeneration: RESERVATION.targetGeneration,
		accepted: true,
	};
}

describe('Kusto execution-start protocol', () => {
	it('constructs exact frozen start and acknowledgement messages', () => {
		const started = createKustoExecutionStartedMessage(
			RESERVATION,
			'print Value=1',
			'manual-current',
		);
		expect(started).toEqual({ ok: true, value: canonicalStart() });
		if (!started.ok) throw new Error(started.error);
		expect(Object.isFrozen(started.value)).toBe(true);

		const acknowledgement = createKustoExecutionStartedAckMessage(
			started.value.boxId,
			started.value.executionId,
			started.value.sectionInstanceId,
			started.value.targetGeneration,
			false,
		);
		expect(acknowledgement).toEqual({
			ok: true,
			value: { ...canonicalAck(), accepted: false },
		});
		if (!acknowledgement.ok) throw new Error(acknowledgement.error);
		expect(Object.isFrozen(acknowledgement.value)).toBe(true);
	});

	it('rejects hostile start-constructor inputs without invoking accessors or proxy traps', () => {
		let getterCalls = 0;
		const accessor = { ...RESERVATION } as Record<string, unknown>;
		Object.defineProperty(accessor, 'engine', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'kusto';
			},
		});
		let proxyTraps = 0;
		const proxy = new Proxy(RESERVATION, {
			ownKeys(target) {
				proxyTraps++;
				return Reflect.ownKeys(target);
			},
			getOwnPropertyDescriptor(target, key) {
				proxyTraps++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});

		for (const reservation of [
			accessor,
			Object.assign(Object.create({ inherited: true }), RESERVATION),
			proxy,
		]) {
			const result = createKustoExecutionStartedMessage(
				reservation as unknown as KustoExecutionReservation,
				'print Value=1',
			);
			expect(result.ok).toBe(false);
		}
		expect(getterCalls).toBe(0);
		expect(proxyTraps).toBe(0);
	});

	it('rejects producer shapes that cannot use the start handshake', () => {
		for (const reservation of [
			{ ...RESERVATION, producer: 'manual' as const },
			{ ...RESERVATION, producer: 'tool' as const },
			{ ...RESERVATION, producer: 'comparison' as const },
		]) {
			expect(createKustoExecutionStartedMessage(reservation, 'print Value=1').ok).toBe(false);
		}

		for (const producer of ['manual', 'tool'] as const) {
			const admission = admitKustoExecutionStartHostMessage({ ...canonicalStart(), producer });
			expect(admission.recognized && admission.parsed.ok).toBe(false);
		}
		const comparisonWithoutLineage = admitKustoExecutionStartHostMessage({
			...canonicalStart(), producer: 'comparison',
		});
		expect(comparisonWithoutLineage.recognized && comparisonWithoutLineage.parsed.ok).toBe(false);
	});

	it('captures an exact frozen comparison identity', () => {
		const comparisonRun = {
			sourceBoxId: 'query-source',
			sourceExecutionId: 'source-execution',
			comparisonBoxId: 'query-comparison',
		};
		const result = createKustoExecutionStartedMessage({
			...RESERVATION,
			boxId: comparisonRun.comparisonBoxId,
			executionId: 'comparison-execution',
			producer: 'comparison',
			comparisonRun,
		}, 'print Value=2');

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.value.comparisonRun).toEqual(comparisonRun);
		expect(result.value.comparisonRun).not.toBe(comparisonRun);
		expect(Object.isFrozen(result.value.comparisonRun)).toBe(true);
	});

	it('rejects malformed start fields without invoking accessors', () => {
		let getterCalls = 0;
		const accessor = canonicalStart() as Record<string, unknown>;
		Object.defineProperty(accessor, 'query', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'forged';
			},
		});
		const inherited = Object.assign(Object.create({ type: 'kustoExecutionStarted' }), canonicalStart());
		delete inherited.type;

		for (const input of [
			{ ...canonicalStart(), query: ['print forged=1'] },
			{ ...canonicalStart(), targetGeneration: '7' },
			{ ...canonicalStart(), reservationSequence: 0 },
			{ ...canonicalStart(), producer: 'sql' },
			{ ...canonicalStart(), extra: true },
			Object.assign(Object.create({ inherited: true }), canonicalStart()),
			inherited,
			accessor,
			Object.assign([], canonicalStart()),
		]) {
			const admission = admitKustoExecutionStartHostMessage(input);
			expect(admission.recognized).toBe(true);
			if (admission.recognized) expect(admission.parsed.ok).toBe(false);
		}
		expect(getterCalls).toBe(0);
	});

	it('rejects malformed comparison ownership', () => {
		const comparisonRun = {
			sourceBoxId: 'query-source',
			sourceExecutionId: 'source-execution',
			comparisonBoxId: 'query-comparison',
		};
		for (const input of [
			{ ...canonicalStart(), comparisonRun },
			{
				...canonicalStart(), producer: 'comparison', comparisonRun,
				boxId: 'unrelated', executionId: 'unrelated-execution',
			},
			{
				...canonicalStart(), producer: 'comparison',
				comparisonRun: { ...comparisonRun, extra: true },
			},
		]) {
			const admission = admitKustoExecutionStartHostMessage(input);
			expect(admission.recognized && admission.parsed.ok).toBe(false);
		}
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
		const inherited = Object.assign(Object.create({ type: 'kustoExecutionStartedAck' }), canonicalAck());
		delete inherited.type;

		for (const input of [
			{ ...canonicalAck(), accepted: 'yes' },
			{ ...canonicalAck(), targetGeneration: 1.5 },
			{ ...canonicalAck(), extra: true },
			Object.assign(Object.create({ inherited: true }), canonicalAck()),
			inherited,
			accessor,
			Object.assign([], canonicalAck()),
		]) {
			const admission = admitKustoExecutionStartWebviewMessage(input);
			expect(admission.recognized).toBe(true);
			if (admission.recognized) expect(admission.parsed.ok).toBe(false);
		}
		expect(getterCalls).toBe(0);
	});

	it('uses the one-shot envelope descriptor snapshot for both directions', () => {
		const start = canonicalStart();
		const startEnvelope = captureRuntimeMessageEnvelope(start);
		expect(startEnvelope.ok).toBe(true);
		if (!startEnvelope.ok) throw new Error(startEnvelope.error);
		(start as { query: string }).query = 'forged after capture';
		const admittedStart = admitKustoExecutionStartHostMessageFromEnvelope(
			startEnvelope.descriptorSnapshot,
		);
		expect(admittedStart.recognized && admittedStart.parsed.ok).toBe(true);
		if (admittedStart.recognized && admittedStart.parsed.ok) {
			expect(admittedStart.parsed.value.query).toBe('print Value=1');
		}

		const acknowledgement = canonicalAck();
		const ackEnvelope = captureRuntimeMessageEnvelope(acknowledgement);
		expect(ackEnvelope.ok).toBe(true);
		if (!ackEnvelope.ok) throw new Error(ackEnvelope.error);
		(acknowledgement as { accepted: boolean }).accepted = false;
		const admittedAck = admitKustoExecutionStartWebviewMessageFromEnvelope(
			ackEnvelope.descriptorSnapshot,
		);
		expect(admittedAck.recognized && admittedAck.parsed.ok).toBe(true);
		if (admittedAck.recognized && admittedAck.parsed.ok) {
			expect(admittedAck.parsed.value.accepted).toBe(true);
		}
	});

	it('declines unrelated traffic and fails closed for a revoked proxy', () => {
		expect(admitKustoExecutionStartHostMessage({ type: 'queryResult' })).toEqual({ recognized: false });
		expect(admitKustoExecutionStartWebviewMessage({ type: 'toolResponse' })).toEqual({ recognized: false });

		const revocable = Proxy.revocable(canonicalAck(), {});
		revocable.revoke();
		const admission = admitKustoExecutionStartWebviewMessage(revocable.proxy);
		expect(admission.recognized).toBe(true);
		if (admission.recognized) expect(admission.parsed.ok).toBe(false);
	});

	it('is the sole execution-start message owner', () => {
		const root = path.resolve(__dirname, '../../..');
		const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
		const protocol = read('src/shared/kustoExecutionStartProtocol.ts');
		const execution = read('src/shared/kustoExecution.ts');
		const hostTypes = read('src/host/queryEditorTypes.ts');
		const webviewTypes = read('src/webview/shared/webview-messages.ts');
		const handler = read('src/host/kustoSectionExecutionApplicationHandler.ts');
		const dispatcher = read('src/webview/core/message-handler.ts');

		expect(protocol).toContain("type: 'kustoExecutionStarted'");
		expect(protocol).toContain("type: 'kustoExecutionStartedAck'");
		expect(execution).not.toContain('export type KustoExecutionStarted');
		expect(hostTypes).toContain('KustoExecutionStartWebviewMessage');
		expect(webviewTypes).toContain('KustoExecutionStartWebviewMessage');
		expect(hostTypes).not.toContain("{ type: 'kustoExecutionStartedAck'; boxId:");
		expect(webviewTypes).not.toContain("{ type: 'kustoExecutionStartedAck'; boxId:");
		expect(handler.indexOf('createKustoExecutionStartedMessage(')).toBeLessThan(
			handler.indexOf('const key = this.executionAckKey(reservation);'),
		);
		expect(handler.indexOf('admitKustoExecutionStartWebviewMessage(message)')).toBeLessThan(
			handler.indexOf('this.settleExecutionStartAck('),
		);
		expect(dispatcher.indexOf('admitKustoExecutionStartHostMessageFromEnvelope(')).toBeLessThan(
			dispatcher.indexOf("case 'kustoExecutionStarted':"),
		);
		expect(dispatcher).toContain('const acknowledgement = createKustoExecutionStartedAckMessage(');
	});
});