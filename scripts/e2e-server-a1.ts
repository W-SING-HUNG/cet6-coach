#!/usr/bin/env node
/**
 * **A1 只读检查工作台**的 E2E 服务启动器（端口 3270）。
 *
 * ── 它存在的理由 ──
 *
 * 被验收的对象是**真实浏览器**里的完整 A1 流程。要拍出真实证据，
 * 就必须有一个真实的回环服务在监听、走一次**真实的 token 握手**，
 * 并有一份**真实的合成源目录**可以勾选。
 *
 * ── 它绝不碰真实材料 ──
 *
 * - 源目录建在 `.e2e/a1-source/`（合成夹具，含显眼的合成标识）；
 * - canonical 真题库建在 `.e2e/a1-papers/`（`sourceKind` 恒为 `test_fixture`）；
 * - 不打开数据库（A1 在结构上就没有这个能力）；
 * - 不写任何文件到 `private-content/`。
 *
 * ── 为什么源根是**预置**的 ──
 *
 * 弹出一个真实的系统模态文件夹窗口在自动化环境里无人可关 ——
 * 那会让整个 E2E 套件挂死。因此这里把合成源根**预置**进 A1 能力对象：
 * spec 一打开就能看到目录树、勾选、检查。
 *
 * 选取窗口本身的三条路径（取消 / 打不开 / 超时）由
 * `tests/course-a1-workbench.test.ts`（协议层）与 `pnpm course:a1-proof`
 * （真实进程层）覆盖 —— 而**真实弹窗成功**那条路径需要人操作，
 * 它在空间上不可自动化，如实登记为未验证。
 *
 * ── token 怎么交给 spec ──
 *
 * `startAnnotationServer` 生成随机 token 并放在 URL 的 **fragment** 里。
 * 这里把那条 URL 写进 `.e2e/a1-handoff.json`（**只有 URL 与源根标签**），
 * spec 读它并导航 —— 因此测到的是真实凭据流程，而不是旁路。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startAnnotationServer, newSessionToken, type AnnotationSession, type IntakeCapability } from "@/content/course-pipeline/segment-server";
import { renderIntakeShell } from "@/content/course-pipeline/intake-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
import { buildTextPdf, buildCjkPdf, buildImageOnlyPdf, buildMinimalDocx, buildSilentWav, writeSourceTree } from "../scripts/course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_PASSAGE_B,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "../scripts/course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { E2E_A1_HANDOFF_PATH, E2E_A1_PAPERS_ROOT, E2E_A1_PORT, E2E_A1_SOURCE_ROOT } from "../e2e/config";

function wrap(text: string, width = 70): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") { current = word; continue; }
    if (current.length + 1 + word.length > width) { lines.push(current); current = word; continue; }
    current += ` ${word}`;
  }
  if (current !== "") lines.push(current);
  return lines;
}

function wrapCjk(text: string, width = 24): string[] {
  const chars = [...text];
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) lines.push(chars.slice(index, index + width).join(""));
  return lines.filter((line) => line !== "");
}

/**
 * **合成**源目录内容（**显眼可辨的测试夹具**，不是任何真实课程材料）。
 *
 * 覆盖 A1 的四类形态与对抗性场景：
 * 有文本层 PDF / 无文字层 PDF / 损坏 PDF / 0 字节文件 /
 * DOCX（本版本不解析）/ 音频 / PDF+DOCX 同材料 / 写作模板 /
 * 中文翻译材料 / 嵌套目录。
 */
