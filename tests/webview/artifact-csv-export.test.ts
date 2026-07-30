import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postMessageToHost: vi.fn() }));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: mocks.postMessageToHost,
}));
vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoNotifyResultsUpdated: vi.fn(),
}));
vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: { resultsVisibleByBoxId: {}, lastExecutedBox: '' },
}));
vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	__kustoSetResultsVisible: vi.fn(), setQueryExecuting: vi.fn(),
}));

import {
	bindResultArtifactConsumer,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	setResultsState,
} from '../../src/webview/core/results-state.js';
import {
	csvTableArtifactConsumerId,
	RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT,
} from '../../src/shared/resultArtifact.js';
import {
	cancelArtifactCsvSave,
	provideArtifactCsvSaveData,
	registerArtifactCsvTable,
	releaseAllArtifactCsvTables,
	releaseArtifactCsvTable,
	saveArtifactCsv,
} from '../../src/webview/shared/artifact-csv-export.js';

describe('artifact CSV export gate', () => {
	beforeEach(() => mocks.postMessageToHost.mockClear());
	afterEach(() => {
		releaseAllArtifactCsvTables();
		vi.useRealTimers();
	});

	it('exports the displayed artifact A after current advances to B', () => {
		const boxId = 'query_csv_source';
		setResultsState(boxId, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-a' },
			policy: { exportToCsv: true },
		});
		const artifactA = getCurrentResultArtifact(boxId)!;
		const tableToken = registerArtifactCsvTable(boxId, artifactA.artifactId)!;
		setResultsState(boxId, { columns: ['Value'], rows: [['b']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-b' },
			policy: { exportToCsv: true },
		});

		expect(saveArtifactCsv({
			sourceBoxId: boxId,
			artifactId: artifactA.artifactId,
			tableToken,
			csv: 'Value\na',
			suggestedFileName: 'Results.csv',
		})).toBe(true);

		const intent = mocks.postMessageToHost.mock.calls
			.map(call => call[0])
			.find(message => message.type === 'requestArtifactCsvSave');
		expect(intent).toMatchObject({
			type: 'requestArtifactCsvSave', boxId, artifactId: artifactA.artifactId,
			suggestedFileName: 'Results.csv',
		});
		provideArtifactCsvSaveData({
			requestId: 'host-nonce', exportId: intent.requestId,
			boxId, artifactId: artifactA.artifactId,
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'artifactCsvSaveData', requestId: 'host-nonce', boxId,
			artifactId: artifactA.artifactId, accepted: true, csv: 'Value\na',
		});
		expect(getCurrentResultArtifact(boxId)?.producer?.executionId).toBe('execution-b');
		expect(getBoundResultArtifact(csvTableArtifactConsumerId(boxId), boxId)).toBe(artifactA);
		releaseArtifactCsvTable(boxId, tableToken);
	});

	it('fails closed when CSV export permission is absent', () => {
		const boxId = 'query_csv_denied';
		setResultsState(boxId, { columns: ['Secret'], rows: [['denied']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-denied' },
			policy: { exportToCsv: false },
		});
		const artifact = getCurrentResultArtifact(boxId)!;
		const tableToken = registerArtifactCsvTable(boxId, artifact.artifactId);
		expect(tableToken).toBeUndefined();

		expect(saveArtifactCsv({
			sourceBoxId: boxId, artifactId: artifact.artifactId,
			tableToken: '',
			csv: 'Secret\ndenied', suggestedFileName: 'Results.csv',
		})).toBe(false);
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'requestArtifactCsvSave' }));
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'showInfo', message: 'Results are not permitted for CSV export.',
		});
	});

	it('rejects retained artifact A after the active table rebinds to B', () => {
		const boxId = 'transformation_csv_rebind';
		setResultsState(boxId, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'transformation', boxId, executionId: 'execution-a' },
			policy: { exportToCsv: true },
		});
		const artifactA = getCurrentResultArtifact(boxId)!;
		bindResultArtifactConsumer('retain:a', boxId, artifactA.artifactId);
		const tokenA = registerArtifactCsvTable(boxId, artifactA.artifactId)!;
		setResultsState(boxId, { columns: ['Value'], rows: [['b']], metadata: {} }, {
			producer: { engine: 'transformation', boxId, executionId: 'execution-b' },
			policy: { exportToCsv: true },
		});
		const artifactB = getCurrentResultArtifact(boxId)!;
		const tokenB = registerArtifactCsvTable(boxId, artifactB.artifactId)!;
		releaseArtifactCsvTable(boxId, tokenA);

		expect(saveArtifactCsv({
			sourceBoxId: boxId, artifactId: artifactA.artifactId, tableToken: tokenA, csv: 'Value\na',
		})).toBe(false);
		expect(saveArtifactCsv({
			sourceBoxId: boxId, artifactId: artifactB.artifactId, tableToken: tokenB, csv: 'Value\nb',
		})).toBe(true);
		releaseArtifactCsvTable(boxId, tokenB);
	});

	it('cancels a pending projection when its table binding is released', () => {
		const boxId = 'query_csv_revoked';
		setResultsState(boxId, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-a' },
			policy: { exportToCsv: true },
		});
		const artifact = getCurrentResultArtifact(boxId)!;
		const tableToken = registerArtifactCsvTable(boxId, artifact.artifactId)!;
		saveArtifactCsv({ sourceBoxId: boxId, artifactId: artifact.artifactId, tableToken, csv: 'Value\na' });
		const intent = mocks.postMessageToHost.mock.calls
			.map(call => call[0])
			.find(message => message.type === 'requestArtifactCsvSave');
		releaseArtifactCsvTable(boxId, tableToken);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSaveIntent', requestId: intent.requestId,
		});
		mocks.postMessageToHost.mockClear();

		provideArtifactCsvSaveData({
			requestId: 'host-nonce', exportId: intent.requestId, boxId, artifactId: artifact.artifactId,
		});
		expect(mocks.postMessageToHost).not.toHaveBeenCalled();
	});

	it('drops a canceled pending projection', () => {
		const boxId = 'query_csv_cancelled';
		setResultsState(boxId, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-a' },
			policy: { exportToCsv: true },
		});
		const artifact = getCurrentResultArtifact(boxId)!;
		const tableToken = registerArtifactCsvTable(boxId, artifact.artifactId)!;
		saveArtifactCsv({ sourceBoxId: boxId, artifactId: artifact.artifactId, tableToken, csv: 'Value\na' });
		const intent = mocks.postMessageToHost.mock.calls
			.map(call => call[0])
			.find(message => message.type === 'requestArtifactCsvSave');
		cancelArtifactCsvSave(intent.requestId);
		mocks.postMessageToHost.mockClear();

		provideArtifactCsvSaveData({
			requestId: 'host-nonce', exportId: intent.requestId, boxId, artifactId: artifact.artifactId,
		});
		expect(mocks.postMessageToHost).not.toHaveBeenCalled();
		releaseArtifactCsvTable(boxId, tableToken);
	});

	it('notifies the host when a pending projection expires', () => {
		vi.useFakeTimers();
		const boxId = 'query_csv_expired';
		setResultsState(boxId, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-a' },
			policy: { exportToCsv: true },
		});
		const artifact = getCurrentResultArtifact(boxId)!;
		const tableToken = registerArtifactCsvTable(boxId, artifact.artifactId)!;
		saveArtifactCsv({ sourceBoxId: boxId, artifactId: artifact.artifactId, tableToken, csv: 'Value\na' });
		const intent = mocks.postMessageToHost.mock.calls
			.map(call => call[0])
			.find(message => message.type === 'requestArtifactCsvSave');

		vi.advanceTimersByTime(10 * 60_000);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSaveIntent', requestId: intent.requestId,
		});
		releaseArtifactCsvTable(boxId, tableToken);
	});

	it('allows one pending projection per table', () => {
		const boxId = 'query_csv_duplicate';
		setResultsState(boxId, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-a' },
			policy: { exportToCsv: true },
		});
		const artifact = getCurrentResultArtifact(boxId)!;
		const tableToken = registerArtifactCsvTable(boxId, artifact.artifactId)!;
		const request = { sourceBoxId: boxId, artifactId: artifact.artifactId, tableToken, csv: 'Value\na' };

		expect(saveArtifactCsv(request)).toBe(true);
		expect(saveArtifactCsv(request)).toBe(false);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'showInfo', message: 'A CSV export is already in progress for these results.',
		});
	});

	it('caps pending projections across tables', () => {
		const outcomes: boolean[] = [];
		for (let index = 0; index < 9; index++) {
			const boxId = `query_csv_cap_${index}`;
			setResultsState(boxId, { columns: ['Value'], rows: [[index]], metadata: {} }, {
				producer: { engine: 'kusto', boxId, executionId: `execution-${index}` },
				policy: { exportToCsv: true },
			});
			const artifact = getCurrentResultArtifact(boxId)!;
			const tableToken = registerArtifactCsvTable(boxId, artifact.artifactId)!;
			outcomes.push(saveArtifactCsv({
				sourceBoxId: boxId, artifactId: artifact.artifactId, tableToken, csv: `Value\n${index}`,
			}));
		}

		expect(outcomes).toEqual([true, true, true, true, true, true, true, true, false]);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'showInfo', message: 'Too many CSV exports are already in progress.',
		});
	});

	it('cancels a pending derived export named by transitive source revocation', () => {
		const derivedBoxId = 'transformation_csv_transitive';
		setResultsState(derivedBoxId, { columns: ['Value'], rows: [['derived']], metadata: {} }, {
			producer: { engine: 'transformation', boxId: derivedBoxId, executionId: 'derived' },
			policy: { exportToCsv: true },
		});
		const artifact = getCurrentResultArtifact(derivedBoxId)!;
		const tableToken = registerArtifactCsvTable(derivedBoxId, artifact.artifactId)!;
		saveArtifactCsv({
			sourceBoxId: derivedBoxId, artifactId: artifact.artifactId, tableToken, csv: 'Value\nderived',
		});
		const intent = mocks.postMessageToHost.mock.calls
			.map(call => call[0])
			.find(message => message.type === 'requestArtifactCsvSave');

		window.dispatchEvent(new CustomEvent(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, {
			detail: {
				sourceBoxId: 'query_upstream',
				consumerIds: [csvTableArtifactConsumerId(derivedBoxId)],
			},
		}));

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSaveIntent', requestId: intent.requestId,
		});
		expect(saveArtifactCsv({
			sourceBoxId: derivedBoxId, artifactId: artifact.artifactId, tableToken, csv: 'Value\nderived',
		})).toBe(false);
	});
});