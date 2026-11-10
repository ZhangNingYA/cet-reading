import {
  LEARNING_SELECTOR_PROMPT,
  LearningReviewSchema,
  type LearningArticle,
} from "@cet-reading/contracts/learning";
import type { RuntimeConfig } from "@cet-reading/contracts/config";
export async function reviewLearningArticle(
  config: RuntimeConfig,
  model: string,
  article: LearningArticle,
  stage: number,
  role: string,
  recent: unknown[],
) {
  if (!config.apiKey || !config.apiUrl || !model || config.mode !== "ai")
    throw new Error("Learning review requires the configured AI service");
  const input = {
    stage,
    role,
    recent,
    title: article.title,
    blocks: article.blocks,
  };
  if (JSON.stringify(input).length > 150000)
    throw new Error("Material is too long for a complete editorial review");
  const r = await fetch(
    `${config.apiUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: LEARNING_SELECTOR_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`Learning review HTTP ${r.status}`);
  }
  const d = (await r.json()) as any;
  const result = LearningReviewSchema.parse(
    JSON.parse(
      String(d.choices?.[0]?.message?.content).replace(
        /^```(?:json)?\s*|\s*```$/g,
        "",
      ),
    ),
  );
  if (result.stage !== stage || result.role !== role)
    throw new Error(
      "Review does not match the current course prerequisite or role",
    );
  if (
    result.evidenceBlockIds.some(
      (id) => !article.blocks.some((b) => b.id === id),
    )
  )
    throw new Error("Review cites unknown source blocks");
  if (
    result.accepted &&
    role === "practice" &&
    !article.blocks.some((b) => b.type === "code")
  )
    throw new Error("Practice material has no implementation");
  return result;
}
