import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSourceTree } from "../scripts/course-source-fixture";
import { twoUnitTranslationFixture, multiUnitTranslationFixture } from "../scripts/course-source-scenarios";

/**
 * **F5 的 CLI 集成测试**：显式 `--plan` 必须失败关闭。
 *
 * ── 为什么必须走真实 CLI（而不是只测解析函数）──
 *
 * 复评证明的缺陷发生在**参数处置层**，不在解析层：
 * `course:extract --plan <不存在的文件>` 退出 0 并按自动分段跑完。
 * `parseSegmentationPlan` 本身是对的 —— 是 CLI 把它**当成没提供**处理了。
 * 因此只有真的 spawn 那条命令才能守住这条语义。
 *
 * ── 语义矩阵（本文件逐条覆盖）──
 *
 * | 输入 | 期望 |
 * | --- | --- |
 * | 不给 `--plan`（默认位置也没有） | 退出 0，自动分段 |
 * | `--plan` 显式给出且**可用** | 退出 0，按计划产段 |
 * | `--plan` 显式给出但**文件不存在** | **非零退出**，不写候选 |
 * | `--plan` 显式给出但**不是 JSON** | **非零退出**，不写候选 |
 * | `--plan` 显式给出但**契约版本不认识** | **非零退出**，不写候选 |
 * | `--plan` 显式给出但**绑定错误课程** | **非零退出**，不写候选 |
 * | `--plan` 显式给出但**源已漂移（陈旧）** | **非零退出**，不写候选 |
 * | `--no-plan`（默认位置有可用计划） | 退出 0，走自动分段 |
 * | `--plan` 与 `--no-plan` 同时给出 | **非零退出**（自相矛盾） |
 * | 默认位置恰好有一份计划 | 退出 0，自动加载（既有行为不变） |
 *
 * ── 隐私 ──
 *
 * 全部合成夹具，隔离 `CET6_CONTENT_ROOT` ⇒ 绝不触碰 使用者 真实
 * `private-content/` 或 `data/cet6.db`。
 */

interface CliResult {
  code: number;
  out: string;
}

/** 在隔离内容根上跑真实 CLI。 */
function runCli(args: string[], contentRoot: string): CliResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", ...args],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, CET6_CONTENT_ROOT: contentRoot },
    },
  );
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * 跑 CLI 并取出它 `--json` 输出的那个 JSON 对象。
 *
 * ── 为什么不能简单 `slice(indexOf("{"))` ──
 *
 * CLI 的终端输出里，JSON 报告**前面**有阶段摘要、**后面**还有"下一步"
 * 提示文本，而两者都可能含 `{`。因此必须按**大括号配对**切出那一段
 * （同时要跳过字符串字面量里的大括号 —— 这里只需要够用即可，
 * 因为报告结构里不含嵌套字符串括号）。
 */
function runCliJson(args: string[], contentRoot: string): { code: number; json: Record<string, unknown>; out: string } {
  const result = runCli(args, contentRoot);
  const start = result.out.indexOf("\n{");
  if (start < 0) throw new Error(`CLI 输出里没有 JSON 报告：${result.out.slice(-500)}`);
  const from = start + 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = from; index < result.out.length; index += 1) {
    const char = result.out[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`CLI 输出的 JSON 报告不完整：${result.out.slice(-500)}`);
  return { code: result.code, json: JSON.parse(result.out.slice(from, end)) as Record<string, unknown>, out: result.out };
}

interface Env {
  root: string;
  contentRoot: string;
  sourceRoot: string;
  plansDir: string;
  candidateDir: string;
  courseId: string;
  dispose(): void;
}

function makeEnv(courseId: string, tree = twoUnitTranslationFixture()): Env {
  const root = mkdtempSync(join(tmpdir(), "cet6-plan-failclosed-"));
  const contentRoot = join(root, "content");
  const sourceRoot = join(contentRoot, "course-sources", courseId);
  const plansDir = join(contentRoot, "course-segmentation-plans");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  writeSourceTree(sourceRoot, tree);
  return {
    root,
    contentRoot,
    sourceRoot,
    plansDir,
    candidateDir: join(contentRoot, "course-candidates", courseId),
    courseId,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 抽取的公共参数（canonical 库指向隔离目录，避免读到真实库）。 */
function extractArgs(env: Env, extra: string[] = []): string[] {
  return [
    "scripts/course-extract.ts",
    "--source",
    env.sourceRoot,
    "--id",
    env.courseId,
    "--papers-dir",
    join(env.contentRoot, "cet6", "papers"),
    ...extra,
  ];
}

/** 读一份"形状合法但绑定到别的课程"的计划（用于绑定不符用例）。 */
function readPlanFile(env: Env, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(env.plansDir, name), "utf8")) as Record<string, unknown>;
}

