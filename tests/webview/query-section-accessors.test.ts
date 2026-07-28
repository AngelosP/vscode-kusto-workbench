import { beforeEach, describe, expect, it, vi } from 'vitest';

import { retireKustoOptimizeForQueryEdit, synchronizeKustoSectionTarget } from '../../src/webview/core/query-section-accessors.js';

function section(id: string, connectionId: string, database: string, clusterUrl: string) {
	const element = document.createElement('kw-query-section') as any;
	element.id = id;
	let currentConnectionId = connectionId;
	let currentDatabase = database;
	let currentClusterUrl = clusterUrl;
	element.getConnectionId = () => currentConnectionId;
	element.getDatabase = () => currentDatabase;
	element.getClusterUrl = () => currentClusterUrl;
	element.setConnectionId = vi.fn((value: string) => { currentConnectionId = value; currentClusterUrl = clusterUrl; });
	element.setDesiredDatabase = vi.fn();
	element.clearDesiredDatabase = vi.fn();
	element.setDatabase = vi.fn((value: string) => { currentDatabase = value; });
	element.setSchemaLifecycleTarget = vi.fn();
	element.clearTargetBoundState = vi.fn();
	document.body.appendChild(element);
	return element;
}

describe('synchronizeKustoSectionTarget', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('retires execution and target-bound state before changing the comparison target', () => {
		const source = section('query_source', 'connection-a', 'DbA', 'https://cluster-a.kusto.windows.net');
		const target = section('query_comparison', 'connection-b', 'DbB', 'https://cluster-b.kusto.windows.net');
		target.setConnectionId.mockImplementation((value: string) => {
			expect(target.clearTargetBoundState).toHaveBeenCalledOnce();
			currentTarget(target, value, source.getClusterUrl());
		});

		expect(synchronizeKustoSectionTarget(source.id, target.id)).toBe(true);
		expect(target.clearTargetBoundState).toHaveBeenCalledOnce();
	});

	it('does not clear state when the full data target already matches', () => {
		const source = section('query_source', 'connection-a', 'DbA', 'https://cluster-a.kusto.windows.net');
		const target = section('query_comparison', 'connection-a', 'DbA', 'https://cluster-a.kusto.windows.net');

		expect(synchronizeKustoSectionTarget(source.id, target.id)).toBe(true);
		expect(target.clearTargetBoundState).not.toHaveBeenCalled();
	});

	it('retires standalone Optimize when the source query changes', () => {
		const source = section('query_source', 'connection-a', 'DbA', 'https://cluster-a.kusto.windows.net');
		source.retireKustoOptimizeRequest = vi.fn();

		retireKustoOptimizeForQueryEdit(source.id);

		expect(source.retireKustoOptimizeRequest).toHaveBeenCalledOnce();
	});
});

function currentTarget(target: any, connectionId: string, clusterUrl: string): void {
	target.getConnectionId = () => connectionId;
	target.getClusterUrl = () => clusterUrl;
}