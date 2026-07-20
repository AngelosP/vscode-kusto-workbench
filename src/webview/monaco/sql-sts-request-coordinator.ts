export type SqlStsRequestOwner = Readonly<{
	ownerToken: string;
	targetGeneration: number;
}>;

type PendingRequest = {
	boxId: string;
	owner: SqlStsRequestOwner;
	resolve: (value: unknown | null) => void;
	timer: ReturnType<typeof setTimeout>;
};

function ownersEqual(left: SqlStsRequestOwner | undefined, right: SqlStsRequestOwner | undefined): boolean {
	return !!left && !!right
		&& left.ownerToken === right.ownerToken
		&& left.targetGeneration === right.targetGeneration;
}

export class SqlStsRequestCoordinator {
	private readonly ownerByBoxId = new Map<string, SqlStsRequestOwner>();
	private readonly pendingByRequestId = new Map<string, PendingRequest>();
	private readonly requestIdsByBoxId = new Map<string, Set<string>>();
	private requestSequence = 0;

	setOwner(boxId: string, owner: SqlStsRequestOwner | undefined): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		const current = this.ownerByBoxId.get(id);
		if (ownersEqual(current, owner)) return;
		this.settleBox(id);
		if (owner) this.ownerByBoxId.set(id, owner);
		else this.ownerByBoxId.delete(id);
	}

	getOwner(boxId: string): SqlStsRequestOwner | undefined {
		return this.ownerByBoxId.get(String(boxId || '').trim());
	}

	request<T>(
		boxId: string,
		timeoutMs: number,
		dispatch: (requestId: string, owner: SqlStsRequestOwner) => void,
	): Promise<T | null> {
		const id = String(boxId || '').trim();
		const owner = this.ownerByBoxId.get(id);
		if (!owner) return Promise.resolve(null);

		return new Promise<T | null>(resolve => {
			const requestId = `sts_${Date.now()}_${++this.requestSequence}`;
			const timer = setTimeout(() => this.settle(requestId, null), timeoutMs);
			this.pendingByRequestId.set(requestId, {
				boxId: id,
				owner,
				resolve: value => resolve(value as T | null),
				timer,
			});
			let requestIds = this.requestIdsByBoxId.get(id);
			if (!requestIds) {
				requestIds = new Set<string>();
				this.requestIdsByBoxId.set(id, requestIds);
			}
			requestIds.add(requestId);

			try {
				dispatch(requestId, owner);
			} catch {
				this.settle(requestId, null);
			}
		});
	}

	resolve(requestId: string, result: unknown, responseOwner: SqlStsRequestOwner | undefined): boolean {
		const pending = this.pendingByRequestId.get(requestId);
		if (!pending) return false;
		const currentOwner = this.ownerByBoxId.get(pending.boxId);
		const admitted = ownersEqual(pending.owner, responseOwner) && ownersEqual(pending.owner, currentOwner);
		this.settle(requestId, admitted ? result : null);
		return true;
	}

	clearBox(boxId: string): void {
		this.setOwner(boxId, undefined);
	}

	private settleBox(boxId: string): void {
		for (const requestId of [...(this.requestIdsByBoxId.get(boxId) ?? [])]) {
			this.settle(requestId, null);
		}
	}

	private settle(requestId: string, value: unknown | null): void {
		const pending = this.pendingByRequestId.get(requestId);
		if (!pending) return;
		this.pendingByRequestId.delete(requestId);
		clearTimeout(pending.timer);
		const requestIds = this.requestIdsByBoxId.get(pending.boxId);
		requestIds?.delete(requestId);
		if (requestIds?.size === 0) this.requestIdsByBoxId.delete(pending.boxId);
		pending.resolve(value);
	}
}