# 知识库脚本

这里负责知识建设。Agent 的 `search_knowledge` 只读查询，依赖方向为 `tools → KnowledgeService → KnowledgeRepository / KnowledgeVectorRepository`。

当前是单项目、静态文档，因此用 JSON 快照保存文档元数据、完整条目及分块，没有额外创建 MySQL 表。Qdrant 保存 dense 向量，BM25 在查询端建立内存倒排索引，两路结果通过 RRF 融合。以后迁移到后端时，先迁移此目录的入库流程，再替换只读 Repository；工具接口不需要暴露存储实现。

## 先运行精确查询

要求 Node.js 22 和 Poppler 的 `pdftotext`。Ubuntu/Debian 可安装 `poppler-utils`。当前 PDF 有可提取文本层，无需安装 OCR、Docling 或 Python 模型。

在项目根目录运行（没有 `.env` 时先从 `.env.example` 复制）：

```bash
npm install
npm run knowledge:build
npm run knowledge:search -- "A01009 原因和处理方法" --device g120_01
npm start -- "电机1的 A01009 是什么意思？引用手册页码。"
```

首条查询不需要采集数据库、Qdrant 或 embedding 服务。未构建快照时 Agent 仍能启动，只有知识查询失败并提示入库命令。

`search_knowledge` 是工具的正式名称。正文包含证据 ID、来源文件、版本、PDF 页码（从 1 开始）、印刷页码和原文；`details` 保留结构化引用信息。

## 启用真实混合检索

本地示例采用 Qdrant + Ollama 的 BGE-M3 dense embedding。CPU 可以运行，首次下载模型及完整向量入库可能需要较长时间。Ollama 的 BGE-M3 接口只返回 dense 向量，本实现的词法路是 BM25，不是 BGE-M3 sparse。

