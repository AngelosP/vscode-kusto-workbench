function __kustoCloseAllColumnMenus() {
	try {
		document.querySelectorAll('.column-menu.visible').forEach((m) => {
			try { m.classList.remove('visible'); } catch { /* ignore */ }
		});
	} catch { /* ignore */ }
	try {
		if (window.__kustoActiveColumnMenu) {
			window.__kustoActiveColumnMenu = null;
		}
	} catch { /* ignore */ }
}

function __kustoWireColumnMenuAutoClose() {
	try {
		if (window.__kustoColumnMenuAutoCloseWired) {
			return;
		}
		window.__kustoColumnMenuAutoCloseWired = true;
	} catch { /* ignore */ }

	const shouldIgnoreTarget = (target) => {
		try {
			const active = window.__kustoActiveColumnMenu;
			if (active && active.menu) {
				if (active.menu.contains(target)) return true;
				if (active.button && active.button.contains && active.button.contains(target)) return true;
			}
			// Also ignore clicks on any column menu button (opening another menu will close the current one anyway).
			if (target && target.closest && target.closest('.column-menu-btn')) return true;
		} catch { /* ignore */ }
		return false;
	};

	// Use capture so we reliably observe the click even if inner handlers call stopPropagation().
	document.addEventListener('pointerdown', (ev) => {
		try {
			const target = ev && ev.target ? ev.target : null;
			const anyOpen = document.querySelector('.column-menu.visible');
			if (!anyOpen) return;
			if (shouldIgnoreTarget(target)) return;
			__kustoCloseAllColumnMenus();
		} catch { /* ignore */ }
	}, true);

	document.addEventListener('keydown', (ev) => {
		try {
			const key = String(ev && ev.key ? ev.key : '');
			if (key !== 'Escape') return;
			const anyOpen = document.querySelector('.column-menu.visible');
			if (!anyOpen) return;
			try { ev.preventDefault(); } catch { /* ignore */ }
			__kustoCloseAllColumnMenus();
		} catch { /* ignore */ }
	}, true);

	// Close column menus on scroll/wheel so they don't float detached from their buttons.
	document.addEventListener('scroll', () => {
		try {
			const anyOpen = document.querySelector('.column-menu.visible');
			if (!anyOpen) return;
			__kustoCloseAllColumnMenus();
		} catch { /* ignore */ }
	}, true); // Use capture to catch scroll events on nested scrollable elements

	document.addEventListener('wheel', () => {
		try {
			const anyOpen = document.querySelector('.column-menu.visible');
			if (!anyOpen) return;
			__kustoCloseAllColumnMenus();
		} catch { /* ignore */ }
	}, { passive: true });
}

function toggleColumnMenu(colIdx, boxId) {
	// Ensure outside-click/Escape dismiss is wired once.
	try { __kustoWireColumnMenuAutoClose(); } catch { /* ignore */ }

	// Close all other menus
	const menuId = boxId + '_col_menu_' + colIdx;
	document.querySelectorAll('.column-menu.visible').forEach(other => {
		if (other && other.id !== menuId) {
			other.classList.remove('visible');
		}
	});

	const menu = document.getElementById(menuId);
	if (!menu) return;

	const isVisible = menu.classList.contains('visible');
	if (isVisible) {
		menu.classList.remove('visible');
		try {
			if (window.__kustoActiveColumnMenu && window.__kustoActiveColumnMenu.menu === menu) {
				window.__kustoActiveColumnMenu = null;
			}
		} catch { /* ignore */ }
		return;
	}

	// Position the menu using fixed positioning, clamped to viewport.
	const button = menu.previousElementSibling;
	if (!button || typeof button.getBoundingClientRect !== 'function') {
		menu.classList.add('visible');
		try { window.__kustoActiveColumnMenu = { menu, button: button || null }; } catch { /* ignore */ }
		return;
	}

	const margin = 8;
	const buttonRect = button.getBoundingClientRect();

	// Make it visible for measurement without flashing.
	menu.style.position = 'fixed';
	menu.style.visibility = 'hidden';
	menu.style.left = '0px';
	menu.style.top = '0px';
	menu.classList.add('visible');
	try { window.__kustoActiveColumnMenu = { menu, button }; } catch { /* ignore */ }

	const menuRect = menu.getBoundingClientRect();
	const viewportW = Math.max(0, window.innerWidth || 0);
	const viewportH = Math.max(0, window.innerHeight || 0);

	let left = buttonRect.left;
	let top = buttonRect.bottom + 2;

	// If it would overflow bottom, prefer opening upwards.
	if (top + menuRect.height + margin > viewportH && buttonRect.top - 2 - menuRect.height >= margin) {
		top = buttonRect.top - 2 - menuRect.height;
	}

	// Clamp to viewport bounds.
	left = Math.min(left, viewportW - menuRect.width - margin);
	left = Math.max(margin, left);
	if (!isFinite(left)) left = margin;

	top = Math.min(top, viewportH - menuRect.height - margin);
	top = Math.max(margin, top);
	if (!isFinite(top)) top = margin;

	menu.style.left = left + 'px';
	menu.style.top = top + 'px';
	menu.style.visibility = '';
}