function buildSyntheticSource(): void {
  if (existsSync(E2E_A1_SOURCE_ROOT)) rmSync(E2E_A1_SOURCE_ROOT, { recursive: true, force: true });
  const tree = new Map<string, Buffer>();

  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      // 第 1 页：篇章一（Latin-1 PDF 只能承载 ASCII，因此标识用英文）
      ["SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL", "Reading Handout", "Passage One", "Questions 46 to 50 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_A)],
      // 第 2 页：题目
      ["Passage One Questions", "46. What did the synthetic researchers assume?", "A) A single synthetic spotlight.", "B) Synthetic divided capacity."],
      // 第 3 页：答案（课程主张，不是判分真相）
      ["Answer Keys", "46. A", "47. B"],
      // 第 4 页：篇章二
      ["Passage Two", "Questions 51 to 55 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_B)],
    ]),
  );
  // PDF + DOCX 同一份讲义：**等价性是提案，不是事实**
  tree.set("阅读/shared-handout.pdf", buildTextPdf([["SYNTHETIC FIXTURE - Shared Handout", "Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
  tree.set("阅读/shared-handout.docx", buildMinimalDocx("synthetic deferred docx"));
  // 对抗性形态
  tree.set("阅读/scanned-handout.pdf", buildImageOnlyPdf(2));
  tree.set("阅读/corrupted.pdf", Buffer.from("synthetic corrupt bytes, not a pdf at all", "utf8"));
  tree.set("阅读/empty.pdf", Buffer.alloc(0));
  // 中文翻译材料（多段，需要人工分段）—— 必须用 CJK 构造器
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["【合成夹具】翻译练习 · 请勿当真", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)],
      ["参考译文", ...wrapCjk(FIXTURE_TRANSLATION_REFERENCE)],
    ]),
  );
  // 写作模板：**按设计不参与** canonical 匹配
  tree.set(
    "写作/writing-template.pdf",
    buildTextPdf([
      [
        "SYNTHETIC FIXTURE - Writing Template",
        "Introduction: state the topic and your position in one sentence.",
        "Body: give the strongest reason with an example.",
        "Note: this template does not correspond to any single exam question.",
      ],
    ]),
  );
  // 听力套装：三个文件名各不相同 ⇒ 按目录合并（提案，需人工确认）
  tree.set(
    "听力/question-handout.pdf",
    buildTextPdf([["SYNTHETIC FIXTURE - Listening Comprehension", "Section A", "Questions 1 to 4 are based on the conversation."]]),
  );
  tree.set(
    "听力/transcript-analysis.pdf",
    buildTextPdf([["Transcript and Analysis", "Transcript", "Conversation One", "W: Synthetic line one.", "M: Synthetic line two."]]),
  );
  tree.set("听力/listening-full.wav", buildSilentWav(0.1));
  // 更深一层嵌套（验证多级目录）
  tree.set("阅读/第1套/extra-passages.pdf", buildTextPdf([["Passage Three", ...wrap(FIXTURE_PASSAGE_B)]]));

  writeSourceTree(E2E_A1_SOURCE_ROOT, tree);
}

/**
 * **合成** canonical 真题库（`sourceKind` 恒为 `test_fixture`）。
 *
 * 建 **12 份**卷子，且每份的仔细阅读篇章**内容唯一** ——
 * 这是"10+ 个不同目标"那条验收标准在浏览器里可被观察的前提：
 * 若所有卷子共用同一段文本，前 5 条建议就被完全并列的候选占满
 * （那是 5 条上限契约的正确行为，但看不到 10 个不同目标）。
 */
function buildSyntheticPapers(): void {
  if (existsSync(E2E_A1_PAPERS_ROOT)) rmSync(E2E_A1_PAPERS_ROOT, { recursive: true, force: true });
  mkdirSync(E2E_A1_PAPERS_ROOT, { recursive: true });

  for (let index = 0; index < 12; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    const fixture = buildFixturePackage({ id, year: 2024, session: "December", variant: `set${index + 1}` });
    const passage = uniqueSyntheticPassage(index + 1);
    const sections = fixture.manifest.sections as Record<string, unknown>[];
    const section = sections.find((item) => item.type === "reading.careful_reading");
    const groups = section!.groups as Record<string, unknown>[];
    groups[0].passage = passage;
    writeFixturePackage(E2E_A1_PAPERS_ROOT, id, fixture);
  }
}

/** 内容唯一的合成篇章（通用说明文，不是任何真实材料）。 */
function uniqueSyntheticPassage(index: number): string {
  const sentences: string[] = [];
  for (let s = 0; s < 10; s += 1) {
    sentences.push(
      `Synthetic marker ${index}-${s}: the discussion of topic number ${index * 17 + s} proceeds by distinguishing ` +
        `the ${index}-th hypothesis from its neighbours, and the argument for candidate ${index}-${s} rests on ` +
        `observable consequences rather than on the authority of the speaker who first proposed it.`,
    );
  }
  return sentences.join(" ");
}

