/**
 * Pure utility functions extracted from QueryEditorProvider.
 *
 * Zero VS Code imports — can be unit-tested with Vitest.
 */

// ---------------------------------------------------------------------------
// getErrorMessage
// ---------------------------------------------------------------------------

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

// ---------------------------------------------------------------------------
// formatQueryExecutionErrorForUser
// ---------------------------------------------------------------------------

export function formatQueryExecutionErrorForUser(errorMessage: string, clusterUrl: string, database?: string): string {
	const cleaned = errorMessage.replace(/^Query execution failed:\s*/i, '').trim();
	const lower = cleaned.toLowerCase();
	const cluster = String(clusterUrl || '').trim();
	const dbSuffix = database ? ` (db: ${database})` : '';

	if (lower.includes('failed to get cloud info')) {
		return (
			`Can't connect to cluster ${cluster}${dbSuffix}.\n` +
			`This often happens when VPN is off, Wi\u2011Fi is down, or your network blocks outbound HTTPS.\n` +
			`Next steps:\n` +
			`- Turn on your VPN (if required)\n` +
			`- Confirm you have internet access\n` +
			`- Verify the cluster URL is correct\n` +
			`- Try again\n` +
			`\n` +
			`Technical details: ${cleaned}`
		);
	}
	if (lower.includes('etimedout') || lower.includes('timeout')) {
		return (
			`Connection timed out reaching ${cluster}${dbSuffix}.\n` +
			`Next steps:\n` +
			`- Turn on your VPN (if required)\n` +
			`- Check Wi\u2011Fi / network connectivity\n` +
			`- Try again\n` +
			`\n` +
			`Technical details: ${cleaned}`
		);
	}
	if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo')) {
		return (
			`Couldn't resolve the cluster host for ${cluster}${dbSuffix}.\n` +
			`Next steps:\n` +
			`- Verify the cluster URL is correct\n` +
			`- Turn on your VPN (if required)\n` +
			`- Check DNS / network connectivity\n` +
			`\n` +
			`Technical details: ${cleaned}`
		);
	}
	if (lower.includes('econnrefused') || lower.includes('connection refused')) {
		return (
			`Connection was refused by ${cluster}${dbSuffix}.\n` +
			`Next steps:\n` +
			`- Verify the cluster URL is correct\n` +
			`- Check VPN / proxy / firewall rules\n` +
			`- Try again\n` +
			`\n` +
			`Technical details: ${cleaned}`
		);
	}
	if (lower.includes('aads') || lower.includes('aadsts') || lower.includes('unauthorized') || lower.includes('authentication')) {
		return (
			`Authentication failed connecting to ${cluster}${dbSuffix}.\n` +
			`Next steps:\n` +
			`- Re-authenticate (sign in again)\n` +
			`- Confirm you have access to the database\n` +
			`- Try again\n` +
			`\n` +
			`Technical details: ${cleaned}`
		);
	}

	const firstLine = cleaned.split(/\r?\n/)[0]?.trim() ?? '';
	const isJsonLike = firstLine.startsWith('{') || firstLine.startsWith('[');
	const isKustoQueryError = /\b(semantic|syntax)\s+error\b/i.test(firstLine);
	const includeSnippet = !!firstLine && !isJsonLike && (isKustoQueryError || firstLine.length <= 160);

	return includeSnippet
		? `Query failed${dbSuffix}: ${firstLine}`
		: `Query failed${dbSuffix}: ${cleaned || 'Unknown error'}`;
}

// ---------------------------------------------------------------------------
// isControlCommand
// ---------------------------------------------------------------------------

export function isControlCommand(query: string): boolean {
	const trimmed = (query ?? '').replace(/^\s+/, '');
	let i = 0;
	while (i < trimmed.length) {
		while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
		if (i >= trimmed.length) return false;
		if (trimmed[i] === '/' && trimmed[i + 1] === '/') {
			const nl = trimmed.indexOf('\n', i + 2);
			if (nl < 0) return false;
			i = nl + 1;
			continue;
		}
		if (trimmed[i] === '/' && trimmed[i + 1] === '*') {
			const end = trimmed.indexOf('*/', i + 2);
			if (end < 0) return false;
			i = end + 2;
			continue;
		}
		return trimmed[i] === '.';
	}
	return false;
}

// ---------------------------------------------------------------------------
// appendQueryMode
// ---------------------------------------------------------------------------

export function appendQueryMode(query: string, queryMode?: string): string {
	if (isControlCommand(query)) {
		return query;
	}

	const mode = (queryMode ?? '').toLowerCase();
	let fragment = '';
	switch (mode) {
		case 'take100':
			fragment = '| take 100';
			break;
		case 'sample100':
			fragment = '| sample 100';
			break;
		case 'plain':
		case '':
		default:
			return query;
	}

	const base = query.replace(/\s+$/g, '').replace(/;+\s*$/g, '');
	return `${base}\n${fragment}`;
}

// ---------------------------------------------------------------------------
// buildCacheDirective
// ---------------------------------------------------------------------------

export function buildCacheDirective(
	cacheEnabled?: boolean,
	cacheValue?: number,
	cacheUnit?: string
): string | undefined {
	if (!cacheEnabled || !cacheValue || !cacheUnit) {
		return undefined;
	}

	const unit = String(cacheUnit).toLowerCase();
	let timespan: string | undefined;
	switch (unit) {
		case 'minutes':
			timespan = `time(${cacheValue}m)`;
			break;
		case 'hours':
			timespan = `time(${cacheValue}h)`;
			break;
		case 'days':
			timespan = `time(${cacheValue}d)`;
			break;
		default:
			return undefined;
	}

	return `set query_results_cache_max_age = ${timespan};`;
}