function __kustoGetVisibleRowIndices(state) {
	if (!state || !Array.isArray(state.rows)) {
		return [];
	}
	if (Array.isArray(state.filteredRowIndices)) {
		return state.filteredRowIndices;
	}
	if (Array.isArray(state.displayRowIndices)) {
		return state.displayRowIndices;
	}
	return state.rows.map((_, idx) => idx);
}

function showUniqueValues(colIdx, boxId) {
	const state = (typeof __kustoGetResultsState === 'function') ? __kustoGetResultsState(boxId) : null;
	if (!state) { return; }

	// Close menu
	toggleColumnMenu(colIdx, boxId);

	const columnName = state.columns[colIdx];
	const valueCounts = new Map();
	const rowIndices = __kustoGetVisibleRowIndices(state);

	// Count occurrences of each value (respect current filters)
	rowIndices.forEach(rowIdx => {
		const row = state.rows[rowIdx];
		if (!row) { return; }
		const cell = row[colIdx];
		let value;

		// Extract value from cell object
		if (typeof cell === 'object' && cell !== null && 'display' in cell) {
			value = cell.display;
		} else {
			value = String(cell);
		}

		valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
	});

	const totalRows = rowIndices.length;

	// Convert to array and sort by count (descending)
	const sortedValues = Array.from(valueCounts.entries())
		.sort((a, b) => b[1] - a[1]);

	// Display in modal
	const modal = document.getElementById('columnAnalysisModal');
	const title = document.getElementById('columnAnalysisTitle');
	const body = document.getElementById('columnAnalysisBody');

	title.textContent = 'Unique Values - ' + columnName;

	const analysisBoxId = String(boxId) + '_col_' + String(colIdx) + '_unique_values';
	const tableHostId = 'columnAnalysisTableHost';
	let html = '';
	// Host for reusing the main tabular results control.
	html += '<div id="' + tableHostId + '"></div>';
	// Keep the existing chart below the table.
	html += '<div style="margin-top: 24px;">';
	html += '<canvas id="uniqueValuesPieChart" style="width: 100%; height: 400px;"></canvas>';
	html += '</div>';
	body.innerHTML = html;
	modal.classList.add('visible');

	// Render the tabular control after the DOM is updated.
	setTimeout(() => {
		try {
			const host = document.getElementById(tableHostId);
			if (!host || typeof displayResultForBox !== 'function') {
				return;
			}
			const rows = sortedValues.map(([value, count]) => {
				const percentage = totalRows ? ((count / totalRows) * 100).toFixed(2) : '0.00';
				return [escapeHtml(value), String(count), percentage + '%'];
			});
			displayResultForBox({
				columns: ['Value', 'Count', '%'],
				rows: rows,
				metadata: {}
			}, analysisBoxId, {
				label: 'Unique Values',
				showExecutionTime: false,
				resultsDiv: host
			});
		} catch {
			// ignore
		}
	}, 0);

	// Draw pie chart after DOM is updated
	setTimeout(() => {
		const canvas = document.getElementById('uniqueValuesPieChart');
		if (canvas) {
			canvas.width = canvas.offsetWidth;
			canvas.height = 400;
			drawPieChart('uniqueValuesPieChart', sortedValues, totalRows);
		}
	}, 0);
}

