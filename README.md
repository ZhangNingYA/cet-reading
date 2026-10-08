# CET Reading

英语四级、六级和考研英语阅读服务。项目从 `tend` 独立出来，专注于试卷元数据、逐句精读、做题记录、按需 AI 生成和结果缓存。

## 项目目标

- 用户先阅读原文，主动点击后才生成精读。
- 每句话的结果独立缓存，后续访问直接读取数据库。
- 精读结果使用结构化 JSON，支持翻译、句型、语法结构、重点单词与词组，以及原文点击高亮。
- 精读面板可重新生成当前句子；新结果校验成功后更新缓存，失败保留旧结果。旧缓存仍可查看，通过重新生成补充重点词汇。
- 做题模式与精读模式分开；只有精读模式可以创建 AI 任务，客观题由 API 判分，主观题保存作答。
- CET4、CET6 和考研共用一套数据模型，通过试卷元数据区分。
- 当前已导入 70 套用户提供的真实试卷（四级 24 套、六级 42 套、考研 4 套），可精读和做题。原文、题目、选项和原题图表依据本地 PDF 核对，保留全部非听力内容；重复阅读章节按原件说明显示提示和对应入口。目录与内容说明见 [试卷数据说明](data/README.md)。
- 有随卷答案时逐题核对；没有答案页时，客观题参考答案依据原文整理，提交后明确标为非官方参考答案；写作与翻译保存作答供自行核对。精读中的选词填空按参考答案补全，原题空格仍保留在做题模式。
- 前端、API 和生成 Worker 可以在 Azure Ubuntu 服务器上使用 Docker 运行。

详细范围见 [项目目标](docs/PROJECT_GOAL.md) 和 [架构说明](docs/ARCHITECTURE.md)。

## 新增试卷

把手动下载的 PDF 放入 `data/inbox/`，告诉 Codex“处理新增试卷”即可。执行者按照 [试卷导入流程](docs/PAPER_IMPORT_WORKFLOW.md) 完成分类、原件归档、非听力内容校对、数据库新增、检查和上线验证；项目 [AGENTS.md](AGENTS.md) 会引导后续执行者读取该规范。

## 本地启动

需要 Node.js 22+、Docker 和 Docker Compose。

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run dev:api
```

另开终端启动前端：

```bash
npm run dev:web
```

修改 `data/papers/<考试>/<年月>/*.json` 后运行 `npm run seed:generate`，同步生成初始化与部署 SQL；脚本递归读取子目录，自动检查会验证数据文件和 SQL 一致。已有数据库也需要应用 `db/migrations/009_seed_papers.sql`；生产部署会自动执行。

如果需要运行生成 Worker：

```bash
npm run dev:worker
```

默认开启 `AI_DRY_RUN=true`，Worker 会生成可验证的演示结果。接入真实模型时，填写 `.env` 中的 `AI_API_URL`、`AI_API_KEY` 和 `AI_MODEL`，并关闭 `AI_DRY_RUN`。

## 服务

- Web：Astro 静态前端，Docker 入口默认 `http://localhost:8081`；开发服务器默认 `http://localhost:4321`
- API：Fastify，默认 `http://localhost:3000`
- 数据库：PostgreSQL，默认 `localhost:5432`
- Worker：从数据库任务表领取句子生成任务

也可以直接启动完整的 Docker 服务：

```bash
docker compose up --build
```

此时 Web 入口为 `http://localhost:8081`，它会通过同一入口代理 `/api` 到 API 服务。

## 自动检查和部署

项目的 GitHub Actions 会在 Pull request 中执行检查和构建；推送到 `main` 后，会先通过检查，再由 Azure 服务器上的自托管 runner 更新 Docker Compose 服务，最后验证公开站点和 API。配置和服务器 runner 说明见 [CI/CD 文档](docs/CI_CD.md)。

## 当前边界

当前提供 70 套用户上传的四级、六级及考研真题，均可精读和做题。先前的模拟卷、演示数据和外部试卷记录已清理。人工审核后台、登录和限流属于后续迭代。
