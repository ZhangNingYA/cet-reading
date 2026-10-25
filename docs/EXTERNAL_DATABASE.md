# 外部 PostgreSQL

生产环境可以使用 Azure Database for PostgreSQL。服务器 `.env` 保留全部连接凭据，不将凭据写入镜像、发布清单或 Git。

```dotenv
CET_DATABASE_MODE=external
DATABASE_URL=postgresql://APP_USER:URL_ENCODED_PASSWORD@SERVER.postgres.database.azure.com:5432/cet_reading?sslmode=verify-full
```

密码和用户名中的特殊字符需要 URL 编码。应用连接验证服务器证书和主机名。Azure 必须允许应用服务器的网络连接，并在 `azure.extensions` 中允许项目使用的 `pgcrypto` 扩展。

`scripts/deploy-server.sh` 根据 `CET_DATABASE_MODE` 自动合并 `docker-compose.external-db.yml`，将同一个连接地址传给 API、Worker、News，并移除这三项服务对本地 PostgreSQL 的启动依赖。本地数据库服务归入 `local-database` profile；切换成功后停止容器，保留原始数据卷。

迁移和任务恢复使用退出即删除的 PostgreSQL 18 客户端容器。密码放入权限为 `0600` 的临时环境文件，执行后删除，不传入进程参数或发布日志。客户端使用系统 CA 和 `verify-full`。未来迁移至高于 18 的 PostgreSQL 时，需要同时升级客户端主版本。

手动调用外部模式 Compose：

```bash
docker compose --env-file .env --env-file .deployment/current.env \
  -f docker-compose.yml -f docker-compose.production.yml -f docker-compose.external-db.yml ps
```

## 首次迁移

1. 创建专用应用账号和空数据库，启用 `pgcrypto`，先导入到独立校验库演练。
2. 核对所有用户表的行数和内容摘要，并检查序列、约束、精读缓存与业务 API。
3. 停止 API、Worker 和 News，等待现有任务完成；完成最终备份并导入目标库。
4. 校验两边数据一致，保存原 `.env`，设置外部模式和新连接地址，再启动三个服务。
5. 验证 API、公开页面以及应用实际连接的服务器，最后停止本地 PostgreSQL；保留原卷和备份。

切换失败且尚未开放新库写入时，可以恢复原 `.env` 并启动原数据库及应用。切换成功并产生新写入后，原本地卷只是迁移时的快照；回迁必须先备份并同步远端最新数据，不能直接切回旧卷。

`CET_DATABASE_MODE=local` 保留原有 Compose 本地数据库流程。应用镜像回退与数据库迁移是两个操作；发布回退仍连接当前 `.env` 指定的数据库，不恢复旧数据。