function drawPieChart(canvasId, data, total) {
	const canvas = document.getElementById(canvasId);
	if (!canvas) return;
	if (!total || total <= 0) return;

	const ctx = canvas.getContext('2d');
	// Calculate dimensions based on canvas width
	const chartWidth = canvas.width * 0.6; // 60% for pie chart
	const legendWidth = canvas.width * 0.4; // 40% for legend
	const centerX = chartWidth / 2;
	const centerY = canvas.height / 2;
	const radius = Math.min(centerX, centerY) - 40;

	// Generate colors
	const colors = [
		'#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
		'#1abc9c', '#e67e22', '#34495e', '#95a5a6', '#16a085',
		'#27ae60', '#2980b9', '#8e44ad', '#c0392b', '#d35400'
	];

	let currentAngle = -Math.PI / 2; // Start at top

	// Take top 10 values, group the rest as "Others"
	const topN = 10;
	let displayData = data.slice(0, topN);

	if (data.length > topN) {
		const othersCount = data.slice(topN).reduce((sum, [_, count]) => sum + count, 0);
		displayData.push(['Others', othersCount]);
	}

	// Draw slices
	displayData.forEach(([value, count], index) => {
		const sliceAngle = (count / total) * 2 * Math.PI;
		const color = colors[index % colors.length];

		// Draw slice
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(centerX, centerY);
		ctx.arc(centerX, centerY, radius, currentAngle, currentAngle + sliceAngle);
		ctx.closePath();
		ctx.fill();

		// Draw border
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.stroke();

		// Draw label if slice is large enough
		const percentage = (count / total) * 100;
		if (percentage > 3) {
			const labelAngle = currentAngle + sliceAngle / 2;
			const labelX = centerX + (radius * 0.7) * Math.cos(labelAngle);
			const labelY = centerY + (radius * 0.7) * Math.sin(labelAngle);

			ctx.fillStyle = '#ffffff';
			ctx.font = 'bold 12px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 3;
			ctx.strokeText(percentage.toFixed(1) + '%', labelX, labelY);
			ctx.fillText(percentage.toFixed(1) + '%', labelX, labelY);
		}

		currentAngle += sliceAngle;
	});

	// Draw legend on the right side
	const legendX = chartWidth + 20;
	let legendY = 40;

	displayData.forEach(([value, count], index) => {
		const color = colors[index % colors.length];

		// Draw color box
		ctx.fillStyle = color;
		ctx.lineWidth = 1;
		ctx.strokeRect(legendX, legendY, 15, 15);

		// Draw label
		ctx.fillStyle = 'var(--vscode-foreground)';
		ctx.font = '11px sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';

		const labelText = value.length > 25 ? value.substring(0, 22) + '...' : value;
		const percentage = ((count / total) * 100).toFixed(1);
		ctx.fillText(labelText + ' (' + percentage + '%)', legendX + 20, legendY + 2);

		legendY += 20;
	});
}

function showDistinctCountPicker(colIdx, boxId) {
	const state = (typeof __kustoGetResultsState === 'function') ? __kustoGetResultsState(boxId) : null;
	if (!state) { return; }

	// Close menu
	toggleColumnMenu(colIdx, boxId);

	const columnName = state.columns[colIdx];
	const modal = document.getElementById('columnAnalysisModal');
	const title = document.getElementById('columnAnalysisTitle');
	const body = document.getElementById('columnAnalysisBody');

	title.textContent = 'Distinct Count - ' + columnName;
	const analysisBoxId = String(boxId) + '_col_' + String(colIdx) + '_distinct_count';
	const resultsHostId = 'distinctCountResultsHost';

	let html = '<div class="column-picker">';
	html += '<label>Count distinct values of:</label>';
	html += '<select id="distinctCountTargetColumn" onchange="calculateDistinctCount(' + colIdx + ', \'' + boxId + '\')">';
	html += '<option value="">Select a column...</option>';

	// Build sorted column list
	const sortedColumns = state.columns
		.map((col, idx) => ({ col, idx }))
		.filter(item => item.idx !== colIdx)
		.sort((a, b) => a.col.localeCompare(b.col));

	sortedColumns.forEach(item => {
		html += '<option value="' + item.idx + '">' + item.col + '</option>';
	});

	html += '</select>';
	html += '</div>';
	html += '<div id="' + resultsHostId + '" data-analysis-boxid="' + analysisBoxId + '"></div>';

	body.innerHTML = html;
	modal.classList.add('visible');
}

