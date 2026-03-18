// Pure persistence utility functions.
// No DOM access, no window globals. Extracted from persistence.ts.

/**
 * Normalize a cluster URL for consistent comparison.
 * Ensures https:// prefix, strips trailing slashes, lowercases.
 */
export function normalizeClusterUrl(clusterUrl: unknown): string {
	try {
		let u = String(clusterUrl || '').trim();
		if (!u) return '';
		if (!/^https?:\/\//i.test(u)) {
			u = 'https://' + u;
		}
		return u.replace(/\/+$/g, '').toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Check if a cluster URL is in a "Leave no trace" list.
 * Compares normalized URLs.
 */
export function isLeaveNoTraceCluster(clusterUrl: unknown, leaveNoTraceClusters: unknown[]): boolean {
	try {
		if (!clusterUrl) return false;
		if (!Array.isArray(leaveNoTraceClusters)) return false;
		const normalized = normalizeClusterUrl(clusterUrl);
		if (!normalized) return false;
		return leaveNoTraceClusters.some((lntUrl) =>
			normalizeClusterUrl(lntUrl) === normalized
		);
	} catch {
		return false;
	}
}

/**
 * Compute the UTF-8 byte length of a string.
 * Falls back to UTF-16 code-unit estimate if TextEncoder is unavailable.
 */
export function byteLengthUtf8(text: unknown): number {
	try {
		if (typeof TextEncoder !== 'undefined') {
			return new TextEncoder().encode(String(text)).length;
		}
		// Fallback: approximate (UTF-16 code units). Safe enough for a cap.
		return String(text).length * 2;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

/**
 * Result of attempting to store a query result within the byte cap.
 * `json` is the serialized JSON string if it fits, or `null` if too large.
 */
export interface TryStoreResult {
	json: string | null;
	truncated: boolean;
	rowCount?: number;
}

/**
 * Attempt to serialize a query result into a JSON string within the byte cap.
 * If the result is too large, binary-search the largest number of rows that fit.
 *
 * @param result The query result object (columns, rows, metadata).
 * @param maxBytes Maximum allowed byte length (default 5 MB).
 * @param maxRowsHardCap Maximum rows to consider (default 5000).
 */
export function trySerializeQueryResult(
	result: unknown,
	maxBytes: number = 5 * 1024 * 1024,
	maxRowsHardCap: number = 5000
): TryStoreResult {
	try {
		if (result === undefined || result === null) {
			return { json: null, truncated: false };
		}
		let json = '';
		try {
			json = JSON.stringify(result);
		} catch {
			return { json: null, truncated: false };
		}
		const bytes = byteLengthUtf8(json);
		if (bytes <= maxBytes) {
			return { json, truncated: false };
		}

		// Too large: attempt to persist a truncated version.
		const r = result as Record<string, unknown>;
		const cols = Array.isArray(r.columns) ? r.columns : [];
		const rows = Array.isArray(r.rows) ? r.rows : [];
		const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};

		if (!rows.length) {
			return { json: null, truncated: false };
		}

		const totalRows = rows.length;
		let hi = Math.min(totalRows, maxRowsHardCap);
		let lo = 0;
		let bestJson = '';
		let bestCount = 0;

		// Binary search the largest row count that fits.
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			const candidate = {
				columns: cols,
				rows: rows.slice(0, mid),
				metadata: Object.assign({}, meta, {
					persistedTruncated: true,
					persistedTotalRows: totalRows,
					persistedRows: mid
				})
			};
			let candidateJson = '';
			try {
				candidateJson = JSON.stringify(candidate);
			} catch {
				candidateJson = '';
			}
			const candidateBytes = candidateJson ? byteLengthUtf8(candidateJson) : Number.MAX_SAFE_INTEGER;
			if (candidateJson && candidateBytes <= maxBytes) {
				bestJson = candidateJson;
				bestCount = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}

		if (bestJson && bestCount > 0) {
			return { json: bestJson, truncated: true, rowCount: bestCount };
		}

		return { json: null, truncated: false };
	} catch {
		return { json: null, truncated: false };
	}
}
