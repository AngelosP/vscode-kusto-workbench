import type * as vscode from 'vscode';

import type { ConnectionManager, KustoConnectionChange } from './connectionManager';
import { getKustoConnectionIdentityKey } from '../shared/kustoAuth';

export interface KustoConnectionLifecycleEffects {
	invalidateConnections(connectionIds: readonly string[]): void;
	publishIdentityChange(connectionIds: readonly string[]): unknown | PromiseLike<unknown>;
	refreshConnections(): unknown | PromiseLike<unknown>;
}

function safeConnectionIdentity(connection: { clusterUrl: string; authorityId?: string }): string | undefined {
	try {
		return getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
	} catch {
		return undefined;
	}
}

export function getIdentityInvalidatedConnectionIds(change: KustoConnectionChange): readonly string[] {
	switch (change.type) {
		case 'added':
			return [];
		case 'removed':
			return [change.connection.id];
		case 'cleared':
			return change.connections.map(connection => connection.id);
		case 'updated': {
			const currentIdentity = safeConnectionIdentity(change.connection);
			const previousIdentity = safeConnectionIdentity(change.previous);
			return currentIdentity !== undefined && previousIdentity !== undefined && currentIdentity === previousIdentity
				? []
				: [change.connection.id];
		}
	}
}

export class KustoConnectionLifecycle implements vscode.Disposable {
	private readonly subscription: vscode.Disposable;
	private tail: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		connectionManager: ConnectionManager,
		private readonly effects: KustoConnectionLifecycleEffects,
	) {
		this.subscription = connectionManager.onDidChangeConnections(change => {
			const run = () => this.handleChange(change);
			const next = this.tail.then(run, run);
			this.tail = next.catch(() => undefined);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.subscription.dispose();
	}

	private async handleChange(change: KustoConnectionChange): Promise<void> {
		if (this.disposed) return;
		try {
			const invalidated = [...new Set(getIdentityInvalidatedConnectionIds(change).filter(Boolean))];
			if (invalidated.length > 0) {
				this.effects.invalidateConnections(invalidated);
				await this.effects.publishIdentityChange(invalidated);
			}
		} finally {
			if (!this.disposed) await this.effects.refreshConnections();
		}
	}
}