function calculateDistinctCount(groupByColIdx, boxId) {
	const state = (typeof __kustoGetResultsState === 'function') ? __kustoGetResultsState(boxId) : null;
	if (!state) { return; }

	const targetColIdx = parseInt(document.getElementById('distinctCountTargetColumn').value);
	if (isNaN(targetColIdx)) { return; }

	const groupByColumnName = state.columns[groupByColIdx];
	const targetColumnName = state.columns[targetColIdx];

	// Map of groupBy value -> Set of target values
	const groupedValues = new Map();
	const rowIndices = __kustoGetVisibleRowIndices(state);

	rowIndices.forEach(rowIdx => {
		const row = state.rows[rowIdx];
		if (!row) { return; }
		const groupByCell = row[groupByColIdx];
		const targetCell = row[targetColIdx];

		let groupByValue;
		let targetValue;

		// Extract values
		if (typeof groupByCell === 'object' && groupByCell !== null && 'display' in groupByCell) {
			groupByValue = groupByCell.display;
		} else {
			groupByValue = String(groupByCell);
		}

		if (typeof targetCell === 'object' && targetCell !== null && 'display' in targetCell) {
			targetValue = targetCell.display;
		} else {
			targetValue = String(targetCell);
		}

		if (!groupedValues.has(groupByValue)) {
			groupedValues.set(groupByValue, new Set());
		}
		groupedValues.get(groupByValue).add(targetValue);
	});

	// Convert to array and sort by distinct count (descending)
	const results = Array.from(groupedValues.entries())
		.map(([groupValue, valueSet]) => ({
			groupValue,
			distinctCount: valueSet.size
		}))
		.sort((a, b) => b.distinctCount - a.distinctCount);

	// Calculate total distinct count across all groups
	const totalDistinctValues = new Set();
	groupedValues.forEach(valueSet => {
		valueSet.forEach(value => totalDistinctValues.add(value));
	});
	const totalDistinctCount = totalDistinctValues.size;

	// Display results using the shared tabular results control.
	const resultsHost = document.getElementById('distinctCountResultsHost');
	if (!resultsHost || typeof displayResultForBox !== 'function') {
		return;
	}
	const analysisBoxId = (resultsHost && resultsHost.dataset && resultsHost.dataset.analysisBoxid)
		? String(resultsHost.dataset.analysisBoxid)
		: (String(boxId) + '_col_' + String(groupByColIdx) + '_distinct_count');
	const rows = results.map(r => {
		const percentage = totalDistinctCount ? ((r.distinctCount / totalDistinctCount) * 100).toFixed(2) : '0.00';
		return [escapeHtml(r.groupValue), String(r.distinctCount), percentage + '%'];
	});
	// Add total row
	rows.push(['<strong>Total</strong>', '<strong>' + String(totalDistinctCount) + '</strong>', '<strong>100.00%</strong>']);
	displayResultForBox({
		columns: [escapeHtml(groupByColumnName), 'Distinct ' + escapeHtml(targetColumnName), '%'],
		rows: rows,
		metadata: {}
	}, analysisBoxId, {
		label: 'Distinct Count',
		showExecutionTime: false,
		resultsDiv: resultsHost
	});
}

function closeColumnAnalysis(event) {
	if (event && event.target !== event.currentTarget) {
		return;
	}

	const modal = document.getElementById('columnAnalysisModal');
	modal.classList.remove('visible');
}
