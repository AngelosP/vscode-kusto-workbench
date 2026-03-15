// Results table rendering sub-module — extracted from resultsTable.ts
// Virtual scrolling, table body rendering, result display, error UX.
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window;

function __kustoRerenderResultsTable(boxId: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) return;
	const table = document.getElementById(boxId + '_table');
	if (!table) return;

	try { __kustoRerenderResultsTableBody(boxId, undefined); } catch { /* ignore */ }
	return;
}

function __kustoGetVirtualizationState(state: any) {
	if (!state || typeof state !== 'object') return null;
	if (!state.__kustoVirtual) {
		state.__kustoVirtual = {
			enabled: false,
			rowHeight: 22,
			overScan: 5,
			lastStart: -1,
			lastEnd: -1,
			lastDisplayVersion: -1,
			lastVisualVersion: -1,
			rafPending: false,
			resizeObserver: null,
			scrollEl: null,
			scrollHandler: null,
			observedEls: [],
			theadHeight: 0
		};
	}
	return state.__kustoVirtual;
}

function __kustoResolveVirtualScrollElement(containerEl: any) {
	if (!containerEl) return null;
	// Prefer the table container itself when it is scrollable.
	try {
		const sh = Math.max(0, containerEl.scrollHeight || 0);
		const ch = Math.max(0, containerEl.clientHeight || 0);
		if (sh > (ch + 1)) return containerEl;
	} catch { /* ignore */ }

	// Otherwise, find the nearest scrollable ancestor.
	let el = null;
	try { el = containerEl.parentElement; } catch { el = null; }
	for (let i = 0; el && i < 12; i++) {
		try {
			const sh = Math.max(0, el.scrollHeight || 0);
			const ch = Math.max(0, el.clientHeight || 0);
			if (sh > (ch + 1)) {
				let oy = '';
				try { oy = String(window.getComputedStyle(el).overflowY || '').toLowerCase(); } catch { oy = ''; }
				if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
					return el;
				}
			}
		} catch { /* ignore */ }
		try { el = el.parentElement; } catch { el = null; }
	}

	// Fallback to document scroller.
	try {
		const se = document.scrollingElement || document.documentElement;
		if (se) {
			const sh = Math.max(0, se.scrollHeight || 0);
			const ch = Math.max(0, se.clientHeight || 0);
			if (sh > (ch + 1)) return se;
		}
	} catch { /* ignore */ }

	return containerEl;
}

function __kustoResolveScrollSourceForEvent(ev: any, containerEl: any) {
	try {
		if (!containerEl) return null;
		const t = ev && ev.target ? ev.target : null;
		// Scroll events do not bubble; when we capture on document, the target can be the
		// actual scroller (element) or the document.
		if (t && t.nodeType === 9) {
			try { return document.scrollingElement || document.documentElement || null; } catch { return null; }
		}
		if (t && t.nodeType === 1) {
			let el = t;
			for (let i = 0; el && i < 16; i++) {
				try {
					// Only consider ancestors related to this table container.
					if (!el.contains(containerEl) && !containerEl.contains(el)) {
						// Keep climbing; a higher ancestor might contain both.
						el = el.parentElement;
						continue;
					}
					const sh = Math.max(0, el.scrollHeight || 0);
					const ch = Math.max(0, el.clientHeight || 0);
					if (sh > (ch + 1)) {
						let oy = '';
						try { oy = String(window.getComputedStyle(el).overflowY || '').toLowerCase(); } catch { oy = ''; }
						if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
							return el;
						}
					}
				} catch { /* ignore */ }
				try { el = el.parentElement; } catch { el = null; }
			}
		}
	} catch { /* ignore */ }
	return __kustoResolveVirtualScrollElement(containerEl);
}

