import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import sharp from "sharp";
import { readNewsConfig } from "@cet-reading/contracts/news";
import {
  LEARNING_STAGES,
  LearningProgressSchema,
  learningDay,
  learningSlot,
  type LearningBlock,
} from "@cet-reading/contracts/learning";
import { pool } from "./store.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function profile(request: FastifyRequest) {
  const token = request.headers.authorization?.match(
    /^Bearer ([a-f0-9]{64})$/,
  )?.[1];
  if (!token) return null;
  return (
    (
      await pool.query("SELECT id FROM learning_profiles WHERE token_hash=$1", [
        digest(token),
      ])
    ).rows[0]?.id || null
  );
}
export function registerLearningRoutes(app: FastifyInstance) {
  app.get("/api/learning/library", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const articles = (
      await pool.query(`SELECT id,title,source_name,source_url,published_at,batch_at,word_count,learning_order,learning_stage,learning_role,lesson_title,learning_objective,learning_exercise,prerequisites,source_revision
      FROM news_articles WHERE status='published' AND learning_order IS NOT NULL ORDER BY learning_order`)
    ).rows;
    const curriculum = (
      await pool.query(
        `SELECT planned_order AS "order",stage,role,editorial_json->>'lessonTitle' AS title FROM learning_candidates WHERE planned_order IS NOT NULL ORDER BY planned_order`,
      )
    ).rows;
    const now = new Date();
    const today = learningSlot(learningDay(now));
    const todayPublished = articles.some(article => new Date(article.batch_at).valueOf() === today.valueOf());
    const next =
      now < today && !todayPublished
        ? today
        : learningSlot(learningDay(new Date(now.valueOf() + 86400000)));
    const run =
      (
        await pool.query(
          `SELECT status,day,finished_at FROM learning_runs WHERE kind='publish' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0] || null;
    return {
      articles,
      curriculum,
      stages: LEARNING_STAGES,
      schedule: {
        enabled: readNewsConfig().enabled,
        timezone: "Asia/Shanghai",
        hour: 8,
        count: 2,
        next: next.toISOString(),
      },
      run,
    };
  });
  app.post("/api/learning/profile", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = randomBytes(32).toString("hex");
    const r = await pool.query(
      "INSERT INTO learning_profiles(token_hash) VALUES($1) RETURNING id",
      [digest(token)],
    );
    return { id: r.rows[0].id, token };
  });
  app.get("/api/learning/progress", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = await profile(request);
    if (!id)
      return reply.code(401).send({ error: "learning_profile_required" });
    return {
      progress: (
        await pool.query(
          "SELECT article_id,status,sentence_id,block_id,exercise_done,notes,revision,updated_at,completed_at FROM learning_progress WHERE profile_id=$1",
          [id],
        )
      ).rows,
    };
  });
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/learning/progress/:id",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const id = await profile(request);
      if (!id)
        return reply.code(401).send({ error: "learning_profile_required" });
      const input = LearningProgressSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send({ error: "invalid_learning_progress" });
      const p = input.data;
      const article = (
        await pool.query(
          `SELECT id,blocks_json FROM news_articles WHERE id=$1 AND status='published' AND learning_order IS NOT NULL`,
          [request.params.id],
        )
      ).rows[0];
      if (!article) return reply.code(404).send({ error: "article_not_found" });
      if (
        p.sentenceId &&
        !(
          await pool.query(
            "SELECT 1 FROM sentences WHERE id=$1 AND article_id=$2",
            [p.sentenceId, article.id],
          )
        ).rowCount
      )
        return reply.code(400).send({ error: "invalid_sentence" });
      if (
        p.blockId &&
        !article.blocks_json.some((b: LearningBlock) => b.id === p.blockId)
      )
        return reply.code(400).send({ error: "invalid_block" });
      const result = await pool.query(
        `INSERT INTO learning_progress(profile_id,article_id,status,sentence_id,block_id,exercise_done,notes,revision,completed_at)
      SELECT $1,$2,COALESCE($3,'reading'),$4,$5,COALESCE($6,false),COALESCE($7,''),1,CASE WHEN $3='completed' THEN NOW() END WHERE $8=0 OR EXISTS(SELECT 1 FROM learning_progress WHERE profile_id=$1 AND article_id=$2)
      ON CONFLICT(profile_id,article_id) DO UPDATE SET
        status=COALESCE($3,learning_progress.status),sentence_id=CASE WHEN $9 THEN $4 ELSE learning_progress.sentence_id END,
        block_id=CASE WHEN $10 THEN $5 ELSE learning_progress.block_id END,exercise_done=COALESCE($6,learning_progress.exercise_done),notes=COALESCE($7,learning_progress.notes),
        revision=learning_progress.revision+1,updated_at=NOW(),completed_at=CASE WHEN $3='completed' THEN COALESCE(learning_progress.completed_at,NOW()) ELSE learning_progress.completed_at END
      WHERE learning_progress.revision=$8 RETURNING article_id,status,sentence_id,block_id,exercise_done,notes,revision,updated_at,completed_at`,
        [
          id,
          article.id,
          p.status ?? null,
          p.sentenceId ?? null,
          p.blockId ?? null,
          p.exerciseDone ?? null,
          p.notes ?? null,
          p.revision,
          "sentenceId" in p,
          "blockId" in p,
        ],
      );
      if (!result.rowCount) {
        const current = (
          await pool.query(
            "SELECT article_id,status,sentence_id,block_id,exercise_done,notes,revision,updated_at,completed_at FROM learning_progress WHERE profile_id=$1 AND article_id=$2",
            [id, article.id],
          )
        ).rows[0];
        return reply.code(409).send({ error: "progress_changed", current });
      }
      return { progress: result.rows[0] };
    },
  );
  app.get<{ Params: { id: string; block: string } }>(
    "/api/news/:id/assets/:block",
    async (request, reply) => {
      const { id, block } = request.params;
      const cached = (
        await pool.query(
          "SELECT body,content_type FROM learning_images WHERE article_id=$1 AND block_id=$2",
          [id, block],
        )
      ).rows[0];
      if (cached)
        return reply
          .type(cached.content_type)
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .send(cached.body);
      const article = (
        await pool.query(
          `SELECT blocks_json FROM news_articles WHERE id=$1 AND status='published' AND learning_order IS NOT NULL`,
          [id],
        )
      ).rows[0];
      const b = article?.blocks_json.find(
        (b: LearningBlock) => b.id === block && b.type === "image",
      ) as LearningBlock | undefined;
      if (!b?.src) return reply.code(404).send({ error: "image_unavailable" });
      try {
        let bytes: Buffer;
        if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.src))
          bytes = Buffer.from(b.src.split(",")[1]!, "base64");
        else {
          const u = new URL(b.src);
          if (
            u.protocol !== "https:" ||
            u.hostname !== "raw.githubusercontent.com" ||
            u.username ||
            u.password ||
            u.port ||
            !/^\/(openai\/openai-cookbook|anthropics\/claude-cookbooks)\/[a-f0-9]{40}\//.test(
              u.pathname,
            )
          )
            throw new Error("Image source is not approved");
          const r = await fetch(u, {
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          });
          if (!r.ok || !r.body) {
            await r.body?.cancel();
            throw new Error("Image fetch failed");
          }
          const reader = r.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 8_000_000) throw new Error("Image too large");
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          bytes = Buffer.concat(chunks);
        }
        if (bytes.length > 8_000_000) throw new Error("Image too large");
        const body = await sharp(bytes, { limitInputPixels: 32_000_000 })
          .resize({
            width: 1800,
            height: 1800,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 88 })
          .toBuffer();
        await pool.query(
          `INSERT INTO learning_images(article_id,block_id,body,content_type) VALUES($1,$2,$3,'image/webp') ON CONFLICT DO NOTHING`,
          [id, block, body],
        );
        return reply
          .type("image/webp")
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .send(body);
      } catch {
        return reply.code(502).send({ error: "image_unavailable" });
      }
    },
  );
}
