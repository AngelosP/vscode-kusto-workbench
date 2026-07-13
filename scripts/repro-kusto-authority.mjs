#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function usage() {
	return `Usage: npm run repro:kusto-authority -- [options]

Runs exactly two serialized, read-only ADX management requests using Azure CLI
tokens for the same account and resource. The wrong authority must not reveal
the target database; the resource authority must reveal it.

Options (or equivalent environment variables):
  --cluster <https-url>          KUSTO_AUTH_REPRO_CLUSTER
  --database <name>              KUSTO_AUTH_REPRO_DATABASE
  --resource-authority <tenant>  KUSTO_AUTH_REPRO_RESOURCE_AUTHORITY
  --wrong-authority <tenant>     KUSTO_AUTH_REPRO_WRONG_AUTHORITY
  --subscription <guid>          KUSTO_AUTH_REPRO_SUBSCRIPTION (optional)
  --expected-account <name>      KUSTO_AUTH_REPRO_EXPECTED_ACCOUNT (optional)
  --timeout <ms>                 KUSTO_AUTH_REPRO_TIMEOUT_MS (default 30000)
  --help

This script never runs data queries, creates resources, mutates ADX, or prints
access tokens. Start the fixture cluster separately before running it.`;
}

function parseArgs(argv) {
	const options = {
		cluster: process.env.KUSTO_AUTH_REPRO_CLUSTER || '',
		database: process.env.KUSTO_AUTH_REPRO_DATABASE || '',
		resourceAuthority: process.env.KUSTO_AUTH_REPRO_RESOURCE_AUTHORITY || '',
		wrongAuthority: process.env.KUSTO_AUTH_REPRO_WRONG_AUTHORITY || '',
		subscription: process.env.KUSTO_AUTH_REPRO_SUBSCRIPTION || '',
		expectedAccount: process.env.KUSTO_AUTH_REPRO_EXPECTED_ACCOUNT || '',
		timeoutMs: process.env.KUSTO_AUTH_REPRO_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS),
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const next = () => {
			index++;
			if (index >= argv.length) throw new Error(`Missing value for ${argument}`);
			return argv[index];
		};
		switch (argument) {
			case '--cluster': options.cluster = next(); break;
			case '--database': options.database = next(); break;
			case '--resource-authority': options.resourceAuthority = next(); break;
			case '--wrong-authority': options.wrongAuthority = next(); break;
			case '--subscription': options.subscription = next(); break;
			case '--expected-account': options.expectedAccount = next(); break;
			case '--timeout': options.timeoutMs = next(); break;
			case '--help':
				console.log(usage());
				process.exit(0);
			default: throw new Error(`Unknown argument: ${argument}`);
		}
	}

	options.cluster = normalizeClusterUrl(options.cluster);
	options.database = String(options.database || '').trim();
	options.resourceAuthority = normalizeTenant(options.resourceAuthority, 'resource authority');
	options.wrongAuthority = normalizeTenant(options.wrongAuthority, 'wrong authority');
	options.subscription = String(options.subscription || '').trim();
	options.expectedAccount = String(options.expectedAccount || '').trim();
	options.timeoutMs = Number(options.timeoutMs);

	if (!options.database || /[\r\n]/.test(options.database)) throw new Error('A single-line target database name is required.');
	if (options.resourceAuthority === options.wrongAuthority) throw new Error('Resource and wrong authorities must differ.');
	if (options.subscription && !GUID_PATTERN.test(options.subscription)) throw new Error('Subscription must be a GUID.');
	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
		throw new Error('Timeout must be an integer from 1000 through 120000 milliseconds.');
	}
	return options;
}

function normalizeClusterUrl(value) {
	let parsed;
	try {
		parsed = new URL(String(value || '').trim());
	} catch {
		throw new Error('Cluster must be a valid HTTPS root URL.');
	}
	if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
		throw new Error('Cluster must be an HTTPS root URL without credentials, port, path, query, or fragment.');
	}
	return parsed.origin;
}

function normalizeTenant(value, label) {
	const tenant = String(value || '').trim().toLowerCase();
	if (!GUID_PATTERN.test(tenant) && !TENANT_DOMAIN_PATTERN.test(tenant)) {
		throw new Error(`${label} must be a tenant GUID or tenant domain.`);
	}
	return tenant;
}

function redactSensitiveText(value) {
	return String(value || '')
		.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]')
		.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED_TOKEN]')
		.trim();
}

