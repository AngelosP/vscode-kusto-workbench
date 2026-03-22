import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** Minimal interface the controller needs from its host element. */
export interface RowJumpHost extends ReactiveControllerHost, HTMLElement {
	getSelectedCol(): number;
}

/**
 * Manages the jump-to-row dialog state, query parsing, target navigation,
 * and scroll-to-row for `<kw-data-table>`.
 */
export class TableRowJumpController implements ReactiveController {
	host: RowJumpHost;

	// ── Public state (read by host in render()) ──
	visible = false;
	query = '';
	targets: number[] = [];
	currentIndex = 0;
	error = '';

	/** Callback for scrolling to a given row index. Set by the host. */
	scrollToRow: ((index: number) => void) | null = null;

	constructor(host: RowJumpHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void { /* no-op */ }
	hostDisconnected(): void { /* no-op */ }

	// ── Public API ──

	toggle(totalRows: number): void {
		this.visible = !this.visible;
		if (this.visible) {
			this.exec(totalRows);
		} else {
			this.targets = [];
			this.query = '';
			this.currentIndex = 0;
			this.error = '';
		}
		this.host.requestUpdate();
	}

	close(totalRows: number): void {
		if (!this.visible) return;
		this.toggle(totalRows);
	}

	setQuery(value: string, totalRows: number): void {
		this.query = value;
		this.exec(totalRows);
	}

	exec(totalRows: number): void {
		const parsed = this._parseTargets(this.query, totalRows);
		this.targets = parsed.targets;
		this.error = parsed.error;
		this.currentIndex = 0;
		if (!parsed.error && parsed.targets.length > 0) this._goToTarget(0);
		this.host.requestUpdate();
	}

	nextTarget(): void {
		if (!this.targets.length) return;
		this.currentIndex = (this.currentIndex + 1) % this.targets.length;
		this._goToTarget(this.currentIndex);
		this.host.requestUpdate();
	}

	prevTarget(): void {
		if (!this.targets.length) return;
		this.currentIndex = (this.currentIndex - 1 + this.targets.length) % this.targets.length;
		this._goToTarget(this.currentIndex);
		this.host.requestUpdate();
	}

	/** Reset state when the underlying data changes. */
	reset(): void {
		this.targets = [];
		this.currentIndex = 0;
		this.error = '';
	}

	// ── Private ──

	private _goToTarget(index: number): void {
		const row = this.targets[index];
		if (row === undefined) return;
		this.scrollToRow?.(row);
	}

	private _parseTargets(query: string, maxRows: number): { targets: number[]; error: string } {
		const txt = query.trim();
		if (!txt) return { targets: [], error: '' };
		if (maxRows <= 0) return { targets: [], error: 'No rows available' };

		const tokens = txt.split(',').map(t => t.trim()).filter(Boolean);
		if (!tokens.length) return { targets: [], error: '' };

		const out: number[] = [];
		const seen = new Set<number>();
		for (const token of tokens) {
			const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
			if (rangeMatch) {
				const start = parseInt(rangeMatch[1], 10);
				const end = parseInt(rangeMatch[2], 10);
				if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) {
					return { targets: [], error: `Invalid row range: ${token}` };
				}
				const lo = Math.min(start, end);
				const hi = Math.max(start, end);
				for (let oneBased = lo; oneBased <= hi; oneBased++) {
					if (oneBased > maxRows) continue;
					const zeroBased = oneBased - 1;
					if (!seen.has(zeroBased)) { seen.add(zeroBased); out.push(zeroBased); }
				}
				continue;
			}

			if (!/^\d+$/.test(token)) return { targets: [], error: `Invalid row number: ${token}` };
			const oneBased = parseInt(token, 10);
			if (!Number.isFinite(oneBased) || oneBased < 1) return { targets: [], error: `Invalid row number: ${token}` };
			if (oneBased > maxRows) continue;
			const zeroBased = oneBased - 1;
			if (!seen.has(zeroBased)) { seen.add(zeroBased); out.push(zeroBased); }
		}

		if (!out.length) return { targets: [], error: `No rows in range (1-${maxRows})` };
		return { targets: out, error: '' };
	}
}
