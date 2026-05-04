import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const catalogPath = join(root, 'media', 'tutorials', 'catalog.v1.json');
const tutorialsRoot = dirname(catalogPath);
const maxImageBytes = 3 * 1024 * 1024;

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

function isInside(parent, child) {
	const rel = relative(parent, child);
	return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function validateMarkdownImageReferences(markdown, contentPath, tutorialId) {
	const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	for (const match of markdown.matchAll(imagePattern)) {
		const imageRef = match[1].trim();
		if (/^https?:\/\//i.test(imageRef)) {
			if (!isAllowedRemoteUrl(imageRef)) fail(`tutorial ${tutorialId} image URL must be HTTPS GitHub-hosted: ${imageRef}`);
			continue;
		}
		if (!isSafeContentUrl(imageRef)) {
			fail(`tutorial ${tutorialId} has unsafe image path ${imageRef}`);
			continue;
		}
		const imagePath = normalize(join(dirname(contentPath), imageRef));
		if (!isInside(dirname(contentPath), imagePath)) {
			fail(`tutorial ${tutorialId} image escapes content directory: ${imageRef}`);
			continue;
		}
		if (!existsSync(imagePath)) {
			fail(`tutorial ${tutorialId} image does not exist: ${imageRef}`);
			continue;
		}
		if (statSync(imagePath).size > maxImageBytes) {
			fail(`tutorial ${tutorialId} image exceeds 3 MB: ${imageRef}`);
		}
	}
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
if (catalog.schemaVersion !== 1) fail('schemaVersion must be 1');
requireString(catalog.generatedAt, 'generatedAt');
if (!Array.isArray(catalog.categories)) fail('categories must be an array');
if (!Array.isArray(catalog.content)) fail('content must be an array');

const categoryIds = new Set();
for (const [index, category] of (catalog.categories || []).entries()) {
	const id = requireString(category?.id, `categories[${index}].id`);
	requireString(category?.title, `categories[${index}].title`);
	if (categoryIds.has(id)) fail(`duplicate category id ${id}`);
	categoryIds.add(id);
}

const tutorialIds = new Set();
for (const [index, tutorial] of (catalog.content || []).entries()) {
	const id = requireString(tutorial?.id, `content[${index}].id`);
	const categoryId = requireString(tutorial?.categoryId, `content[${index}].categoryId`);
	const contentUrl = requireString(tutorial?.contentUrl, `content[${index}].contentUrl`);
	const minExtensionVersion = requireString(tutorial?.minExtensionVersion, `content[${index}].minExtensionVersion`);
	requireString(tutorial?.updateToken, `content[${index}].updateToken`);
	if (tutorialIds.has(id)) fail(`duplicate tutorial id ${id}`);
	tutorialIds.add(id);
	if (!categoryIds.has(categoryId)) fail(`tutorial ${id} references unknown category ${categoryId}`);
	if (!isSafeContentUrl(contentUrl)) fail(`tutorial ${id} has unsafe contentUrl ${contentUrl}`);
	if (minExtensionVersion && !isSemverLikeVersion(minExtensionVersion)) fail(`tutorial ${id} has invalid minExtensionVersion ${minExtensionVersion}`);
	if (/^https?:\/\//i.test(contentUrl)) {
		if (!isAllowedRemoteUrl(contentUrl)) fail(`tutorial ${id} remote contentUrl must be HTTPS GitHub-hosted: ${contentUrl}`);
	} else {
		const localPath = normalize(join(tutorialsRoot, contentUrl));
		if (!isInside(tutorialsRoot, localPath)) fail(`tutorial ${id} content escapes media/tutorials`);
		if (!existsSync(localPath)) fail(`tutorial ${id} content file does not exist: ${contentUrl}`);
		else {
			const markdown = readFileSync(localPath, 'utf8');
			if (!/^#\s+\S/.test(markdown)) fail(`tutorial ${id} content file must start with a top-level heading`);
			validateMarkdownImageReferences(markdown, localPath, id);
		}
	}
}

if (errors.length) {
	console.error('Tutorial catalog validation failed:');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(`Tutorial catalog OK: ${catalog.content.length} content items in ${catalog.categories.length} categories.`);
