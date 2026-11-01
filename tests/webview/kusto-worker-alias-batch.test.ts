// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { parseKustoClusterRef } from '../../src/shared/kustoClusterUrls';

type Database = { name: string; majorVersion: number; columns: string[] };
type Symbol = Readonly<{ Name: string; columns: readonly string[] }>;

const clusterUrl = 'https://help.kusto.windows.net';
const aliases = ['help', 'help.kusto.windows.net'];
const vendorSource = readFileSync('node_modules/@kusto/monaco-kusto/release/min/kustoWorker.js', 'utf8');
const buildSource = ts.createSourceFile('esbuild.js', readFileSync('esbuild.js', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = buildSource.statements.find(statement =>
	ts.isFunctionDeclaration(statement) && statement.name?.text === 'patchMonacoKustoDatabaseAliases',
);
if (!declaration) throw new Error('Missing database alias build patch');

async function patch(source = vendorSource) {
	let output = '';
	const writeFile = vi.fn(async (_file: string, value: string) => { output = value; });
	const context = createContext({
		fs: { promises: { readFile: async () => source, writeFile } },
	});
	runInContext(declaration.getText(buildSource), context);
	await context.patchMonacoKustoDatabaseAliases('worker.js');
	return { output, writeFile };
}

async function methods() {
	const { output } = await patch();
	const source = ts.createSourceFile('worker.js', output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const declarations: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isObjectLiteralExpression(node)) {
			const key = node.properties.find(property =>
				ts.isPropertyAssignment(property) && property.name.getText(source) === 'key',
			);
			if (key && ts.isPropertyAssignment(key) && ts.isStringLiteral(key.initializer)
				&& key.initializer.text === 'addDatabaseAliasesToSchema') {
				const value = node.properties.find(property =>
					ts.isPropertyAssignment(property) && property.name.getText(source) === 'value',
				);
				if (value && ts.isPropertyAssignment(value)) declarations.push(value.initializer.getText(source));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	expect(declarations).toHaveLength(2);
	const service = declarations.find(value => value.includes('convertToDatabaseSymbol'));
	const proxy = declarations.find(value => value.includes('this._languageService'));
	if (!service || !proxy) throw new Error('Both alias batch implementations must be present');
	return { output, service, proxy };
}

class Cluster {
	constructor(readonly Name: string, readonly databases: ReadonlyMap<string, Symbol> = new Map()) {}
	GetDatabase(name: string): Symbol | undefined { return this.databases.get(name); }
	AddOrUpdateDatabase(database: Symbol): Cluster {
		return new Cluster(this.Name, new Map([...this.databases, [database.Name, database]]));
	}
}

class Globals {
	constructor(
		readonly Cluster: Cluster,
		readonly Database: Symbol,
		readonly clusters: ReadonlyMap<string, Cluster> = new Map([[Cluster.Name, Cluster]]),
	) {}
	GetCluster$1(name: string): Cluster | undefined { return this.clusters.get(name); }
	AddOrReplaceCluster(cluster: Cluster): Globals {
		return new Globals(this.Cluster, this.Database, new Map([...this.clusters, [cluster.Name, cluster]]));
	}
	WithCluster(cluster: Cluster): Globals { return new Globals(cluster, this.Database, this.clusters); }
	WithDatabase(database: Symbol): Globals { return new Globals(this.Cluster, database, this.clusters); }
}

async function harness(primaryUrl = clusterUrl, primaryName = 'help') {
	const implementations = await methods();
	const convert = vi.fn((database: Database): Symbol => Object.freeze({
		Name: database.name, columns: Object.freeze([...database.columns]),
	}));
	const primary: Database = { name: 'TelemetryDb', majorVersion: 17, columns: ['Before'] };
	const primarySymbol = convert(primary);
	convert.mockClear();
	const primaryCluster = new Cluster(primaryName, new Map([[primary.name, primarySymbol]]));
	const initialGlobals = new Globals(primaryCluster, primarySymbol);
	const script = vi.fn((text: string, globals: Globals) => ({ text, globals }));
	const cache: Record<string, Record<string, { database: Database; symbol: Symbol; includesFunctions: boolean }>> = {
		[primaryUrl]: { [primary.name]: { database: primary, symbol: primarySymbol, includesFunctions: true } },
	};
	const context = createContext({
		Kusto: { Language: { KustoFacts: { GetHostName: (alias: string) => parseKustoClusterRef(alias).host } } },
		mu: { ClusterSymbol: { $ctor1: class extends Cluster { constructor(name: string) { super(name); } } } },
		u: { convertToDatabaseSymbol: convert },
		Du: { CodeScript: { From$1: script } },
	});
	const apply = runInContext(`(${implementations.service})`, context);
	const service = {
		_schemaCache: cache,
		_schema: { cluster: { connectionString: primaryUrl } },
		_kustoJsSchemaV2: initialGlobals,
		_script: { initial: true },
		_parsePropertiesV2: { stale: true },
	};
	const document = { getText: () => 'Events' };
	return {
		...implementations, service, primary, primarySymbol, initialGlobals, convert, script, document,
		apply: (database = primary, url = primaryUrl, names: readonly string[] = aliases) =>
			apply.call(service, document, url, names, database),
	};
}

describe('Monaco Kusto database alias batch', () => {
	it('patches the exact dependency service and proxy without replacing legacy entry points', async () => {
		const { output, writeFile } = await patch();
		expect(writeFile).toHaveBeenCalledOnce();
		expect(output.match(/key:"addDatabaseAliasesToSchema"/g)).toHaveLength(2);
		expect(output.match(/key:"addDatabaseToSchema"/g)).toHaveLength(2);
	});

	it.each(['changed dependency', 'already patched'])('rejects %s instead of silently producing an incompatible worker', async mode => {
		const source = mode === 'already patched' ? (await patch()).output
			: vendorSource.replace('key:"addDatabaseToSchema"', 'key:"differentDatabaseMethod"');
		await expect(patch(source)).rejects.toThrow('Expected one unpatched Monaco Kusto database service and worker proxy.');
	});

	it('reuses the primary database symbol for every alias without reconstructing its columns', async () => {
		const state = await harness();
		await state.apply();
		expect(state.convert).not.toHaveBeenCalled();
		for (const alias of aliases) {
			expect(state.service._kustoJsSchemaV2.GetCluster$1(alias)?.GetDatabase('TelemetryDb')).toBe(state.primarySymbol);
		}
		expect(state.service._kustoJsSchemaV2.Database).toBe(state.primarySymbol);
		expect(state.script).toHaveBeenCalledOnce();
		expect(state.service._parsePropertiesV2).toBeUndefined();
	});

	it('constructs a later revision once and replaces all aliases and the default without mutating prior state', async () => {
		const state = await harness();
		await state.apply();
		const previous = state.service._kustoJsSchemaV2;
		const next: Database = { name: 'TelemetryDb', majorVersion: 18, columns: ['Before', 'After'] };
		await state.apply(next);
		expect(state.convert).toHaveBeenCalledOnce();
		const symbol = state.convert.mock.results[0].value;
		for (const alias of aliases) {
			expect(state.service._kustoJsSchemaV2.GetCluster$1(alias)?.GetDatabase('TelemetryDb')).toBe(symbol);
		}
		expect(state.service._kustoJsSchemaV2.Database).toBe(symbol);
		expect(symbol.columns).toEqual(['Before', 'After']);
		expect(previous.Database).toBe(state.primarySymbol);
		expect(previous.Database.columns).toEqual(['Before']);
		expect(state.service._schemaCache[clusterUrl].TelemetryDb.symbol).toBe(symbol);
	});

	it('shares an unrelated cluster database without retargeting the selected context', async () => {
		const state = await harness();
		const database: Database = { name: 'TelemetryDb', majorVersion: 17, columns: ['Remote'] };
		await state.apply(database, 'https://remote.kusto.windows.net', ['remote', 'remote.kusto.windows.net']);
		expect(state.convert).toHaveBeenCalledOnce();
		const symbol = state.convert.mock.results[0].value;
		expect(state.service._kustoJsSchemaV2.GetCluster$1('remote')?.GetDatabase(database.name)).toBe(symbol);
		expect(state.service._kustoJsSchemaV2.GetCluster$1('remote.kusto.windows.net')?.GetDatabase(database.name)).toBe(symbol);
		expect(state.service._kustoJsSchemaV2.Cluster).toBe(state.initialGlobals.Cluster);
		expect(state.service._kustoJsSchemaV2.Database).toBe(state.primarySymbol);
	});

	it('updates the native default for a custom endpoint without requiring an added short alias', async () => {
		const url = 'https://events.example.test';
		const state = await harness(url, 'events');
		await state.apply({ name: 'TelemetryDb', majorVersion: 18, columns: ['Custom'] }, url, ['events.example.test']);
		const symbol = state.convert.mock.results[0].value;
		expect(state.convert).toHaveBeenCalledOnce();
		expect(state.service._kustoJsSchemaV2.GetCluster$1('events.example.test')?.GetDatabase('TelemetryDb')).toBe(symbol);
		expect(state.service._kustoJsSchemaV2.Cluster.Name).toBe('events');
		expect(state.service._kustoJsSchemaV2.Database).toBe(symbol);
	});

	it('keeps other cached databases and the selected database when adding a sibling', async () => {
		const state = await harness();
		const sibling: Database = { name: 'Sibling', majorVersion: 18, columns: ['SiblingColumn'] };
		await state.apply(sibling);
		expect(state.convert).toHaveBeenCalledOnce();
		expect(state.service._schemaCache[clusterUrl].TelemetryDb.symbol).toBe(state.primarySymbol);
		expect(state.service._schemaCache[clusterUrl].Sibling.symbol.columns).toEqual(['SiblingColumn']);
		expect(state.service._kustoJsSchemaV2.Database).toBe(state.primarySymbol);
		expect(state.service._kustoJsSchemaV2.Cluster.GetDatabase('Sibling')?.columns).toEqual(['SiblingColumn']);
	});

	it('refreshes a cached incomplete function set instead of reusing it', async () => {
		const state = await harness();
		state.service._schemaCache[clusterUrl].TelemetryDb.includesFunctions = false;
		await state.apply();
		expect(state.convert).toHaveBeenCalledOnce();
		expect(state.service._schemaCache[clusterUrl].TelemetryDb.includesFunctions).toBe(true);
	});

	it('does not publish a new cache entry or globals when script construction fails', async () => {
		const state = await harness();
		state.script.mockImplementation(() => { throw new Error('script preparation failed'); });
		expect(() => state.apply({ name: 'TelemetryDb', majorVersion: 18, columns: ['After'] }))
			.toThrow('script preparation failed');
		expect(state.service._kustoJsSchemaV2).toBe(state.initialGlobals);
		expect(state.service._schemaCache[clusterUrl].TelemetryDb.symbol).toBe(state.primarySymbol);
	});

	it('handles property-like database names without changing cache prototypes', async () => {
		const state = await harness();
		const prototype = Object.getPrototypeOf(state.service._schemaCache[clusterUrl]);
		await state.apply({ name: '__proto__', majorVersion: 18, columns: ['Safe'] });
		expect(Object.getPrototypeOf(state.service._schemaCache[clusterUrl])).toBe(prototype);
		expect(Object.prototype.hasOwnProperty.call(state.service._schemaCache[clusterUrl], '__proto__')).toBe(true);
	});

	it.each(['empty aliases', 'empty cluster', 'invalid revision'] as const)('rejects %s before constructing or publishing symbols', async invalid => {
		const state = await harness();
		expect(() => state.apply(
			{ ...state.primary, majorVersion: invalid === 'invalid revision' ? -1 : 17 },
			invalid === 'empty cluster' ? '' : clusterUrl,
			invalid === 'empty aliases' ? [] : aliases,
		)).toThrow('Invalid Monaco Kusto database alias batch.');
		expect(state.convert).not.toHaveBeenCalled();
		expect(state.service._kustoJsSchemaV2).toBe(state.initialGlobals);
	});

	it('forwards the complete batch through the worker proxy and rejects a missing model', async () => {
		const implementations = await methods();
		const proxy = runInContext(`(${implementations.proxy})`, createContext({}));
		const document = { getText: () => 'Events' };
		const forwarded = vi.fn(async () => undefined);
		const database: Database = { name: 'TelemetryDb', majorVersion: 17, columns: ['Column'] };
		const worker = { _getTextDocument: (uri: string) => uri === 'model' ? document : undefined,
			_languageService: { addDatabaseAliasesToSchema: forwarded } };
		await proxy.call(worker, 'model', clusterUrl, aliases, database);
		expect(forwarded).toHaveBeenCalledExactlyOnceWith(document, clusterUrl, aliases, database);
		await expect(proxy.call(worker, 'missing', clusterUrl, aliases, database)).rejects.toThrow('missing Monaco model');
		expect(forwarded).toHaveBeenCalledOnce();
	});
});
