# News 采集与阅读

News 使用独立文章表和独立采集进程。试卷、做题记录及已有精读缓存保留原有 ID、数据和调用方式。

前端按采集日期归档（例如 `26/10/9`），日期下面固定显示 08:00、11:00、14:00、17:00 四组，每组目标三篇；尚未到点显示「待更新」。文章的真实发布日期单独保留。

北京时间（Asia/Shanghai）每日 08:00、11:00、14:00、17:00，每轮目标 3 篇：1 篇编辑规则优先选择的阅读材料（首选 360info），2 篇 AI 选取的时效热点。候选来源为 360info、Global Voices、EFF、Futurity、SciDev.Net、NASA 的官方 RSS。AI 通过服务器提供的 `read_article` 和 `search_news` 工具读取真实正文、搜索 Google News RSS 的媒体报道，再按难度和事件证据选取。来源不足时保存实际数量和原因，不用旧闻或模型创作凑数。**12 篇是目标，不是来源供给保证。**

每次读取来源政策并核验原站正文，跳过特殊限制及授权不明的转载稿。360info、Global Voices、EFF 使用政策中的 CC BY 链接；Futurity 同时核验 [转载政策](https://www.futurity.org/about/#republishing)及每篇原站的 Attribution 4.0 International 声明；SciDev.Net 使用 [CC BY 2.0 转载政策](https://www.scidev.net/global/content/media.html)，其 RSS 仅含摘要时，读取原站完整正文。NASA 单独使用 [教育/信息用途许可](https://www.nasa.gov/nasa-brand-center/images-and-media/)，明确标为 `NASA educational use`，不伪标 CC BY；仅从 www.nasa.gov、science.nasa.gov 官方正文提取文字，跳过第三方限制，不复制图片、标志或暗示 NASA 背书。

保留标题、署名、来源、原文与许可链接。正文保留文字（普通链接转为文字），不引入图片和视频。精读是用户点击后的独立 AI 辅助说明，并非来源提供的译文。Global Voices 的作者、原文链接署名置于正文前。

热点优先 24 小时，最大 48 小时，实际事件/新进展也必须在前 48 小时，热度依据至少两家不同媒体的同事件报道，证据真实 ID/URL/时间留档。NASA 公告、大学及 EurekAlert 新闻稿只作事实参考，不计入独立媒体数量；Space.com/Live Science 等已知同集团网站合并计数。AI 判断相关性及难度，服务器验证时间、来源、完整正文读取、证据 ID、配额及重复内容；这些规则无法完全代替人工编辑，可检查批次审计。

## 操作

服务器 `.env` 使用现有 `AI_API_URL`、`AI_API_KEY`，`NEWS_MODEL` 为空时沿用 `AI_MODEL`。句子分析模型不受 News 配置影响。新增：

```dotenv
NEWS_ENABLED=true
NEWS_MODEL=
NEWS_MAX_ROUNDS=10
```

首次补跑使用服务器命令，不开放公网采集接口：

```sh
docker compose run --rm --no-deps news node apps/worker/dist/news-service.js --slot 2026-10-09/8
docker compose up -d --no-deps --force-recreate news
docker compose logs --tail 80 news
```

`--slot YYYY-MM-DD/8`（也支持 11/14/17）按该时间点前已发表的候选补跑，真实生成时间单独保留。同一批次完成/不足后不会重复生成，失败最多重试 3 次。数据库 advisory lock 防止多个实例同时选取；事务同时保存文章、切句及批次结果。文章 URL/正文哈希去重，近 180 篇事件去重；保留快照，不自动覆写已缓存的原文。

人工复核不足批次后，可在同一命令后追加 `--supplement` 重新检索缺少的类别；只新增缺额，保留已发表原文、ID、缓存及此前审计，不自动对不足批次重复调用模型。自动失败最多尝试 3 次；服务器端显式人工补齐允许再次执行，不因以前的自动次数永久封锁缺额，完成的批次仍不可重复执行。

启用后每 15 秒检查北京时间当日到点批次；服务重启会补跑当日漏过的时段。失败重试间隔 2 分钟，单次 AI 选择上限 12 分钟；网络读取限制时间、大小和来源域名。不补跑以前日期，历史补跑需显式命令。采集进程与精读 Worker 分离，避免占用分析任务队列。

## 数据与接口

- `news_batches`：时段、状态、重试数、原因、真实开始/完成时间、模型及工具检索审计。
- `news_articles`：完整段落、原站/许可、日期/难度/字数/话题、事件及热点证据、选取理由、正文哈希。
- `sentences.article_id`：与试卷句子互斥的归属，复用既有 `sentence_analyses` / `analysis_jobs` 缓存和质量校验。
- `GET /api/news` / `?before=ISO时间`：文章摘要与批次状态分页。
- `GET /api/news/:id`：原文、出处和对应稳定句子 ID。
- `GET /api/news/:id/analyses?mode=intensive`：只读取已有缓存。
- `POST /api/sentences/:id/analyze?mode=intensive`：点击后生成；`regenerate=true` 手动重新生成。

采集和文章打开期间不生成词义、翻译、语法或句型。News 无做题模式。

实际选择提示词保存在 `packages/contracts/src/news.ts` 的 `NEWS_SELECTOR_PROMPT`。工具调用遵循 [OpenAI function calling 文档](https://developers.openai.com/api/docs/guides/function-calling)，当前 CPA 已验证支持 Chat Completions 的函数工具调用。
