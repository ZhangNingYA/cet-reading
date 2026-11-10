import "dotenv/config";
import { Pool } from "pg";
import { readConfig } from "@cet-reading/contracts/config";
import { readNewsConfig } from "@cet-reading/contracts/news";
import { runLearningBatch } from "./learning-store.js";
const config = readConfig(),
  news = readNewsConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
const once =
  process.argv.includes("--initialize") || process.argv.includes("--run-once");
if (once) {
  try {
    console.log(
      JSON.stringify(
        await runLearningBatch(pool, config, news.model, {
          initialize: process.argv.includes("--initialize"),
          force: true,
        }),
      ),
    );
  } finally {
    await pool.end();
  }
} else {
  let stopping = false;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    if (wake) clearTimeout(wake);
    release?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log(
    `Agent learning: two ordered articles daily at 08:00 Asia/Shanghai; enabled=${news.enabled}`,
  );
  try {
    while (!stopping) {
      if (news.enabled)
        try {
          const result = await runLearningBatch(pool, config, news.model);
          if (result.status === "complete") console.log(JSON.stringify(result));
        } catch (e) {
          console.error(
            e instanceof Error ? e.message : "Learning collection failed",
          );
        }
      if (!stopping)
        await new Promise<void>((r) => {
          release = r;
          wake = setTimeout(r, 30000);
        });
    }
  } finally {
    await pool.end();
  }
}
