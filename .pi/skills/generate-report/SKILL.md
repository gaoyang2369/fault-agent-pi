
---
name: generate-report
description: >
  Generate a historical operation report for a registered
  G120 motor or drive, including operating statistics,
  fault records, evidence and maintenance recommendations.
---

# 设备运行报告生成

## 任务要求

基于真实查询结果生成结构化运行报告。

## 工作流程

1. 确认设备、统计时间范围和报告类型。
2. 使用 query_data 查询所需运行指标。
3. 使用 analyze_data 获取适用的统计分析结果。
4. 查询故障码、报警码和运行状态。
5. 如存在有效故障或用户要求故障分析，
   按 diagnose-fault 的诊断规范执行。
6. 将事实、分析结论和局限整理为 Markdown 报告。

## 报告章节

1. 设备与统计周期
2. 运行情况概述
3. 主要运行指标
4. 故障和报警情况
5. 故障分析与手册证据
6. 总体结论与维护建议
7. 数据质量、数据来源和局限

## 质量要求

- 每项数值必须来自查询或分析结果。
- 保留统计周期、单位和统计口径。
- 不能把局部采样结果写成全周期结论。
- 没有故障记录不代表设备不存在故障。
- 不可凭空推算运行时长或故障持续时长。
- 未获取的指标写明“未获取”，不得补造。
- 不将推测原因表达为已验证根因。

## 输出方式

默认在对话中输出 Markdown 报告。
只有存在明确的文件导出能力并且用户要求时，
才使用相应工具导出报告。
