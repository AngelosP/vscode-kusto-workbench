import * as path from 'path';
import * as vscode from 'vscode';

export type WorkbenchFileKind =
	| 'kqlx'
	| 'mdx'
	| 'sqlx'
	| 'kql'
	| 'csl'
	| 'kql-sidecar'
	| 'csl-sidecar'
	| 'sql'
	| 'sql-sidecar'
	| 'md';

export interface WorkbenchFileInfo {
	uri: vscode.Uri;
	uriString: string;
	uriKey: string;
	logicalUri: vscode.Uri;
	logicalUriString: string;
	logicalUriKey: string;
	openFileId: string;
	fileKind: WorkbenchFileKind;
	filePath?: string;
	fileName?: string;
	sidecarFor?: string;
	isSidecar: boolean;
}

export interface ClassifyWorkbenchUriOptions {
	viewType?: string;
	includeOptionalPlainText?: boolean;
}

const KQL_COMPAT_VIEW_TYPE = 'kusto.kqlCompatEditor';
const KQLX_VIEW_TYPE = 'kusto.kqlxEditor';
const MD_COMPAT_VIEW_TYPE = 'kusto.mdCompatEditor';
const SQL_COMPAT_VIEW_TYPE = 'kusto.sqlCompatEditor';

function getUriPath(uri: vscode.Uri): string {
	try {
		if (uri.scheme === 'file' && typeof uri.fsPath === 'string' && uri.fsPath) {
			return uri.fsPath;
		}
	} catch {
		// ignore
	}
	return String(uri.path || uri.toString() || '');
}

function withPath(uri: vscode.Uri, nextPath: string): vscode.Uri {
	try {
		if (uri.scheme === 'file') {
			return vscode.Uri.file(nextPath);
		}
		return uri.with({ path: nextPath });
	} catch {
		return uri;
	}
}

function trimJsonSuffix(value: string): string {
	return value.slice(0, -'.json'.length);
}

function normalizePathForKey(value: string): string {
	const normalized = value.replace(/\\/g, '/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function normalizeWorkbenchUriKey(uri: vscode.Uri): string {
	try {
		if (uri.scheme === 'file') {
			return `file:${normalizePathForKey(uri.fsPath || uri.path || uri.toString())}`;
		}
	} catch {
		// ignore
	}
	const scheme = String(uri.scheme || '').toLowerCase();
	const value = String(uri.toString() || '');
	const colonIndex = value.indexOf(':');
	const body = colonIndex >= 0 ? value.slice(colonIndex + 1) : value;
	return `${scheme}:${body}`;
}

function base64UrlEncode(value: string): string {
	return Buffer.from(value, 'utf8')
		.toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

export function openFileIdFromLogicalUriKey(logicalUriKey: string): string {
	return `wf_${base64UrlEncode(logicalUriKey)}`;
}

function displayUri(uri: vscode.Uri): string {
	try {
		return uri.scheme === 'file' ? uri.fsPath : uri.toString();
	} catch {
		return uri.toString();
	}
}

function getFileName(uri: vscode.Uri): string | undefined {
	try {
		if (uri.scheme === 'file') {
			return path.basename(uri.fsPath);
		}
		return path.posix.basename(uri.path || uri.toString()) || undefined;
	} catch {
		return undefined;
	}
}

function optionalPlainTextAllowed(kind: 'md' | 'sql', options: ClassifyWorkbenchUriOptions): boolean {
	if (options.includeOptionalPlainText === true) {
		return true;
	}
	if (kind === 'md') {
		return options.viewType === MD_COMPAT_VIEW_TYPE;
	}
	return options.viewType === SQL_COMPAT_VIEW_TYPE;
}

export function classifyWorkbenchUri(
	uri: vscode.Uri,
	options: ClassifyWorkbenchUriOptions = {}
): WorkbenchFileInfo | undefined {
	const originalPath = getUriPath(uri);
	const lowerPath = originalPath.toLowerCase();
	let fileKind: WorkbenchFileKind | undefined;
	let logicalUri = uri;
	let isSidecar = false;

	if (lowerPath.endsWith('.kql.json')) {
		fileKind = 'kql-sidecar';
		logicalUri = withPath(uri, trimJsonSuffix(originalPath));
		isSidecar = true;
	} else if (lowerPath.endsWith('.csl.json')) {
		fileKind = 'csl-sidecar';
		logicalUri = withPath(uri, trimJsonSuffix(originalPath));
		isSidecar = true;
	} else if (lowerPath.endsWith('.sql.json')) {
		fileKind = 'sql-sidecar';
		logicalUri = withPath(uri, trimJsonSuffix(originalPath));
		isSidecar = true;
	} else if (lowerPath.endsWith('.kqlx')) {
		fileKind = 'kqlx';
	} else if (lowerPath.endsWith('.mdx')) {
		fileKind = 'mdx';
	} else if (lowerPath.endsWith('.sqlx')) {
		fileKind = 'sqlx';
	} else if (lowerPath.endsWith('.kql')) {
		fileKind = 'kql';
	} else if (lowerPath.endsWith('.csl')) {
		fileKind = 'csl';
	} else if (lowerPath.endsWith('.sql') && optionalPlainTextAllowed('sql', options)) {
		fileKind = 'sql';
	} else if (lowerPath.endsWith('.md') && optionalPlainTextAllowed('md', options)) {
		fileKind = 'md';
	}

	if (!fileKind) {
		return undefined;
	}

	const filePath = logicalUri.scheme === 'file' ? logicalUri.fsPath : undefined;
	const logicalUriKey = normalizeWorkbenchUriKey(logicalUri);
	return {
		uri,
		uriString: uri.toString(),
		uriKey: normalizeWorkbenchUriKey(uri),
		logicalUri,
		logicalUriString: logicalUri.toString(),
		logicalUriKey,
		openFileId: openFileIdFromLogicalUriKey(logicalUriKey),
		fileKind,
		...(filePath ? { filePath } : {}),
		...(getFileName(logicalUri) ? { fileName: getFileName(logicalUri) } : {}),
		...(isSidecar ? { sidecarFor: displayUri(logicalUri) } : {}),
		isSidecar,
	};
}

export function classifyWorkbenchUriString(
	uriString: string,
	options: ClassifyWorkbenchUriOptions = {}
): WorkbenchFileInfo | undefined {
	try {
		return classifyWorkbenchUri(vscode.Uri.parse(uriString), options);
	} catch {
		return undefined;
	}
}

export function isWorkbenchCustomEditorViewType(viewType: string | undefined): boolean {
	return viewType === KQLX_VIEW_TYPE
		|| viewType === KQL_COMPAT_VIEW_TYPE
		|| viewType === SQL_COMPAT_VIEW_TYPE
		|| viewType === MD_COMPAT_VIEW_TYPE;
}