Compose 默认使用官方 Ollama 镜像。只用 CPU 时，可以在项目 `.env` 中设置 `KNOWLEDGE_OLLAMA_IMAGE=alpine/ollama:0.12.3`，使用 [alpine-docker 维护的 CPU 镜像](https://github.com/alpine-docker/ollama)，减少 GPU 运行库下载；这是社区构建，不是 Ollama 官方镜像。

```bash
docker compose --env-file .env -p pi-learning-knowledge -f scripts/knowledge/compose.yaml up -d
docker compose --env-file .env -p pi-learning-knowledge -f scripts/knowledge/compose.yaml exec embedding ollama pull bge-m3
```

在 `.env` 中添加配置；也可通过环境变量注入：

```dotenv
KNOWLEDGE_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
KNOWLEDGE_EMBEDDING_MODEL=bge-m3
KNOWLEDGE_QDRANT_URL=http://127.0.0.1:6333
```

也可以使用 [GPUStack 发布的 BGE-M3 Q4_K_M GGUF](https://huggingface.co/gpustack/bge-m3-GGUF)，减少本地下载和内存需求。本次工作区的 CPU 验证使用此版本，配置中的模型名为 `hf.co/gpustack/bge-m3-GGUF:Q4_K_M`，模型来源和精度应纳入后续召回评测：

```bash
docker compose --env-file .env -p pi-learning-knowledge -f scripts/knowledge/compose.yaml exec embedding ollama pull hf.co/gpustack/bge-m3-GGUF:Q4_K_M
```

使用它时将 `KNOWLEDGE_EMBEDDING_MODEL` 改为上述完整模型名；保持入库和查询端一致。

然后构建并查询：

```bash
npm run knowledge:build -- --vectors
npm run knowledge:search -- "控制单元发热，风扇或通风可能有问题" --device g120_01
```

查询返回 `retrievalMode: hybrid` 表示完成 BM25 + dense + RRF；语义服务失败时明确报告 `lexical` 降级。故障码查询独立返回 `exact`，不依赖语义服务，也不会用相近故障码替代未知码。查码结果出现 `needs_context` 时，应根据候选驱动对象继续缩小范围，例如：

```bash
npm run knowledge:search -- "F01040" --device g120_01 --drive-object VECTOR
```

其他 embedding 服务只要支持 `POST <baseUrl>/embeddings`、`input: string[]` 和带 `index` 的 float embedding 响应，即可通过三个 `KNOWLEDGE_EMBEDDING_*` 变量配置。远程服务使用独立 API key，不会复用 pi 的聊天模型凭证。更换模型须重建向量索引。

本地数据放在 `scripts/knowledge/.data/`，已忽略版本管理。停止服务：

```bash
docker compose --env-file .env -p pi-learning-knowledge -f scripts/knowledge/compose.yaml down
```

## 添加、更新和删除知识

`knowledge/sources.json` 是发布清单。字段区分原文的 `declaredProducts` 与维护者确认的 `applicableProducts`，当前 G120 适用关系来自项目维护者的确认。每个文档 ID 必须唯一；组件、固件或驱动对象不能从产品名称猜测。

- 添加：登记新的来源。此手册格式的文本 PDF 使用 `fault_manual`；其他指南、案例、FAQ 首版支持 Markdown。
- 更新：修改原文件和版本信息，然后重新构建。
- 删除：从发布清单移除对应来源，然后重新构建。移除整个知识库时删除快照，查询会明确报告尚未构建。

每次全量构建都只发布清单里的来源。需要保持语义检索时使用 `--vectors`；不加该参数会发布仅含精确/BM25 的快照。可通过 `--sources <清单文件>`、`--output <快照文件>` 制作独立知识库。

流程：解析 → 提取字段/拼接跨页条目 → 切分 → 可选 embedding/Qdrant → 校验 → 原子替换快照。失败不会覆盖旧快照。向量构建使用新 collection，完整写入并校验数量后才发布其名称；正常失败会清理未发布 collection。以前的已发布 collection 留作回滚，用 Qdrant 管理界面清理时应避开当前快照引用的 collection。

原始文档与来源清单要随部署保留，生成快照不提交版本库。源文件路径是相对项目根目录的引用；后端可将其映射为文档查看链接。快照存储路径可通过 `KNOWLEDGE_SNAPSHOT_PATH` 调整。

## 当前解析和检索范围

- PDF 解析适配 Siemens `4.2 故障和报警列表` 的文本版面，识别主码和明确的类别切换码，去除页眉页脚并拼接跨页内容。缺少原因或处理会中止发布。扫描件与其他 PDF 版式须增加解析适配器，不能静默当成成功入库。
- 同故障码可有多个驱动对象变体，分别保存。已知 `driveObject` 时进行过滤；未确定时返回候选，不合并处理方法。
- 短条目整体作为一块；长条目按行拆分，正文每块最多约 1,200 字符，另附标题上下文，不跨故障码合并。这是字符上限，不是 tokenizer token 数；BGE-M3 的上下文足够容纳这些块。
- BM25 使用 ICU 分词、相邻汉字特征及少量问句停用词；标题单独评分并以 2 倍权重加入正文分数，避免“控制单元”被其他部件的泛化风扇检查淹没。BM25 与 dense 各召回 40 块，RRF 后按父条目去重，默认返回 5 条。这些是当前语料的初始参数，新增文档后需继续评测。
- 返回正文有总预算，长条目明确标为节选，优先保留命中片段、原因和处理；需按来源页码核对完整条件。
- 首版不加入 reranker、查询重写、自动根因概率或多租户系统。现象检索返回 `status: candidates`，由 Agent 核对相关性；相似候选不等于适用证据，也不代表证实现场根因。采集指标与手册参数的映射、未知固件适用性仍由设备业务确认。

## 验证

```bash
npm run typecheck
npm test
```

测试覆盖跨页、类别码、同码多版本、产品过滤、未知码、缓存更新、取消、降级和 embedding 响应校验。真实 Qdrant 集成测试使用独立 fixture 和模拟 embedding 协议，验证写入、过滤、写入成功但响应丢失后的安全重试和发布失败恢复；提供测试服务地址才启用，不会修改正式知识库：

```bash
KNOWLEDGE_TEST_QDRANT_URL=http://127.0.0.1:6333 npm test
```

设计参考：[Poppler pdftotext](https://manpages.debian.org/bookworm/poppler-utils/pdftotext.1.en.html)、[Qdrant 查询 API](https://api.qdrant.tech/api-reference/search/query-points)、[BGE-M3](https://huggingface.co/BAAI/bge-m3)、[Ollama embedding 协议](https://docs.ollama.com/api/openai-compatibility)。
