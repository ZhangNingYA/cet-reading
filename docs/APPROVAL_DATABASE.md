# 审批数据库约定

审批数据使用 PostgreSQL 16，独立于阅读业务，以 approval_ 为表名前缀。
034_approval_integrity.sql 同时用于新库初始化和已有数据库升级；两个文件内容保持一致。

## 数据归属

- approval_requests：申请人、执行人、内容、截止时间和当前流程状态。
- approval_request_steps：每轮审批/点评及处理人，同一申请最多一个待处理步骤。
- approval_events：完整操作历史及当次提交正文；系统操作的 actor_id 为空。
- approval_attachments：提交批次和排序。event_id 非空时，事件必须属于同一审批。
- approval_media_files：文件存储位置和上传生命周期。附件中的文件元数据是绑定时的不可变快照。
- approval_task_scores：每条任务唯一的最终评分事实，分数归申请的执行人。
- approval_daily_score_summary：只读汇总视图，从任务评分派生日评分和任务数量。

好友关系按双方分别保存两条记录，从而支持各自的备注；确认/删除必须在同一事务内修改双方记录。

## 评分口径

每日与临时任务均按每条任务独立记分，超时任务记 0 分。
人工评分必须有 reviewer_id；超时评分必须为 0 且 reviewer_id 为空。
组合外键保证评分的执行人等于任务执行人，已记分任务不能单独更换执行人。

每日趋势按 scored_at 对应的 Asia/Shanghai 自然日归组，包括人工评分和超时评分。
scheduled_for 是每日任务的计划日期，不是评分统计日期。
例如 10 月 24 日计划的任务在 10 月 26 日点评，其评分进入 10 月 26 日。

每日均分取当日所有任务分数的算术平均值并四舍五入；总均分直接对全部任务求平均，
不对每日均分再次平均。同日多模板、多申请人委托同一执行人均不会覆盖分数。

## 删除与历史

已有申请引用的模板不可物理删除；使用 active=false 停用。
附件关联的操作事件不可单独删除；整条申请删除时，步骤、事件、附件和任务评分一起级联删除。
附件的事件外键在事务结束时校验，允许申请整体级联清理。
历史附件可以保留空 event_id，新提交必须通过业务接口绑定到新建事件。
每次提交的附件序号限制为 0 至 8，同一事件的序号唯一，最多容纳 9 张照片。

034 不删除旧表或历史行：

- approval_daily_scores 是旧版每日快照，仅用于兼容、历史核对和旧应用回退；
  新代码不再写入或读取它，也不能用它重新覆盖任务评分。
- approval_user_avatars 保留旧二进制头像的读取回退，新图片使用对象存储。
- approval_comments 为独立交流预留；审批意见保存在步骤和事件中。

## 迁移与验证

部署脚本在 033 后执行 034；Docker 空库初始化按同样顺序执行 db/init。
迁移使用事务，锁等待最多 5 秒；发现历史记录违反约束时整次回滚，不删除或猜测修正旧数据。
根据报错中的约束名核对历史记录，明确修复后重新执行迁移。可用以下查询定位常见问题：

~~~sql
-- 评分归属不一致或来源字段不合法
SELECT s.*
FROM approval_task_scores s
JOIN approval_requests r ON r.id=s.request_id
WHERE s.executor_id<>r.executor_id
   OR (s.source='manual' AND s.reviewer_id IS NULL)
   OR (s.source='overdue' AND (s.score<>0 OR s.reviewer_id IS NOT NULL));

-- 图片引用了其他审批的事件
SELECT a.id, a.request_id, a.event_id
FROM approval_attachments a
JOIN approval_events e ON e.id=a.event_id
WHERE a.request_id<>e.request_id;

-- 重复待处理步骤、重复图片顺序
SELECT request_id, count(*) FROM approval_request_steps
WHERE status='pending' GROUP BY request_id HAVING count(*)>1;
SELECT event_id, sort_order, count(*) FROM approval_attachments
WHERE event_id IS NOT NULL GROUP BY event_id, sort_order HAVING count(*)>1;
~~~

仅对独立测试库运行以下检查：

~~~bash
TEST_DATABASE_URL=postgres://.../approval_schema_test_name node --import tsx scripts/test-approval-schema.mjs
TEST_DATABASE_URL=postgres://.../approval_friends_test_name node --import tsx scripts/test-approval-friends.mjs
TEST_DATABASE_URL=postgres://.../approval_account_test_name node --import tsx scripts/test-approval-account.mjs
TEST_DATABASE_URL=postgres://.../approval_media_test_name node --import tsx scripts/test-approval-media.mjs
~~~

CI 使用 PostgreSQL 16 运行上述四组测试，包括旧库升级、完整迁移链重放、空库初始化、
无损回滚、多任务汇总、非法关联、并发点评和原有图片/好友/审批流程。
