type RunningQueryEntry = Readonly<{
	cancel: () => void;
	runSeq: number;
	clientActivityId?: string;
	executionId?: string;
}>;

export class QueryRunCoordinator {
	private readonly runningByBoxId = new Map<string, RunningQueryEntry>();
	private runSequence = 0;

	nextSequence(): number {
		return ++this.runSequence;
	}

	get(boxId: string): RunningQueryEntry | undefined {
		return this.runningByBoxId.get(boxId);
	}

	has(boxId: string): boolean {
		return this.runningByBoxId.has(boxId);
	}

	register(boxId: string, entry: RunningQueryEntry): void {
		this.runningByBoxId.set(boxId, entry);
	}

	replaceAndCancel(boxId: string, replacement: RunningQueryEntry): RunningQueryEntry | undefined {
		const previous = this.runningByBoxId.get(boxId);
		this.runningByBoxId.set(boxId, replacement);
		if (previous) {
			try {
				previous.cancel();
			} catch {
				// Replacement remains authoritative even when old cancellation fails.
			}
		}
		return previous;
	}

	replaceIfCurrent(
		boxId: string,
		expectedCancel: () => void,
		expectedRunSeq: number,
		replacement: RunningQueryEntry,
	): boolean {
		if (!this.isCurrent(boxId, expectedCancel, expectedRunSeq)) return false;
		this.runningByBoxId.set(boxId, replacement);
		return true;
	}

	isCurrent(boxId: string, cancel: () => void, runSeq: number): boolean {
		const current = this.runningByBoxId.get(boxId);
		return current?.cancel === cancel && current.runSeq === runSeq;
	}

	unregister(boxId: string, cancel: () => void, runSeq: number): boolean {
		if (!this.isCurrent(boxId, cancel, runSeq)) return false;
		this.runningByBoxId.delete(boxId);
		return true;
	}

	cancel(boxId: string): RunningQueryEntry | undefined {
		const running = this.runningByBoxId.get(boxId);
		if (!running) return undefined;
		this.runningByBoxId.delete(boxId);
		try {
			running.cancel();
		} catch {
			// Cancellation is best-effort; terminal state is still retired.
		}
		return running;
	}

	cancelAll(): void {
		const runningEntries = [...this.runningByBoxId.values()];
		this.runningByBoxId.clear();
		for (const running of runningEntries) {
			try {
				running.cancel();
			} catch {
				// Continue cancelling the remaining runs.
			}
		}
	}
}