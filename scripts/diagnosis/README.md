# 独立故障事件查询

该入口只调用 `FaultEventService` 和 MySQL 仓储，不导入 Pi SDK、不创建 Agent 会话、不调用 LLM。根目录 `.env` 提供 `DCMA_DB_*` 数据库配置。

省略时间范围时，查询设备有数据的最新一小时：

```bash
npm run fault-events:query -- --device g120_01 --limit 5
```

指定窗口时，开始和结束时间必须同时给出，两端均包含：

```bash
npm run fault-events:query -- --device g120_02 \
  --start "2026-10-08 11:26:04" --end "2026-10-09 21:14:16" --limit 5
```

输出为有界的 JSON 摘要。`limit` 默认 20，上限 100；限制事件列表，不中断全窗口扫描。`eventCount` 为完整事件总数，`eventsTruncated` 表示返回列表被截断。事件句柄属于事件摘要，不能用于 `analyze_data` 的数值分析。

无需数据库的单元测试与类型检查：

```bash
npm run typecheck
npm test
```

真实 MySQL 只读验收，直接执行 Tool 和 CLI，不启动 Agent 会话：

```bash
TELEMETRY_TEST_MYSQL=1 node --env-file=.env --import tsx --test tests/query-fault-events.integration.test.ts
```
