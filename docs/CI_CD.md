# CI/CD

项目现在使用一条 GitHub Actions 流程完成：

```text
本地提交 → GitHub 检查 → Azure 自托管 Runner 部署 → 公开域名验证
```

## 触发规则

- Pull request：执行 `npm ci`、`npm run check`、`npm run build` 和 Compose 配置检查。
- `main` 分支 push：先完成同样的检查，再在 Azure 服务器更新 Compose 服务，最后从 GitHub runner 访问 `https://cet.fulafu.com/` 和 `/api/papers`。
- `workflow_dispatch`：可以在 Actions 页面手动运行；手动运行不会部署，只有 push 到 `main` 才会部署。

部署使用服务器上的自托管 runner，是因为当前 Azure 主机通过 Tailscale 地址访问，GitHub 托管 runner 无法直接 SSH 到这个地址。

## 服务器 Runner

Runner 以 `cyan` 用户运行，标签为 `cet-reading`，工作目录建议使用 `/home/cyan/actions-runner`。它必须能访问 Docker，并且 `/home/cyan/cet-reading/.env` 必须已经存在。`.env` 永远不提交到仓库。

在仓库 Settings → Actions → Runners 中确认 runner 状态为 **Idle** 后，推送 `main` 才会触发部署。

## 仓库配置

在 `production` environment 中设置变量：

```text
DEPLOY_URL=https://cet.fulafu.com
```

没有设置时 workflow 使用这个域名作为默认值。AI API 地址、模型和密钥只在服务器 `.env` 中设置，GitHub Actions 不读取也不保存 AI 密钥。

## 手动回滚

服务器上的部署脚本按 `origin/main` 更新代码。需要回滚时，在服务器执行：

```bash
cd /home/cyan/cet-reading
git checkout <known-good-commit>
docker compose up -d --build --remove-orphans --wait
```

下一次自动部署会恢复到 `main` 的最新提交。
