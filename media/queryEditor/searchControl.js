// Reusable search control + matching utilities.
// Supports wildcard ("*") and regex modes.

(function () {
	const SEARCH_MODE_WILDCARD = 'wildcard';
	const SEARCH_MODE_REGEX = 'regex';

	function __kustoNormalizeSearchMode(mode) {
		const m = String(mode || '').toLowerCase();
		return (m === SEARCH_MODE_REGEX) ? SEARCH_MODE_REGEX : SEARCH_MODE_WILDCARD;
	}

	function __kustoUpdateSearchModeToggle(btn, mode) {
		if (!btn) return;
		const isRegex = (mode === SEARCH_MODE_REGEX);
		btn.innerHTML = isRegex ? __kustoGetRegexIconSvg() : __kustoGetWildcardIconSvg();
		btn.title = isRegex
			? 'Regex mode (click to switch to Wildcard)\n\nExamples:\n  ^hello - starts with "hello"\n  world$ - ends with "world"\n  \\d+ - one or more digits\n  foo|bar - "foo" or "bar"'
			: 'Wildcard mode (click to switch to Regex)\n\nExamples:\n  hello - contains "hello"\n  hello*world - "hello" followed by "world"\n  *error* - contains "error"\n  log_* - starts with "log_"';
		btn.setAttribute('aria-label', btn.title);
	}

	function __kustoGetSearchIconSvg() {
		return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>';
	}

	function __kustoGetWildcardIconSvg() {
		return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="3" y="12" font-size="11" font-weight="bold" font-family="monospace">*</text></svg>';
	}

	function __kustoGetRegexIconSvg() {
		return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="1" y="12" font-size="10" font-weight="bold" font-family="monospace">.*</text></svg>';
	}

	function __kustoGetChevronUpSvg() {
		return '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 5.5L3.5 10l.707.707L8 6.914l3.793 3.793.707-.707L8 5.5z"/></svg>';
	}

	function __kustoGetChevronDownSvg() {
		return '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 10.5l4.5-4.5-.707-.707L8 9.086 4.207 5.293 3.5 6 8 10.5z"/></svg>';
	}

	function __kustoUpdateSearchStatus(statusEl, matchCount, currentMatchIndex, hasError, errorMsg) {
		if (!statusEl) return;
		if (hasError) {
			statusEl.textContent = '';
			statusEl.title = errorMsg || 'Invalid search';
			statusEl.classList.add('kusto-search-status-error');
			return;
		}
		statusEl.classList.remove('kusto-search-status-error');
		const count = (typeof matchCount === 'number' && isFinite(matchCount)) ? matchCount : 0;
		if (count === 0) {
			statusEl.textContent = '';
			statusEl.title = '';
			return;
		}
		const cur = (typeof currentMatchIndex === 'number' && isFinite(currentMatchIndex)) ? currentMatchIndex : 0;
		const shown = Math.min(count, Math.max(1, cur + 1));
		statusEl.textContent = '(' + shown + '/' + count + ')';
		statusEl.title = 'Match ' + shown + ' of ' + count;
	}

	function __kustoSetSearchNavEnabled(prevBtn, nextBtn, enabled, matchCount) {
		const count = (typeof matchCount === 'number' && matchCount > 1) ? matchCount : 0;
		const canNav = enabled && count > 1;
		if (prevBtn) prevBtn.disabled = !canNav;
		if (nextBtn) nextBtn.disabled = !canNav;
	}

	function __kustoCreateSearchControl(hostEl, options) {
		if (!hostEl) return null;
		const opts = options && typeof options === 'object' ? options : {};

		const inputId = String(opts.inputId || '').trim();
		const modeId = String(opts.modeId || '').trim();
		if (!inputId || !modeId) return null;

		try { hostEl.textContent = ''; } catch { /* ignore */ }

		const wrapper = document.createElement('div');
		wrapper.className = 'kusto-search-control';

		// Search icon (magnifying glass watermark).
		const searchIcon = document.createElement('span');
		searchIcon.className = 'kusto-search-icon';
		searchIcon.innerHTML = __kustoGetSearchIconSvg();
		searchIcon.setAttribute('aria-hidden', 'true');

		const input = document.createElement('input');
		input.type = 'text';
		input.id = inputId;
		input.className = 'kusto-search-input ' + String(opts.inputClass || '').trim();
		input.placeholder = 'Search...';
		input.autocomplete = 'off';
		try { input.spellcheck = false; } catch { /* ignore */ }
		if (opts.ariaLabel) {
			try { input.setAttribute('aria-label', String(opts.ariaLabel)); } catch { /* ignore */ }
		}
		if (opts.title) {
			try { input.title = String(opts.title); } catch { /* ignore */ }
		}

		// Match status indicator (e.g. "3 / 12").
		const statusEl = document.createElement('span');
		statusEl.className = 'kusto-search-status';
		statusEl.id = inputId + '_status';
		// Keep the status text the same size as the search input text.
		try {
			const fs = window.getComputedStyle ? window.getComputedStyle(input).fontSize : '';
			if (fs) statusEl.style.fontSize = fs;
		} catch { /* ignore */ }

		const toggleBtn = document.createElement('button');
		toggleBtn.type = 'button';
		toggleBtn.id = modeId;
		toggleBtn.className = 'kusto-search-mode-toggle';
		const initialMode = __kustoNormalizeSearchMode(opts.initialMode);
		toggleBtn.dataset.mode = initialMode;
		__kustoUpdateSearchModeToggle(toggleBtn, initialMode);

		// Previous match button.
		const prevBtn = document.createElement('button');
		prevBtn.type = 'button';
		prevBtn.className = 'kusto-search-nav-btn kusto-search-prev';
		prevBtn.id = inputId + '_prev';
		prevBtn.innerHTML = __kustoGetChevronUpSvg();
		prevBtn.title = 'Previous match (Shift+Enter)';
		prevBtn.setAttribute('aria-label', 'Previous match');
		prevBtn.disabled = true;

		// Next match button.
		const nextBtn = document.createElement('button');
		nextBtn.type = 'button';
		nextBtn.className = 'kusto-search-nav-btn kusto-search-next';
		nextBtn.id = inputId + '_next';
		nextBtn.innerHTML = __kustoGetChevronDownSvg();
		nextBtn.title = 'Next match (Enter)';
		nextBtn.setAttribute('aria-label', 'Next match');
		nextBtn.disabled = true;

		const onInput = (typeof opts.onInput === 'function') ? opts.onInput : null;
		const onKeyDown = (typeof opts.onKeyDown === 'function') ? opts.onKeyDown : null;
		const onPrev = (typeof opts.onPrev === 'function') ? opts.onPrev : null;
		const onNext = (typeof opts.onNext === 'function') ? opts.onNext : null;

		if (onInput) {
			try { input.addEventListener('input', onInput); } catch { /* ignore */ }
		}
		if (onKeyDown) {
			try { input.addEventListener('keydown', onKeyDown); } catch { /* ignore */ }
		}

		toggleBtn.addEventListener('click', function () {
			const current = String(toggleBtn.dataset.mode || SEARCH_MODE_WILDCARD);
			const next = (current === SEARCH_MODE_REGEX) ? SEARCH_MODE_WILDCARD : SEARCH_MODE_REGEX;
			toggleBtn.dataset.mode = next;
			__kustoUpdateSearchModeToggle(toggleBtn, next);
			if (onInput) {
				try { onInput(); } catch { /* ignore */ }
			}
		});

		if (onPrev) {
			prevBtn.addEventListener('click', function () {
				try { onPrev(); } catch { /* ignore */ }
			});
		}
		if (onNext) {
			nextBtn.addEventListener('click', function () {
				try { onNext(); } catch { /* ignore */ }
			});
		}

		// Visual divider before navigation buttons.
		const navDivider = document.createElement('span');
		navDivider.className = 'kusto-search-nav-divider';
		navDivider.setAttribute('aria-hidden', 'true');

		wrapper.appendChild(searchIcon);
		wrapper.appendChild(input);
		wrapper.appendChild(statusEl);
		wrapper.appendChild(toggleBtn);
		wrapper.appendChild(navDivider);
		wrapper.appendChild(prevBtn);
		wrapper.appendChild(nextBtn);
		hostEl.appendChild(wrapper);

		return { wrapper, input, toggleBtn, statusEl, prevBtn, nextBtn };
	}

	function __kustoGetSearchControlState(inputId, modeId) {
		try {
			const input = document.getElementById(inputId);
			const modeEl = document.getElementById(modeId);
			const modeVal = modeEl ? (modeEl.dataset.mode || modeEl.value || SEARCH_MODE_WILDCARD) : SEARCH_MODE_WILDCARD;
			return {
				query: String((input && input.value) ? input.value : '').trim(),
				mode: __kustoNormalizeSearchMode(modeVal)
			};
		} catch {
			return { query: '', mode: SEARCH_MODE_WILDCARD };
		}
	}

	function __kustoTryBuildSearchRegex(query, mode) {
		const q = String(query || '').trim();
		const m = __kustoNormalizeSearchMode(mode);
		if (!q) return { regex: null, error: null, mode: m };

		let pattern = '';
		if (m === SEARCH_MODE_REGEX) {
			pattern = q;
		} else {
			// Wildcard mode: only '*' is special; everything else is literal. Use non-greedy match.
			pattern = q.split('*').map(escapeRegex).join('.*?');
		}

		try {
			const regex = new RegExp(pattern, 'gi');
			// Guard: patterns that can match empty string are unusable for highlighting.
			try {
				const nonGlobal = new RegExp(regex.source, regex.flags.replace(/g/g, ''));
				if (nonGlobal.test('')) {
					return { regex: null, error: 'Search pattern matches empty text. Please refine it.', mode: m };
				}
			} catch { /* ignore */ }
			return { regex, error: null, mode: m };
		} catch {
			return { regex: null, error: 'Invalid regex. Please fix the pattern.', mode: m };
		}
	}

	function __kustoRegexTest(regex, text) {
		if (!regex) return false;
		try {
			regex.lastIndex = 0;
			return regex.test(String(text || ''));
		} catch {
			return false;
		}
	}

	function __kustoCountRegexMatches(regex, text, maxMatches) {
		if (!regex) return 0;
		const s = String(text || '');
		const limit = (typeof maxMatches === 'number' && isFinite(maxMatches) && maxMatches > 0) ? Math.floor(maxMatches) : 5000;
		let count = 0;
		try {
			regex.lastIndex = 0;
			let m;
			while ((m = regex.exec(s)) !== null) {
				count++;
				if (count >= limit) break;
				if (!m[0]) {
					// Should be prevented by empty-match guard, but keep safe.
					regex.lastIndex = regex.lastIndex + 1;
				}
			}
		} catch { /* ignore */ }
		return count;
	}

	function __kustoHighlightPlainTextToHtml(text, regex, options) {
		const s = String(text || '');
		const opts = options && typeof options === 'object' ? options : {};
		const highlightClass = String(opts.highlightClass || 'kusto-search-highlight');
		const includeMatchIndex = opts.includeMatchIndex !== false;
		const maxMatches = (typeof opts.maxMatches === 'number' && isFinite(opts.maxMatches) && opts.maxMatches > 0) ? Math.floor(opts.maxMatches) : 5000;

		if (!regex) {
			return { html: escapeHtml(s), count: 0 };
		}

		let html = '';
		let lastIndex = 0;
		let count = 0;
		try {
			regex.lastIndex = 0;
			let m;
			while ((m = regex.exec(s)) !== null) {
				const start = m.index;
				const matchText = m[0];
				if (!matchText) break;
				if (start > lastIndex) {
					html += escapeHtml(s.slice(lastIndex, start));
				}
				const attrs = includeMatchIndex ? (' data-kusto-match-index="' + String(count) + '"') : '';
				html += '<span class="' + highlightClass + '"' + attrs + '>' + escapeHtml(matchText) + '</span>';
				count++;
				lastIndex = start + matchText.length;
				if (count >= maxMatches) break;
			}
		} catch {
			return { html: escapeHtml(s), count: 0 };
		}

		if (lastIndex < s.length) {
			html += escapeHtml(s.slice(lastIndex));
		}
		return { html, count };
	}

	function __kustoHighlightElementTextNodes(rootEl, regex, highlightClass) {
		if (!rootEl) return 0;
		if (!regex) return 0;
		const cls = String(highlightClass || 'kusto-search-highlight');

		let total = 0;
		const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
		const nodes = [];
		try {
			let node;
			while ((node = walker.nextNode())) nodes.push(node);
		} catch { /* ignore */ }

		for (const n of nodes) {
			try {
				const text = String(n.textContent || '');
				if (!text) continue;
				regex.lastIndex = 0;
				if (!regex.test(text)) continue;

				// Replace this text node with a fragment with highlights.
				regex.lastIndex = 0;
				const frag = document.createDocumentFragment();
				let lastIndex = 0;
				let m;
				while ((m = regex.exec(text)) !== null) {
					const start = m.index;
					const matchText = m[0];
					if (!matchText) break;
					if (start > lastIndex) {
						frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
					}
					const span = document.createElement('span');
					span.className = cls;
					span.textContent = matchText;
					frag.appendChild(span);
					total++;
					lastIndex = start + matchText.length;
				}
				if (lastIndex < text.length) {
					frag.appendChild(document.createTextNode(text.slice(lastIndex)));
				}
				if (n.parentNode) {
					n.parentNode.insertBefore(frag, n);
					n.parentNode.removeChild(n);
				}
			} catch { /* ignore */ }
		}
		return total;
	}

	// Expose globals (webview codebase uses global functions).
	window.__kustoCreateSearchControl = __kustoCreateSearchControl;
	window.__kustoGetSearchControlState = __kustoGetSearchControlState;
	window.__kustoTryBuildSearchRegex = __kustoTryBuildSearchRegex;
	window.__kustoRegexTest = __kustoRegexTest;
	window.__kustoCountRegexMatches = __kustoCountRegexMatches;
	window.__kustoHighlightPlainTextToHtml = __kustoHighlightPlainTextToHtml;
	window.__kustoHighlightElementTextNodes = __kustoHighlightElementTextNodes;
	window.__kustoUpdateSearchModeToggle = __kustoUpdateSearchModeToggle;
	window.__kustoUpdateSearchStatus = __kustoUpdateSearchStatus;
	window.__kustoSetSearchNavEnabled = __kustoSetSearchNavEnabled;
})();