describe("F5 —— 显式 --plan 必须失败关闭（真实 CLI 集成）", () => {
  it("不给 --plan 且默认位置没有计划 ⇒ 退出 0，走自动分段", () => {
    const env = makeEnv("f5-none");
    try {
      const result = runCli(extractArgs(env), env.contentRoot);
      expect(result.code, `应成功，实际输出：${result.out.slice(-400)}`).toBe(0);
      expect(result.out).toContain("默认位置没有计划");
      const candidate = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        segmentation: { modeEvidence: { mode: string } };
      };
      expect(candidate.segmentation.modeEvidence.mode).toBe("automatic");
    } finally {
      env.dispose();
    }
  });

  it("**`--plan` 指向不存在的文件 ⇒ 非零退出，且不写任何候选**（F5 的核心负例）", () => {
    const env = makeEnv("f5-missing");
    try {
      const missing = join(env.plansDir, "does-not-exist.json");
      const result = runCli(extractArgs(env, ["--plan", missing]), env.contentRoot);

      expect(result.code, "显式 --plan 不存在时必须非零退出").not.toBe(0);
      expect(result.code, "必须是「计划失败关闭」的专用退出码").toBe(3);
      expect(result.out, "必须给出机器可读错误码").toContain("PLAN_NOT_FOUND");
      // **绝不**静默回退：不得产出候选
      expect(existsSync(env.candidateDir), "失败关闭时绝不写出候选").toBe(false);
      expect(result.out, "不得声称走了自动分段").not.toContain("默认位置没有计划");
    } finally {
      env.dispose();
    }
  });

  it("`--plan` 指向坏 JSON ⇒ 非零退出，不写候选", () => {
    const env = makeEnv("f5-badjson");
    try {
      const bad = join(env.plansDir, "broken.json");
      writeFileSync(bad, '{"schemaVersion": 1, "units": [', "utf8");
      const result = runCli(extractArgs(env, ["--plan", bad]), env.contentRoot);

      expect(result.code).toBe(3);
      expect(result.out).toContain("PLAN_INVALID");
      expect(existsSync(env.candidateDir)).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("`--plan` 契约版本不认识 ⇒ 非零退出，不写候选", () => {
    const env = makeEnv("f5-version");
    try {
      const path = join(env.plansDir, "future.json");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 99,
          binding: { courseId: env.courseId, sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
          units: [{ title: "u", kind: "translation_passage", assignments: [] }],
        }),
        "utf8",
      );
      const result = runCli(extractArgs(env, ["--plan", path]), env.contentRoot);

      expect(result.code).toBe(3);
      expect(result.out).toContain("PLAN_INVALID");
      expect(result.out, "必须说明契约版本不受支持").toContain("plan_schema_version_unsupported");
      expect(existsSync(env.candidateDir)).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("**`--plan` 绑定到别的课程 ⇒ 非零退出（内容层拒绝也必须失败关闭）**", () => {
    const env = makeEnv("f5-binding");
    try {
      /*
       * 先跑一次自动抽取拿到真实的源摘要（计划必须绑定它）。
       * 这里用 --dry-run + --json，因此**不写任何文件**。
       */
      const bootstrap = runCliJson(extractArgs(env, ["--dry-run", "--json"]), env.contentRoot);
      expect(bootstrap.code, `预跑应成功：${bootstrap.out.slice(-300)}`).toBe(0);
      const digest = (bootstrap.json.inventory as { digest: string }).digest;
      expect(digest, "夹具健全性：源摘要必须是真的 64 位 hex").toMatch(/^[0-9a-f]{64}$/);

      // 用真实摘要，但把 courseId 绑成另一个课程 ⇒ 内容层拒绝（致命）
      const path = join(env.plansDir, "wrong-course.json");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          binding: { courseId: "some-other-course", sourceDigest: digest, assets: [{ assetKey: "x", sha256: "y" }] },
          author: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          reason: "绑定到错误的课程",
          units: [
            {
              title: "u",
              kind: "translation_passage",
              assignments: [{ channel: "source", range: { assetKey: "x", page: 1, lineStart: 1, lineEnd: 1 }, note: null }],
            },
          ],
        }),
        "utf8",
      );

      const result = runCli(extractArgs(env, ["--plan", path]), env.contentRoot);
      expect(result.code, "绑定不符时必须非零退出").toBe(3);
      expect(result.out).toContain("PLAN_REJECTED");
      expect(result.out, "必须说明是课程绑定不符").toContain("plan_binding_course_mismatch");
      expect(existsSync(env.candidateDir), "失败关闭时绝不写出候选").toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("**`--plan` 陈旧（源摘要不符）⇒ 非零退出，不写候选**", () => {
    const env = makeEnv("f5-stale", multiUnitTranslationFixture());
    try {
      /*
       * 先自动抽取一次拿到**真实**的资产键与校验和，再写一份"除源摘要外
       * 一切都对"的计划。这样它才能通过形状层、走到**内容层**的陈旧判定 ——
       * 否则会被 `plan_assets_empty` 之类的形状问题先拦下（那测的是另一件事）。
       */
      expect(runCli(extractArgs(env), env.contentRoot).code).toBe(0);
      const candidate = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        inventory: { digest: string; assets: { assetKey: string; sha256: string }[] };
      };
      const asset = candidate.inventory.assets[0]!;

      const path = join(env.plansDir, "stale.json");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          // 源摘要刻意写成另一个值 ⇒ **陈旧**（资产校验和是真的，因此只有摘要不符）
          binding: { courseId: env.courseId, sourceDigest: "f".repeat(64), assets: [{ assetKey: asset.assetKey, sha256: asset.sha256 }] },
          author: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          reason: "陈旧的计划（源摘要已变）",
          units: [
            {
              title: "u",
              kind: "translation_passage",
              assignments: [
                { channel: "source", range: { assetKey: asset.assetKey, page: 1, lineStart: 2, lineEnd: 3 }, note: null },
              ],
            },
          ],
        }),
        "utf8",
      );

      const result = runCli(extractArgs(env, ["--plan", path]), env.contentRoot);
      expect(result.code, "陈旧计划必须非零退出（不静默套到新源上）").toBe(3);
      expect(result.out, "必须走内容层的 PLAN_REJECTED 分支").toContain("PLAN_REJECTED");
      expect(result.out, "必须明确报出陈旧").toContain("plan_binding_source_stale");
    } finally {
      env.dispose();
    }
  });

  it("`--plan` 与 `--no-plan` 同时给出 ⇒ 非零退出（自相矛盾，不猜）", () => {
    const env = makeEnv("f5-conflict");
    try {
      const result = runCli(extractArgs(env, ["--plan", "whatever.json", "--no-plan"]), env.contentRoot);
      expect(result.code, "参数冲突必须被拒绝").toBe(2);
      expect(result.out).toContain("参数冲突");
      expect(existsSync(env.candidateDir)).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("`--no-plan` 忽略默认位置的计划 ⇒ 退出 0 且走自动分段", () => {
    const env = makeEnv("f5-noplan");
    try {
      // 先真的产出一份可用计划：用自动抽取的结果绑定的坐标构造
      const bootstrap = runCliJson(extractArgs(env, ["--dry-run", "--json"]), env.contentRoot);
      const digest = (bootstrap.json.inventory as { digest: string }).digest;
      // 写一份"形状合法"的计划到默认位置（内容层可能被拒，但那不影响本用例）
      writeFileSync(
        join(env.plansDir, `${env.courseId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          binding: { courseId: env.courseId, sourceDigest: digest, assets: [] },
          author: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          reason: "默认位置的计划",
          units: [
            {
              title: "u",
              kind: "translation_passage",
              assignments: [{ channel: "source", range: { assetKey: "x", page: 1, lineStart: 1, lineEnd: 1 }, note: null }],
            },
          ],
        }),
        "utf8",
      );

      const result = runCli(extractArgs(env, ["--no-plan"]), env.contentRoot);
      expect(result.code, `--no-plan 应成功：${result.out.slice(-400)}`).toBe(0);
      expect(result.out).toContain("--no-plan");
      const candidate = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        segmentation: { modeEvidence: { mode: string; planDigest: string | null } };
      };
      expect(candidate.segmentation.modeEvidence.mode, "必须走自动分段").toBe("automatic");
      expect(candidate.segmentation.modeEvidence.planDigest).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it("**默认位置恰好有可用计划 ⇒ 自动加载（既有行为不变）**", () => {
    const env = makeEnv("f5-autoload", multiUnitTranslationFixture());
    try {
      // 用真实坐标构造一份完整覆盖的计划（6 页，页眉显式标为家具）
      const result0 = runCliJson(extractArgs(env, ["--dry-run", "--json"]), env.contentRoot);
      expect(result0.code).toBe(0);
      const dryDigest = (result0.json.inventory as { digest: string }).digest;
      expect(dryDigest).toMatch(/^[0-9a-f]{64}$/);

      // 需要真实 assetKey 与逐页行数 —— 从 dry-run 的 candidate 结构拿不到，
      // 因此这里用 staging：先跑一次自动抽取写出候选，再从 candidate.json 读
      const auto = runCli(extractArgs(env), env.contentRoot);
      expect(auto.code).toBe(0);
      const candidate = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        inventory: { digest: string; assets: { assetKey: string; sha256: string }[] };
        extraction: { documents: { assetKey: string; pages: { page: number; hasTextLayer: boolean; lines: string[] }[] }[] };
      };
      const asset = candidate.inventory.assets[0]!;
      const doc = candidate.extraction.documents.find((d) => d.assetKey === asset.assetKey)!;
      const pages = doc.pages.filter((p) => p.hasTextLayer);
      expect(pages.length, "夹具必须是 6 页").toBe(6);

      const assignments = pages.flatMap((page) => [
        { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: page.page, lineStart: 1, lineEnd: 1 }, note: "重复页眉" },
        { channel: "source", range: { assetKey: asset.assetKey, page: page.page, lineStart: 2, lineEnd: page.lines.length }, note: null },
      ]);
      writeFileSync(
        join(env.plansDir, `${env.courseId}.json`),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            binding: {
              courseId: env.courseId,
              sourceDigest: candidate.inventory.digest,
              assets: [{ assetKey: asset.assetKey, sha256: asset.sha256 }],
            },
            author: "owner",
            createdAt: "2026-01-01T00:00:00.000Z",
            reason: "默认位置的完整计划",
            units: [{ title: "整份材料", kind: "translation_passage", assignments }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const loaded = runCli(extractArgs(env), env.contentRoot);
      expect(loaded.code, `默认位置加载应成功：${loaded.out.slice(-500)}`).toBe(0);
      expect(loaded.out).toContain("默认位置自动加载");
      const planned = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        segmentation: { modeEvidence: { mode: string; planDigest: string | null } };
      };
      expect(planned.segmentation.modeEvidence.mode, "必须按计划产段").toBe("human_planned");
      expect(planned.segmentation.modeEvidence.planDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      env.dispose();
    }
  });

  it("`--plan` 显式给出**可用**计划 ⇒ 退出 0 且按计划产段（正例）", () => {
    const env = makeEnv("f5-explicit-ok", multiUnitTranslationFixture());
    try {
      // 先自动抽取一次拿到真实坐标
      expect(runCli(extractArgs(env), env.contentRoot).code).toBe(0);
      const candidate = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        inventory: { digest: string; assets: { assetKey: string; sha256: string }[] };
        extraction: { documents: { assetKey: string; pages: { page: number; hasTextLayer: boolean; lines: string[] }[] }[] };
      };
      const asset = candidate.inventory.assets[0]!;
      const doc = candidate.extraction.documents.find((d) => d.assetKey === asset.assetKey)!;
      const pages = doc.pages.filter((p) => p.hasTextLayer);

      const assignments = pages.flatMap((page) => [
        { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: page.page, lineStart: 1, lineEnd: 1 }, note: null },
        { channel: "source", range: { assetKey: asset.assetKey, page: page.page, lineStart: 2, lineEnd: page.lines.length }, note: null },
      ]);
      const explicit = join(env.root, "explicit-plan.json");
      writeFileSync(
        explicit,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            binding: {
              courseId: env.courseId,
              sourceDigest: candidate.inventory.digest,
              assets: [{ assetKey: asset.assetKey, sha256: asset.sha256 }],
            },
            author: "owner",
            createdAt: "2026-01-01T00:00:00.000Z",
            reason: "显式给出的完整计划",
            units: [{ title: "显式单元", kind: "translation_passage", assignments }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runCli(extractArgs(env, ["--plan", explicit]), env.contentRoot);
      expect(result.code, `显式可用计划应成功：${result.out.slice(-500)}`).toBe(0);
      expect(result.out, "必须说明是显式强制").toContain("强制生效");
      const planned = JSON.parse(readFileSync(join(env.candidateDir, "candidate.json"), "utf8")) as {
        segmentation: { modeEvidence: { mode: string } };
      };
      expect(planned.segmentation.modeEvidence.mode).toBe("human_planned");
      void readPlanFile;
    } finally {
      env.dispose();
    }
  });
});
