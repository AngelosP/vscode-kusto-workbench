// Webview-friendly ECharts bundle entry.
// This is bundled by esbuild into an IIFE and exposed on window.echarts.

import * as echarts from 'echarts/core';

import { LineChart, BarChart, ScatterChart, PieChart, FunnelChart, SankeyChart, HeatmapChart } from 'echarts/charts';
import {
	DatasetComponent,
	GridComponent,
	LegendComponent,
	TitleComponent,
	TooltipComponent,
	ToolboxComponent,
	DataZoomComponent,
	VisualMapComponent
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// Register only what we need initially.
// (We can add more chart types/components later.)
echarts.use([
	LineChart,
	BarChart,
	ScatterChart,
	PieChart,
	FunnelChart,
	SankeyChart,
	HeatmapChart,
	DatasetComponent,
	GridComponent,
	LegendComponent,
	TitleComponent,
	TooltipComponent,
	ToolboxComponent,
	DataZoomComponent,
	VisualMapComponent,
	CanvasRenderer
]);

try {
	window.echarts = echarts;
} catch {
	// ignore
}
