// Webview-friendly ECharts bundle entry.
// This is bundled by esbuild into an IIFE and exposed on window.echarts.

import * as echarts from 'echarts/core';

import { LineChart, BarChart, ScatterChart, PieChart } from 'echarts/charts';
import {
	DatasetComponent,
	GridComponent,
	LegendComponent,
	TitleComponent,
	TooltipComponent,
	ToolboxComponent
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// Register only what we need initially.
// (We can add more chart types/components later.)
echarts.use([
	LineChart,
	BarChart,
	ScatterChart,
	PieChart,
	DatasetComponent,
	GridComponent,
	LegendComponent,
	TitleComponent,
	TooltipComponent,
	ToolboxComponent,
	CanvasRenderer
]);

try {
	window.echarts = echarts;
} catch {
	// ignore
}
