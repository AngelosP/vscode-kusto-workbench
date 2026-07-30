import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	clearResultsState,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	setResultsState,
} from '../../src/webview/core/results-state.js';
import { diffArtifactConsumerId } from '../../src/shared/resultArtifact.js';
import '../../src/webview/viewers/diff-view/kw-diff-view.js';
import type { KwDiffView } from '../../src/webview/viewers/diff-view/kw-diff-view.js';

function publish(boxId: string, executionId: string, value: string) {
	return setResultsState(boxId, {
		boxId, columns: ['Value'], rows: [[value]], metadata: {},
	}, {
		producer: { engine: 'kusto', boxId, executionId },
		policy: { exportToCsv: true },
	});
}

describe('Diff immutable artifact bindings', () => {
	let view: KwDiffView;

	beforeEach(() => {
		view = document.createElement('kw-diff-view') as KwDiffView;
		document.body.appendChild(view);
	});

	afterEach(() => {
		view.remove();
		clearResultsState('query_diff_a');
		clearResultsState('query_diff_b');
	});

	it('pins exact A and B artifacts when current advances', async () => {
		const artifactA = publish('query_diff_a', 'a-1', 'a-1')!;
		const artifactB = publish('query_diff_b', 'b-1', 'b-1')!;
		view.open({
			aBoxId: 'query_diff_a', bBoxId: 'query_diff_b',
			aArtifactId: artifactA.artifactId, bArtifactId: artifactB.artifactId,
		});
		publish('query_diff_a', 'a-2', 'a-2');
		await view.updateComplete;

		expect(getCurrentResultArtifact('query_diff_a')?.producer?.executionId).toBe('a-2');
		expect(getBoundResultArtifact(diffArtifactConsumerId('a'), 'query_diff_a')).toBe(artifactA);
		expect(getBoundResultArtifact(diffArtifactConsumerId('b'), 'query_diff_b')).toBe(artifactB);
		expect((view as any)._model?._aState).toBe(artifactA);
	});

	it('clears its model and bindings on close', () => {
		const artifactA = publish('query_diff_a', 'a-1', 'a-1')!;
		const artifactB = publish('query_diff_b', 'b-1', 'b-1')!;
		view.open({
			aBoxId: 'query_diff_a', bBoxId: 'query_diff_b',
			aArtifactId: artifactA.artifactId, bArtifactId: artifactB.artifactId,
		});

		view.close();

		expect(view.isVisible).toBe(false);
		expect((view as any)._model).toBeNull();
		expect(getBoundResultArtifact(diffArtifactConsumerId('a'))).toBeNull();
		expect(getBoundResultArtifact(diffArtifactConsumerId('b'))).toBeNull();
	});

	it('closes synchronously when either bound source is revoked', () => {
		const artifactA = publish('query_diff_a', 'a-1', 'a-1')!;
		const artifactB = publish('query_diff_b', 'b-1', 'b-1')!;
		view.open({
			aBoxId: 'query_diff_a', bBoxId: 'query_diff_b',
			aArtifactId: artifactA.artifactId, bArtifactId: artifactB.artifactId,
		});

		return view.updateComplete.then(() => {
			const tables = Array.from(view.shadowRoot?.querySelectorAll<any>('kw-data-table') || []);
			expect(tables.length).toBeGreaterThan(0);
			const table = tables[0];
			(table as any)._selectionCtrl.setSelectedCell({ row: 0, col: 0 });

			clearResultsState('query_diff_a');

			expect(view.isVisible).toBe(false);
			expect((view as any)._model).toBeNull();
			expect(getBoundResultArtifact(diffArtifactConsumerId('b'))).toBeNull();
			for (const child of tables) {
				expect(child.rows).toEqual([]);
				expect(child.columns).toEqual([]);
				expect(child.canCopyRows()).toBe(false);
				expect((child as any)._table).toBeNull();
			}
		});
	});
});