async function main(): Promise<void> {
  buildSyntheticPapers();
  buildSyntheticSource();

  // 12 份卷子的仔细阅读篇章也要出现在源目录里，匹配才有真实证据。
  //
  // ── 两个必须同时成立的夹具条件（都实测踩到过）──
  //
  // 1. **每一份都必须带 `Passage One` 标记行，且它独占一行。**
  //    分段判据只认独立成行的篇章标记（`READING_PASSAGE_MARKER`）。
  //    把标识写在标记行的同一行（`SYNTHETIC FIXTURE - Passage One`）
  //    会让那一行不再"整行只有标记" ⇒ 分段退回文档级 `method_note` ⇒
  //    而 method_note 按设计不参与 canonical 匹配 ⇒ 一个目标都匹配不到。
  // 2. **文件必须落在带模块标签的目录下**（这里是 `阅读/`）。
  //    模块提示来自**文件夹标签**；放在一个无标签的目录（例如 `匹配/`）里，
  //    材料会退化成 `method_note`，同样永远匹配不上。
  //    实测：12 份全变成 method_note，`distinctTargetCount` 停在 5。
  const tree = new Map<string, Buffer>();
  for (let index = 0; index < 12; index += 1) {
    tree.set(
      `阅读/匹配材料/handout-${String.fromCharCode(97 + index)}.pdf`,
      buildTextPdf([
        [
          "SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL",
          "Passage One",
          ...wrap(uniqueSyntheticPassage(index + 1)),
        ],
      ]),
    );
  }
  writeSourceTree(E2E_A1_SOURCE_ROOT, tree);

  const papersDir = joinPapersDir();
  const token = newSessionToken();
  const sourceRoot = E2E_A1_SOURCE_ROOT;

  const capability: IntakeCapability = {
    async pickFolder() {
      /*
       * E2E 里**不弹**真实模态窗口（自动化环境无人可关它）。
       * 选取窗口的三条失败路径由单元测试与 a1-proof 覆盖；
       * 这里回一个明确的"已取消"，让人不会误以为它被验证过。
       */
      return {
        outcome: "cancelled",
        path: null,
        detail: "E2E 实例不打开系统窗口（源目录已预置）。",
        newFolderButtonHidden: null,
      };
    },
    rememberSource(path: string) {
      void path;
    },
    sourceLabel() {
      return sourceRoot.split(/[\\/]/).filter((part: string) => part !== "").pop() ?? "source";
    },
    hasSource() {
      return existsSync(sourceRoot);
    },
    async browse() {
      return inspectSourceTree(sourceRoot);
    },
    async inspect(selection) {
      return runInspection({ sourceRoot, courseId: "a1-e2e-fixture", selection, papersDir });
    },
    forgetSource() {
      /* E2E 里源根是预置的，不支持忘掉 */
    },
  };

  const session: AnnotationSession = {
    token,
    courseId: "a1-e2e-fixture",
    sourceDigest: "",
    config: { courseId: "a1-e2e-fixture", sourceDigest: "", assets: [], existingPlan: null },
    savePlan() {
      // A1 模式：**结构性拒绝**（E2E 也要证明这一条）
      return { ok: false, detail: "A1 只读工作台不具备保存计划的能力（这是设计，不是错误）。", planDigest: "" };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: E2E_A1_PORT,
    page: () => renderAnnotationShell(),
    intakePage: () => renderIntakeShell(),
  });

  mkdirSync(dirname(E2E_A1_HANDOFF_PATH), { recursive: true });
  writeFileSync(
    E2E_A1_HANDOFF_PATH,
    `${JSON.stringify(
      {
        /*
         * ── URL 的构造必须显式，不能对 `handle.url` 做字符串拼接 ──
         *
         * `handle.url` 形如 `http://127.0.0.1:<port>/#token=…` ——
         * 路径在 `#` **之前**。若写成 `handle.url.replace(/\/$/, "") + "/intake"`，
         * 结果会把 `/intake` 接到 fragment **之后**（`#token=…/intake`），
         * 于是浏览器打开的是 `GET /`（既有标注外壳），
         * 而 spec 会一直等一个永远不会出现的 `#tree`。
         * 实测踩到过：表现为每一条用例都 30 秒超时。
         */
        url: `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`,
        port: handle.port,
        boundAddress: handle.boundAddress,
        // **只有目录名**，不含任何绝对路径
        sourceLabel: capability.sourceLabel(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`[e2e-server-a1] 只读检查工作台: http://${handle.boundAddress}:${handle.port}/intake`);
  console.log(`[e2e-server-a1] 合成源目录标签: ${capability.sourceLabel()}（非真实材料）`);
  console.log(`[e2e-server-a1] 合成真题库: 12 份 test_fixture 包`);

  process.on("SIGINT", () => {
    void handle.close().then(() => process.exit(0));
  });
}

/** `writeFixturePackage` 自己会拼 `cet6/papers`，因此返回它上面那一层。 */
function joinPapersDir(): string {
  return `${E2E_A1_PAPERS_ROOT}/cet6/papers`;
}

main().catch((error: unknown) => {
  console.error("[e2e-server-a1] 启动失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