function __kustoGetVirtualScrollMetrics(scrollEl: any, containerEl: any) {
	let scrollTop = 0;
	let clientH = 0;
	try {
		if (scrollEl && containerEl && scrollEl !== containerEl) {
			// When the scroll container is an ancestor (or the document), compute effective
			// scrollTop as the amount the table container's top has scrolled past the top
			// of the scroll viewport. Compute clientH as the visible intersection height.
			const sRect = scrollEl.getBoundingClientRect ? scrollEl.getBoundingClientRect() : null;
			const cRect = containerEl.getBoundingClientRect ? containerEl.getBoundingClientRect() : null;
			if (sRect && cRect) {
				scrollTop = Math.max(0, Math.floor((sRect.top - cRect.top) || 0));
				const visTop = Math.max(cRect.top, sRect.top);
				const visBottom = Math.min(cRect.bottom, sRect.bottom);
				clientH = Math.max(0, Math.floor(visBottom - visTop));
			}
			if (!clientH) {
				try { clientH = Math.max(0, Math.floor(containerEl.clientHeight || 0)); } catch { /* ignore */ }
			}
		} else if (containerEl) {
			try { scrollTop = Math.max(0, Math.floor(containerEl.scrollTop || 0)); } catch { /* ignore */ }
			try { clientH = Math.max(0, Math.floor(containerEl.clientHeight || 0)); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	return { scrollTop, clientH };
}

function __kustoBumpVisualVersion(state: any) {
	try {
		if (!state || typeof state !== 'object') return;
		const cur = (typeof state.__kustoVisualVersion === 'number' && isFinite(state.__kustoVisualVersion))
			? state.__kustoVisualVersion
			: 0;
		state.__kustoVisualVersion = cur + 1;
	} catch { /* ignore */ }
}

function __kustoComputeVirtualRange(state: any, containerEl: any, displayRowIndices: any, options: any) {
	const v = __kustoGetVirtualizationState(state);
	const total = Array.isArray(displayRowIndices) ? displayRowIndices.length : 0;
	if (!v || !containerEl || total <= 0) {
		return { start: 0, end: total };
	}
	const rowH = Math.max(12, Math.floor(v.rowHeight || 22));
	let scrollTop = 0;
	let clientH = 0;
	try {
		// Always prefer the container's own scroll position when it is scrollable.
		// Using a cached scrollSourceEl (which can be e.g. the document scroller, set by an
		// unrelated document-level scroll event) would give wrong metrics and cause the
		// virtual window to get "stuck" at its initial position.
		let effectiveScrollEl = null;
		try {
			const sh = Math.max(0, containerEl.scrollHeight || 0);
			const ch = Math.max(0, containerEl.clientHeight || 0);
			if (sh > (ch + 1)) {
				effectiveScrollEl = containerEl;
			}
		} catch { /* ignore */ }
		if (!effectiveScrollEl) {
			effectiveScrollEl = (options && options.scrollEl) ? options.scrollEl : __kustoResolveVirtualScrollElement(containerEl);
		}
		const m = __kustoGetVirtualScrollMetrics(effectiveScrollEl, containerEl);
		scrollTop = Math.max(0, Math.floor(m.scrollTop || 0));
		clientH = Math.max(0, Math.floor(m.clientH || 0));
	} catch { /* ignore */ }

	// Subtract the thead height so scrollTop maps to the data row area, not the header.
	const theadH = Math.max(0, Math.floor(v.theadHeight || 0));
	const dataScrollTop = Math.max(0, scrollTop - theadH);

	const visibleCount = Math.max(1, Math.ceil(clientH / rowH));
	const overscan = Math.max(4, Math.floor(v.overScan || 5));
	// Compute the first visible row index from the scroll position.
	const topRow = Math.floor(dataScrollTop / rowH);
	// Start `overscan` rows above the viewport, end `overscan` rows below it.
	// Unlike `end = start + visibleCount + 2*overscan`, this formula ensures `end`
	// tracks the actual viewport bottom even when `start` is clamped to 0 near the
	// top of the list. The old formula created an over-extended window at the top
	// (e.g. 47 rows for a 7-row viewport), causing the window to stay stuck at
	// [0, 47) until the user scrolled past 600+ pixels into the empty spacer.
	let start = Math.max(0, topRow - overscan);
	let end = Math.min(total, topRow + visibleCount + overscan);

	// If a specific display row should be visible (selected cell, current search match),
	// expand/shift the window so it is included.
	const forceDisplayRow = options && isFinite(options.forceDisplayRow) ? Math.floor(options.forceDisplayRow) : null;
	if (forceDisplayRow !== null && forceDisplayRow >= 0 && forceDisplayRow < total) {
		if (forceDisplayRow < start) {
			start = Math.max(0, forceDisplayRow - overscan);
			end = Math.min(total, Math.max(end, forceDisplayRow + visibleCount + overscan));
		} else if (forceDisplayRow >= end) {
			end = Math.min(total, forceDisplayRow + overscan + 1);
			start = Math.max(0, Math.min(start, forceDisplayRow - visibleCount - overscan));
		}
	}

	return { start, end };
}

function __kustoBuildResultsTableRowHtml(rowIdx: any, displayIdx: any, state: any, boxId: any, matchSet: any, currentKey: any) {
	const rows = Array.isArray(state.rows) ? state.rows : [];
	const row = rows[rowIdx] || [];
	const range = (state && state.cellSelectionRange && typeof state.cellSelectionRange === 'object') ? state.cellSelectionRange : null;
	const trClass = state.selectedRows && state.selectedRows.has(rowIdx) ? ' class="selected-row"' : '';
	const boxIdArg = __kustoEscapeForHtmlAttribute(JSON.stringify(String(boxId)));
	return (
		'<tr data-row="' + rowIdx + '"' + trClass + '>' +
		'<td class="row-selector" onclick="toggleRowSelection(' + rowIdx + ', ' + boxIdArg + '); event.stopPropagation();">' + (displayIdx + 1) + '</td>' +
		row.map((cell: any, colIdx: any) => {
			const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
			const displayValue = hasHover ? cell.display : cell;
			const fullValue = hasHover ? cell.full : cell;
			const isObject = cell && cell.isObject;
			const title = hasHover && displayValue !== fullValue && !isObject ? ' title="' + __kustoEscapeForHtmlAttribute(fullValue) + '"' : '';
			const viewBtn = isObject ? '<button class="object-view-btn" onclick="event.stopPropagation(); openObjectViewer(' + rowIdx + ', ' + colIdx + ', ' + boxIdArg + ')">View</button>' : '';
			const cellHtml = isObject ? '' : _win.__kustoFormatCellDisplayValueForTable(displayValue);
			let tdClass = '';
			if (range && isFinite(range.displayRowMin) && isFinite(range.displayRowMax) && isFinite(range.colMin) && isFinite(range.colMax)) {
				if (displayIdx >= range.displayRowMin && displayIdx <= range.displayRowMax && colIdx >= range.colMin && colIdx <= range.colMax) {
					tdClass += (tdClass ? ' ' : '') + 'selected-cell';
				}
			}
			if (state.selectedCell && state.selectedCell.row === rowIdx && state.selectedCell.col === colIdx) {
				tdClass += (tdClass ? ' ' : '') + 'selected-cell-focus';
			}
			if (matchSet && matchSet.has(String(rowIdx) + ',' + String(colIdx))) {
				tdClass += (tdClass ? ' ' : '') + 'search-match';
				if (currentKey && currentKey === (String(rowIdx) + ',' + String(colIdx))) {
					tdClass += ' search-match-current';
				}
			}
			const classAttr = tdClass ? (' class="' + tdClass + '"') : '';
			const dblClickHandler = ' ondblclick="handleCellDoubleClick(event, ' + rowIdx + ', ' + colIdx + ', ' + boxIdArg + ')"';
			return '<td data-row="' + rowIdx + '" data-col="' + colIdx + '"' + classAttr + title + ' onclick="selectCell(' + rowIdx + ', ' + colIdx + ', ' + boxIdArg + ')"' + dblClickHandler + '>' +
				cellHtml + viewBtn +
			'</td>';
		}).join('') +
		'</tr>'
	);
}

function __kustoRerenderResultsTableBody(boxId: any, options: any) {
	const state = __kustoGetResultsState(boxId);
	if (!state) { return; }
	const table = document.getElementById(boxId + '_table');
	if (!table) { return; }
	const container = document.getElementById(boxId + '_table_container');
	const boxIdArg = __kustoEscapeForHtmlAttribute(JSON.stringify(String(boxId)));

	// Update sort indicators.
	try {
		const spec = Array.isArray(state.sortSpec) ? state.sortSpec : [];
		for (let i = 0; i < (state.columns || []).length; i++) {
			const indicator = document.getElementById(boxId + '_sort_ind_' + i);
			if (!indicator) continue;
			const ruleIdx = spec.findIndex((r: any) => r && r.colIndex === i);
			if (ruleIdx < 0) {
				indicator.innerHTML = '';
				continue;
			}
			const dir = _win.__kustoNormalizeSortDirection(spec[ruleIdx].dir);
			const arrow = (dir === 'desc') ? '▼' : '▲';
			const ord = spec.length > 1 ? ('<span class="kusto-sort-priority">' + String(ruleIdx + 1) + '</span>') : '';
			indicator.innerHTML = arrow + ord;
		}
	} catch { /* ignore */ }

	// Update filtered column links.
	try {
		const filters = _win.__kustoEnsureColumnFiltersMap(state);
		for (let i = 0; i < (state.columns || []).length; i++) {
			const el = document.getElementById(boxId + '_filter_link_' + i);
			if (!el) continue;
			const active = _win.__kustoIsFilterSpecActive(filters[String(i)]);
			el.innerHTML = active
				? ('<a href="#" class="kusto-filtered-link" onclick="openColumnFilter(event, ' + String(i) + ', ' + boxIdArg + '); return false;">(filtered)</a>')
				: '';
		}
	} catch { /* ignore */ }

	// Build fast lookup for search matches.
	let matchSet = null;
	let currentKey = null;
	try {
		const matches = Array.isArray(state.searchMatches) ? state.searchMatches : [];
		if (matches.length > 0) {
			matchSet = new Set();
			for (const m of matches) {
				if (!m) continue;
				matchSet.add(String(m.row) + ',' + String(m.col));
			}
			const cur = (state.currentSearchIndex >= 0 && state.currentSearchIndex < matches.length) ? matches[state.currentSearchIndex] : null;
			if (cur) currentKey = String(cur.row) + ',' + String(cur.col);
		}
	} catch { /* ignore */ }

	const rows = Array.isArray(state.rows) ? state.rows : [];
	const cols = Array.isArray(state.columns) ? state.columns : [];
	const displayRowIndices = Array.isArray(state.displayRowIndices) ? state.displayRowIndices : rows.map((_: any, i: any) => i);

	try {
		const countEl = document.getElementById(boxId + '_results_count');
		if (countEl) {
			const total = rows ? rows.length : 0;
			const shown = displayRowIndices ? displayRowIndices.length : 0;
			// When results were truncated during persistence (file too large), show the
			// original row count alongside the restored count so the user knows why the
			// number is smaller than expected.
			const meta = (state && state.metadata && typeof state.metadata === 'object') ? state.metadata : {};
			const wasTruncated = !!meta.persistedTruncated;
			const originalTotal = (wasTruncated && typeof meta.persistedTotalRows === 'number' && isFinite(meta.persistedTotalRows))
				? meta.persistedTotalRows
				: 0;
			let countText = '';
			if (shown !== total) {
				countText = String(shown) + ' / ' + String(total);
			} else {
				countText = String(total);
			}
			if (wasTruncated && originalTotal > total) {
				countText += ' (of ' + String(originalTotal) + ' \u2014 truncated to fit file)';
			}
			countEl.textContent = countText;
		}
	} catch { /* ignore */ }

	// Enable virtualization only for larger results.
	const v = __kustoGetVirtualizationState(state);
	const virtualThreshold = 500;
	try { if (v) v.enabled = (displayRowIndices.length > virtualThreshold); } catch { /* ignore */ }

	// Determine which display row should be forced into view (selected cell or current search match).
	// IMPORTANT: Only apply forceDisplayRow for programmatic navigation (initial render, search,
	// keyboard cell navigation). During user-initiated scrolling, forceDisplayRow would anchor the
	// virtual window to the selected cell and prevent it from advancing as the user scrolls.
	const _reason = (options && options.reason) ? options.reason : '';
	const _isScrollDriven = (_reason === 'scroll' || _reason === 'resize' || _reason === 'spacer-visible' || _reason === 'spacer-visible-deferred');
	let forceDisplayRow = null;
	try {
		if (v && v.enabled && !_isScrollDriven) {
			const inv = Array.isArray(state.rowIndexToDisplayIndex) ? state.rowIndexToDisplayIndex : null;
			if (state.selectedCell && inv && isFinite(inv[state.selectedCell.row])) {
				forceDisplayRow = inv[state.selectedCell.row];
			} else if (state.searchMatches && state.currentSearchIndex >= 0 && state.currentSearchIndex < state.searchMatches.length) {
				const m = state.searchMatches[state.currentSearchIndex];
				if (m && inv && isFinite(inv[m.row])) {
					forceDisplayRow = inv[m.row];
				}
			}
		}
	} catch { /* ignore */ }

	const visibleRange = (v && v.enabled)
		? __kustoComputeVirtualRange(state, container, displayRowIndices, { forceDisplayRow, scrollEl: (v && v.scrollSourceEl) ? v.scrollSourceEl : null })
		: { start: 0, end: displayRowIndices.length };

	const colSpan = (cols ? cols.length : 0) + 1;
	const rowH = v ? Math.max(12, Math.floor(v.rowHeight || 22)) : 22;
	const topPad = (v && v.enabled) ? (visibleRange.start * rowH) : 0;
	const bottomPad = (v && v.enabled) ? ((displayRowIndices.length - visibleRange.end) * rowH) : 0;
	const displayVersion = (typeof state.__kustoDisplayRowVersion === 'number' && isFinite(state.__kustoDisplayRowVersion))
		? state.__kustoDisplayRowVersion
		: 0;
	const visualVersion = (typeof state.__kustoVisualVersion === 'number' && isFinite(state.__kustoVisualVersion))
		? state.__kustoVisualVersion
		: 0;

	let tbodyHtml = '';
	if (v && v.enabled && topPad > 0) {
		// Spacer rows must reliably contribute to table height so the scroll container
		// gets a real scrollbar. Some table layouts ignore an empty cell's height, so
		// include an inner block element and set height on both TR + TD.
		tbodyHtml += '<tr class="kusto-virtual-spacer" aria-hidden="true" style="height:' + topPad + 'px;">' +
			'<td colspan="' + colSpan + '" style="height:' + topPad + 'px; min-height:' + topPad + 'px; padding:0; border:0;">' +
			'<div style="height:' + topPad + 'px; overflow:hidden; font-size:0; line-height:0;"></div>' +
			'</td></tr>';
	}
	for (let displayIdx = visibleRange.start; displayIdx < visibleRange.end; displayIdx++) {
		const rowIdx = displayRowIndices[displayIdx];
		tbodyHtml += __kustoBuildResultsTableRowHtml(rowIdx, displayIdx, state, boxId, matchSet, currentKey);
	}
	if (v && v.enabled && bottomPad > 0) {
		tbodyHtml += '<tr class="kusto-virtual-spacer" aria-hidden="true" style="height:' + bottomPad + 'px;">' +
			'<td colspan="' + colSpan + '" style="height:' + bottomPad + 'px; min-height:' + bottomPad + 'px; padding:0; border:0;">' +
			'<div style="height:' + bottomPad + 'px; overflow:hidden; font-size:0; line-height:0;"></div>' +
			'</td></tr>';
	}

	try {
		const tbody = table.querySelector('tbody') as any;
		if (tbody) {
			if (!v || !v.enabled || v.lastStart !== visibleRange.start || v.lastEnd !== visibleRange.end || v.lastDisplayVersion !== displayVersion || v.lastVisualVersion !== visualVersion) {
				// Save scrollTop before innerHTML replacement. Replacing tbody content can
				// cause the browser to momentarily recalculate scroll metrics. If the content
				// height drops briefly (between removing old content and rendering new), the
				// browser clamps scrollTop to 0, which causes the virtual window to jump back
				// to the beginning. Restoring scrollTop after the update prevents this.
				let savedScrollTop = -1;
				try {
					if (container) savedScrollTop = container.scrollTop;
				} catch { /* ignore */ }
				tbody.innerHTML = tbodyHtml;
				// Restore scrollTop immediately after DOM update.
				try {
					if (container && savedScrollTop > 0 && Math.abs(container.scrollTop - savedScrollTop) > 1) {
						container.scrollTop = savedScrollTop;
					}
				} catch { /* ignore */ }
				if (v && v.enabled) {
					v.lastStart = visibleRange.start;
					v.lastEnd = visibleRange.end;
					v.lastDisplayVersion = displayVersion;
					v.lastVisualVersion = visualVersion;
				}
			}
		}
	} catch { /* ignore */ }

	// Measure row height and thead height once (after first render) to make virtualization accurate.
	try {
		if (v && v.enabled) {
			let needsRerender = false;
			// Measure actual data row height.
			// Re-measure if rowHeight was never set, is still the default (22),
			// or was set from a hidden-element measurement (12 = Math.max(12, 0)).
			// When the table is inside a display:none tree, getBoundingClientRect()
			// returns 0, so Math.max(12, 0) = 12 locks in a bogus value. The
			// condition below ensures we re-measure until a real (> 12) value is
			// obtained.
			if (!v.rowHeight || v.rowHeight <= 12 || v.rowHeight === 22) {
				const sample = table.querySelector('tbody tr[data-row]') as any;
				if (sample) {
					const h = Math.max(12, Math.round(sample.getBoundingClientRect().height || 0));
					if (h && isFinite(h) && h > 12 && h !== v.rowHeight) {
						v.rowHeight = h;
						needsRerender = true;
					}
				}
			}
			// Measure thead height so scrollTop-to-row-index mapping accounts for the header.
			if (!v.theadHeight) {
				const thead = table.querySelector('thead') as any;
				if (thead) {
					const th = Math.max(0, Math.round(thead.getBoundingClientRect().height || 0));
					if (th && isFinite(th)) {
						v.theadHeight = th;
						needsRerender = true;
					}
				}
			}
			if (needsRerender) {
				v.lastStart = -1;
				v.lastEnd = -1;
				// Re-render immediately with corrected measurements so spacer heights are
				// accurate from the start, preventing scroll jumps and empty regions.
				try { __kustoRerenderResultsTableBody(boxId, { reason: 'measurement' }); } catch { /* ignore */ }
				return; // the recursive call already handled the rest
			}
		}
	} catch { /* ignore */ }

	// Attach scroll/resize handlers for virtualization.
	// IMPORTANT: the actual scroller can differ by host (query results vs URL/CSV embeds).
	// Always attach to the table container, and also attach to the resolved scroll element
	// (which can be an ancestor) to avoid missing scroll events.
	try {
		if (container) {
			const st = __kustoGetResultsState(boxId);
			const vv = __kustoGetVirtualizationState(st);
			const scrollEl = __kustoResolveVirtualScrollElement(container);
			if (vv && scrollEl) {
				if (!vv.scrollHandler) {
					vv.scrollHandler = (ev: any) => {
						try {
							// Ignore scroll/wheel events that clearly don't relate to this table.
							try {
								const cont = document.getElementById(boxId + '_table_container');
								const t = ev && ev.target ? ev.target : null;
								if (cont && t && t !== cont) {
									if (t.nodeType === 1) {
										const te = t;
										// If the scroll target neither contains the container nor is contained by it,
										// it's unrelated (e.g. a different scrollable panel).
										if (!te.contains(cont) && !cont.contains(te)) {
											return;
										}
									}
								}
							} catch { /* ignore */ }

							// Record the actual scroll source so range calculation matches the host's scroll behavior.
							// IMPORTANT: only update scrollSourceEl when the source is directly related
							// to this table (the container or one of its ancestors that contains it).
							// Document-level captured events from unrelated scrollers (or the document
							// scroller itself) would corrupt the cached source, causing all subsequent
							// range calculations to use wrong metrics and making the virtual window
							// appear "stuck" — showing only the initial ~30 rows.
							try {
								const cont = document.getElementById(boxId + '_table_container');
								if (cont) {
									const src = __kustoResolveScrollSourceForEvent(ev, cont);
									// Only store the source if it is the container itself or a direct
									// scrollable ancestor that actually contains the table. The document
									// scrolling element should not override a more specific source.
									if (src && src !== document.scrollingElement && src !== document.documentElement) {
										vv.scrollSourceEl = src;
									} else if (src && !vv.scrollSourceEl) {
										// Only use document scroller as fallback if nothing better was found
										vv.scrollSourceEl = src;
									}
								}
							} catch { /* ignore */ }

							const st2 = __kustoGetResultsState(boxId);
							const vv2 = __kustoGetVirtualizationState(st2);
							if (!vv2) {
								return;
							}
							// The enabled flag may be stale if the state object was replaced
							// (e.g. displayResultForBox creates a new state). Re-derive it
							// from the actual row count so the handler doesn't silently die.
							if (!vv2.enabled) {
								const rows2 = Array.isArray(st2.rows) ? st2.rows : [];
								const disp2 = Array.isArray(st2.displayRowIndices) ? st2.displayRowIndices : rows2;
								if (disp2.length > 500) {
									vv2.enabled = true;
								} else {
									return; // genuinely small result, no virtualization needed
								}
							}
							if (vv2.rafPending) {
								return;
							}
							vv2.rafPending = true;
							// Use setTimeout(0) instead of requestAnimationFrame for coalescing.
							// RAF callbacks can be delayed or skipped in VS Code webviews under
							// certain conditions (e.g. background tabs, rapid scrolling during
							// layout recalculations). setTimeout(0) ensures the callback fires
							// on the next event-loop turn regardless of rendering state.
							setTimeout(() => {
								vv2.rafPending = false;
								try { __kustoRerenderResultsTableBody(boxId, { reason: 'scroll' }); } catch { /* ignore */ }
							}, 0);
						} catch { /* ignore */ }
					};
				}
				// Always listen on the table container (ideal scroller in most hosts).
				try { container.addEventListener('scroll', vv.scrollHandler, { passive: true }); } catch { /* ignore */ }
				try { container.addEventListener('wheel', vv.scrollHandler, { passive: true }); } catch { /* ignore */ }

				try {
					if (vv.scrollEl && vv.scrollEl !== scrollEl && vv.scrollHandler) {
						vv.scrollEl.removeEventListener('scroll', vv.scrollHandler);
					}
				} catch { /* ignore */ }
				try {
					if (scrollEl !== container) {
						scrollEl.addEventListener('scroll', vv.scrollHandler, { passive: true });
						try { scrollEl.addEventListener('wheel', vv.scrollHandler, { passive: true }); } catch { /* ignore */ }
					}
					vv.scrollEl = scrollEl;
				} catch { /* ignore */ }

				// Fallback: capture scroll/wheel at the document level.
				// Scroll events do not bubble, and in some hosts the scroller can be an ancestor or the
				// document itself. Capturing ensures we still get notified.
				try {
					if (!vv.documentCaptureAttached) {
						vv.documentCaptureAttached = true;
						document.addEventListener('scroll', vv.scrollHandler, { passive: true, capture: true });
						document.addEventListener('wheel', vv.scrollHandler, { passive: true, capture: true });
					}
				} catch { /* ignore */ }

				try {
					if (typeof ResizeObserver !== 'undefined') {
						if (!vv.resizeObserver) {
							vv.resizeObserver = new ResizeObserver(() => {
								try {
									const st3 = __kustoGetResultsState(boxId);
									const vv3 = __kustoGetVirtualizationState(st3);
									if (vv3) {
										vv3.lastStart = -1;
										vv3.lastEnd = -1;
									}
									__kustoRerenderResultsTableBody(boxId, { reason: 'resize' });
								} catch { /* ignore */ }
							});
						}
						if (vv.resizeObserver && Array.isArray(vv.observedEls)) {
							if (vv.observedEls.indexOf(container) < 0) {
								vv.resizeObserver.observe(container);
								vv.observedEls.push(container);
							}
							if (scrollEl && vv.observedEls.indexOf(scrollEl) < 0) {
								vv.resizeObserver.observe(scrollEl);
								vv.observedEls.push(scrollEl);
							}
						}
					}
				} catch { /* ignore */ }

				// IntersectionObserver fallback: when a virtual spacer row becomes visible, it
				// means the user has scrolled to the edge of the rendered window. Trigger a
				// re-render to materialize the next batch of rows. This is more robust than
				// relying solely on scroll events, which can be missed or coalesced away.
				try {
					if (typeof IntersectionObserver !== 'undefined' && vv.enabled) {
						if (!vv.spacerObserver) {
							vv.spacerObserver = new IntersectionObserver((entries) => {
								try {
									if (vv._suppressSpacerCallback) return;
									let anyVisible = false;
									for (const entry of entries) {
										if (entry.isIntersecting) { anyVisible = true; break; }
									}
									if (!anyVisible) return;
									// Debounce: at most one re-render per 50ms from the observer.
									if (vv._spacerRenderPending) return;
									vv._spacerRenderPending = true;
									setTimeout(() => {
										vv._spacerRenderPending = false;
										try { __kustoRerenderResultsTableBody(boxId, { reason: 'spacer-visible' }); } catch { /* ignore */ }
									}, 50);
								} catch { /* ignore */ }
							}, { root: container, threshold: 0 });
						}
						// Disconnect old observations and observe the current spacer rows.
						try { vv.spacerObserver.disconnect(); } catch { /* ignore */ }
						// Suppress callbacks briefly so that observing freshly-rendered spacers doesn't
						// immediately trigger a re-render loop.
						vv._suppressSpacerCallback = true;
						try {
							const spacers = table.querySelectorAll('tbody tr.kusto-virtual-spacer');
							for (const sp of spacers) {
								vv.spacerObserver.observe(sp);
							}
						} catch { /* ignore */ }
						setTimeout(() => {
							vv._suppressSpacerCallback = false;
							// After suppression ends, manually check if any observed spacer is
							// visible. The initial observe() callback fires immediately (and was
							// suppressed), but IntersectionObserver won't fire again until the
							// intersection *changes*. So if a spacer was already visible when
							// observed, we'd never get another callback. Re-check now.
							try {
								const obs = vv.spacerObserver;
								if (obs && typeof obs.takeRecords === 'function') {
									const records = obs.takeRecords();
									let anyVisible = false;
									for (const entry of records) {
										if (entry.isIntersecting) { anyVisible = true; break; }
									}
									if (anyVisible && !vv._spacerRenderPending) {
										vv._spacerRenderPending = true;
										setTimeout(() => {
											vv._spacerRenderPending = false;
											try { __kustoRerenderResultsTableBody(boxId, { reason: 'spacer-visible-deferred' }); } catch { /* ignore */ }
										}, 50);
									}
								}
							} catch { /* ignore */ }
						}, 100);
					}
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	try { _win.__kustoEnsureDragSelectionHandlers(boxId); } catch { /* ignore */ }
	try { _win.__kustoUpdateSplitButtonState(boxId); } catch { /* ignore */ }
}

function displayResult(result: any) {
	const boxId = (_win.lastExecutedBox as any);
	if (!boxId) { return; }

	(_win.setQueryExecuting as any)(boxId, false);

	displayResultForBox(result, boxId, {
		label: 'Results',
		showExecutionTime: true
	});
}

// Ensure these entrypoints are always accessible globally (some hosts/tooling can
// make bare function declarations non-global).
try { (window as any).displayResult = displayResult; } catch { /* ignore */ }
try { (window as any).displayResultForBox = displayResultForBox; } catch { /* ignore */ }

function __kustoEnsureResultsStateMap() {
	if (!(_win.__kustoResultsByBoxId as any) || typeof (_win.__kustoResultsByBoxId as any) !== 'object') {
		(_win.__kustoResultsByBoxId as any) = {};
	}
	return (_win.__kustoResultsByBoxId as any);
}

function __kustoGetResultsState(boxId: any) {
	if (!boxId) {
		return null;
	}
	const map = __kustoEnsureResultsStateMap();
	return map[boxId] || null;
}

function __kustoSetResultsState(boxId: any, state: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureResultsStateMap();
	map[boxId] = state;
	// Backward-compat: keep the last rendered result as the "current" one.
	try { (_win.currentResult as any) = state; } catch { /* ignore */ }
	// Notify any dependent sections (charts/transformations) that this data source changed.
	try {
		if (typeof (_win.__kustoNotifyResultsUpdated as any) === 'function') {
			(_win.__kustoNotifyResultsUpdated as any)(boxId);
		}
	} catch { /* ignore */ }
}

function displayResultForBox(result: any, boxId: any, options: any) {
	if (!boxId) { return; }

	// If the section is a <kw-query-section> Lit element, delegate to displayResult().
	if (!(options && options.resultsDiv)) {
		try {
			const sectionEl = document.getElementById(boxId);
			if (sectionEl && typeof (sectionEl as any).displayResult === 'function') {
				(sectionEl as any).displayResult(result, options);
				// Still update global results state for cross-section dependencies.
				const cols = Array.isArray(result && result.columns) ? result.columns : [];
				const rws = Array.isArray(result && result.rows) ? result.rows : [];
				const meta = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};
				__kustoSetResultsState(boxId, {
					boxId, columns: cols, rows: rws, metadata: meta,
					selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
					selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
					sortSpec: [], columnFilters: {}, filteredRowIndices: null,
					displayRowIndices: null, rowIndexToDisplayIndex: null
				});
				try { _win.__kustoEnsureDisplayRowIndexMaps(__kustoGetResultsState(boxId)); } catch { /* ignore */ }
				try { (_win.__kustoTryStoreQueryResult as any)(boxId, result); } catch { /* ignore */ }
				try { _win.__kustoUpdateSplitButtonState(boxId); } catch { /* ignore */ }
				return;
			}
		} catch { /* ignore — fall through to legacy rendering */ }
	}

	const resultsDiv = (options && options.resultsDiv) ? options.resultsDiv : document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	const columns = Array.isArray(result && result.columns) ? result.columns : [];
	const rows = Array.isArray(result && result.rows) ? result.rows : [];
	const metadata = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};
	__kustoSetResultsState(boxId, {
		boxId: boxId,
		columns: columns,
		rows: rows,
		metadata: metadata,
		selectedCell: null,
		cellSelectionAnchor: null,
		cellSelectionRange: null,
		selectedRows: new Set(),
		searchMatches: [],
		currentSearchIndex: -1,
		sortSpec: [],
		columnFilters: {},
		filteredRowIndices: null,
		displayRowIndices: null,
		rowIndexToDisplayIndex: null
	});
	try {
		const st = __kustoGetResultsState(boxId);
		if (st) {
			_win.__kustoEnsureDisplayRowIndexMaps(st);
		}
	} catch { /* ignore */ }

	const label = (options && typeof options.label === 'string' && options.label) ? options.label : 'Results';
	const showExecutionTime = !(options && options.showExecutionTime === false);
	const execTime = metadata && typeof metadata.executionTime === 'string' ? metadata.executionTime : '';
	const execPart = (showExecutionTime && execTime) ? ('<span class="results-exec-info"> (Execution time: ' + execTime + ')</span>') : '';

	const searchIconSvg = _win.__kustoGetSearchIconSvg();
	const scrollToColumnIconSvg = _win.__kustoGetScrollToColumnIconSvg();
	const resultsVisibilityIconSvg = _win.__kustoGetResultsVisibilityIconSvg();
	const sortIconSvg = _win.__kustoGetSortIconSvg();
	const copyIconSvg = _win.__kustoGetCopyIconSvg();
	const saveIconSvg = _win.__kustoGetSaveIconSvg();
	const toolsIconSvg = '<span class="codicon codicon-tools" aria-hidden="true"></span>';
	const chevronDownSvg = '<svg class="results-tools-dropdown-caret" width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

	const stateForRender = __kustoGetResultsState(boxId);
	const displayRowIndices = (stateForRender && Array.isArray(stateForRender.displayRowIndices)) ? stateForRender.displayRowIndices : rows.map((_: any, i: any) => i);

	// Build the collapsed Tools dropdown menu (shown when width is narrow)
	const toolsDropdownHtml =
		'<div class="results-tools-dropdown" id="' + boxId + '_results_tools_dropdown">' +
		'<button class="results-tools-dropdown-btn" id="' + boxId + '_results_tools_dropdown_btn" type="button" onclick="__kustoToggleResultsToolsDropdown(\'' + boxId + '\'); event.stopPropagation();" title="Tools" aria-label="Tools" aria-haspopup="listbox" aria-expanded="false">' +
		toolsIconSvg + chevronDownSvg +
		'</button>' +
		'<div class="results-tools-dropdown-menu" id="' + boxId + '_results_tools_dropdown_menu" role="listbox" tabindex="-1">' +
		'<div class="results-tools-dropdown-item results-visibility-item" id="' + boxId + '_tools_dd_visibility" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'visibility\');" title="Show/Hide results">' + resultsVisibilityIconSvg + '<span id="' + boxId + '_tools_dd_visibility_label">Hide results</span></div>' +
		'<div class="results-tools-dropdown-sep results-visibility-item"></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_search" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'search\');" title="Search data">' + searchIconSvg + '<span>Search</span></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_column" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'column\');" title="Scroll to column">' + scrollToColumnIconSvg + '<span>Go to column</span></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_sort" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'sort\');" title="Sort">' + sortIconSvg + '<span>Sort</span></div>' +
		'<div class="results-tools-dropdown-sep"></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_save" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'save\');" title="Save results to file">' + saveIconSvg + '<span>Save</span></div>' +
		'<div class="results-tools-dropdown-item" id="' + boxId + '_tools_dd_copy" onclick="__kustoResultsToolsDropdownAction(\'' + boxId + '\', \'copy\');" title="Copy results to clipboard">' + copyIconSvg + '<span>Copy</span></div>' +
		'</div>' +
		'</div>';

	const clientActivityId = metadata && typeof metadata.clientActivityId === 'string' ? metadata.clientActivityId : '';
	const serverStats = (metadata && metadata.serverStats && typeof metadata.serverStats === 'object') ? metadata.serverStats : null;
	const hasTooltipContent = !!(clientActivityId || serverStats);
	const titleRowTooltipClass = hasTooltipContent ? ' results-label-tooltip-anchor' : '';

	// Build rich tooltip HTML with activity ID + server stats
	let resultsLabelTooltipHtml = '';
	if (hasTooltipContent) {
		let tooltipRows = '';

		// Activity ID row
		if (clientActivityId) {
			tooltipRows +=
				'<div class="results-label-tooltip-row">' +
				'<span class="results-label-tooltip-title">Client Activity ID</span>' +
				'<span class="results-label-tooltip-value" id="' + boxId + '_client_activity_id">' + clientActivityId + '</span>' +
				'<button class="results-label-tooltip-copy" type="button" onclick="event.stopPropagation(); __kustoCopyClientActivityId(\'' + __kustoEscapeJsStringLiteral(boxId) + '\')" title="Copy to clipboard" aria-label="Copy Client Activity ID">' +
				copyIconSvg +
				'</button>' +
				'</div>';
		}

		// Server stats rows
		if (serverStats) {
			const fmtCpuMs = function(ms: any) {
				if (ms < 1000) { return ms.toFixed(1) + 'ms'; }
				return (ms / 1000).toFixed(3) + 's';
			};
			const fmtBytes = function(bytes: any) {
				if (bytes == null || !isFinite(bytes)) { return '?'; }
				if (bytes < 1024) { return bytes + ' B'; }
				if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
				if (bytes < 1024 * 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
				return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
			};
			const fmtNum = function(n: any) { return n == null ? '?' : Number(n).toLocaleString(); };

			const statRow = function(label: any, value: any) {
				return '<div class="results-label-tooltip-row results-label-tooltip-stat-row">' +
					'<span class="results-label-tooltip-title">' + label + '</span>' +
					'<span class="results-label-tooltip-value">' + value + '</span>' +
					'</div>';
			};

			tooltipRows += '<div class="results-label-tooltip-separator"></div>';

			if (serverStats.cpuTimeMs != null && isFinite(serverStats.cpuTimeMs)) {
				tooltipRows += statRow('Server CPU', fmtCpuMs(serverStats.cpuTimeMs));
			} else if (serverStats.cpuTime) {
				tooltipRows += statRow('Server CPU', serverStats.cpuTime);
			}
			if (serverStats.peakMemoryPerNode != null && isFinite(serverStats.peakMemoryPerNode)) {
				tooltipRows += statRow('Peak memory', fmtBytes(serverStats.peakMemoryPerNode));
			}
			if (serverStats.extentsScanned != null) {
				var extLabel = fmtNum(serverStats.extentsScanned);
				if (serverStats.extentsTotal != null) {
					extLabel += ' / ' + fmtNum(serverStats.extentsTotal);
				}
				tooltipRows += statRow('Extents scanned', extLabel);
			}
			// Cache
			var memHits = typeof serverStats.memoryCacheHits === 'number' ? serverStats.memoryCacheHits : null;
			var memMisses = typeof serverStats.memoryCacheMisses === 'number' ? serverStats.memoryCacheMisses : null;
			if (memHits != null || memMisses != null) {
				var total = (memHits || 0) + (memMisses || 0);
				var rate = total > 0 ? ((memHits || 0) / total * 100).toFixed(1) + '%' : 'N/A';
				tooltipRows += statRow('Memory cache', rate + ' (' + fmtNum(memHits || 0) + ' hits, ' + fmtNum(memMisses || 0) + ' misses)');
			}
			var diskHits = typeof serverStats.diskCacheHits === 'number' ? serverStats.diskCacheHits : null;
			var diskMisses = typeof serverStats.diskCacheMisses === 'number' ? serverStats.diskCacheMisses : null;
			if (diskHits != null || diskMisses != null) {
				var dTotal = (diskHits || 0) + (diskMisses || 0);
				var dRate = dTotal > 0 ? ((diskHits || 0) / dTotal * 100).toFixed(1) + '%' : 'N/A';
				tooltipRows += statRow('Disk cache', dRate + ' (' + fmtNum(diskHits || 0) + ' hits, ' + fmtNum(diskMisses || 0) + ' misses)');
			}
			if (serverStats.shardHotHitBytes != null || serverStats.shardHotMissBytes != null) {
				tooltipRows += statRow('Shard hot cache', fmtBytes(serverStats.shardHotHitBytes || 0) + ' hit / ' + fmtBytes(serverStats.shardHotMissBytes || 0) + ' miss');
			}
			if (serverStats.serverRowCount != null) {
				tooltipRows += statRow('Server row count', fmtNum(serverStats.serverRowCount));
			}
			if (serverStats.serverTableSize != null) {
				tooltipRows += statRow('Result size', fmtBytes(serverStats.serverTableSize));
			}
		}

		resultsLabelTooltipHtml =
			'<div class="results-label-tooltip" id="' + boxId + '_activity_id_tooltip">' +
			tooltipRows +
			'</div>';
	}

	const wasTruncated = !!metadata.persistedTruncated;
	const originalTotal = (wasTruncated && typeof metadata.persistedTotalRows === 'number' && isFinite(metadata.persistedTotalRows))
		? metadata.persistedTotalRows : 0;
	const initialRowCountText = (rows ? rows.length : 0) +
		(wasTruncated && originalTotal > (rows ? rows.length : 0)
			? ' (of ' + String(originalTotal) + ' \u2014 truncated to fit file)'
			: '');

	let html =
		'<div class="results-header">' +
		'<div class="results-title-row' + titleRowTooltipClass + '">' +
		'<strong>' + label + ':</strong><span class="results-row-col-info"> <span id="' + boxId + '_results_count">' + initialRowCountText + '</span> rows / ' + (columns ? columns.length : 0) + ' columns</span>' +
		execPart +
		'<button class="unified-btn-secondary tool-toggle-btn results-visibility-toggle" id="' + boxId + '_results_toggle" type="button" onclick="toggleQueryResultsVisibility(\'' + boxId + '\')" title="Hide results" aria-label="Hide results">' + resultsVisibilityIconSvg + '</button>' +
		resultsLabelTooltipHtml +
		'</div>' +
		'<div class="results-tools-row">' +
		// Collapsed Tools dropdown (visible when narrow)
		toolsDropdownHtml +
		// Individual tool buttons (visible when wide enough)
		'<div class="results-tools-individual">' +
		'<button class="unified-btn-secondary tool-toggle-btn" id="' + boxId + '_results_search_btn" onclick="toggleSearchTool(\'' + boxId + '\')" title="Search data" aria-label="Search data">' + searchIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn" id="' + boxId + '_results_column_btn" onclick="toggleColumnTool(\'' + boxId + '\')" title="Scroll to column" aria-label="Scroll to column">' + scrollToColumnIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn" id="' + boxId + '_results_sort_btn" onclick="toggleSortDialog(\'' + boxId + '\')" title="Sort" aria-label="Sort">' + sortIconSvg + '</button>' +
		'<span class="results-sep" id="' + boxId + '_results_sep_2" aria-hidden="true"></span>' +
		'<span class="kusto-split-btn" id="' + boxId + '_results_save_split">' +
		'<button class="unified-btn-secondary tool-toggle-btn tool-save-results-btn" id="' + boxId + '_results_save_btn" onclick="__kustoOnSavePrimary(\'' + boxId + '\', \'' + __kustoEscapeJsStringLiteral(label) + '\')" title="Save results to file" aria-label="Save results to file">' + saveIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn kusto-split-caret" id="' + boxId + '_results_save_menu_btn" style="display: none;" onclick="__kustoOnSaveMenu(\'' + boxId + '\', \'' + __kustoEscapeJsStringLiteral(label) + '\', this)" title="More save options" aria-label="More save options"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></button>' +
		'</span>' +
		'<span class="kusto-split-btn" id="' + boxId + '_results_copy_split">' +
		'<button class="unified-btn-secondary tool-toggle-btn tool-copy-results-btn" id="' + boxId + '_results_copy_btn" onclick="__kustoOnCopyPrimary(\'' + boxId + '\')" title="Copy results to clipboard" aria-label="Copy results to clipboard">' + copyIconSvg + '</button>' +
		'<button class="unified-btn-secondary tool-toggle-btn kusto-split-caret" id="' + boxId + '_results_copy_menu_btn" style="display: none;" onclick="__kustoOnCopyMenu(\'' + boxId + '\', this)" title="More copy options" aria-label="More copy options"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></button>' +
		'</span>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="results-body" id="' + boxId + '_results_body" data-kusto-no-editor-focus="true">' +
		'<div class="data-search" id="' + boxId + '_data_search_container" style="display: none;">' +
		'<div class="kusto-search-host" id="' + boxId + '_data_search_host"></div>' +
		'</div>' +
		'<div class="column-search" id="' + boxId + '_column_search_container" style="display: none;">' +
		'<div class="kusto-search-host" id="' + boxId + '_column_search_host"></div>' +
		'<div class="column-autocomplete" id="' + boxId + '_column_autocomplete"></div>' +
		'</div>' +
		'<div class="table-container" id="' + boxId + '_table_container" tabindex="0" data-kusto-no-editor-focus="true" onkeydown="handleTableKeydown(event, \'' + boxId + '\')" oncontextmenu="handleTableContextMenu(event, \'' + boxId + '\')">' +
		'<table id="' + boxId + '_table">' +
		'<thead><tr>' +
		'<th class="row-selector">#</th>' +
		columns.map((c: any, i: any) =>
			'<th data-col="' + i + '" onclick="handleHeaderSortClick(event, ' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
			'<div class="column-header-content">' +
			'<div class="column-header-left">' +
			'<span class="column-name">' + c + '</span>' +
			'<span class="kusto-filter-link-host" id="' + boxId + '_filter_link_' + i + '"></span>' +
			'<span class="kusto-sort-indicator" id="' + boxId + '_sort_ind_' + i + '"></span>' +
			'</div>' +
			'<button class="column-menu-btn" onclick="toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">☰</button>' +
			'<div class="column-menu" id="' + boxId + '_col_menu_' + i + '">' +
			'<div class="column-menu-item" onclick="sortColumnAscending(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Sort ascending</div>' +
			'<div class="column-menu-item" onclick="sortColumnDescending(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Sort descending</div>' +
			'<div class="column-menu-item" onclick="openColumnFilter(event, ' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); toggleColumnMenu(' + i + ', \'' + __kustoEscapeJsStringLiteral(boxId) + '\'); event.stopPropagation();">Filter...</div>' +
			'<div class="column-menu-item" onclick="showUniqueValues(' + i + ', \'' + boxId + '\')">Unique values</div>' +
			'<div class="column-menu-item" onclick="showDistinctCountPicker(' + i + ', \'' + boxId + '\')">Distinct count by column...</div>' +
			'</div>' +
			'</div>' +
			'</th>'
		).join('') +
		'</tr></thead>' +
		'<tbody></tbody>' +
		'</table>' +
		'</div>' +
		'</div>' +
		'<div class="kusto-sort-modal" id="' + boxId + '_sort_modal" onclick="closeSortDialogOnBackdrop(event, \'' + __kustoEscapeJsStringLiteral(boxId) + '\')">' +
		'<div class="kusto-sort-dialog" onclick="event.stopPropagation();">' +
		'<div class="kusto-sort-header">' +
		'<button type="button" class="kusto-sort-close" onclick="closeSortDialog(\'' + __kustoEscapeJsStringLiteral(boxId) + '\')" title="Close" aria-label="Close">' + _win.__kustoGetTrashIconSvg(14) + '</button>' +
		'<div><strong>Sort</strong></div>' +
		'</div>' +
		'<div class="kusto-sort-body">' +
		'<div id="' + boxId + '_sort_list"></div>' +
		'</div>' +
		'</div>' +
		'</div>';

	resultsDiv.innerHTML = html;
	try { __kustoEnsureResultsSearchControls(boxId); } catch { /* ignore */ }
	// Ensure the results UI establishes a consistent scroll surface everywhere it is embedded.
	// Some hosts (e.g. URL/CSV) don't have the same wrapper DOM as query results, so we
	// apply minimal inline flex/overflow styles to make virtualization + selection reliable.
	try {
		resultsDiv.style.display = 'flex';
		resultsDiv.style.flexDirection = 'column';
		resultsDiv.style.flex = '1 1 auto';
		resultsDiv.style.minHeight = '0';
		resultsDiv.style.minWidth = '0';
		resultsDiv.style.overflow = 'hidden';
	} catch { /* ignore */ }
	try {
		const body = document.getElementById(boxId + '_results_body');
		if (body && body.style) {
			body.style.display = 'flex';
			body.style.flexDirection = 'column';
			body.style.flex = '1 1 auto';
			body.style.minHeight = '0';
			body.style.overflow = 'hidden';
		}
	} catch { /* ignore */ }
	try {
		const container = document.getElementById(boxId + '_table_container');
		if (container && container.style) {
			container.style.display = 'block';
			container.style.flex = '1 1 auto';
			container.style.minHeight = '0';
			container.style.minWidth = '0';
			container.style.maxHeight = 'none';
			container.style.overflowX = 'auto';
			container.style.overflowY = 'auto';
		}
	} catch { /* ignore */ }
	try { __kustoRerenderResultsTableBody(boxId, { reason: 'initial' }); } catch { /* ignore */ }
	// Some hosts (notably URL/CSV previews) can inject the table before the container has a
	// real height, so virtualization may bind scroll handlers to the wrong element until a
	// later rerender (e.g. on click). Do a one-time post-layout rerender to rebind.
	// Use setTimeout instead of requestAnimationFrame because RAF can be delayed or
	// skipped entirely in VS Code webview environments (background tabs, rapid layout
	// recalculations). Two nested setTimeout(0) calls approximate double-RAF timing
	// while guaranteeing execution.
	try {
		const st = __kustoGetResultsState(boxId);
		if (st && !st.__kustoPostLayoutRerenderScheduled) {
			st.__kustoPostLayoutRerenderScheduled = true;
			setTimeout(() => {
				setTimeout(() => {
					try { __kustoRerenderResultsTableBody(boxId, { reason: 'post-layout' }); } catch { /* ignore */ }
				}, 0);
			}, 0);
		}
	} catch { /* ignore */ }
	try { _win.__kustoUpdateSplitButtonState(boxId); } catch { /* ignore */ }
	try {
		if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
			(_win.__kustoApplyResultsVisibility as any)(boxId);
		}
	} catch {
		// ignore
	}
	try {
		if (typeof (_win.__kustoUpdateQueryResultsToggleButton) === 'function') {
			(_win.__kustoUpdateQueryResultsToggleButton as any)(boxId);
		}
	} catch {
		// ignore
	}
	resultsDiv.classList.add('visible');
}

function __kustoEnsureResultsSearchControls(boxId: any) {
	try {
		if (typeof (_win.__kustoCreateSearchControl as any) !== 'function') return;

		const dataHost = document.getElementById(boxId + '_data_search_host');
		if (dataHost && !document.getElementById(boxId + '_data_search')) {
			(_win.__kustoCreateSearchControl as any)(dataHost, {
				inputId: boxId + '_data_search',
				modeId: boxId + '_data_search_mode',
				ariaLabel: 'Search data',
				onInput: function () { _win.searchData(boxId); },
				onKeyDown: function (e: any) { _win.handleDataSearchKeydown(e, boxId); },
				onPrev: function () { _win.previousSearchMatch(boxId); },
				onNext: function () { _win.nextSearchMatch(boxId); }
			});
		}

		const colHost = document.getElementById(boxId + '_column_search_host');
		if (colHost && !document.getElementById(boxId + '_column_search')) {
			(_win.__kustoCreateSearchControl as any)(colHost, {
				inputId: boxId + '_column_search',
				modeId: boxId + '_column_search_mode',
				ariaLabel: 'Scroll to column',
				onInput: function () { _win.filterColumns(boxId); },
				onKeyDown: function (e: any) { _win.handleColumnSearchKeydown(e, boxId); }
			});
		}
	} catch { /* ignore */ }
}

function __kustoTryExtractJsonFromErrorText(raw: any) {
	const text = String(raw || '');
	const firstObj = text.indexOf('{');
	const firstArr = text.indexOf('[');
	let start = -1;
	let end = -1;
	if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
		start = firstObj;
		end = text.lastIndexOf('}');
	} else if (firstArr >= 0) {
		start = firstArr;
		end = text.lastIndexOf(']');
	}
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	const candidate = text.slice(start, end + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		// Best-effort: if the message contains extra trailing characters after JSON, try trimming.
		try {
			const trimmed = candidate.trim();
			return JSON.parse(trimmed);
		} catch {
			// ignore
		}
		return null;
	}
}

function __kustoExtractLinePosition(text: any) {
	const s = String(text || '');
	const m = s.match(/\[line:position\s*=\s*(\d+)\s*:\s*(\d+)\s*\]/i);
	if (!m) {
		return null;
	}
	const line = parseInt(m[1], 10);
	const col = parseInt(m[2], 10);
	if (!isFinite(line) || !isFinite(col) || line <= 0 || col <= 0) {
		return null;
	}
	return { line, col, token: `[line:position=${line}:${col}]` };
}

function __kustoNormalizeBadRequestInnerMessage(msg: any) {
	let s = String(msg || '').trim();
	// Strip boilerplate prefixes commonly returned by Kusto.
	s = s.replace(/^Request is invalid[^:]*:\s*/i, '');
	s = s.replace(/^(Semantic error:|Syntax error:)\s*/i, '');
	return s.trim();
}

function __kustoStripLinePositionTokens(text: any) {
	let s = String(text || '');
	// Remove any existing [line:position=...] tokens to avoid duplicating adjusted locations.
	s = s.replace(/\s*\[line:position\s*=\s*\d+\s*:\s*\d+\s*\]\s*/gi, ' ');
	// Normalize whitespace.
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}

function __kustoTryExtractAutoFindTermFromMessage(message: any) {
	try {
		const msg = String(message || '');
		if (!msg.trim()) return null;
		// Kusto common pitfall: calling notempty() with no args.
		// Example: "SEM0219: notempty(): function expects 1 argument(s)."
		// Auto-find "notempty" so users can quickly fix occurrences.
		try {
			const lower = msg.toLowerCase();
			const looksLikeSem0219 = lower.includes('sem0219');
			const looksLikeArity1 = lower.includes('function expects 1 argument');
			const mentionsNotEmpty = /\bnotempty\b/i.test(msg);
			if ((looksLikeSem0219 || looksLikeArity1) && mentionsNotEmpty) {
				return 'notempty';
			}
		} catch { /* ignore */ }
		// Specific common cases (more precise patterns first).
		let m = msg.match(/\bSEM0139\b\s*:\s*Failed\s+to\s+resolve\s+expression\s*(['"])(.*?)\1/i);
		if (!m) {
			m = msg.match(/\bSEM0260\b\s*:\s*Unknown\s+function\s*:\s*(['"])(.*?)\1/i);
		}
		// SEM0100 and similar: the useful token is often the identifier in `named 'X'`.
		if (!m) {
			m = msg.match(/\bnamed\s*(['"])(.*?)\1/i);
		}
		// Generic semantic error pattern: SEMxxxx ... 'token'
		if (!m) {
			m = msg.match(/\bSEM\d{4}\b[^\n\r]*?(['"])(.*?)\1/i);
		}
		if (m && m[2]) {
			const t = String(m[2]);
			// Avoid pathological cases (huge extracted strings).
			if (t.length > 0 && t.length <= 400) {
				return t;
			}
		}
	} catch { /* ignore */ }
	return null;
}

function __kustoBuildErrorUxModel(rawError: any) {
	const raw = (rawError === null || rawError === undefined) ? '' : String(rawError);
	if (!raw.trim()) {
		return { kind: 'none' };
	}

	const json = __kustoTryExtractJsonFromErrorText(raw);
	if (json && json.error && typeof json.error === 'object') {
		const code = String(json.error.code || '').trim();
		if (code === 'General_BadRequest') {
			const inner = (json.error.innererror && typeof json.error.innererror === 'object') ? json.error.innererror : null;
			const candidateMsg =
				(inner && (inner['@message'] || inner.message)) ||
				(json.error['@message'] || json.error.message) ||
				raw;
			const normalized = __kustoNormalizeBadRequestInnerMessage(candidateMsg);
			let loc = __kustoExtractLinePosition(candidateMsg) || __kustoExtractLinePosition(normalized) || __kustoExtractLinePosition(raw);
			if (!loc && inner) {
				try {
					const line = parseInt(inner['@line'] || inner.line || '', 10);
					const col = parseInt(inner['@pos'] || inner.pos || '', 10);
					if (isFinite(line) && isFinite(col) && line > 0 && col > 0) {
						loc = { line, col, token: `[line:position=${line}:${col}]` };
					}
				} catch { /* ignore */ }
			}
			const autoFindTerm = __kustoTryExtractAutoFindTermFromMessage(String(normalized || candidateMsg || ''));
			return { kind: 'badrequest', message: normalized || raw, location: loc || null, autoFindTerm };
		}

		try {
			return { kind: 'json', pretty: JSON.stringify(json, null, 2) };
		} catch {
			// fall through
		}
	}

	// Not JSON (or unparseable): display as wrapped text.
	return {
		kind: 'text',
		text: raw,
		autoFindTerm: __kustoTryExtractAutoFindTermFromMessage(raw)
	};
}

function __kustoMaybeAdjustLocationForCacheLine(boxId: any, location: any) {
	if (!location || typeof location !== 'object') {
		return location;
	}
	const bid = String(boxId || '').trim();
	if (!bid) {
		return location;
	}
	let cacheEnabled = false;
	try {
		cacheEnabled = !!((_win.__kustoLastRunCacheEnabledByBoxId as any) && (_win.__kustoLastRunCacheEnabledByBoxId as any)[bid]);
	} catch {
		cacheEnabled = false;
	}
	if (!cacheEnabled) {
		return location;
	}
	const line = parseInt(String(location.line || ''), 10);
	const col = parseInt(String(location.col || ''), 10);
	if (!isFinite(line) || line <= 0) {
		return location;
	}
	const nextLine = Math.max(1, line - 1);
	return {
		...location,
		line: nextLine,
		col: isFinite(col) && col > 0 ? col : location.col,
		token: `[line:position=${nextLine}:${isFinite(col) && col > 0 ? col : (location.col || 1)}]`
	};
}

function __kustoEscapeForHtml(s: any) {
	return (typeof (_win.escapeHtml) === 'function') ? (_win.escapeHtml as any)(String(s || '')) : String(s || '');
}

function __kustoEscapeJsStringLiteral(s: any) {
	return String(s || '')
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/"/g, '\\"');
}

function __kustoEscapeForHtmlAttribute(s: any) {
	// Attribute-safe escaping (quotes included).
	return __kustoEscapeForHtml(s)
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function __kustoRenderActivityIdInlineHtml(boxId: any, clientActivityId: any) {
	if (!clientActivityId || typeof clientActivityId !== 'string') {
		return '';
	}
	const bid = String(boxId || '');
	const copyIconSvg = _win.__kustoGetCopyIconSvg();
	return (
		'<div class="kusto-error-activity-id">' +
		'<span class="kusto-error-activity-id-label">Client Activity ID:</span> ' +
		'<span class="kusto-error-activity-id-value" id="' + bid + '_client_activity_id">' + __kustoEscapeForHtml(clientActivityId) + '</span>' +
		'<button class="results-label-tooltip-copy" type="button" onclick="event.stopPropagation(); __kustoCopyClientActivityId(\'' + __kustoEscapeJsStringLiteral(bid) + '\')" title="Copy to clipboard" aria-label="Copy Client Activity ID">' +
		copyIconSvg +
		'</button>' +
		'</div>'
	);
}

function __kustoRenderErrorUxHtml(boxId: any, model: any, clientActivityId: any) {
	if (!model || model.kind === 'none') {
		return '';
	}
	const bid = String(boxId || '');
	const activityIdHtml = __kustoRenderActivityIdInlineHtml(bid, clientActivityId);
	if (model.kind === 'badrequest') {
		const msgEsc = __kustoEscapeForHtml(model.message);
		let locHtml = '';
		if (model.location && model.location.line && model.location.col) {
			const line = model.location.line;
			const col = model.location.col;
			const tokenEsc = __kustoEscapeForHtml(`Line ${line}, Col ${col}`);
			locHtml =
				' <a href="#" class="kusto-error-location"' +
				' data-boxid="' + __kustoEscapeForHtmlAttribute(bid) + '"' +
				' data-line="' + String(line) + '"' +
				' data-col="' + String(col) + '"' +
				' title="Go to line ' + String(line) + ', column ' + String(col) + '">' +
				tokenEsc +
				'</a>';
		}
		return (
			'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
			'<div><strong>' + msgEsc + '</strong>' + locHtml + '</div>' +
			activityIdHtml +
			'</div>'
		);
	}
	if (model.kind === 'json') {
		const pre = __kustoEscapeForHtml(model.pretty);
		return (
			'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
			'<pre style="margin:0; white-space:pre-wrap; word-break:break-word; font-family: var(--vscode-editor-font-family);">' +
			pre +
			'</pre>' +
			activityIdHtml +
			'</div>'
		);
	}
	// text
	const lines = String(model.text || '').split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
	return (
		'<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">' +
		lines +
		activityIdHtml +
		'</div>'
	);
}

// Centralized error UX renderer (hidden when no error).
try {
	(window as any).__kustoRenderErrorUx = function (boxId: any, error: any, clientActivityId: any) {
		const bid = String(boxId || '').trim();
		if (!bid) return;
		try { _win.__kustoEnsureResultsShownForTool(bid); } catch { /* ignore */ }
		const resultsDiv = document.getElementById(bid + '_results');
		if (!resultsDiv) return;
		const model = __kustoBuildErrorUxModel(error);
		try {
			if (model && model.location) {
				model.location = __kustoMaybeAdjustLocationForCacheLine(bid, model.location);
			}
		} catch { /* ignore */ }
		try {
			if (model && model.kind === 'badrequest' && model.location && model.message) {
				model.message = __kustoStripLinePositionTokens(model.message);
			}
		} catch { /* ignore */ }
		if (!model || model.kind === 'none') {
			resultsDiv.innerHTML = '';
			try {
				if (resultsDiv.classList) {
					resultsDiv.classList.remove('visible');
				}
			} catch { /* ignore */ }
			try {
				if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
					(_win.__kustoApplyResultsVisibility as any)(bid);
				}
			} catch { /* ignore */ }
			return;
		}
		const html = __kustoRenderErrorUxHtml(bid, model, clientActivityId);
		resultsDiv.innerHTML = html;
		resultsDiv.classList.add('visible');
		try {
			if (typeof (_win.__kustoApplyResultsVisibility) === 'function') {
				(_win.__kustoApplyResultsVisibility as any)(bid);
			}
		} catch { /* ignore */ }
		try {
			if (typeof (_win.__kustoClampResultsWrapperHeight as any) === 'function') {
				(_win.__kustoClampResultsWrapperHeight as any)(bid);
			}
		} catch { /* ignore */ }
		// Special UX: on SEM0139, auto-find the unresolved expression in the query editor.
		try {
			if (model && model.autoFindTerm && typeof (_win.__kustoAutoFindInQueryEditor as any) === 'function') {
				setTimeout(() => {
					try { (_win.__kustoAutoFindInQueryEditor as any)(bid, String(model.autoFindTerm)); } catch { /* ignore */ }
				}, 0);
			}
		} catch { /* ignore */ }
	};
} catch {
	// ignore
}

// Navigate to a line/column in the query editor and scroll it into view.
try {
	(window as any).__kustoNavigateToQueryLocation = function (event: any, boxId: any, line: any, col: any) {
		try {
			if (event && typeof event.preventDefault === 'function') {
				event.preventDefault();
			}
			if (event && typeof event.stopPropagation === 'function') {
				event.stopPropagation();
			}
		} catch { /* ignore */ }
		const bid = String(boxId || '').trim();
		const ln = parseInt(String(line), 10);
		const cn = parseInt(String(col), 10);
		if (!bid || !isFinite(ln) || !isFinite(cn) || ln <= 0 || cn <= 0) {
			return;
		}
		try {
			const boxEl = document.getElementById(bid);
			if (boxEl && typeof boxEl.scrollIntoView === 'function') {
				boxEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
			}
		} catch { /* ignore */ }
		try {
			const editor = (typeof (_win.queryEditors as any) !== 'undefined' && (_win.queryEditors as any)) ? (_win.queryEditors as any)[bid] : null;
			if (!editor) return;
			const pos = { lineNumber: ln, column: cn };
			try { editor.focus(); } catch { /* ignore */ }
			try { if (typeof editor.setPosition === 'function') editor.setPosition(pos); } catch { /* ignore */ }
			try { if (typeof editor.revealPositionInCenter === 'function') editor.revealPositionInCenter(pos); } catch { /* ignore */ }
			try {
				if (typeof editor.setSelection === 'function') {
					editor.setSelection({ startLineNumber: ln, startColumn: cn, endLineNumber: ln, endColumn: cn });
				}
			} catch { /* ignore */ }
		} catch {
			// ignore
		}
	};
} catch {
	// ignore
}

// Delegated click handler for clickable error locations.
try {
	if (!(_win.__kustoErrorLocationClickHandlerInstalled as any)) {
		(_win.__kustoErrorLocationClickHandlerInstalled as any) = true;
		document.addEventListener('click', (event) => {
			try {
				const target = event && event.target ? event.target : null;
				if (!target || typeof (target as any).closest !== 'function') {
					return;
				}
				const link = (target as any).closest('a.kusto-error-location');
				if (!link) {
					return;
				}
				const boxId = String(link.getAttribute('data-boxid') || '').trim();
				const line = parseInt(String(link.getAttribute('data-line') || ''), 10);
				const col = parseInt(String(link.getAttribute('data-col') || ''), 10);
				if (!boxId || !isFinite(line) || !isFinite(col)) {
					return;
				}
				if (typeof (_win.__kustoNavigateToQueryLocation as any) === 'function') {
					(_win.__kustoNavigateToQueryLocation as any)(event, boxId, line, col);
					return;
				}
			} catch {
				// ignore
			}
		}, true);
	}
} catch {
	// ignore
}

function displayError(error: any) {
	const boxId = (_win.lastExecutedBox as any);
	if (!boxId) { return; }

	(_win.setQueryExecuting as any)(boxId, false);

	try {
		if (typeof (_win.__kustoRenderErrorUx as any) === 'function') {
			(_win.__kustoRenderErrorUx as any)(boxId, error);
			return;
		}
	} catch { /* ignore */ }
	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }
	const raw = (error === null || error === undefined) ? '' : String(error);
	const esc = raw.split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
	resultsDiv.innerHTML = '<div class="results-header" style="color: var(--vscode-errorForeground);">' + esc + '</div>';
	resultsDiv.classList.add('visible');
}

// Display a non-query error message in a specific box's results area.
// Used for auxiliary actions like refreshing databases.
try {
	(window as any).__kustoDisplayBoxError = function (boxId: any, error: any) {
		const bid = String(boxId || '').trim();
		if (!bid) return;
		try {
			if (typeof (_win.__kustoRenderErrorUx as any) === 'function') {
				(_win.__kustoRenderErrorUx as any)(bid, error);
				return;
			}
		} catch { /* ignore */ }
		try { _win.__kustoEnsureResultsShownForTool(bid); } catch { /* ignore */ }
		const resultsDiv = document.getElementById(bid + '_results');
		if (!resultsDiv) return;
		const raw = (error === null || error === undefined) ? '' : String(error);
		const esc = raw.split(/\r?\n/).map(__kustoEscapeForHtml).join('<br>');
		resultsDiv.innerHTML = '<div class="results-header" style="color: var(--vscode-errorForeground);">' + esc + '</div>';
		resultsDiv.classList.add('visible');
	};
} catch {
	// ignore
}

function displayCancelled() {
	const boxId = (_win.lastExecutedBox as any);
	if (!boxId) { return; }

	(_win.setQueryExecuting as any)(boxId, false);

	const resultsDiv = document.getElementById(boxId + '_results');
	if (!resultsDiv) { return; }

	resultsDiv.innerHTML =
		'<div class="results-header">' +
		'<strong>Cancelled.</strong>' +
		'</div>';
	resultsDiv.classList.add('visible');
}

// ── Window bridge exports for remaining legacy callers ──
(window as any).__kustoRerenderResultsTable = __kustoRerenderResultsTable;
(window as any).__kustoGetVirtualizationState = __kustoGetVirtualizationState;
(window as any).__kustoResolveVirtualScrollElement = __kustoResolveVirtualScrollElement;
(window as any).__kustoResolveScrollSourceForEvent = __kustoResolveScrollSourceForEvent;
(window as any).__kustoGetVirtualScrollMetrics = __kustoGetVirtualScrollMetrics;
(window as any).__kustoBumpVisualVersion = __kustoBumpVisualVersion;
(window as any).__kustoComputeVirtualRange = __kustoComputeVirtualRange;
(window as any).__kustoBuildResultsTableRowHtml = __kustoBuildResultsTableRowHtml;
(window as any).__kustoRerenderResultsTableBody = __kustoRerenderResultsTableBody;
(window as any).displayResult = displayResult;
(window as any).__kustoEnsureResultsStateMap = __kustoEnsureResultsStateMap;
(window as any).__kustoGetResultsState = __kustoGetResultsState;
(window as any).__kustoSetResultsState = __kustoSetResultsState;
(window as any).displayResultForBox = displayResultForBox;
(window as any).__kustoEnsureResultsSearchControls = __kustoEnsureResultsSearchControls;
(window as any).__kustoTryExtractJsonFromErrorText = __kustoTryExtractJsonFromErrorText;
(window as any).__kustoExtractLinePosition = __kustoExtractLinePosition;
(window as any).__kustoNormalizeBadRequestInnerMessage = __kustoNormalizeBadRequestInnerMessage;
(window as any).__kustoStripLinePositionTokens = __kustoStripLinePositionTokens;
(window as any).__kustoTryExtractAutoFindTermFromMessage = __kustoTryExtractAutoFindTermFromMessage;
(window as any).__kustoBuildErrorUxModel = __kustoBuildErrorUxModel;
(window as any).__kustoMaybeAdjustLocationForCacheLine = __kustoMaybeAdjustLocationForCacheLine;
(window as any).__kustoEscapeForHtml = __kustoEscapeForHtml;
(window as any).__kustoEscapeJsStringLiteral = __kustoEscapeJsStringLiteral;
(window as any).__kustoEscapeForHtmlAttribute = __kustoEscapeForHtmlAttribute;
(window as any).__kustoRenderActivityIdInlineHtml = __kustoRenderActivityIdInlineHtml;
(window as any).__kustoRenderErrorUxHtml = __kustoRenderErrorUxHtml;
(window as any).displayError = displayError;
(window as any).displayCancelled = displayCancelled;

