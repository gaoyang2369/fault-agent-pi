import type { DataService } from "../services/data-service.ts";
import type { AnalysisService } from "../services/analysis-service.ts";
import { createAnalyzeDataTool } from "./analyze-data.ts";
import { createQueryDataTool } from "./query-data.ts";

/**
 * 构造全部自定义工具。
 *
 * 新增工具只改这里。注意 SDK 有两份清单：`customTools` 负责注册，`tools` 是允许列表，
 * 且**未出现在允许列表里的自定义工具会被静默过滤掉、不报任何错**。所以 agent.ts 里
 * 的工具名一律从本函数的返回值推导，不手写，避免漏登记。
 */
export function createCustomTools(dataService: DataService, analysisService: AnalysisService) {
	return [createQueryDataTool(dataService), createAnalyzeDataTool(analysisService)];
}
