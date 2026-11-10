import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import Fastify from "fastify";
import sharp from "sharp";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes("test"))
  throw new Error("A disposable test database is required");
process.env.DATABASE_URL = url;
process.env.AI_DRY_RUN = "true";
process.env.NEWS_ENABLED = "true";
const { runLearningBatch } =
  await import("../apps/worker/src/learning-store.ts");
const { hash } = await import("../apps/worker/src/learning-sources.ts");
const { registerLearningRoutes } =
  await import("../apps/api/src/learning-routes.ts");
const { pool: apiPool } = await import("../apps/api/src/store.ts");
const pool = new pg.Pool({ connectionString: url });
const paths = [
  "db/init/001_schema.sql",
  ...[
    "003_paper_modes",
    "005_original_practice",
    "008_imported_papers",
    "013_exam_materials",
    "011_analysis_regeneration",
    "014_news",
    "015_analysis_queue_resilience",
    "016_shared_reading",
    "017_analysis_runtime_settings",
    "018_analysis_admin_phase2",
    "019_analysis_news_priorities",
    "020_question_analysis",
    "021_analysis_priority_target",
    "022_analysis_priority_queue",
    "023_analysis_priority_news",
    "024_analysis_queue_capacity",
    "025_analysis_backfill_retries",
    "026_reading_progress",
    "027_analysis_request_traces",
    "035_news_agent_categories",
    "036_analysis_reasoning_effort",
    "037_agent_learning",
  ].map((n) => `db/migrations/${n}.sql`),
];
const now = new Date("2026-11-10T01:00:00Z"),
  config = { mode: "demo" },
  app = Fastify();
