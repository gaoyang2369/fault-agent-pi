
---
name: diagnose-fault
description: >
  Diagnose recorded faults or abnormal operating behavior
  of registered G120 drives. Use for device fault analysis,
  shutdown investigation, or alarm investigation.
---

# 故障诊断工作流

## 目标

基于历史采集数据和设备知识库，识别已记录故障，
分析相关运行指标，形成有证据的辅助诊断结论。

## 执行步骤

1. 确定设备与时间范围。
   如果用户只询问故障码含义，直接调用 search_knowledge。

2. 对实际故障诊断，调用 query_data：
   - 首先查询 fault_code、alarm_code、status。
   - 明确数据覆盖范围、记录数及截断情况。
   - 不把无数据视为正常运行。

3. 提取故障码：
   - 排除确认无故障含义的占位值。
   - 保留实际出现的故障码和报警码。
   - 不猜测或修改无法识别的故障码。

4. 对故障码调用 search_knowledge：
   - 指定 device。
   - 核对产品系列、驱动对象与文档版本。
   - 未匹配时标记未知，不使用近似故障码替代。

5. 按需分析运行指标：
   - 选择与故障有关的指标。
   - 调用 query_data，再用 datasetId 调用 analyze_data。
   - 只使用已确认来源的阈值。
   - 区分全窗口统计和部分采样结果。

6. 对照现场观测与手册：
   - 列出支持证据。
   - 列出矛盾和缺失信息。
   - 区分已记录故障和推测根因。

7. 输出结果：
   - 设备和时间范围
   - 故障识别结果
   - 相关运行数据
   - 手册证据与来源
   - 可能原因及不确定性
   - 后续检查建议

## 禁止事项

- 不把故障码解释直接当作已验证根因。
- 不根据少量采样推断完整故障持续时间。
- 不把没有记录故障码解释为设备健康。
- 不编造阈值、指标、手册内容和数据。
- 不执行设备控制、复位或参数修改。
