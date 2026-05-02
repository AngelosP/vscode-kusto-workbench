import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const catalogPath = join(root, 'media', 'tutorials', 'catalog.v1.json');
const allowedCommands = new Set([
	'kusto.openQueryEditor',
	'kusto.manageConnections',
	'kusto.openCustomAgent',
]);

const errors = [];

function fail(message) {
	errors.push(message);
}

function requireString(value, path) {
	if (typeof value !== 'string' || value.trim() === '') {
		fail(`${path} must be a non-empty string`);
		return '';
	}
	return value.trim();
}

function isSafeContentUrl(value) {
	if (/^(command|javascript|vscode|vscode-insiders|file|data):/i.test(value)) return false;
	if (value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
	if (value.split('/').includes('..')) return false;
	return true;
}

function isSemverLikeVersion(value) {
	return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isAllowedRemoteUrl(value) {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' && ['github.com', 'raw.githubusercontent.com'].includes(parsed.hostname.toLowerCase());
	} catch {
		return false;
	}
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
if (catalog.schemaVersion !== 1) fail('schemaVersion must be 1');
requireString(catalog.generatedAt, 'generatedAt');
if (!Array.isArray(catalog.categories)) fail('categories must be an array');
if (!Array.isArray(catalog.tutorials)) fail('tutorials must be an array');

const categoryIds = new Set();
for (const [index, category] of (catalog.categories || []).entries()) {
	const id = requireString(category?.id, `categories[${index}].id`);
	requireString(category?.title, `categories[${index}].title`);
	if (categoryIds.has(id)) fail(`duplicate category id ${id}`);
	categoryIds.add(id);
}

const tutorialIds = new Set();
for (const [index, tutorial] of (catalog.tutorials || []).entries()) {
	const id = requireString(tutorial?.id, `tutorials[${index}].id`);
	const categoryId = requireString(tutorial?.categoryId, `tutorials[${index}].categoryId`);
	const contentUrl = requireString(tutorial?.contentUrl, `tutorials[${index}].contentUrl`);
	requireString(tutorial?.title, `tutorials[${index}].title`);
	requireString(tutorial?.summary, `tutorials[${index}].summary`);
	const minExtensionVersion = requireString(tutorial?.minExtensionVersion, `tutorials[${index}].minExtensionVersion`);
	requireString(tutorial?.updateToken, `tutorials[${index}].updateToken`);
	if (tutorialIds.has(id)) fail(`duplicate tutorial id ${id}`);
	tutorialIds.add(id);
	if (!categoryIds.has(categoryId)) fail(`tutorial ${id} references unknown category ${categoryId}`);
	if (!isSafeContentUrl(contentUrl)) fail(`tutorial ${id} has unsafe contentUrl ${contentUrl}`);
	if (minExtensionVersion && !isSemverLikeVersion(minExtensionVersion)) fail(`tutorial ${id} has invalid minExtensionVersion ${minExtensionVersion}`);
	if (/^https?:\/\//i.test(contentUrl)) {
		if (!isAllowedRemoteUrl(contentUrl)) fail(`tutorial ${id} remote contentUrl must be HTTPS GitHub-hosted: ${contentUrl}`);
	} else {
		const localPath = normalize(join(dirname(catalogPath), contentUrl));
		if (!localPath.startsWith(normalize(dirname(catalogPath)))) fail(`tutorial ${id} content escapes media/tutorials`);
		if (!existsSync(localPath)) fail(`tutorial ${id} content file does not exist: ${contentUrl}`);
	}
	for (const [actionIndex, action] of (tutorial.actions || []).entries()) {
		const command = requireString(action?.command, `tutorials[${index}].actions[${actionIndex}].command`);
		if (!allowedCommands.has(command)) fail(`tutorial ${id} uses blocked command ${command}`);
	}
}

if (errors.length) {
	console.error('Tutorial catalog validation failed:');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(`Tutorial catalog OK: ${catalog.tutorials.length} tutorials in ${catalog.categories.length} categories.`);
