function toggleColumnMenu(colIdx, boxId) {
	console.log('toggleColumnMenu called:', colIdx, boxId);

	// Close all other menus
	document.querySelectorAll('.column-menu').forEach(menu => {
		if (menu.id !== boxId + '_col_menu_' + colIdx) {
			menu.classList.remove('visible');
		}
	});

	// Toggle this menu
	const menuId = boxId + '_col_menu_' + colIdx;
	const menu = document.getElementById(menuId);
	console.log('Menu element:', menu, 'ID:', menuId);
	if (menu) {
		const isVisible = menu.classList.contains('visible');

		if (!isVisible) {
			// Position the menu using fixed positioning
			const button = menu.previousElementSibling;
			if (button) {
				const rect = button.getBoundingClientRect();
				menu.style.position = 'fixed';
				menu.style.top = (rect.bottom + 2) + 'px';
				menu.style.left = rect.left + 'px';
			}
		}

		menu.classList.toggle('visible');
		console.log('Menu classes after toggle:', menu.className);
	}
}

function showUniqueValues(colIdx, boxId) {
	const state = (typeof __kustoGetResultsState === 'function') ? __kustoGetResultsState(boxId) : null;
	if (!state) { return; }

	// Close menu
	toggleColumnMenu(colIdx, boxId);

	const columnName = state.columns[colIdx];
	const valueCounts = new Map();

	// Count occurrences of each value
	state.rows.forEach(row => {
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

	const totalRows = state.rows.length;

	// Convert to array and sort by count (descending)
	const sortedValues = Array.from(valueCounts.entries())
		.sort((a, b) => b[1] - a[1]);

	// Display in modal
	const modal = document.getElementById('columnAnalysisModal');
	const title = document.getElementById('columnAnalysisTitle');
	const body = document.getElementById('columnAnalysisBody');

	title.textContent = 'Unique Values - ' + columnName;

	let html = '<table class="column-analysis-table">';
	html += '<thead><tr><th>Value</th><th>Count</th><th>%</th></tr></thead>';
	html += '<tbody>';

	sortedValues.forEach(([value, count]) => {
		const percentage = ((count / totalRows) * 100).toFixed(2);
		html += '<tr><td>' + escapeHtml(value) + '</td><td>' + count + '</td><td>' + percentage + '%</td></tr>';
	});

	html += '</tbody></table>';
	html += '<div style="margin-top: 24px;">';
	html += '<canvas id="uniqueValuesPieChart" style="width: 100%; height: 400px;"></canvas>';
	html += '</div>';

	body.innerHTML = html;
	modal.classList.add('visible');

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

	const columnName = state.columns[colIdx];
	const modal = document.getElementById('columnAnalysisModal');
	const title = document.getElementById('columnAnalysisTitle');
	const body = document.getElementById('columnAnalysisBody');

	title.textContent = 'Distinct Count - ' + columnName;

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
	html += '<div id="distinctCountResults"></div>';

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

	state.rows.forEach(row => {
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

	// Display results
	const resultsDiv = document.getElementById('distinctCountResults');

	let html = '<table class="column-analysis-table">';
	html += '<thead><tr><th>' + escapeHtml(groupByColumnName) + '</th><th>Distinct ' + escapeHtml(targetColumnName) + '</th><th>%</th></tr></thead>';
	html += '<tbody>';

	results.forEach(result => {
		const percentage = ((result.distinctCount / totalDistinctCount) * 100).toFixed(2);
		html += '<tr><td>' + escapeHtml(result.groupValue) + '</td><td>' + result.distinctCount + '</td><td>' + percentage + '%</td></tr>';
	});

	// Add total row
	html += '<tr class="total-row"><td><strong>Total</strong></td><td><strong>' + totalDistinctCount + '</strong></td><td><strong>100.00%</strong></td></tr>';
	html += '</tbody></table>';

	resultsDiv.innerHTML = html;
}

function closeColumnAnalysis(event) {
	if (event && event.target !== event.currentTarget) {
		return;
	}

	const modal = document.getElementById('columnAnalysisModal');
	modal.classList.remove('visible');
}

// Close column menus when clicking outside

document.addEventListener('click', (event) => {
	if (!event.target.closest('.column-menu-btn')) {
		document.querySelectorAll('.column-menu').forEach(menu => {
			menu.classList.remove('visible');
		});
	}
});
