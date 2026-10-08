# 架构说明

```text
Browser
   |
   v
Astro Web  ---- HTTPS /api ---->  Fastify API
                                  |       |
                                  v       v
                            PostgreSQL  AI Worker
```

## 数据边界

- `papers` 保存 CET4/CET6/考研试卷和版本元数据；用户提供的试卷通过 `content_kind=imported` 标记，原创练习使用 `original`，外部记录只保留 `source_url`。
- `paper_sections` 保存阅读、完形、匹配、翻译和写作等非听力板块。
- `questions` 保存做题模式题目；`practice_attempts` 保存答题快照、答案和提交结果。
- `sentences` 保存可复用的原文句子和顺序。
- `sentence_analyses` 保存某句在特定原文、提示词和模型版本下的结果。
- `analysis_jobs` 保存待处理、进行中、成功和失败的任务；只有待处理和进行中的相同缓存键任务共用一条记录，每次重新生成保留独立的历史任务。
- AI 结果以 JSONB 保存；前端根据 JSON 渲染界面，不保存 HTML。

## 缓存键

```text
sentence_id + source_hash + context_hash + prompt_version + model + mode
```

原文、提示词或模型改变时生成新版本，旧结果仍然可追溯。外部试卷不进入精读或做题接口，用户通过原站链接查看内容。

重点词汇使用 `vocabulary` 数组，项目包含 `kind`（`word` / `phrase`）、`expression`、语境含义 `meaning`、简短用法 `usage` 和原文 token 范围 `ranges`。多个范围可以表达 `attribute … to …` 这类被其他成分隔开的搭配。Worker 校验范围、单词数量和顺序后才保存结果。

当前提示词版本在环境配置的 `PROMPT_VERSION` 后追加 `-vocabulary-v1-grammar-v2`。查询优先读取新版本，也可复用 `-vocabulary-v1` 及原版本的有效缓存；每条候选结果都必须通过原文 token、语法和词汇校验。包含“句子主要成分”“句子主干”等占位解释、空语法数组或错误范围的缓存会被跳过，旧记录保留用于追溯；没有有效缓存时按需生成。

`grammar.clauses` 和 `grammar.components` 都必须非空，简单句也应解释主句。解释应引用具体英文，说明成分作用、中心词和主从关系。AI 漏填或返回无效结果时，Worker 最多提交一次带校验错误的修正请求；两次请求共用原来的超时期限。修正后仍不合格则标记任务失败，不填充通用说明，也不保存为成功结果。

AI 首次生成和最多一次校正共用最多 180 秒的期限（`AI_REQUEST_TIMEOUT_MS=180000`），任务租约默认 210 秒，始终需要比生成上限多至少 15 秒。前端最多轮询 10 分钟以容纳连续点击多句时的排队时间，并区分排队与生成状态。失败原因在数据库中保留；任务接口只返回 `errorCode`，前端据此显示超时、服务不可用或结果校验失败。Worker 失败日志记录任务 ID、错误类别、耗时及超时发生在第几次模型请求。

`POST /api/sentences/:id/analyze?mode=intensive&regenerate=true` 跳过缓存并创建或复用正在进行的任务。普通请求继续读取已有缓存，重新生成失败不删除旧结果；Worker 以领取次数核对任务所有权，过期后被其他 Worker 接管的旧请求不能覆盖新结果。

## 部署

Azure Ubuntu 服务器运行 Docker Compose。生产环境使用 HTTPS，PostgreSQL 不开放公网端口；GitHub 用于代码托管和部署流水线。

部署先构建镜像，再停止 API 和 Worker、应用数据库迁移，最后启动新版服务，确保任务索引与代码同步更新。
