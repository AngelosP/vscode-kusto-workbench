function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

function escapeRegex(str) {
	return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}
