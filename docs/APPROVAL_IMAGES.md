# 审批图片

头像、申请照片和执行结果照片使用 Azure Blob 私有容器。PostgreSQL 保存文件标识、尺寸、上传者、用途和审批关系，不再写入新的头像二进制。旧头像读取接口保留兼容；旧客户端的 avatarBase64 更新也转存 Blob。

## 配置和部署

服务器 `.env` 配置 `AZURE_STORAGE_CONNECTION_STRING`、`AZURE_STORAGE_CONTAINER=images`。连接字符串只在服务器运行时读取，不能写入小程序或 Git。容器应预先创建并保持私有。Compose 的 env_file 在 API 更新时载入配置。

部署按顺序运行 028 到 033 迁移。031 创建临时文件记录，给头像增加文件关联，并给附件表增加文件关联、缩略图和排序字段；迁移可重复运行。API 镜像先安装生产依赖，再从相同平台的构建阶段复制 sharp 的 `@img` 原生模块，保留图片处理所需二进制并排除工作区的可选开发依赖。

## 上传与提交

- `POST /api/approval/media?purpose=avatar|application|result`：Bearer 登录，multipart 单文件字段 `image`，上传上限 2 MiB。返回 `{media: {id,width,height,byteSize}}`。
- 服务端解码 JPG/PNG/WebP，限制 2000 万像素，修正方向、去除元数据并输出 JPEG。头像最大 512 方图、256 KiB；普通照片长边最大 1920、2 MiB。每张图片生成最长边 320 的缩略图。API 同时只处理一张图片，繁忙时返回 429，客户端可单张重试。
- `PATCH /api/approval/me` 接收 `displayName` 和可选 `avatarMediaId`。上传不会直接替换头像，保存资料后才绑定。
- 创建审批或补充材料接收可选 `photoIds`，每次最多 9 个；图片通过 eventId 关联到对应批次，旧材料保留。
- 提交执行结果接收 `resultBody` 和可选 `photoIds`，独立最多 9 个；文字或照片至少有一项。
- 每次提交在同一事务中校验上传者、用途和临时状态，再写入审批附件并标记文件已绑定。重复、越权、跨用途或已经提交的文件均拒绝。
- `DELETE /api/approval/media/:id` 仅允许上传者删除未提交文件。已提交的文件不能通过该接口删除。

## 展示和清理

审批详情返回 `photos`，包含申请/结果阶段、完整图和缩略图 URL。列表及首页返回 `photoCount` 和 `thumbnailUrl`。图片链接使用现有 API 域名，有效期 15 分钟，每次读取还会检查签名、用户状态及审批参与关系。小程序图片组件无需携带 Authorization；头像继续通过公开头像接口展示。私有图片路由关闭请求日志，避免记录签名 URL。

API 启动后及每小时清理超过 24 小时的未提交文件、未使用的旧头像及上次删除失败的文件；清理使用锁，避免与提交竞争。删除仅使用数据库中的文件键，不接收客户端指定的任意 Blob 路径。

## 验证

`TEST_DATABASE_URL=postgres://.../approval_media_test_name node --import tsx scripts/test-approval-media.mjs` 使用独立数据库和内存 Blob，覆盖图片处理、九张限制、原子绑定、权限、照片结果和清理。运行前应准备独立 PostgreSQL 测试库。

`scripts/test-approval-account.mjs` 继续验证资料、模板和历史；只接受 `approval_account_test_*` 测试库。

真实 Blob 链路可显式设置 `TEST_REAL_BLOB=true` 后运行 `scripts/test-approval-blob-smoke.mjs`，数据库仍必须为独立 `approval_media_test_*`。脚本使用唯一的测试用户文件前缀，结束时删除自己的云端测试图片。
