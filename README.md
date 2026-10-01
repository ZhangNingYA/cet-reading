# CET Reading

英语四级、六级阅读精读服务。项目从 `tend` 独立出来，专注于试卷原文、逐句精读、按需 AI 生成和结果缓存。

## 项目目标

- 用户先阅读原文，主动点击后才生成精读。
- 每句话的结果独立缓存，后续访问直接读取数据库。
- 精读结果使用结构化 JSON，支持翻译、句型、语法结构和单词点击。
- CET4 和 CET6 共用一套数据模型，通过试卷元数据区分。
- 前端、API 和生成 Worker 可以在 Azure Ubuntu 服务器上使用 Docker 运行。

详细范围见 [项目目标](docs/PROJECT_GOAL.md) 和 [架构说明](docs/ARCHITECTURE.md)。

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

如果需要运行生成 Worker：

```bash
npm run dev:worker
```

默认开启 `AI_DRY_RUN=true`，Worker 会生成可验证的演示结果。接入真实模型时，填写 `.env` 中的 `AI_API_URL`、`AI_API_KEY` 和 `AI_MODEL`，并关闭 `AI_DRY_RUN`。

## 服务

- Web：Astro 静态前端，默认 `http://localhost:4321`
- API：Fastify，默认 `http://localhost:3000`
- 数据库：PostgreSQL，默认 `localhost:5432`
- Worker：从数据库任务表领取句子生成任务

也可以直接启动完整的 Docker 服务：

```bash
docker compose up --build
```

此时 Web 入口为 `http://localhost:8080`，它会通过同一入口代理 `/api` 到 API 服务。

## 当前边界

第一版先完成数据模型、缓存流程、任务状态和前端展示骨架。真实试卷导入、人工审核后台、登录和限流属于后续迭代。
