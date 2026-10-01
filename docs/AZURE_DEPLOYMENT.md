# Azure 部署

Ubuntu 22 服务器上只需要运行 Docker Compose。生产环境建议把域名解析到服务器，并让 Caddy 在宿主机或 Web 容器中负责 HTTPS。

```bash
git clone <your-repository-url> cet-reading
cd cet-reading
cp .env.example .env
# 填入 AI_API_URL、AI_API_KEY 和 AI_MODEL
docker compose up -d --build
```

安全边界：

- Azure NSG 和 UFW 只开放 SSH、HTTP、HTTPS。
- PostgreSQL 只绑定服务器本机地址，不开放 `5432` 到公网。
- AI 密钥只放在服务器环境变量中，不提交到 Git。
- 为 PostgreSQL 数据卷设置定期备份。
- API 必须增加限流和认证后再开放给公众使用。

Compose 中的 `web` 服务同时提供静态页面和 `/api` 反向代理。以后接入正式域名时，把 `apps/web/Caddyfile` 中的 `:80` 换成域名即可由 Caddy 管理 HTTPS。

