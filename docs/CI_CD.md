# CI/CD

```text
本地提交 → GitHub 检查 → GitHub 并行构建/测试三种镜像 → Azure 拉取并更新 → 公开站点验证
```

## 触发和镜像

- Pull request、手动 `workflow_dispatch`：执行依赖安装、完整检查、构建和 Compose 配置检查，不部署。
- `main` push：检查通过后，在 GitHub 托管 runner 并行构建 API、Worker、Web 三个镜像，并执行生产镜像启动/依赖检查。
- 镜像发布到 `ghcr.io/<小写 owner>/<小写 repo>/{api,worker,web}:<完整提交 SHA>`。News 与 Worker 使用同一个 Worker 镜像，仅启动命令不同。
- 部署通过本次运行的 artifact 获取每个镜像的不可变 digest，校验仓库、服务名和提交，再按 digest 拉取，不使用浮动 `latest` 部署。
- Docker 构建层按服务分别缓存在 GitHub Actions 中；npm 下载缓存通过 BuildKit cache mount 与 Actions cache 保留。安装使用锁文件和 `npm ci`。
- API、Worker 使用多阶段构建，最终镜像只包含对应服务、共享 contracts 的编译结果和生产依赖。Web 最终镜像仍只包含 Caddy 和静态文件。

镜像使用 OCI source 标签关联本仓库。构建 job 的 `GITHUB_TOKEN` 只有该 job 获得 `packages: write`；服务器部署 job 使用短期 `packages: read` 权限拉取，Docker 凭据位于临时目录，阶段结束即删除。无需在服务器保存新的长期镜像仓库密钥。首次发布的包默认保持仓库平台的私有设置，不主动修改可见性。

## Azure 部署

自托管 runner 标签为 `cet-reading`，部署目录 `/home/cyan/cet-reading`，必须保留服务器 `.env`。AI 密钥只由服务器容器读取，不传入 GitHub 镜像构建或构建产物。

部署分为四个可见步骤，每步报告耗时；准备和拉取阶段还记录 CPU 数量、负载、内存、磁盘空间和容器资源使用情况：

1. **准备发布**：保存旧镜像信息、切换到经过检查的确切提交、生成更新计划。
2. **拉取镜像**：下载三个经过测试的镜像，Worker/News 只下载一次；这一步不停止现有服务。
3. **应用更新**：比较上一版与本次 digest，仅更新变化的服务。前端单独变化时保留 API、Worker、News；相同镜像不重启。数据库/试卷来源变化或首次切换时执行迁移和必要的种子导入；后台镜像变化时先停止两个任务生产者，再恢复被中断的任务。
4. **验证并记录**：验证容器、首页和试卷接口，成功后原子更新 `.deployment/current.env`。更新或健康检查失败时恢复上一版应用镜像，保留数据库内容，不反向执行数据库迁移。

`.deployment/` 不提交、不进入 Docker 镜像。其中保存当前发布、上一版不同镜像的发布（`previous.env`）、本次更新的回退快照和更新计划，均不含 AI 密钥。首次迁移从现有容器记录本地 image ID，保障切换到新流程时仍可回退。

`main` 的部署串行执行，新提交不会取消正在进行的服务切换。检查、镜像构建、服务器部署和公开验证分别设有超时，失败时保留具体步骤和日志。

## 配置与回退

数据库默认使用本地 Compose PostgreSQL。使用 Azure 等外部 PostgreSQL 时，在服务器 `.env` 设置 `CET_DATABASE_MODE=external` 和带 `sslmode=verify-full` 的 `DATABASE_URL`；部署自动使用外部数据库执行迁移，并在验证成功后停止本地数据库容器。完整流程见 [外部数据库](EXTERNAL_DATABASE.md)。

GitHub `production` environment 的 `DEPLOY_URL` 默认 `https://cet.fulafu.com`。仓库需要允许 workflow 使用 GitHub Container Registry；构建和部署通过工作流临时 token 访问关联本仓库的镜像包。

手动恢复上一版应用镜像：

```bash
cd /home/cyan/cet-reading
bash scripts/deploy-server.sh /home/cyan/cet-reading rollback "$(git rev-parse HEAD)" force
```

此操作恢复上一版不同镜像的发布，重复部署同一组镜像不会覆盖这份记录；只使用本机已经保留的镜像，不还原数据库。下一次成功的 `main` 部署会记录新的当前发布。服务器不再执行镜像构建；本地开发仍可用 `docker compose up -d --build`，若单独启动 News，首次先执行 `docker compose build worker`。

## 首次实测

[2026-10-19 新流程首次部署](https://github.com/ZhangNingYA/cet-reading/actions/runs/39209672020)：三个并行镜像任务各耗时 49–59 秒。服务器准备、拉取、更新和本机验证分别为 24、45、120、35 秒；首次切换包含数据库兼容检查和后台服务更新。

同一台服务器以 `docker image inspect` 统计，API 镜像从约 181 MB 降至 82 MB，Worker 从约 181 MB 降至 83 MB，约减少 55%；News 复用 Worker 镜像。页面跨年份导航、快捷键和真实 AI 问答均已通过公开站点浏览器验证。
