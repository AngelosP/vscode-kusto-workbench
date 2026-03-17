import * as assert from 'assert';
import {
	ensureHttpsUrl,
	getDefaultConnectionName,
	getClusterShortName,
	getClusterShortNameKey,
	getClusterCacheKey,
	normalizeFavoriteClusterUrl
} from '../../src/host/queryEditorConnection';

suite('ensureHttpsUrl', () => {
	test('empty string → empty string', () => {
		assert.strictEqual(ensureHttpsUrl(''), '');
	});

	test('bare hostname → https:// prepended', () => {
		assert.strictEqual(
			ensureHttpsUrl('mycluster.kusto.windows.net'),
			'https://mycluster.kusto.windows.net'
		);
	});

	test('http:// prefix is kept', () => {
		assert.strictEqual(
			ensureHttpsUrl('http://mycluster.kusto.windows.net'),
			'http://mycluster.kusto.windows.net'
		);
	});

	test('https:// prefix is kept unchanged', () => {
		assert.strictEqual(
			ensureHttpsUrl('https://mycluster.kusto.windows.net'),
			'https://mycluster.kusto.windows.net'
		);
	});

	test('whitespace is trimmed before adding scheme', () => {
		assert.strictEqual(ensureHttpsUrl('  mycluster  '), 'https://mycluster');
	});

	test('preserves original casing when scheme is present', () => {
		assert.strictEqual(ensureHttpsUrl('HTTPS://MyCluster'), 'HTTPS://MyCluster');
	});

	test('leading slashes are stripped before prepending scheme', () => {
		assert.strictEqual(ensureHttpsUrl('///mycluster'), 'https://mycluster');
	});
});

suite('getDefaultConnectionName', () => {
	test('returns hostname for standard cluster URL', () => {
		assert.strictEqual(
			getDefaultConnectionName('https://mycluster.kusto.windows.net'),
			'mycluster.kusto.windows.net'
		);
	});

	test('empty string → fallback "Kusto Cluster"', () => {
		assert.strictEqual(getDefaultConnectionName(''), 'Kusto Cluster');
	});

	test('bare hostname → adds https:// then extracts hostname', () => {
		assert.strictEqual(
			getDefaultConnectionName('mycluster.kusto.windows.net'),
			'mycluster.kusto.windows.net'
		);
	});

	test('URL with path → returns only hostname', () => {
		assert.strictEqual(
			getDefaultConnectionName('https://mycluster.kusto.windows.net/some/path'),
			'mycluster.kusto.windows.net'
		);
	});
});

suite('getClusterShortName', () => {
	test('standard cluster URL → first hostname part', () => {
		assert.strictEqual(
			getClusterShortName('https://mycluster.kusto.windows.net'),
			'mycluster'
		);
	});

	test('multi-part hostname → first part only', () => {
		assert.strictEqual(
			getClusterShortName('https://mycluster.eastus2.kusto.windows.net'),
			'mycluster'
		);
	});

	test('bare hostname → first part', () => {
		assert.strictEqual(
			getClusterShortName('mycluster.kusto.windows.net'),
			'mycluster'
		);
	});

	test('single-word (no dots) → returned as-is', () => {
		assert.strictEqual(getClusterShortName('mycluster'), 'mycluster');
	});
});

suite('getClusterShortNameKey', () => {
	test('lowercases the short name', () => {
		assert.strictEqual(
			getClusterShortNameKey('https://MyCluster.kusto.windows.net'),
			'mycluster'
		);
	});

	test('already lowercase → unchanged', () => {
		assert.strictEqual(
			getClusterShortNameKey('https://mycluster.kusto.windows.net'),
			'mycluster'
		);
	});

	test('empty input → empty string', () => {
		assert.strictEqual(getClusterShortNameKey(''), '');
	});

	test('bare hostname with mixed case → lowercased first part', () => {
		assert.strictEqual(
			getClusterShortNameKey('MyCluster.kusto.windows.net'),
			'mycluster'
		);
	});
});

suite('getClusterCacheKey', () => {
	test('standard URL → lowercase hostname', () => {
		assert.strictEqual(
			getClusterCacheKey('https://mycluster.kusto.windows.net'),
			'mycluster.kusto.windows.net'
		);
	});

	test('mixed case + trailing slash → normalized', () => {
		assert.strictEqual(
			getClusterCacheKey('HTTPS://MyCluster.KUSTO.Windows.NET/'),
			'mycluster.kusto.windows.net'
		);
	});

	test('no scheme → adds https:// first, then normalizes', () => {
		assert.strictEqual(
			getClusterCacheKey('mycluster.kusto.windows.net'),
			'mycluster.kusto.windows.net'
		);
	});

	test('empty input → empty string', () => {
		assert.strictEqual(getClusterCacheKey(''), '');
	});

	test('whitespace → trimmed to empty', () => {
		assert.strictEqual(getClusterCacheKey('   '), '');
	});
});

suite('normalizeFavoriteClusterUrl', () => {
	test('bare hostname → https:// prepended', () => {
		assert.strictEqual(
			normalizeFavoriteClusterUrl('mycluster.kusto.windows.net'),
			'https://mycluster.kusto.windows.net'
		);
	});

	test('trailing slash is removed', () => {
		assert.strictEqual(
			normalizeFavoriteClusterUrl('https://mycluster.kusto.windows.net/'),
			'https://mycluster.kusto.windows.net'
		);
	});

	test('whitespace is trimmed', () => {
		assert.strictEqual(
			normalizeFavoriteClusterUrl('  https://mycluster  '),
			'https://mycluster'
		);
	});

	test('empty input → empty string', () => {
		assert.strictEqual(normalizeFavoriteClusterUrl(''), '');
	});

	test('multiple trailing slashes are removed', () => {
		assert.strictEqual(
			normalizeFavoriteClusterUrl('https://mycluster///'),
			'https://mycluster'
		);
	});
});
