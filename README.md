# CET Reading

英语四级、六级和考研英语阅读服务。项目从 `tend` 独立出来，专注于试卷元数据、逐句精读、做题记录、按需 AI 生成和结果缓存。

## 项目目标

- 用户先阅读原文，主动点击后才生成精读。
- 每句话的结果独立缓存，后续访问直接读取数据库。
- 精读结果使用结构化 JSON，支持翻译、句型、语法结构和单词点击。
- 做题模式与精读模式分开；只有精读模式可以创建 AI 任务，客观题由 API 判分，主观题保存作答。
- CET4、CET6 和考研共用一套数据模型，通过试卷元数据区分。
- 当前只保留「四级试卷 01 · 技术与合作」一套原创模拟卷，包含完整非听力题量：1 道写作、10 道选词填空、10 道长篇阅读、两篇仔细阅读共 10 道题、1 道翻译。精读按试卷章节显示，也支持范文和参考译文。
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

修改 `data/papers/*.json` 后运行 `npm run seed:generate`，同步生成初始化与部署 SQL；自动检查会验证数据文件和 SQL 一致。

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

当前只提供一套四级原创模拟卷，可按完整非听力题量精读和做题；六级、考研分类暂为空。其余练习、演示数据和外部试卷记录已清理。人工审核后台、登录和限流属于后续迭代。
