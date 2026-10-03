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

- `papers` 保存 CET4/CET6/考研试卷和版本元数据；原创练习通过 `content_kind=original` 标记，外部记录只保留 `source_url`。
- `paper_sections` 保存阅读、完形、匹配、翻译和写作等非听力板块。
- `questions` 保存做题模式题目；`practice_attempts` 保存答题快照、答案和提交结果。
- `sentences` 保存可复用的原文句子和顺序。
- `sentence_analyses` 保存某句在特定原文、提示词和模型版本下的结果。
- `analysis_jobs` 保存待处理、进行中、成功和失败的任务。
- AI 结果以 JSONB 保存；前端根据 JSON 渲染界面，不保存 HTML。

## 缓存键

```text
sentence_id + source_hash + prompt_version + model
```

原文、提示词或模型改变时生成新版本，旧结果仍然可追溯。外部试卷不进入精读或做题接口，用户通过原站链接查看内容。

## 部署

Azure Ubuntu 服务器运行 Docker Compose。生产环境使用 HTTPS，PostgreSQL 不开放公网端口；GitHub 用于代码托管和部署流水线。