registerLearningRoutes(app);
try {
  for (const path of paths) await pool.query(readFileSync(path, "utf8"));
  await pool.query(
    "INSERT INTO papers(id,exam_level,year,month,set_no,title) VALUES('preserved-paper','CET4',2020,6,1,'Preserved test paper')",
  );
  await pool.query(
    "INSERT INTO sentences(id,paper_id,paragraph_index,sentence_index,source_text) VALUES('preserved-sentence','preserved-paper',0,0,'This sentence must remain.')",
  );
  await pool.query(
    "INSERT INTO reading_progress(board,item_id,mode) VALUES('cet4','preserved-paper','intensive'),('news','news-agent-history-2026','intensive')",
  );
  const first = await runLearningBatch(pool, config, "", {
    now,
    initialize: true,
  });
  assert.equal(first.status, "complete");
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM news_articles")).rows[0].n,
    2,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM sentences WHERE id='preserved-sentence'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM reading_progress")).rows[0]
      .n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT jsonb_array_length(data_json->'news_articles') n FROM learning_legacy_archive",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await runLearningBatch(pool, config, "", { now, initialize: true }))
      .status,
    "initialized",
  );
  assert.equal(
    (await runLearningBatch(pool, config, "", { now })).status,
    "already_complete",
  );
  await pool.query(
    readFileSync("db/migrations/037_agent_learning.sql", "utf8"),
  );
  assert.equal(
    (await pool.query("SELECT next_order FROM learning_state")).rows[0]
      .next_order,
    3,
  );
  const day2 = new Date("2026-11-11T01:00:00Z");
  await pool.query("UPDATE learning_state SET last_discovered_at=$1", [day2]);
  // Network failure must retain course position and published articles.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("source offline");
  };
  await assert.rejects(
    runLearningBatch(pool, config, "", { now: day2, force: true }),
    /source offline/,
  );
  globalThis.fetch = originalFetch;
  assert.equal(
    (await pool.query("SELECT next_order FROM learning_state")).rows[0]
      .next_order,
    3,
  );
  const snapshots = JSON.parse(
    readFileSync("data/news/learning-bootstrap.json", "utf8"),
  );
  for (const [i, record] of snapshots.entries()) {
    const order = i + 3;
    const row = (
      await pool.query(
        "SELECT * FROM learning_candidates WHERE planned_order=$1",
        [order],
      )
    ).rows[0];
    const article = structuredClone(record.article);
    article.key = row.key;
    article.sourceUrl = `https://github.com/example/test/${order}`;
    if (i === 0) {
      article.blocks[0].text += " test next lesson";
      article.contentHash = hash(JSON.stringify(article.blocks));
    }
    // The second duplicate forces rollback after the first insertion.
    await pool.query(
      "UPDATE learning_candidates SET article_json=$2,status='ready' WHERE key=$1",
      [row.key, article],
    );
  }
  await assert.rejects(
    runLearningBatch(pool, config, "", { now: day2, force: true }),
    /unique constraint/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM news_articles")).rows[0].n,
    2,
  );
  assert.equal(
    (await pool.query("SELECT next_order FROM learning_state")).rows[0]
      .next_order,
    3,
  );
  const row = (
    await pool.query("SELECT * FROM learning_candidates WHERE planned_order=4")
  ).rows[0];
  row.article_json.blocks[0].text += " test fourth lesson";
  row.article_json.contentHash = hash(JSON.stringify(row.article_json.blocks));
  await pool.query(
    "UPDATE learning_candidates SET article_json=$2 WHERE key=$1",
    [row.key, row.article_json],
  );
  const outcomes = await Promise.all([
    runLearningBatch(pool, config, "", { now: day2, force: true }),
    runLearningBatch(pool, config, "", { now: day2, force: true }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "complete").length, 1);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM news_articles")).rows[0].n,
    4,
  );
  assert.equal(
    (await pool.query("SELECT next_order FROM learning_state")).rows[0]
      .next_order,
    5,
  );
  const profiles = [];
  for (let i = 0; i < 2; i++)
    profiles.push(
      (
        await app.inject({ method: "POST", url: "/api/learning/profile" })
      ).json(),
    );
  const id = first.ids[0],
    headers = { authorization: `Bearer ${profiles[0].token}` };
  assert.equal(
    (await app.inject({ url: "/api/learning/progress" })).statusCode,
    401,
  );
  const write = await app.inject({
    method: "PUT",
    url: `/api/learning/progress/${id}`,
    headers,
    payload: {
      revision: 0,
      status: "reading",
      blockId: "b1",
      notes: "My learning note",
    },
  });
  assert.equal(write.statusCode, 200, write.body);
  const stale = await app.inject({
    method: "PUT",
    url: `/api/learning/progress/${id}`,
    headers,
    payload: { revision: 0, status: "completed" },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().current.status, "reading");
  const invalid = await app.inject({
    method: "PUT",
    url: `/api/learning/progress/${id}`,
    headers,
    payload: { revision: 1, sentenceId: "preserved-sentence" },
  });
  assert.equal(invalid.statusCode, 400);
  const valid = await app.inject({
    method: "PUT",
    url: `/api/learning/progress/${id}`,
    headers,
    payload: { revision: 1, status: "completed", exerciseDone: true },
  });
  assert.equal(valid.statusCode, 200, valid.body);
  assert.equal(valid.json().progress.notes, "My learning note");
  const other = (
    await app.inject({
      url: "/api/learning/progress",
      headers: { authorization: `Bearer ${profiles[1].token}` },
    })
  ).json();
  assert.deepEqual(other.progress, []);
  const lib = (await app.inject({ url: "/api/learning/library" })).json();
  assert.equal(lib.articles.length, 4);
  assert.equal(lib.schedule.count, 2);
  assert.equal(lib.schedule.enabled, true);
  if (lib.articles.some(a => new Date(a.batch_at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10))) assert(new Date(lib.schedule.next) > new Date());
  assert(!JSON.stringify(lib).includes("My learning note"));
  const png = await sharp({
    create: { width: 12, height: 8, channels: 3, background: "#3f644c" },
  })
    .png()
    .toBuffer();
  const imageBlocks = [
    {
      id: "image-test",
      type: "image",
      text: "",
      src: "data:image/png;base64," + png.toString("base64"),
    },
    {
      id: "image-denied",
      type: "image",
      text: "",
      src: "http://127.0.0.1/private",
    },
  ];
  await pool.query(
    "UPDATE news_articles SET blocks_json=blocks_json || $2::jsonb WHERE id=$1",
    [id, JSON.stringify(imageBlocks)],
  );
  const image = await app.inject({ url: `/api/news/${id}/assets/image-test` });
  assert.equal(image.statusCode, 200);
  assert.match(image.headers["content-type"], /image\/webp/);
  assert.equal((await sharp(image.rawPayload).metadata()).width, 12);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM learning_images WHERE article_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await app.inject({ url: `/api/news/${id}/assets/image-denied` }))
      .statusCode,
    502,
  );
  assert.equal(
    (await app.inject({ url: `/api/news/${id}/assets/missing` })).statusCode,
    404,
  );
  console.log(
    "Learning integration passed: one-time reset, preserved papers, atomic rollback, restart, concurrency, course cursor, profile isolation, revision conflicts and safe cached images.",
  );
} finally {
  await app.close();
  await pool.end();
  await apiPool.end();
}
