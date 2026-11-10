import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
import {
  learningDay,
  learningSlot,
  LearningProgressSchema,
} from "@cet-reading/contracts/learning";
const {
  parseLearningDocument,
  imageSource,
  learningCatalog,
  hash,
  sourceFetch,
} = await tsImport(
  "../../apps/worker/src/learning-sources.ts",
  import.meta.url,
);
const revision = "a".repeat(40),
  entry = { repo: "openai/openai-cookbook", path: "examples/lesson.ipynb" };
const paragraph =
  "A tool request contains arguments that the application must validate before execution. The application returns the result to the model so that it can continue the task and decide whether another tool is required. ";
test("technical notebook preserves code, results, tables and inline image position without treating code as English sentences", () => {
  const source = JSON.stringify({
    metadata: { kernelspec: { language: "python" } },
    cells: [
      {
        cell_type: "markdown",
        source: [
          "# A complete lesson\n\n",
          paragraph.repeat(3),
          "\n\n| Step | Action |\n| --- | --- |\n| 1 | Validate arguments |\n\n![Architecture](../images/diagram.png)\n",
        ],
      },
      {
        cell_type: "code",
        source: ["def run():\n", "    return 1"],
        outputs: [{ text: ["1\n"] }],
      },
      { cell_type: "markdown", source: [paragraph] },
    ],
  });
  const parsed = parseLearningDocument(source, entry, revision);
  assert.equal(parsed.title, "A complete lesson");
  assert.equal(
    parsed.blocks.find((b) => b.type === "code").text,
    "def run():\n    return 1",
  );
  assert.deepEqual(parsed.blocks.find((b) => b.type === "table").rows, [
    ["Step", "Action"],
    ["1", "Validate arguments"],
  ]);
  assert.equal(
    parsed.blocks.find((b) => b.type === "image").src,
    `https://raw.githubusercontent.com/openai/openai-cookbook/${revision}/images/diagram.png`,
  );
  assert(!parsed.paragraphs.join("").includes("def run"));
  assert(parsed.blocks.some((b) => b.language === "output"));
  assert.deepEqual(
    parsed.blocks
      .filter((b) => b.paragraphIndex !== undefined)
      .map((b) => b.paragraphIndex),
    [0, 1],
  );
});
test("image URLs are fixed to the original repository revision and unknown assets are not hotlinked", () => {
  assert.equal(
    imageSource(
      "https://raw.githubusercontent.com/openai/openai-cookbook/main/images/chart.png",
      entry.repo,
      entry.path,
      revision,
    ),
    `https://raw.githubusercontent.com/openai/openai-cookbook/${revision}/images/chart.png`,
  );
  for (const url of [
    "https://tracker.example/a.png",
    "http://127.0.0.1/a.png",
    "../../private.png",
    "https://raw.githubusercontent.com/other/repo/main/a.png",
    "https://raw.githubusercontent.com/openai/openai-cookbook/main/logo.png",
  ])
    assert.equal(imageSource(url, entry.repo, entry.path, revision), undefined);
});
test("source reading refuses nonofficial repositories before making a network request", async () => {
  await assert.rejects(
    sourceFetch("https://api.github.com/repos/attacker/repo/contents/a"),
    /Unapproved/,
  );
  await assert.rejects(sourceFetch("http://127.0.0.1/private"), /Unapproved/);
});
test("curriculum starts with verified real snapshots and preserves ordered pairs and prerequisite stages", () => {
  const catalog = learningCatalog();
  const initial = JSON.parse(
    readFileSync("data/news/learning-bootstrap.json", "utf8"),
  );
  assert.equal(catalog.length, 24);
  assert.equal(new Set(catalog.map((x) => x.key)).size, 24);
  catalog.forEach((x, i) => {
    assert.equal(x.order, i + 1);
    assert.equal(x.role, i % 2 ? "practice" : "concept");
    if (i) assert(x.stage >= catalog[i - 1].stage);
  });
  initial.forEach(({ entry: e, article: a }, i) => {
    assert.equal(e.key, catalog[i].key);
    assert.equal(a.key, e.key);
    assert.equal(a.contentHash, hash(JSON.stringify(a.blocks)));
    assert.match(a.licenseText, /MIT License/);
    assert.match(a.rawUrl, new RegExp(a.revision));
  });
  assert(initial[0].article.wordCount > 500);
});
test("learning dates use Shanghai time and progress rejects malformed or unversioned writes", () => {
  assert.equal(learningDay(new Date("2026-11-09T16:00:00Z")), "2026-11-10");
  assert.equal(
    learningSlot("2026-11-10").toISOString(),
    "2026-11-10T00:00:00.000Z",
  );
  assert.throws(() => learningSlot("2026-02-30"));
  assert.equal(
    LearningProgressSchema.safeParse({ status: "completed" }).success,
    false,
  );
  assert.equal(
    LearningProgressSchema.safeParse({ revision: 0, notes: "x".repeat(12001) })
      .success,
    false,
  );
  assert.equal(
    LearningProgressSchema.safeParse({
      revision: 1,
      blockId: "b2",
      exerciseDone: true,
    }).success,
    true,
  );
});

test("technical questions retain prose and executable code while explicitly bounding long output logs", async () => {
  const { buildArticleChatMessages } = await tsImport(
    "../../apps/api/src/article-chat.ts",
    import.meta.url,
  );
  const messages = buildArticleChatMessages(
    {
      title: "Technical lesson",
      paragraphs: [paragraph],
      technicalBlocks: [
        { id: "p", type: "paragraph", text: paragraph },
        {
          id: "code",
          type: "code",
          language: "python",
          text: "print(tool_result)",
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `o${i}`,
          type: "code",
          language: "output",
          text: "x".repeat(30000),
        })),
      ],
    },
    {
      target: { kind: "news", id: "test" },
      question: "Explain the tool result",
      history: [],
    },
  );
  assert.match(messages[1].content, /print\(tool_result\)/);
  assert.match(messages[1].content, /正文和代码完整/);
  assert.match(messages[1].content, /不得推测未提供的日志/);
  assert(messages[1].content.length < 15000);
  assert.equal(messages[1].content.split(paragraph).length, 2);
});
