import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import {
  LEARNING_VERSION,
  learningDay,
  learningSlot,
  type LearningArticle,
  type LearningEntry,
} from "@cet-reading/contracts/learning";
import { splitNewsParagraph } from "@cet-reading/contracts/news";
import type { RuntimeConfig } from "@cet-reading/contracts/config";
import {
  discoverLearningSources,
  hash,
  learningCatalog,
  readLearningArticle,
} from "./learning-sources.js";
import { reviewLearningArticle } from "./learning-selector.js";

type Prepared = { entry: LearningEntry; article: LearningArticle };
async function seedCatalog(c: PoolClient) {
  for (const e of learningCatalog())
    await c.query(
      `INSERT INTO learning_candidates(key,repo,path,planned_order,stage,role,editorial_json)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(key) DO NOTHING`,
      [e.key, e.repo, e.path, e.order, e.stage, e.role, e],
    );
}
async function prepare(
  c: PoolClient,
  order: number,
  config: RuntimeConfig,
  model: string,
): Promise<Prepared> {
  let row = (
    await c.query("SELECT * FROM learning_candidates WHERE planned_order=$1", [
      order,
    ])
  ).rows[0];
  if (!row) {
    const recent = (
      await c.query(
        `SELECT title,learning_objective FROM news_articles WHERE learning_order IS NOT NULL ORDER BY learning_order DESC LIMIT 60`,
      )
    ).rows;
    const paired =
      order % 2 === 0
        ? ((
            await c.query(
              "SELECT editorial_json FROM learning_candidates WHERE planned_order=$1",
              [order - 1],
            )
          ).rows[0]?.editorial_json as LearningEntry | undefined)
        : undefined;
    if (paired)
      recent.unshift({
        title: paired.lessonTitle,
        learning_objective: paired.objective,
        pairedConcept: true,
      });
    const candidates = (
      await c.query(
        `SELECT * FROM learning_candidates WHERE planned_order IS NULL AND status='discovered' ORDER BY discovered_at,key LIMIT 4`,
      )
    ).rows;
    for (const candidate of candidates) {
      try {
        const article = await readLearningArticle(candidate);
        if (
          (
            await c.query("SELECT 1 FROM news_articles WHERE content_hash=$1", [
              article.contentHash,
            ])
          ).rowCount
        ) {
          await c.query(
            `UPDATE learning_candidates SET status='rejected',reason='Duplicate body',checked_at=NOW() WHERE key=$1`,
            [candidate.key],
          );
          continue;
        }
        const review = await reviewLearningArticle(
          config,
          model,
          article,
          6,
          order % 2 ? "concept" : "practice",
          recent,
        );
        await c.query(
          `UPDATE learning_candidates SET review_json=$2,article_json=$3,checked_at=NOW(),attempts=attempts+1,status=$4,reason=$5 WHERE key=$1`,
          [
            candidate.key,
            review,
            article,
            review.accepted ? "ready" : "rejected",
            review.reason,
          ],
        );
        if (!review.accepted) continue;
        const entry: LearningEntry = {
          key: candidate.key,
          repo: candidate.repo,
          path: candidate.path,
          order,
          stage: review.stage,
          role: review.role,
          lessonTitle: paired?.lessonTitle || review.lessonTitle,
          objective: review.objective,
          exercise: review.exercise,
          prerequisites: review.prerequisites,
        };
        await c.query(
          `UPDATE learning_candidates SET planned_order=$2,stage=$3,role=$4,editorial_json=$5,source_revision=$6,content_hash=$7 WHERE key=$1`,
          [
            entry.key,
            order,
            entry.stage,
            entry.role,
            entry,
            article.revision,
            article.contentHash,
          ],
        );
        return { entry, article };
      } catch (error) {
        await c.query(
          `UPDATE learning_candidates SET attempts=attempts+1,checked_at=NOW(),reason=$2,status=CASE WHEN attempts>=2 THEN 'failed' ELSE status END WHERE key=$1`,
          [
            candidate.key,
            error instanceof Error ? error.message : "Review failed",
          ],
        );
      }
    }
    throw new Error("没有找到满足当前进阶学习目标的完整材料；已保留课程位置。");
  }
  const entry = row.editorial_json as LearningEntry;
  if (row.status === "published")
    throw new Error("Course cursor points to an already published article");
  if (row.article_json) return { entry, article: row.article_json };
  let article: LearningArticle;
  // The first two reviewed snapshots make the one-time cutover independent of
  // upstream downtime. They retain their original revision and license notice.
  const initial = JSON.parse(
    readFileSync(
      new URL("../../../data/news/learning-bootstrap.json", import.meta.url),
      "utf8",
    ),
  ) as Prepared[];
  const snapshot = initial.find((item) => item.entry.key === entry.key);
  try {
    article = snapshot?.article || (await readLearningArticle(entry));
    if (
      article.contentHash !== hash(JSON.stringify(article.blocks)) ||
      !article.licenseText.includes("MIT License")
    )
      throw new Error("Invalid licensed source snapshot");
    await c.query(
      `UPDATE learning_candidates SET article_json=$2,source_revision=$3,content_hash=$4,status='ready',checked_at=NOW(),attempts=attempts+1,reason='' WHERE key=$1`,
      [entry.key, article, article.revision, article.contentHash],
    );
  } catch (error) {
    await c.query(
      `UPDATE learning_candidates SET status='failed',checked_at=NOW(),attempts=attempts+1,reason=$2 WHERE key=$1`,
      [
        entry.key,
        error instanceof Error ? error.message : "Source read failed",
      ],
    );
    throw error;
  }
  return { entry, article };
}
async function archiveAndClear(c: PoolClient) {
  const queries: Record<string, string> = {
    news_articles: "SELECT * FROM news_articles",
    news_batches: "SELECT * FROM news_batches",
    sentences: "SELECT * FROM sentences WHERE article_id IS NOT NULL",
    sentence_analyses:
      "SELECT a.* FROM sentence_analyses a JOIN sentences s ON s.id=a.sentence_id WHERE s.article_id IS NOT NULL",
    analysis_jobs:
      "SELECT j.* FROM analysis_jobs j JOIN sentences s ON s.id=j.sentence_id WHERE s.article_id IS NOT NULL",
    analysis_request_traces:
      "SELECT t.* FROM analysis_request_traces t JOIN analysis_jobs j ON j.id=t.job_id JOIN sentences s ON s.id=j.sentence_id WHERE s.article_id IS NOT NULL",
    analysis_news_priorities: "SELECT * FROM analysis_news_priorities",
    analysis_priority_target:
      "SELECT * FROM analysis_priority_target WHERE source_type='news'",
    reading_progress: "SELECT * FROM reading_progress WHERE board='news'",
  };
  const archive: Record<string, unknown> = {};
  for (const [table, sql] of Object.entries(queries))
    archive[table] = (await c.query(sql)).rows;
  await c.query(
    "INSERT INTO learning_legacy_archive(id,data_json) VALUES(1,$1) ON CONFLICT DO NOTHING",
    [archive],
  );
  await c.query(
    "DELETE FROM analysis_priority_target WHERE source_type='news'",
  );
  await c.query("DELETE FROM news_articles");
  await c.query("DELETE FROM news_batches");
  await c.query("DELETE FROM reading_progress WHERE board='news'");
}
export async function publishLearningArticle(
  c: PoolClient,
  slot: Date,
  { entry: e, article: a }: Prepared,
) {
  const id = `learn-${hash(e.key).slice(0, 20)}`;
  await c.query(
    `INSERT INTO news_articles(id,batch_at,selection_kind,category,keywords,title,author,source_name,source_url,published_at,fetched_at,license_name,license_url,license_policy_url,paragraphs_json,content_hash,word_count,difficulty,difficulty_reason,topic,event_key,selection_reason,
    learning_order,learning_stage,learning_role,lesson_title,learning_objective,learning_exercise,prerequisites,blocks_json,source_revision,license_text)
    VALUES($1,$2,'curated','agent_current',$3,$4,$5,$5,$6,$7,$8,'MIT',$9,$9,$10,$11,$12,'advanced',$13,$14,$15,$13,$16,$17,$18,$14,$13,$19,$20,$21,$22,$23)`,
    [
      id,
      slot,
      [
        e.role === "concept" ? "原理" : "实践",
        e.lessonTitle,
        "Agent development",
      ],
      a.title,
      a.sourceName,
      a.sourceUrl,
      a.updatedAt,
      a.fetchedAt,
      a.licenseUrl,
      JSON.stringify(a.paragraphs),
      a.contentHash,
      Math.max(1, a.wordCount),
      e.objective,
      e.lessonTitle,
      e.key,
      e.order,
      e.stage,
      e.role,
      e.exercise,
      JSON.stringify(e.prerequisites),
      JSON.stringify(a.blocks),
      a.revision,
      a.licenseText,
    ],
  );
  for (const [pi, p] of a.paragraphs.entries())
    for (const [si, text] of splitNewsParagraph(p).entries())
      await c.query(
        "INSERT INTO sentences(id,article_id,paragraph_index,sentence_index,source_text) VALUES($1,$2,$3,$4,$5)",
        [`${id}-sentence-${pi + 1}-${si + 1}`, id, pi, si, text],
      );
  await c.query(
    `UPDATE learning_candidates SET status='published' WHERE key=$1`,
    [e.key],
  );
  return id;
}
export async function runLearningBatch(
  pool: Pool,
  config: RuntimeConfig,
  model: string,
  options: { now?: Date; initialize?: boolean; force?: boolean } = {},
) {
  const now = options.now || new Date();
  const day = learningDay(now),
    slot = learningSlot(day);
  if (now < slot && !options.initialize) return { status: "not_due" };
  const c = await pool.connect();
  let runId: number | undefined;
  let transaction = false;
  try {
    if (
      !(await c.query("SELECT pg_try_advisory_lock(814172026) AS locked"))
        .rows[0].locked
    )
      return { status: "locked" };
    const state = (await c.query("SELECT * FROM learning_state WHERE id=1"))
      .rows[0];
    if (!state) throw new Error("Learning migration has not run");
    if (options.initialize && state.initialized_at)
      return { status: "initialized" };
    if (
      state.initialized_at &&
      (
        await c.query(
          "SELECT 1 FROM news_articles WHERE batch_at=$1 AND learning_order IS NOT NULL",
          [slot],
        )
      ).rowCount
    )
      return { status: "already_complete" };
    const attempts = (
      await c.query(
        "SELECT count(*)::int AS count,max(finished_at) AS last FROM learning_runs WHERE day=$1 AND kind='publish' AND status IN ('failed','partial')",
        [day],
      )
    ).rows[0];
    if (
      !options.force &&
      !options.initialize &&
      (attempts.count >= 3 ||
        (attempts.last &&
          now.valueOf() - new Date(attempts.last).valueOf() < 120000))
    )
      return { status: "retry_deferred" };
    runId = (
      await c.query(
        `INSERT INTO learning_runs(day,kind,status,cursor_before) VALUES($1,'publish','running',$2) RETURNING id`,
        [day, state.next_order],
      )
    ).rows[0].id;
    await seedCatalog(c);
    if (
      !options.initialize &&
      (!state.last_discovered_at ||
        learningDay(new Date(state.last_discovered_at)) !== day)
    ) {
      try {
        for (const e of await discoverLearningSources())
          await c.query(
            "INSERT INTO learning_candidates(key,repo,path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [e.key, e.repo, e.path],
          );
        await c.query(
          "UPDATE learning_state SET last_discovered_at=$1 WHERE id=1",
          [now],
        );
      } catch (error) {
        await c.query(
          `INSERT INTO learning_runs(day,kind,status,finished_at,error) VALUES($1,'discovery','failed',NOW(),$2)`,
          [
            day,
            error instanceof Error ? error.message : "Source discovery failed",
          ],
        );
      }
    }
    const prepared: Prepared[] = [];
    for (let i = 0; i < 2; i++)
      prepared.push(await prepare(c, state.next_order + i, config, model));
    if (prepared[0]!.article.contentHash === prepared[1]!.article.contentHash)
      throw new Error("Daily pair contains duplicate material");
    await c.query("BEGIN");
    transaction = true;
    if (!state.initialized_at) await archiveAndClear(c);
    await c.query(
      `INSERT INTO news_batches(scheduled_at,status,attempts) VALUES($1,'running',1) ON CONFLICT(scheduled_at) DO UPDATE SET status='running',attempts=news_batches.attempts+1`,
      [slot],
    );
    const ids = [];
    for (const p of prepared)
      ids.push(await publishLearningArticle(c, slot, p));
    await c.query(
      `UPDATE news_batches SET status='complete',finished_at=NOW(),reason='',audit_json=$2 WHERE scheduled_at=$1`,
      [
        slot,
        {
          curriculumVersion: LEARNING_VERSION,
          articleIds: ids,
          orders: prepared.map((p) => p.entry.order),
        },
      ],
    );
    await c.query(
      "UPDATE learning_state SET next_order=$1,initialized_at=COALESCE(initialized_at,NOW()),updated_at=NOW() WHERE id=1",
      [state.next_order + 2],
    );
    await c.query(
      `UPDATE learning_runs SET status='complete',finished_at=NOW(),cursor_after=$2,detail_json=$3 WHERE id=$1`,
      [
        runId,
        state.next_order + 2,
        { ids, sourceRevisions: prepared.map((p) => p.article.revision) },
      ],
    );
    await c.query("COMMIT");
    transaction = false;
    return { status: "complete", ids, day, nextOrder: state.next_order + 2 };
  } catch (error) {
    if (transaction) await c.query("ROLLBACK");
    const reason =
      error instanceof Error ? error.message : "Learning batch failed";
    if (runId)
      await c.query(
        `UPDATE learning_runs SET status='failed',finished_at=NOW(),error=$2 WHERE id=$1`,
        [runId, reason],
      );
    throw error;
  } finally {
    await c.query("SELECT pg_advisory_unlock(814172026)").catch(() => {});
    c.release();
  }
}