function accountRef(account) {
	return createHash('sha256').update(String(account || ''), 'utf8').digest('hex').slice(0, 12);
}

function runAzureCli(argumentsList, timeoutMs) {
	const command = process.platform === 'win32' ? 'az.cmd' : 'az';
	const result = spawnSync(command, argumentsList, {
		encoding: 'utf8',
		timeout: timeoutMs,
		windowsHide: true,
		shell: process.platform === 'win32',
	});
	if (result.error) {
		if (result.error.code === 'ETIMEDOUT') throw new Error(`Azure CLI timed out after ${timeoutMs} ms.`);
		throw new Error(`Azure CLI could not start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = redactSensitiveText(result.stderr || result.stdout).split(/\r?\n/).filter(Boolean)[0] || `exit ${result.status}`;
		throw new Error(`Azure CLI failed: ${detail}`);
	}
	return String(result.stdout || '').trim();
}

function azureCliScopeArgs(subscription) {
	return subscription ? ['--subscription', subscription] : [];
}

function acquireToken(options, authority) {
	const token = runAzureCli([
		'account', 'get-access-token',
		'--resource', options.cluster,
		'--tenant', authority,
		...azureCliScopeArgs(options.subscription),
		'--query', 'accessToken',
		'--output', 'tsv',
	], options.timeoutMs);
	if (!token || token.length < 40) throw new Error(`Azure CLI returned no usable token for authority ${authority}.`);
	return token;
}

function collectRows(value, rows = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectRows(item, rows);
		return rows;
	}
	if (!value || typeof value !== 'object') return rows;
	if (Array.isArray(value.Rows)) {
		for (const row of value.Rows) if (Array.isArray(row)) rows.push(row);
	}
	for (const [key, child] of Object.entries(value)) {
		if (key !== 'Rows') collectRows(child, rows);
	}
	return rows;
}

async function showDatabases(options, authority) {
	const token = acquireToken(options, authority);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await fetch(`${options.cluster}/v1/rest/mgmt`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ db: options.database, csl: '.show databases' }),
			signal: controller.signal,
		});
		const responseText = await response.text();
		let payload;
		try { payload = responseText ? JSON.parse(responseText) : undefined; } catch { payload = undefined; }
		const rows = collectRows(payload);
		const targetVisible = rows.some(row => row.some(cell => String(cell || '').toLowerCase() === options.database.toLowerCase()));
		return { authority, status: response.status, ok: response.ok, rowCount: rows.length, targetVisible };
	} catch (error) {
		if (error?.name === 'AbortError') throw new Error(`ADX request timed out after ${options.timeoutMs} ms.`);
		throw new Error(`ADX request failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timeout);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const account = runAzureCli([
		'account', 'show',
		...azureCliScopeArgs(options.subscription),
		'--query', 'user.name',
		'--output', 'tsv',
	], options.timeoutMs);
	if (!account) throw new Error('Azure CLI has no active account for this subscription.');
	if (options.expectedAccount && account.toLowerCase() !== options.expectedAccount.toLowerCase()) {
		throw new Error(`Azure CLI account mismatch (actual ref ${accountRef(account)}).`);
	}

	const wrong = await showDatabases(options, options.wrongAuthority);
	const resource = await showDatabases(options, options.resourceAuthority);
	const wrongIsProtected = wrong.status === 401 || wrong.status === 403 || (wrong.ok && !wrong.targetVisible);
	if (!wrongIsProtected) {
		throw new Error(`Wrong authority unexpectedly exposed the target database (HTTP ${wrong.status}).`);
	}
	if (!resource.ok || !resource.targetVisible) {
		throw new Error(`Resource authority did not expose ${options.database} (HTTP ${resource.status}, rows ${resource.rowCount}).`);
	}

	console.log(JSON.stringify({
		result: 'pass',
		operation: '.show databases',
		accountRef: accountRef(account),
		cluster: options.cluster,
		database: options.database,
		wrongAuthority: { tenant: wrong.authority, status: wrong.status, rowCount: wrong.rowCount, targetVisible: wrong.targetVisible },
		resourceAuthority: { tenant: resource.authority, status: resource.status, rowCount: resource.rowCount, targetVisible: resource.targetVisible },
	}, null, 2));
}

main().catch(error => {
	console.error(`Kusto Authority ID repro failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
	process.exitCode = 1;
});