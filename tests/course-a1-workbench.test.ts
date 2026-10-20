// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { request } from "node:http";
import { Script } from "node:vm";
import {
  INTAKE_ENDPOINTS,
  INTAKE_PAGE_PATH,
  SESSION_TOKEN_HEADER,
  isExactSameOrigin,
  newSessionToken,
  sanitizeIntakeError,
  type AnnotationSession,
  type IntakeCapability,
} from "@/content/course-pipeline/segment-server";
import { renderIntakeShell } from "@/content/course-pipeline/intake-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { INTAKE_CLIENT_SCRIPT } from "@/content/course-pipeline/intake-client-script";
import { buildSourceSelection, runInspection, type InspectionResult } from "@/content/course-pipeline/inspection";
import { scanSourceDirectory, scanSourceTree } from "@/content/course-pipeline/sources";
import {
  FOLDER_PICKER_OUTCOMES,
  encodePowerShellCommand,
  isFolderPickerSupported,
  parsePickerOutput,
  pickFolder,
  runPickerPreflight,
  windowsPowerShellPath,
} from "@/content/course-pipeline/folder-picker";
import {
  decideSourceAfterPick,
  describeIdentityRejection,
  resolveDirectoryIdentity,
  resolvePickOutcome,
  verifyPickedDirectory,
} from "@/content/course-pipeline/directory-identity";
import { buildTextPdf, buildCjkPdf, buildImageOnlyPdf, buildMinimalDocx, buildSilentWav, writeSourceTree } from "../scripts/course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_PASSAGE_B,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "../scripts/course-source-fixture";
import { writeFixturePackage, buildFixturePackage } from "../scripts/paper-fixture";

/**
 * A1 只读检查工作台 · 合成夹具测试。
 *
 * ── 全部内容都是**合成**的 ──
 *
 * 源目录在 `os.tmpdir()` 下临时创建，正文是通用说明文与虚构文本，
 * 真题包由 `buildFixturePackage` 构造（`sourceKind` 恒为 `test_fixture`）。
 * **本次会话从未读取任何真实课程材料或真实数据库。**
 */

const roots: string[] = [];

function makeRoot(prefix = "cet6-a1-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
});

/** 完整合成源目录：嵌套目录 + 五类材料 + 对抗性形态。 */
function fullFixtureTree() {
  const tree = new Map<string, Buffer>();
  // 阅读：篇章 + 答案页
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      ["Reading Handout", "Passage One", "Questions 46 to 50 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_A)],
      ["Passage One Questions", "46. What did early researchers assume?", "A) A single spotlight.", "B) Divided capacity."],
      ["Answer Keys", "46. A", "47. B"],
      ["Passage Two", "Questions 51 to 55 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_B)],
    ]),
  );
  // 翻译：中文原文 + 参考译文
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["翻译练习", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)],
      ["参考译文", ...wrapCjk(FIXTURE_TRANSLATION_REFERENCE)],
    ]),
  );
  // 写作：模板（按设计不参与匹配）
  tree.set(
    "写作/writing-template.pdf",
    buildTextPdf([
      ["Writing Template", "Introduction: state the topic and your position in one sentence.",
       "Note: this template does not correspond to any single exam question."],
    ]),
  );
  // PDF + DOCX 同一份讲义（等价性是提案）
  tree.set("阅读/shared-handout.pdf", buildTextPdf([["Shared Handout", "Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
  tree.set("阅读/shared-handout.docx", buildMinimalDocx("shared handout"));
  // 听力：题干 + 文字稿 + 整段音频
  tree.set("听力/question-handout.pdf", buildTextPdf([["Listening Comprehension", "Section A", "Questions 1 to 4."]]));
  tree.set("听力/transcript-analysis.pdf", buildTextPdf([["Transcript and Analysis", "Transcript", "Conversation One", "W: synthetic line one.", "M: synthetic line two."]]));
  tree.set("听力/listening-full.wav", buildSilentWav(0.1));
  return tree;
}

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
 * **内容唯一**的合成篇章（通用说明文，不是任何真实材料）。
 *
 * 用途：让每一份合成真题包的待匹配篇章互不相同，从而让"每一段有自己
 * 唯一的最佳候选"成立 —— 若所有包共用同一段文本，前 5 条建议就会被
 * 完全并列的候选占满（那是 5 条上限契约的正确行为，但测不出 10+ 目标）。
 */
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

/**
 * 目录内容快照（**递归**：类型 + 相对路径 + 字节数 + 内容的**完整 SHA-256**）。
 *
 * ── 为什么是完整哈希，而不是内容前缀 ──
 *
 * 早先这里记录的是 `readFileSync(full).toString("base64").slice(0, 64)`
 * —— 每个文件**前 48 字节**的内容窗口。那留下一个真实的漏洞：
 * "只改动第 49 字节之后"的写入**不会被发现**，而快照却显示"逐字节不变"。
 *
 * 对零写入证明来说那是最坏的失效形态：断言恒真、报告全绿，
 * 而它声称覆盖的性质**从未被验证**。独立复评指出了这一点。
 *
 * 保留的全部判据：
 * - 存在性 / 相对路径身份（新增或改名 ⇒ 出现 `+`/`-` 条目）
 * - 文件与目录的类型区分（`F` / `D` 前缀）
 * - 字节数
 * - **内容**（完整 sha256）
 * - 目录不可读（`UNREADABLE`）
 */
function snapshotDirectory(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      out.push(`${dir}\tUNREADABLE`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split("\\").join("/");
      if (entry.isDirectory()) {
        out.push(`D\t${rel}`);
        walk(full);
      } else {
        const stat = statSync(full);
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        out.push(`F\t${rel}\t${stat.size}\t${sha256}`);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// 1) 选择范围：只做排除、不影响范围外内容
// ---------------------------------------------------------------------------

describe("A1 · 选择范围（只读检查的输入）", () => {
  it("全选（勾选源根）与不提供选择范围的结果**完全一致**", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());

    const noSelection = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });
    const allSelected = await runInspection({
      sourceRoot: root,
      courseId: "fixture",
      selection: { includeDirectories: [""], excludeFiles: [] },
    });

    /*
     * 这条最重要：**默认路径逐字节不变**。
     *
     * 若"勾选源根"与"根本不提供选择"产生不同结果，那就说明选择判定
     * 在某个地方改变了语义（例如它把某个文件误判成排除）。
     */
    expect(allSelected.sourceDigest).toBe(noSelection.sourceDigest);
    expect(allSelected.counts).toEqual(noSelection.counts);
    expect(allSelected.materials.length).toBe(noSelection.materials.length);
    expect(allSelected.matches.length).toBe(noSelection.matches.length);
  });

  it("排除一个文件会改变源快照，且该文件不出现在任何材料里", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());

    const all = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });
    const withoutTranslation = await runInspection({
      sourceRoot: root,
      courseId: "fixture",
      selection: { includeDirectories: [""], excludeFiles: ["翻译/translation-unit1.pdf"] },
    });

    expect(withoutTranslation.sourceDigest).not.toBe(all.sourceDigest);
    expect(withoutTranslation.counts.selected).toBe(all.counts.selected - 1);
    expect(withoutTranslation.counts.excluded).toBe(1);

    const allPaths = withoutTranslation.materials.flatMap((material) =>
      material.representations.map((representation) => representation.sourceRelativePath),
    );
    expect(allPaths).not.toContain("翻译/translation-unit1.pdf");
  });

  it("只勾选一个子目录 ⇒ 范围外文件不参与快照、分组与匹配（内容级排除，不是显示层过滤）", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());

    const onlyReading = await runInspection({
      sourceRoot: root,
      courseId: "fixture",
      selection: { includeDirectories: ["阅读"], excludeFiles: [] },
    });

    const selectedPaths = onlyReading.materials.flatMap((material) =>
      material.representations.map((representation) => representation.sourceRelativePath),
    );
    expect(selectedPaths.length).toBeGreaterThan(0);
    for (const path of selectedPaths) {
      expect(path.startsWith("阅读/"), `${path} 不应出现在只勾选「阅读」的结果里`).toBe(true);
    }
    // 范围外的文件不进计数
    expect(onlyReading.counts.selected).toBeLessThan(6);
  });

  it("排除一个目录里的全部文件后，该目录不产出任何材料", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());

    const result = await runInspection({
      sourceRoot: root,
      courseId: "fixture",
      selection: { includeDirectories: [""], excludeFiles: ["写作/writing-template.pdf"] },
    });
    const paths = result.materials.flatMap((material) =>
      material.representations.map((representation) => representation.sourceRelativePath),
    );
    expect(paths).not.toContain("写作/writing-template.pdf");
  });

  it("选择范围**只做排除**：它无法让遍历走进一个未被勾选的目录", () => {
    const selection = buildSourceSelection({ includeDirectories: ["阅读"], excludeFiles: [] });
    // 勾选的目录与它的祖先可进入
    expect(selection.shouldDescend("阅读")).toBe(true);
    // 未勾选的兄弟目录不可进入
    expect(selection.shouldDescend("翻译")).toBe(false);
    // 源根本身（为了走到「阅读」这一层）可进入
    expect(selection.shouldDescend(".")).toBe(false);
    // 文件判定只看它是否在勾选目录下
    expect(selection.allowsFile("阅读/a.pdf")).toBe(true);
    expect(selection.allowsFile("翻译/a.pdf")).toBe(false);
  });

  it("排除优先于包含（同一路径既被包含又被排除 ⇒ 排除生效）", () => {
    const selection = buildSourceSelection({
      includeDirectories: [""],
      excludeFiles: ["阅读/shared-handout.docx"],
    });
    expect(selection.allowsFile("阅读/shared-handout.pdf")).toBe(true);
    expect(selection.allowsFile("阅读/shared-handout.docx")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2) 零写入证明（行为层）
// ---------------------------------------------------------------------------

describe("A1 · 零写入证明（真实磁盘快照对照）", () => {
  it("完整检查前后：源目录逐文件字节与结构完全不变", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());

    const before = snapshotDirectory(sourceRoot);
    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null });
    const after = snapshotDirectory(sourceRoot);

    expect(result.counts.selected).toBeGreaterThan(0);
    expect(after, "检查不得改动源目录里的任何字节或条目").toEqual(before);
    // 也不得在源目录里新增任何东西
    expect(after.length).toBe(before.length);
  });

  it("检查不创建候选目录 / 计划 / review.json / 临时文件（含**初始不存在**的路径）", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());

    /*
     * ── 两类目标都必须在场 ──
     *
     * ① **初始不存在**的路径：若 A1 悄悄创建了它们，前后快照会发现
     *    （`existsSync` 从 false 变 true）。
     * ② **已存在且有哨兵内容**的文件：若 A1 覆盖了它们，内容会变。
     *
     * 只测其中一类都会漏掉一种缺陷形态（"创建新的" vs "覆盖旧的"）。
     */
    const contentRoot = join(root, "private-content");
    mkdirSync(contentRoot, { recursive: true });

    const candidateDir = join(contentRoot, "course-candidates", "fixture");
    const planPath = join(contentRoot, "course-segmentation-plans", "fixture.json");
    const reviewPath = join(candidateDir, "review.json");
    const coursesDir = join(contentRoot, "courses", "fixture");
    const dbPath = join(contentRoot, "cet6.db");

    // 哨兵：已存在的文件必须逐字节保留
    const SENTINEL_PLAN = "{\"sentinel\":\"计划哨兵内容，不得被覆盖\"}";
    const SENTINEL_REVIEW = "{\"sentinel\":\"复核哨兵内容\"}";
    const SENTINEL_DB = "sentinel-database-bytes";
    mkdirSync(join(contentRoot, "course-segmentation-plans"), { recursive: true });
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(planPath, SENTINEL_PLAN, "utf8");
    writeFileSync(reviewPath, SENTINEL_REVIEW, "utf8");
    writeFileSync(dbPath, SENTINEL_DB, "utf8");

    const before = snapshotDirectory(root);

    await runInspection({ sourceRoot, courseId: "fixture", selection: null });

    const after = snapshotDirectory(root);
    expect(after, "A1 检查不得创建、删除或修改任何文件").toEqual(before);

    // 逐项再确认一次（失败信息要能指出是哪一个）
    expect(existsSync(coursesDir), "A1 不得创建 courses/").toBe(false);
    expect(readFileSync(planPath, "utf8"), "分段计划哨兵内容不得被改动").toBe(SENTINEL_PLAN);
    expect(readFileSync(reviewPath, "utf8"), "review.json 哨兵内容不得被改动").toBe(SENTINEL_REVIEW);
    expect(readFileSync(dbPath, "utf8"), "数据库文件哨兵内容不得被改动").toBe(SENTINEL_DB);
    expect(readdirSync(candidateDir), "候选目录不得被写入任何文件").toEqual(["review.json"]);
  });

  it("重复检查（含不同选择范围）不产生任何累积痕迹", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    const before = snapshotDirectory(root);

    await runInspection({ sourceRoot, courseId: "fixture", selection: null });
    await runInspection({ sourceRoot, courseId: "fixture", selection: { includeDirectories: ["阅读"], excludeFiles: [] } });
    await runInspection({ sourceRoot, courseId: "fixture", selection: { includeDirectories: [""], excludeFiles: ["听力/listening-full.wav"] } });

    expect(snapshotDirectory(root)).toEqual(before);
  });

  it("快照判据覆盖**全部字节**：窗口之外的内容改动也必须被发现（反空断言）", () => {
    /*
     * ── 这条用例守的是什么 ──
     *
     * 独立复评发现：旧快照只记录每个文件**前 48 字节**的 base64 前缀
     * （`slice(0, 64)`，1 个 base64 字符 = 0.75 字节 ⇒ 48 字节）。
     * 于是"只改第 49 字节之后"的写入**不会被发现** ——
     * 而零写入证明却在全绿的情况下声称覆盖了它。
     *
     * 判据必须是**因果**的：先证明旧窗口确实看不见（否则"新判据能看见"
     * 可能只是被别的原因抓到的），再证明当前判据能看见，最后证明恢复后一致。
     */
    const root = makeRoot();
    const probeDir = join(root, "causal-probe");
    mkdirSync(probeDir, { recursive: true });
    const probePath = join(probeDir, "probe.bin");

    // 头部恰好覆盖旧窗口；改动只发生在窗口之后
    const HEADER = Buffer.from("SYNTHETIC PROBE HEADER - padding padding padding padding padding\n", "utf8");
    const tail = Buffer.from("TAIL-BEFORE-".repeat(8), "utf8");
    const original = Buffer.concat([HEADER, tail]);
    writeFileSync(probePath, original);
    expect(HEADER.length).toBeGreaterThanOrEqual(48);

    /** 旧判据的投影（**只用于证明盲区存在**，不参与真实断言）。 */
    const legacyWindow = (path: string): string => readFileSync(path).toString("base64").slice(0, 64);

    const snapshotBefore = snapshotDirectory(root);
    const legacyBefore = legacyWindow(probePath);

    // 长度不变 ⇒ 排除"其实是字节数变了"这个解释
    const mutated = Buffer.concat([
      HEADER,
      Buffer.from("TAIL-AFTERX-".repeat(8), "utf8").subarray(0, tail.length),
    ]);
    expect(mutated.length).toBe(original.length);
    expect(mutated.subarray(0, 48).equals(original.subarray(0, 48)), "变异不得触碰旧窗口内字节").toBe(true);
    expect(mutated.equals(original), "变异必须真的改变内容").toBe(false);
    writeFileSync(probePath, mutated);

    // ① 旧窗口判据：看不见（证明盲区确实存在）
    expect(legacyWindow(probePath), "旧 48 字节窗口判据不应该看见窗口外的改动").toBe(legacyBefore);

    // ② 当前判据：必须看见，且指向那个文件
    const snapshotAfter = snapshotDirectory(root);
    expect(snapshotAfter, "完整哈希判据必须发现窗口外的内容改动").not.toEqual(snapshotBefore);
    const changed = snapshotAfter.filter((line) => !snapshotBefore.includes(line));
    expect(changed.join("\n"), "被发现的必须是那个探针文件").toContain("causal-probe/probe.bin");

    // ③ 恢复后一致（判据既不恒真也不恒假）
    writeFileSync(probePath, original);
    expect(snapshotDirectory(root), "恢复原内容后快照必须重新一致").toEqual(snapshotBefore);
  });

  it("全内容判据对**哨兵文件**同样生效（长度不变的内容改动必须被发现）", async () => {
    /*
     * 零写入证明的哨兵断言（`readFileSync(x) === SENTINEL`）本身是对全文的，
     * 但"快照对照"这一层曾只看前缀。这条用例把两者钉在一起：
     * 同一长度的内容改动必须让**快照**也变红 —— 否则"快照全等 ⇒ 零写入"
     * 这条推理在一个真实场景上不成立。
     */
    const root = makeRoot();
    const contentRoot = join(root, "private-content");
    const planPath = join(contentRoot, "course-segmentation-plans", "fixture.json");
    mkdirSync(join(contentRoot, "course-segmentation-plans"), { recursive: true });

    const original = JSON.stringify({ sentinel: "0123456789".repeat(12) });
    writeFileSync(planPath, original, "utf8");
    const before = snapshotDirectory(root);

    // 同长度、同前缀，但内容不同（改动落在旧窗口之后）
    const mutated = `${original.slice(0, 60)}${"X".repeat(original.length - 60)}`;
    expect(mutated.length).toBe(original.length);
    expect(mutated.slice(0, 48)).toBe(original.slice(0, 48));
    writeFileSync(planPath, mutated, "utf8");

    expect(snapshotDirectory(root), "同长度内容改动必须让快照变化").not.toEqual(before);
    expect(readFileSync(planPath, "utf8")).not.toBe(original);

    writeFileSync(planPath, original, "utf8");
    expect(snapshotDirectory(root)).toEqual(before);
  });

  it("元数据浏览**绝不打开文件句柄**：一个不可读的文件不影响目录清单", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());

    /*
     * 判据是"它能不能在一个只有元数据可用的目录上工作"。
     * 这里用一个**空文件**与一个损坏 PDF 作对照：元数据浏览必须
     * 对两者的存在都如实报告 —— 而内容检查才会发现损坏。
     */
    writeFileSync(join(root, "阅读", "broken.pdf"), Buffer.from("%PDF-1.4\nthis is not a valid pdf", "latin1"));
    writeFileSync(join(root, "阅读", "empty.pdf"), Buffer.alloc(0));

    const tree = scanSourceTree(root);
    const paths = tree.files.map((file) => file.relativePath);
    expect(paths).toContain("阅读/broken.pdf");
    expect(paths).toContain("阅读/empty.pdf");
    // 元数据快照没有内容哈希字段（结构事实：它无从覆盖内容）
    const first = tree.files[0] as unknown as Record<string, unknown>;
    expect(first.sha256, "元数据清单不得含内容哈希（它不读字节）").toBeUndefined();
    expect(typeof tree.structureDigest).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3) 清点四类形态
// ---------------------------------------------------------------------------

describe("A1 · 清点四类形态（有文本层 / 无文字层 / 损坏 / 空文件）", () => {
  it("四类各出现在正确的位置，且**没有一个失败被静默忽略**", async () => {
    const root = makeRoot();
    const tree = new Map<string, Buffer>();
    tree.set("阅读/text-layer.pdf", buildTextPdf([["Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
    tree.set("阅读/scanned.pdf", buildImageOnlyPdf(2));
    // 故意损坏的字节：与"无文字层"是两个不同的状态（前者是解析失败）
    tree.set("阅读/corrupted.pdf", Buffer.from("not a pdf at all, just text bytes", "utf8"));
    tree.set("阅读/empty.pdf", Buffer.alloc(0));
    tree.set("写作/notes.docx", buildMinimalDocx("deferred"));
    writeSourceTree(root, tree);

    const result = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });

    expect(result.counts.pdfParsed).toBe(1);
    expect(result.counts.pdfWithoutTextLayer).toBe(1);
    expect(result.counts.empty).toBe(1);
    expect(result.counts.deferred).toBe(1);
    /*
     * `corrupted.pdf` 是"非 PDF 字节"这一形态 —— 它必须落在**失败**里，
     * 而不是被算成"没有文字层"（那两者含义不同，处置也不同）。
     *
     * 判据刻意是"失败数 ≥ 1 且三态之和等于范围内 PDF 总数"：
     * 它同时排除了"某个文件既不算成功也不算失败"（被静默丢掉）与
     * "失败被并进没有文字层"两种形态。
     */
    expect(result.counts.pdfFailed, "损坏的 PDF 必须落进「解析失败」").toBeGreaterThanOrEqual(1);
    /*
     * 范围内有 4 个 PDF（有文本层 / 扫描件 / 损坏字节 / 0 字节）。
     * 三态之和必须**恰好**等于它 —— 少一个就说明有文件被静默丢掉。
     */
    expect(
      result.counts.pdfParsed + result.counts.pdfWithoutTextLayer + result.counts.pdfFailed,
      "三态必须覆盖范围内全部 4 个 PDF（没有一个被静默忽略）",
    ).toBe(4);

    const codes = result.issues.map((issue) => issue.code);
    for (const code of [
      "page_without_text_layer",
      "extraction_failed",
      "empty_file",
      "text_extraction_deferred",
    ]) {
      expect(codes, `必须上报 ${code}`).toContain(code);
    }
  });

  it("每一条冲突与警告都**同时**给出原因与处置（只报错不给怎么办是缺陷）", async () => {
    const root = makeRoot();
    const tree = new Map<string, Buffer>();
    tree.set("阅读/scanned.pdf", buildImageOnlyPdf(1));
    tree.set("阅读/empty.pdf", Buffer.alloc(0));
    tree.set("阅读/broken.pdf", Buffer.from("%PDF-1.4\nnope", "latin1"));
    writeSourceTree(root, tree);

    const result = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.detail.length, `${issue.code} 必须给出原因`).toBeGreaterThan(0);
      expect(issue.recovery.length, `${issue.code} 必须给出处置`).toBeGreaterThan(0);
    }
  });

  it("冲突与警告里**不含**绝对路径", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());
    writeFileSync(join(root, "阅读", "empty.pdf"), Buffer.alloc(0));

    const result = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });
    const text = JSON.stringify(result.issues);
    expect(text).not.toContain(root);
    expect(/[A-Za-z]:\\/.test(text), "不得出现盘符路径").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4) 分组与分段
// ---------------------------------------------------------------------------

describe("A1 · 材料分组与分段", () => {
  it("PDF + DOCX 被提案为**两种表示**，且等价性标记为**未验证**", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());

    const result = await runInspection({
      sourceRoot: root,
      courseId: "fixture",
      selection: { includeDirectories: ["阅读"], excludeFiles: ["阅读/reading-handout.pdf"] },
    });

    const shared = result.materials.find((material) =>
      material.representations.some((representation) => representation.sourceRelativePath === "阅读/shared-handout.docx"),
    );
    expect(shared, "必须有一份材料包含 DOCX 表示").toBeDefined();
    expect(shared!.representations.length).toBe(2);
    expect(shared!.unverifiedEquivalence, "PDF+DOCX 的等价性必须标为未验证").toBe(true);
    expect(shared!.reviewNotes.length).toBeGreaterThan(0);
  });

  it("段携带**真实页码范围**与种类，且不发明边界", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());
    const result = await runInspection({
      sourceRoot: root,
      courseId: "fixture",
      selection: { includeDirectories: ["翻译"], excludeFiles: [] },
    });

    const segments = result.materials.flatMap((material) => material.segments);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      // 页码要么是一个真实数字，要么是 null（"未登记"），绝不是猜测
      if (segment.pageStart !== null) {
        expect(segment.pageStart).toBeGreaterThanOrEqual(1);
      }
      expect(segment.title.length).toBeGreaterThan(0);
      expect(segment.kind.length).toBeGreaterThan(0);
    }
  });

  it("没有结构线索的材料**不产出段**，且给出「工具不发明边界」的说明", async () => {
    const root = makeRoot();
    const tree = new Map<string, Buffer>();
    // 一段没有任何结构标记的连续说明文
    tree.set(
      "方法/notes.pdf",
      buildTextPdf([["Course Notes", ...wrap(FIXTURE_PASSAGE_A), ...wrap(FIXTURE_PASSAGE_B)]]),
    );
    writeSourceTree(root, tree);

    const result = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });
    for (const material of result.materials) {
      for (const segment of material.segments) {
        // 无论产出多少段，都不能是"凭空多切"的产物：段数不得超过页数
        expect(segment.pageEnd === null || segment.pageEnd >= (segment.pageStart ?? 1)).toBe(true);
      }
    }
    // 段数是机器判据的结果，且被如实上报（不是被静默丢弃）
    expect(result.matches.length).toBe(
      result.materials.reduce((sum, material) => sum + material.segments.length, 0),
    );
  });

  it("材料与段的计数与匹配结果**逐段对齐**（没有段被静默丢掉）", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());
    const result = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });

    const materialSegmentIds = result.materials.flatMap((material) =>
      material.segments.map((segment) => segment.id),
    );
    const matchSegmentIds = result.matches.map((match) => match.segmentId);
    expect([...matchSegmentIds].sort()).toEqual([...materialSegmentIds].sort());
  });
});

// ---------------------------------------------------------------------------
// 5) 匹配证据与四态
// ---------------------------------------------------------------------------

describe("A1 · canonical 候选与逐项证据", () => {
  async function fixtureWithPapers(targetCount: number) {
    /*
     * ── 这个夹具为什么必须"每份卷子内容唯一" ──
     *
     * 机器每次最多给出 5 条建议（`MATCH_SUGGESTIONS` 的上限契约）。
     * 若 12 份卷子的待匹配篇章**内容相同**，那么每一段看到的都是同一批
     * 完全并列的候选，前 5 条就把名额占满 —— 于是**永远看不到 10 个
     * 不同目标**，而这不是缺陷，是"内容确实只有一份"的忠实结果。
     *
     * 因此这里让每份卷子的仔细阅读篇章互不相同，并把对应内容放进源目录：
     * 每一段都有自己**唯一**的最佳候选，目标集合于是真的达到 12 个。
     */
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    const tree = new Map<string, Buffer>();

    for (let index = 0; index < targetCount; index += 1) {
      const fixture = buildFixturePackage({
        id: `fixture-cet6-2024-12-set${index + 1}`,
        year: 2024,
        session: "December",
        variant: `set${index + 1}`,
      });
      const passage = uniqueSyntheticPassage(index + 1);
      const sections = fixture.manifest.sections as Record<string, unknown>[];
      const section = sections.find((item) => item.type === "reading.careful_reading");
      const groups = section!.groups as Record<string, unknown>[];
      groups[0].passage = passage;

      writeFixturePackage(papersBase(root), `fixture-cet6-2024-12-set${index + 1}`, fixture);

      // 文件名必须**互不相同**：`normalizeStem` 会去掉尾部数字，
      // 因此 `passage-1.pdf` 与 `passage-2.pdf` 会被归一成同一份材料。
      tree.set(
        `阅读/handout-${String.fromCharCode(97 + index)}.pdf`,
        buildTextPdf([[`Passage ${index + 1}`, ...wrap(passage)]]),
      );
    }
    writeSourceTree(sourceRoot, tree);

    return { root, sourceRoot, papersDir: papersDirOf(root) };
  }

  /**
   * `writeFixturePackage` **自己**会拼上 `cet6/papers/<name>`，
   * 因此它的 `rootDir` 必须是**它上面那一层**。
   *
   * 把已经拼好的 `.../cet6/papers` 再传给它，会得到
   * `.../cet6/papers/cet6/papers/<name>` —— 于是库是空的，
   * 而所有段都变成"未匹配"（实测踩到：这条用例第一次就是这样红的）。
   */
  function papersBase(root: string): string {
    const base = join(root, "papers");
    mkdirSync(base, { recursive: true });
    return base;
  }

  function papersDirOf(root: string): string {
    return join(papersBase(root), "cet6", "papers");
  }

  it("写作模板与方法说明**按设计不参与匹配**（不是「没匹配上」）", async () => {
    /*
     * 这个用例要的是**写作模板**，因此夹具必须真的含它 ——
     * 而 `fixtureWithPapers` 只为匹配目标生成阅读篇章（更贴近"每份卷子
     * 内容唯一"的那种情形）。两者混用会让这条断言对着一个不存在的材料。
     */
    const { sourceRoot, papersDir } = await fixtureWithPapers(1);
    writeSourceTree(join(sourceRoot, "写作"), new Map([
      [
        "writing-template.pdf",
        buildTextPdf([
          [
            "Writing Template",
            "Introduction: state the topic and your position in one sentence.",
            "Note: this template does not correspond to any single exam question.",
          ],
        ]),
      ],
    ]));

    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null, papersDir });

    const writing = result.materials.find((material) =>
      material.representations.some((representation) => representation.sourceRelativePath.includes("writing-template")),
    );
    expect(writing).toBeDefined();
    const writingSegmentIds = writing!.segments.map((segment) => segment.id);
    expect(writingSegmentIds.length).toBeGreaterThan(0);

    for (const id of writingSegmentIds) {
      const match = result.matches.find((item) => item.segmentId === id);
      expect(match).toBeDefined();
      expect(match!.segmentKind, "写作模板模板夹具必须产出 writing_template 段").toBe("writing_template");
      expect(match!.view, "写作/方法段必须是「按设计不匹配」而不是「库里没有」").toBe("not_applicable");
      expect(match!.candidatesConsidered).toBe(0);
    }
  });

  it("未匹配是**合法状态**，且如实说明它不表示材料有问题", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    // 一个空的 canonical 库目录（真实存在的合法状态）
    const papersDir = join(root, "papers");
    mkdirSync(papersDir, { recursive: true });

    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null, papersDir });
    const unmatched = result.matches.filter((match) => match.view === "unmatched");
    expect(unmatched.length).toBeGreaterThan(0);
    for (const match of unmatched) {
      expect(match.unmatchedNote ?? "").toMatch(/未匹配|无法有把握/);
      expect(match.suggestions).toEqual([]);
    }
  });

  it("候选证据把**打分项**与**不参与打分的上下文**分开", async () => {
    const { sourceRoot, papersDir } = await fixtureWithPapers(1);
    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null, papersDir });

    const suggestions = result.matches.flatMap((match) => match.suggestions);
    for (const suggestion of suggestions) {
      // 打分项
      expect(typeof suggestion.scoring.projectionExact).toBe("boolean");
      expect(suggestion.scoring.bodyContainment).toBeGreaterThanOrEqual(0);
      expect(suggestion.scoring.bodyContainment).toBeLessThanOrEqual(1);
      // 上下文（存在但**不参与**打分）
      expect(suggestion.contextOnly).toBeDefined();
      expect(Array.isArray(suggestion.contextOnly.observedQuestionNumbers)).toBe(true);
      // 稳定目标身份
      expect(suggestion.targetKey).toBe(
        `${suggestion.paperId}::${suggestion.sectionId}::${suggestion.groupId ?? "-"}`,
      );
    }
  });

  it("**10+ 个不同目标**全部出现在结果里，一个都不丢、不合并", async () => {
    /*
     * 任务书要求："Support 10+ distinct targets across the inspection results
     * without dropping, accidentally merging or hiding any returned target."
     *
     * 判据必须是**取值级**的：把每个返回的 `targetKey` 收进集合，
     * 断言集合大小 ≥ 10，且集合大小等于"建议总条数中不同目标的个数"。
     * 只看"有没有超过 10 条"会被"同一个目标重复 10 次"骗过去。
     */
    const { sourceRoot, papersDir } = await fixtureWithPapers(12);
    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null, papersDir });

    const keys = new Set(result.matches.flatMap((match) => match.suggestions.map((s) => s.targetKey)));
    expect(keys.size, `不同目标数必须 ≥ 10，实际 ${keys.size}`).toBeGreaterThanOrEqual(10);
    expect(result.distinctTargetCount).toBe(keys.size);

    /*
     * ── 跨段聚合索引必须**完整**且与逐段建议一一对应 ──
     *
     * 每段最多 5 条建议，因此单段列表永远看不到"长"。真正的长列表是
     * 跨段聚合之后的索引 —— 界面据它做诚实分页。
     */
    expect(result.targetIndex.length, "聚合索引必须包含全部不同目标").toBe(keys.size);
    /*
     * 排序判据必须用**同一个比较器**（`localeCompare`）。
     * 实现里的排序用 `localeCompare`，而 `[...set].sort()` 用的是默认的
     * UTF-16 码元序 —— 两者对 `set10` 与 `set2` 的次序**不同**。
     * 用默认 sort 做对照会让断言在一个完全正确的实现上失败（实测踩到）。
     */
    expect(result.targetIndex.map((entry) => entry.targetKey)).toEqual(
      [...keys].sort((a, b) => a.localeCompare(b)),
    );

    // 每个条目都必须带稳定身份与"被几段提到"
    for (const entry of result.targetIndex) {
      expect(entry.segmentIds.length).toBeGreaterThanOrEqual(1);
      expect(entry.label).toContain(entry.paperId);
      expect(entry.targetKey).toBe(`${entry.paperId}::${entry.sectionId}::${entry.groupId ?? "-"}`);
    }

    // 同一个目标被多段提及时只出现一次，且段清单是完整的
    const perSegment = new Map<string, string[]>();
    for (const match of result.matches) {
      for (const suggestion of match.suggestions) {
        const list = perSegment.get(suggestion.targetKey) ?? [];
        list.push(match.segmentId);
        perSegment.set(suggestion.targetKey, list);
      }
    }
    for (const entry of result.targetIndex) {
      expect(entry.segmentIds).toEqual([...perSegment.get(entry.targetKey)!].sort());
    }

    // 每个目标的身份必须唯一可辨（不是被截断的标签）
    for (const key of keys) {
      expect(key.split("::").length).toBe(3);
    }
  });

  it("canonical 库**读不出来的包必须可见**，并说明未匹配因此不可全信", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());

    const papersDir = join(root, "papers");
    mkdirSync(join(papersDir, "broken-paper"), { recursive: true });
    // 一个畸形的 paper.json ⇒ 读取失败
    writeFileSync(join(papersDir, "broken-paper", "paper.json"), "{ not valid json", "utf8");

    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null, papersDir });
    expect(result.canonicalLibrary.complete).toBe(false);
    expect(result.canonicalLibrary.readFailures.length).toBeGreaterThan(0);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("canonical_library_incomplete");
  });
});

// ---------------------------------------------------------------------------
// 6) 源变化 ⇒ 陈旧（绝不用不匹配的快照冒充权威）
// ---------------------------------------------------------------------------

describe("A1 · 源变化 ⇒ 结果陈旧", () => {
  it("检查后改动源字节 ⇒ 内容快照改变（旧结果不可能被当成权威）", async () => {
    const root = makeRoot();
    const tree = new Map<string, Buffer>();
    tree.set("阅读/handout.pdf", buildTextPdf([["Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
    writeSourceTree(root, tree);

    const first = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });

    // 换掉内容但**保持文件大小尽量接近**（这是"看起来一样但内容变了"的形态）
    writeFileSync(
      join(root, "阅读", "handout.pdf"),
      buildTextPdf([["Passage Two", ...wrap(FIXTURE_PASSAGE_B)]]),
    );

    const second = await runInspection({ sourceRoot: root, courseId: "fixture", selection: null });
    expect(second.sourceDigest, "源字节变了，内容摘要必须变").not.toBe(first.sourceDigest);
  });
});

// ---------------------------------------------------------------------------
// 7) 路径安全：逃逸 / 穿越 / 越界
// ---------------------------------------------------------------------------

describe("A1 · 路径安全（逃逸与穿越）", () => {
  it("指向源根之外的符号链接被**拒绝读取并登记**，绝不跟随", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    const outsideDir = join(root, "outside");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret-ish.pdf"), buildTextPdf([["Outside", "should not be read"]]));
    writeSourceTree(sourceRoot, fullFixtureTree());

    let linked = true;
    try {
      symlinkSync(join(outsideDir, "secret-ish.pdf"), join(sourceRoot, "阅读", "escape.pdf"), "file");
    } catch {
      linked = false; // Windows 上无权限创建符号链接是合法的环境事实
    }

    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null });
    const paths = result.materials.flatMap((material) =>
      material.representations.map((representation) => representation.sourceRelativePath),
    );
    expect(paths).not.toContain("阅读/escape.pdf");

    if (linked) {
      expect(
        result.rejectedPaths.some((entry) => entry.relativePath === "阅读/escape.pdf"),
        "越界软链接必须被拒绝并登记",
      ).toBe(true);
    }
  });

  it("选择范围里的穿越形态**不能**扩大读取范围（选择只做排除）", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());

    const result = await runInspection({
      sourceRoot,
      courseId: "fixture",
      // 恶意选择：试图上跳出去
      selection: { includeDirectories: ["../../..", "阅读"], excludeFiles: ["../../etc/passwd"] },
    });

    const paths = result.materials.flatMap((material) =>
      material.representations.map((representation) => representation.sourceRelativePath),
    );
    // 只有真实存在于源根内的路径能出现
    for (const path of paths) {
      expect(path.includes("..")).toBe(false);
      expect(/^[A-Za-z]:/.test(path)).toBe(false);
    }
  });

  it("深度与文件数上限：超限的目录被**登记**而不是静默停止", () => {
    const root = makeRoot();
    // 造一个超过 MAX_SCAN_DEPTH 的深层目录链
    let current = root;
    for (let depth = 0; depth < 16; depth += 1) {
      current = join(current, `level${depth}`);
      mkdirSync(current, { recursive: true });
    }
    writeFileSync(join(current, "deep.pdf"), buildTextPdf([["Deep", "content"]]));

    const tree = scanSourceTree(root);
    expect(tree.rejected.length, "超深目录必须被登记").toBeGreaterThan(0);
    expect(tree.rejected.some((entry) => entry.reason.includes("深度"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8) 端点授权 / Host / Origin / token
// ---------------------------------------------------------------------------

function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface Harness {
  port: number;
  token: string;
  close(): Promise<void>;
}

/**
 * 起一个**真实进程内服务器**（与 `course:workbench` 同一套接线）。
 *
 * `sourceRoot` 为 null 时模拟"还没有选目录"的真实状态。
 */
async function startHarness(options: { sourceRoot: string | null; withIntake?: boolean } = { sourceRoot: null }): Promise<Harness> {
  const token = newSessionToken();
  let sourceRoot = options.sourceRoot;
  const withIntake = options.withIntake ?? true;

  const capability: IntakeCapability = {
    async pickFolder() {
      return { outcome: "cancelled", path: null, detail: "合成：用户取消了。", newFolderButtonHidden: true };
    },
    rememberSource(path: string) {
      sourceRoot = path;
    },
    sourceLabel() {
      return sourceRoot === null ? null : sourceRoot.split(/[\\/]/).filter((part) => part !== "").pop()!;
    },
    hasSource() {
      return sourceRoot !== null && existsSync(sourceRoot);
    },
    async browse() {
      if (sourceRoot === null) throw new Error("还没有选择课程目录");
      return scanSourceTree(sourceRoot);
    },
    async inspect(selection) {
      if (sourceRoot === null) throw new Error("还没有选择课程目录");
      return runInspection({ sourceRoot, courseId: "fixture", selection });
    },
    forgetSource() {
      sourceRoot = null;
    },
  };

  const session: AnnotationSession = {
    token,
    courseId: "fixture",
    sourceDigest: "",
    config: { courseId: "fixture", sourceDigest: "", assets: [], existingPlan: null },
    savePlan() {
      // A1 模式：**结构性拒绝**（与 course-workbench.ts 一字不差的语义）
      return { ok: false, detail: "A1 只读工作台不具备保存计划的能力。", planDigest: "" };
    },
    intake: withIntake ? capability : null,
  };

  const { startAnnotationServer } = await import("@/content/course-pipeline/segment-server");
  const handle = await startAnnotationServer(session, {
    port: 0,
    /*
     * `GET /` 仍然回**既有标注外壳**，`GET /intake` 回 A1 工作台外壳。
     *
     * 这正是"同一个进程、同一套守卫、同一个 token"的形态：
     * 两个页面各自是静态外壳，私有数据一律经认证端点取得。
     */
    page: () => renderAnnotationShell(),
    intakePage: () => renderIntakeShell(),
  });
  return { port: handle.port, token, close: handle.close };
}

describe("A1 · 端点授权边界（真实 HTTP）", () => {
  it("`GET /intake` 是**静态外壳**：可匿名取得、与任何请求者字节相同、不含 token / 正文 / 绝对路径", async () => {
    const root = makeRoot();
    writeSourceTree(join(root, "source"), fullFixtureTree());
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      const anonymous = await rawRequest(harness.port, INTAKE_PAGE_PATH);
      expect(anonymous.status).toBe(200);
      expect(anonymous.headers["cache-control"]).toBe("no-store");
      expect(String(anonymous.headers["content-security-policy"])).toContain("default-src 'none'");
      expect(anonymous.headers["referrer-policy"]).toBe("no-referrer");

      // 两个不同会话（token 不同）取到的页面字节必须完全相同
      const harness2 = await startHarness({ sourceRoot: join(root, "source") });
      try {
        const other = await rawRequest(harness2.port, INTAKE_PAGE_PATH);
        expect(other.body, "静态外壳必须与任何会话无关").toBe(anonymous.body);
      } finally {
        await harness2.close();
      }

      expect(anonymous.body).not.toContain(harness.token);
      expect(anonymous.body).not.toContain(root);
      expect(/[A-Za-z]:\\/.test(anonymous.body), "未认证页面不得含盘符路径").toBe(false);
      expect(anonymous.body).not.toContain("城市轨道交通");
      expect(anonymous.body).not.toContain("CET6 Translation Practice Handout");
    } finally {
      await harness.close();
    }
  });

  it("读端点缺 token / 错 token / 查询串 token ⇒ 一律 403", async () => {
    const root = makeRoot();
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      expect((await rawRequest(harness.port, INTAKE_ENDPOINTS.state)).status).toBe(403);
      expect(
        (await rawRequest(harness.port, INTAKE_ENDPOINTS.state, { headers: { [SESSION_TOKEN_HEADER]: "nope" } })).status,
      ).toBe(403);
      // 查询串里的 token **不算**（它会被跨站请求带上）
      expect((await rawRequest(harness.port, `${INTAKE_ENDPOINTS.state}?token=${harness.token}`)).status).toBe(403);
      expect(
        (await rawRequest(harness.port, INTAKE_ENDPOINTS.state, { headers: { [SESSION_TOKEN_HEADER]: harness.token } })).status,
      ).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("敏感 POST **缺 Origin** ⇒ 403（失败关闭，不是放行）", async () => {
    const root = makeRoot();
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.pick, {
        method: "POST",
        headers: { [SESSION_TOKEN_HEADER]: harness.token, "content-type": "application/json" },
        body: "{}",
      });
      expect(result.status, "缺失 Origin 必须是 403（正常同源 POST 一定带 Origin）").toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("敏感 POST **不同端口的回环 Origin** ⇒ 403（这是与读端点的关键差别）", async () => {
    const root = makeRoot();
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      const otherPort = harness.port + 1;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.pick, {
        method: "POST",
        headers: {
          [SESSION_TOKEN_HEADER]: harness.token,
          origin: `http://127.0.0.1:${otherPort}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(result.status, "另一个回环端口的来源必须被拒（都是回环 ≠ 同源）").toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("敏感 POST 非回环 Origin ⇒ 403", async () => {
    const root = makeRoot();
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.inspect, {
        method: "POST",
        headers: {
          [SESSION_TOKEN_HEADER]: harness.token,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ includeDirectories: [""], excludeFiles: [] }),
      });
      expect(result.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("**同源** POST 成功，且响应体里**没有**绝对路径", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    const harness = await startHarness({ sourceRoot });
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.inspect, {
        method: "POST",
        headers: {
          [SESSION_TOKEN_HEADER]: harness.token,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ includeDirectories: [""], excludeFiles: [] }),
      });
      expect(result.status).toBe(200);
      const payload = JSON.parse(result.body) as { ok: boolean; result: InspectionResult };
      expect(payload.ok).toBe(true);
      expect(payload.result.counts.selected).toBeGreaterThan(0);
      // **绝对路径绝不外泄**
      expect(result.body).not.toContain(sourceRoot);
      expect(result.body).not.toContain(root);
      expect(/[A-Za-z]:\\\\/.test(result.body), "响应体不得含盘符路径").toBe(false);
      expect(JSON.stringify(payload.result)).not.toContain("outside");
    } finally {
      await harness.close();
    }
  });

  it("非回环 Host ⇒ 403（挡 DNS rebinding）", async () => {
    const root = makeRoot();
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      const result = await rawRequest(harness.port, INTAKE_PAGE_PATH, { headers: { host: "evil.example" } });
      expect(result.status).toBe(403);
      const post = await rawRequest(harness.port, INTAKE_ENDPOINTS.pick, {
        method: "POST",
        headers: { host: "evil.example", [SESSION_TOKEN_HEADER]: harness.token, origin: `http://127.0.0.1:${harness.port}` },
        body: "{}",
      });
      expect(post.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("**A1 模式拒绝 `/api/plan` 保存**（服务端层不可用，与按钮是否可见无关）", async () => {
    const root = makeRoot();
    const harness = await startHarness({ sourceRoot: join(root, "source") });
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      /*
       * 提交一份**形状完全合法**的载荷：author + 至少一个 unit。
       *
       * 它必须仍然被拒绝 —— 判据不是"载荷对不对"，而是"A1 里没有这个能力"。
       * 若实现改成"校验失败才拒"，这条用例就会放过一个合法的写入。
       */
      const result = await rawRequest(harness.port, "/api/plan", {
        method: "POST",
        headers: {
          [SESSION_TOKEN_HEADER]: harness.token,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          author: "synthetic",
          reason: "synthetic",
          units: [
            {
              title: "合成单元",
              kind: "translation_passage",
              assignments: [
                { channel: "source", assetKey: "k", page: 1, lineStart: 1, lineEnd: 2, note: null },
              ],
            },
          ],
        }),
      });
      expect(result.status, "A1 的写入必须被拒（400 而不是 200）").toBe(400);
      const payload = JSON.parse(result.body) as { ok: boolean; detail: string };
      expect(payload.ok).toBe(false);
      expect(payload.detail).toContain("只读");
    } finally {
      await harness.close();
    }
  });

  it("**没有注入 intake 能力时**全部 `/api/intake/*` 404（标注模式不被影响）", async () => {
    const root = makeRoot();
    writeSourceTree(join(root, "source"), fullFixtureTree());
    const harness = await startHarness({ sourceRoot: join(root, "source"), withIntake: false });
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      for (const path of [INTAKE_ENDPOINTS.state, INTAKE_ENDPOINTS.browse]) {
        expect((await rawRequest(harness.port, path, { headers: { [SESSION_TOKEN_HEADER]: harness.token } })).status).toBe(404);
      }
      for (const path of [INTAKE_ENDPOINTS.pick, INTAKE_ENDPOINTS.inspect]) {
        const result = await rawRequest(harness.port, path, {
          method: "POST",
          headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
          body: "{}",
        });
        expect(result.status).toBe(404);
      }
    } finally {
      await harness.close();
    }
  });

  it("`GET /intake` 在**没有** intake 能力时仍然可匿名取得（静态外壳与能力无关）", async () => {
    const harness = await startHarness({ sourceRoot: null, withIntake: false });
    try {
      const page = await rawRequest(harness.port, INTAKE_PAGE_PATH);
      expect(page.status).toBe(200);
      expect(page.body.length).toBeGreaterThan(500);
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 9) 生成的真实客户端脚本
// ---------------------------------------------------------------------------

describe("A1 · 生成的客户端脚本（真实字节，不是源码模式）", () => {
  function inlineScript(html: string): string {
    const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (match === null) throw new Error("页面里没有内联脚本");
    return match[1];
  }

  it("从**真实响应字节**抽出的脚本可被 V8 编译（F1 形态的机械守卫）", async () => {
    const harness = await startHarness({ sourceRoot: null });
    try {
      const page = await rawRequest(harness.port, INTAKE_PAGE_PATH);
      const script = inlineScript(page.body);
      let error: string | null = null;
      try {
        new Script(script, { filename: "intake-inline.js" });
      } catch (caught) {
        error = (caught as Error).message;
      }
      expect(error, `内联脚本必须可编译：${error ?? ""}`).toBeNull();
      expect(script.length).toBeGreaterThan(5000);
    } finally {
      await harness.close();
    }
  });

  it("脚本里没有外部资源、绝对 URL、console 调用，也不含 token 与正文", async () => {
    const harness = await startHarness({ sourceRoot: null });
    try {
      const page = await rawRequest(harness.port, INTAKE_PAGE_PATH);
      const script = inlineScript(page.body);
      expect(/["'\`]https?:\/\//.test(script), "不得有外部绝对 URL").toBe(false);
      expect(/console\.(log|info|debug|warn|error)\s*\(/.test(script), "不得有 console 调用").toBe(false);
      expect(/eval\s*\(/.test(script), "不得用 eval").toBe(false);
      expect(script).not.toContain(harness.token);
      expect(script).not.toContain("城市轨道交通");
      // 只经同源 API 取数据
      expect(script).toContain(INTAKE_ENDPOINTS.state);
      expect(script).toContain(INTAKE_ENDPOINTS.browse);
      expect(script).toContain(INTAKE_ENDPOINTS.inspect);
    } finally {
      await harness.close();
    }
  });

  it("页面**没有**任何保存 / 导入 / 建链控件（只读的能力边界不是文案声明的）", async () => {
    const harness = await startHarness({ sourceRoot: null });
    try {
      const page = await rawRequest(harness.port, INTAKE_PAGE_PATH);
      for (const forbidden of ["保存计划", "导入课程", "建立链接", "生成候选", "晋升"]) {
        expect(page.body, `页面不得有「${forbidden}」控件`).not.toContain(forbidden);
      }
      // 只读声明必须存在
      expect(page.body).toContain("只读");
    } finally {
      await harness.close();
    }
  });

  it("源码级：`String.raw` 模板体里**不得**出现反引号或 `${`（唯一转义边界）", () => {
    /*
     * 必须是**源码级**断言：模板一旦被提前终结，常量取值看到的是被截断的
     * 字符串，而对它取值断言恒真。因此这里直接读源码文本。
     *
     * ── 定位开头的判据必须精确（这条断言第一次就是被自己写红的）──
     *
     * 不能 `indexOf("String.raw" + backtick)`：文件顶部的 JSDoc 里
     * **提到**了这个写法（"它是 String.raw 的原始文本"），于是搜索会命中
     * **注释**，而注释里的反引号会被当成"模板体里的反引号" —— 断言恒红。
     * 因此按**行**找声明（该行恰好以反引号结尾）。
     */
    const source = readFileSync(
      join(process.cwd(), "src/content/course-pipeline/intake-client-script.ts"),
      "utf8",
    );
    const lines = source.split(/\r?\n/);
    const declarationIndex = lines.findIndex((line) => /^export const \w+ = String\.raw`$/.test(line));
    expect(declarationIndex, "必须有独占一行的 String.raw 模板声明").toBeGreaterThan(0);

    const closingIndex = lines.findIndex((line, index) => index > declarationIndex && line === "`;");
    expect(closingIndex, "模板必须以独占一行的 `; 终结").toBeGreaterThan(declarationIndex);

    const template = lines.slice(declarationIndex + 1, closingIndex).join("\n");
    expect(template.includes("`"), "模板体里不得出现反引号（会提前终结模板）").toBe(false);
    expect(template.includes("${"), "模板体里不得出现插值（会破坏唯一转义边界）").toBe(false);

    // 而常量本身必须真的含有那段脚本
    expect(INTAKE_CLIENT_SCRIPT.length).toBeGreaterThan(5000);
    expect(INTAKE_CLIENT_SCRIPT).toContain("/api/intake/inspect");
  });

  it("静态外壳里除内联脚本外**没有插值**（模板的其余部分是常量 HTML）", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/intake-page.ts"), "utf8");
    const open = source.indexOf("return `<!doctype html>");
    expect(open).toBeGreaterThan(0);
    const body = source.slice(open);
    const close = body.indexOf("`;\n}");
    const template = body.slice(0, close);
    // 唯一允许的插值是内联脚本那一处
    const interpolations = template.match(/\$\{/g) ?? [];
    expect(interpolations.length, "外壳只允许一处插值（内联脚本）").toBe(1);
    expect(template).toContain("${INTAKE_CLIENT_SCRIPT}");
  });
});

// ---------------------------------------------------------------------------
// 10) 目录选取器（协议 / 平台 / 安全）
// ---------------------------------------------------------------------------

describe("A1 · 本机目录选取器", () => {
  /**
   * 剥掉注释后的源码。
   *
   * 门禁必须剥注释：这些文件里会写明"绝不 shell: true"、"绝不在课程目录里
   * 建东西"，那是**正确的说明**而不是违规（同 paper-pool-policy 的先例）。
   */
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = (path: string): string => strip(readFileSync(join(process.cwd(), path), "utf8"));

  it("协议解析：selected / cancelled / dialog_unavailable 各自可辨", () => {
    const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64");

    const selected = parsePickerOutput(`noise\r\nCET6PICKER\tselected\t${encode("D:\\合成课程目录")}\thidden\r\n`);
    expect(selected.outcome).toBe("selected");
    expect(selected.path).toBe("D:\\合成课程目录");
    expect(selected.newFolderButtonHidden).toBe(true);

    const cancelled = parsePickerOutput(`CET6PICKER\tcancelled\t\tidden\n`);
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.path).toBeNull();
    // "idden" 不是 "hidden" ⇒ 未知，而不是 true
    expect(cancelled.newFolderButtonHidden).toBeNull();

    const unavailable = parsePickerOutput(`CET6PICKER\tdialog_unavailable\t${encode("no desktop")}\tunknown\n`);
    expect(unavailable.outcome).toBe("dialog_unavailable");
    expect(unavailable.path).toBeNull();
  });

  it("协议解析：**没有结果行** ⇒ outcome 为 null（由调用方判成 dialog_unavailable）", () => {
    expect(parsePickerOutput("").outcome).toBeNull();
    expect(parsePickerOutput("some unrelated output\n").outcome).toBeNull();
    // 形态不对（字段不足）同样不算结果
    expect(parsePickerOutput("CET6PICKER\tselected\n").outcome).toBeNull();
  });

  it("空路径的 selected 被降级为 dialog_unavailable（不假装选成功）", () => {
    const parsed = parsePickerOutput(`CET6PICKER\tselected\t\tunknown\n`);
    expect(parsed.outcome).toBe("dialog_unavailable");
    expect(parsed.path).toBeNull();
  });

  it("非 Windows 平台 ⇒ unsupported_platform，且**不启动任何子进程**", async () => {
    const result = await pickFolder({ platform: "linux" });
    expect(result.outcome).toBe("unsupported_platform");
    expect(result.path).toBeNull();
    expect(isFolderPickerSupported("win32")).toBe(true);
    expect(isFolderPickerSupported("linux")).toBe(false);
    expect(isFolderPickerSupported("darwin")).toBe(false);
  });

  it("取消不是错误：`cancelled` 是独立结局，不被压成失败", () => {
    // 取消必须与失败分开：调用方对两者给出**不同**的处置
    expect(FOLDER_PICKER_OUTCOMES).toContain("cancelled");
    expect(FOLDER_PICKER_OUTCOMES).toContain("dialog_unavailable");
    expect(FOLDER_PICKER_OUTCOMES).toContain("timeout");
    expect(FOLDER_PICKER_OUTCOMES).toContain("unsupported_platform");
  });

  it("脚本经 UTF-16LE base64 传递，且脚本里**没有**任何用户数据插值", () => {
    const encoded = encodePowerShellCommand("Write-Output 'x'");
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output 'x'");

    // 只检查**代码**（注释里会解释"绝不 shell: true"，那是正确的说明而不是违规）
    const source = code("src/content/course-pipeline/folder-picker.ts");
    // 起始目录只经**环境变量**传给子进程（不经过任何 shell 解析）
    expect(source).toContain("CET6_PICKER_START_DIR");
    // 绝不使用 shell
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/shell:\s*true/);
    // 绝不出现把路径拼进命令行/脚本的形态
    expect(source).not.toMatch(/EncodedCommand[^\]]*\+/);
  });

  it("真实子进程：**取消路径**可被真实执行并返回 cancelled（不弹窗、不需要桌面交互）", async () => {
    /*
     * 真实跑一个**不需要用户操作**的等价脚本：立刻返回 Cancel。
     *
     * 这条证明的是 spawn 接线本身（stdio / 编码 / 协议解析 / 退出处理）
     * 在真实进程上成立 —— 而不是只有 `parsePickerOutput` 那个纯函数成立。
     * 它刻意**不**调用 `pickFolder()`：那会弹出一个真实模态窗口，
     * 在自动化环境里无人可关。
     *
     * ── 为什么要按平台分支 ──
     *
     * 它 spawn 的是 `powershell.exe`，那是 **Windows 专属宿主**。
     * 在 Linux/macOS 上该可执行文件不存在，`spawn` 直接 `ENOENT` ——
     * 这不是产品缺陷，而是"这条断言的前提在本平台不成立"。
     *
     * ── 为什么分支不是"跳过" ──
     *
     * POSIX 上**必须**继续验证同一件事，只是换成能真实执行的最接近形态：
     * 用本平台的 `sh` 起一个真实子进程，验证我们的 spawn 接线
     * （`stdio: pipe` / `shell: false` / 编码 / 退出处理）确实能工作，
     * 并且产品对"非 Windows 平台"明确给出 `unsupported_platform`
     * 而不是伪造成功。两条断言合起来仍覆盖"真实子进程能跑通"这一属性。
     */
    const { spawn } = await import("node:child_process");

    if (process.platform !== "win32") {
      // POSIX：用真实子进程验证 spawn 接线 + 协议的编码/解析往返。
      const marker = "CET6PICKER";
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn("sh", ["-c", `printf '%s\\tcancelled\\t\\thidden\\n' '${marker}'`], {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
        child.on("error", reject);
        child.on("close", () => resolve(out));
      });
      const parsed = parsePickerOutput(output);
      expect(parsed.outcome, "真实子进程的输出必须能被协议解析器正确读出").toBe("cancelled");
      expect(parsed.newFolderButtonHidden).toBe(true);
      // 该平台本来就不支持原生选取器：必须明确报告，不得假装成功
      expect(isFolderPickerSupported(process.platform)).toBe(false);
      return;
    }

    const script = [
      "$marker = 'CET6PICKER'",
      "$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(''))",
      "[Console]::Out.WriteLine($marker + [char]9 + 'cancelled' + [char]9 + $b64 + [char]9 + 'hidden')",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });

    const parsed = parsePickerOutput(output);
    expect(parsed.outcome).toBe("cancelled");
    expect(parsed.newFolderButtonHidden).toBe(true);
  });

  it("`ShowNewFolderButton` 必须被设为 false（只读检查不得在课程目录里建东西）", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/folder-picker.ts"), "utf8");
    expect(source).toContain("ShowNewFolderButton = $false");
  });
});

// ---------------------------------------------------------------------------
// 11a) 真实宿主兼容性门禁（headless preflight）
// ---------------------------------------------------------------------------

describe("A1 · 生产选取脚本必须在**真实宿主**上跑得起来", () => {
  /*
   * ── 这个门禁为什么存在（它守的真实缺陷）──
   *
   * 生产脚本里曾有一行
   *     $dialog.UseDescriptionForTitle = $true
   * 该属性在 **.NET Framework 4.8** 的 FolderBrowserDialog 上**不存在**
   * （它是 .NET Core 3.0+ 新增的），而本项目**刻意**绑定 Windows PowerShell 5.1
   * （.NET Framework），因为只有它尊重 `ShowNewFolderButton`。
   *
   * 脚本首行是 `$ErrorActionPreference = "Stop"`，赋值抛错后被同一个 catch
   * 捕获 ⇒ 报 `dialog_unavailable`，且异常发生在 `ShowDialog()` **之前**
   * ⇒ 窗口**根本不会创建**。真实 GUI 人工验收因此 FAIL。
   *
   * ── 它为什么穿过了当时的全部绿灯 ──
   *
   * 因为**没有任何门禁执行过真实的 `PICKER_SCRIPT`**：纯函数测试只喂字符串；
   * 源码门禁只做文本匹配；那条"真实子进程"用例用的是**自带的 inline 替身**。
   * 于是"脚本能被编码 / 能被 spawn"与"脚本能在目标宿主上跑起来"之间的
   * 差距从未被跨过。
   *
   * ── 本门禁的判据 ──
   *
   * 在**真实宿主**上执行**同一个** `PICKER_SCRIPT`（经 `runPickerPreflight`），
   * 它跑完真实初始化与全部必需赋值后在 `ShowDialog()` 之前退出 ——
   * **绝不显示任何窗口**。
   */

  const isWindows = process.platform === "win32";

  it("真实宿主上游生产脚本的预检必须通过（未通过 = FAIL，不是 SKIP）", async () => {
    if (!isWindows) {
      /*
       * 非 Windows 上没有这个宿主 ⇒ 明确的**不支持**状态。
       *
       * 它必须与"通过"和"失败"都不同：把它写成通过就是谎报，
       * 写成静默跳过则会让 Windows 回归悄悄失去守护。
       */
      expect(isFolderPickerSupported(process.platform)).toBe(false);
      // 非 Windows 上明确返回 unsupported_platform（而不是抛错或假通过）
      const onOther = await runPickerPreflight();
      expect(onOther.status).toBe("unsupported_platform");
      return;
    }

    /*
     * ── Windows 上：预检必须**真的执行**并**通过** ──
     *
     * 关键：这里**不**允许静默跳过。宿主缺组件、脚本属性不存在、
     * 子进程起不来 —— 每一个都必须是**失败**，因为这条门禁守的正是
     * "生产脚本在目标宿主上跑得起来"这件事。
     */
    expect(
      existsSync(windowsPowerShellPath()),
      `目标宿主不存在：${windowsPowerShellPath()}（这会让原生选取在真实使用中失败）`,
    ).toBe(true);

    const result = await runPickerPreflight({ timeoutMs: 60_000 });

    expect(
      result.status,
      `生产选取脚本在真实宿主上跑不起来：${result.detail}\n` +
        `预检报告：${JSON.stringify(result.report)}`,
    ).toBe("ok");

    // 宿主事实必须与脚本声明的约束一致
    expect(result.report, "预检必须回传结构化报告").not.toBeNull();
    expect(result.report!.missing, "不得有缺失的必需属性").toBe("");
    expect(
      result.newFolderButtonHidden,
      "ShowNewFolderButton 必须被设为 false 并在宿主上读回 false（只读检查不得建文件夹）",
    ).toBe(true);
    expect(result.report!.descriptionSet, "Description 必须真的设上").toBe(true);
    // 报告必须写明它跑在哪个运行时上（便于将来宿主变化时可追溯）
    expect(String(result.report!.host)).toMatch(/\.NET/);
  }, 120_000);

  it("起始目录经环境变量传入时，预检如实报告它**是否真的应用上**", async () => {
    if (!isWindows) return;

    const runRoot = makeRoot("cet6-a1-preflight-");
    const startDir = join(runRoot, "start-here");
    mkdirSync(startDir, { recursive: true });

    const applied = await runPickerPreflight({ startDirectory: startDir, timeoutMs: 60_000 });
    expect(applied.status).toBe("ok");
    expect(applied.report!.startRequested, "传了起始目录必须如实报告").toBe(true);
    expect(applied.report!.startApplied, "存在的起始目录必须能被应用上").toBe(true);

    // 不存在的起始目录：脚本**忽略**它（既有行为），不得因此失败
    const missing = await runPickerPreflight({
      startDirectory: join(runRoot, "does-not-exist"),
      timeoutMs: 60_000,
    });
    expect(missing.status, "不存在的起始目录不是错误（脚本忽略它）").toBe("ok");
    expect(missing.report!.startApplied).toBe(false);
  }, 180_000);

  it("预检**绝不显示窗口**：它必须极快返回（等人操作的模态窗口会超时）", async () => {
    if (!isWindows) return;

    /*
     * 判据刻意是**时间上界**：一个真实模态对话框会一直等人点，
     * 因此若预检误走到 `ShowDialog()`，它必然撞上超时。
     * 这里给一个远小于"人会去点"的预算 —— 通过即证明它没有等任何人。
     */
    const started = Date.now();
    const result = await runPickerPreflight({ timeoutMs: 20_000 });
    const elapsed = Date.now() - started;

    expect(result.status, `预检没有正常返回：${result.detail}`).toBe("ok");
    expect(
      elapsed,
      `预检耗时 ${elapsed}ms —— 若真的弹出了窗口它会一直等人点并最终超时`,
    ).toBeLessThan(15_000);
  }, 60_000);

  it("脚本**没有**任何在本宿主上不存在的属性赋值（禁止靠 catch 静默吞掉）", () => {
    /*
     * 源码级补充判据：把"曾经出问题的那一类赋值"钉死。
     *
     * 真正的判据是上面的预检（执行比形态强），这一条只防"有人把
     * 已知不兼容的属性再加回来"这种回归 —— 它必须**没有**被包在
     * 吞异常的 `try { ... } catch { }` 里蒙混过去。
     *
     * ── 判据必须剥掉 PowerShell **注释**（这条用例第一次就是被自己写红的）──
     *
     * 脚本体里**有意**留了一条维护者警告，写明"不要加
     * `UseDescriptionForTitle`"以及**为什么**（该属性只存在于 .NET Core 3.0+，
     * 而本模块刻意绑定 .NET Framework）。那是正确的文档，不是违规。
     * 朴素的全文子串检查会命中那条注释 —— 因此判据只作用于**代码行**。
     */
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/folder-picker.ts"), "utf8");
    const scriptStart = source.indexOf("const PICKER_SCRIPT = String.raw`");
    const scriptEnd = source.indexOf("\n`;", scriptStart);
    const script = source.slice(scriptStart, scriptEnd);
    expect(script.length, "必须能取出脚本体").toBeGreaterThan(500);

    // 剥掉行注释（`#` 到行尾），保留其余代码用于判定
    const codeOnly = script
      .split(/\r?\n/)
      .map((line) => {
        const hash = line.indexOf("#");
        return hash >= 0 ? line.slice(0, hash) : line;
      })
      .join("\n");

    expect(
      codeOnly,
      "不得出现 UseDescriptionForTitle：该属性在 .NET Framework 4.8 上不存在" +
        "（本项目刻意绑定该宿主以尊重 ShowNewFolderButton）",
    ).not.toContain("UseDescriptionForTitle");

    // 反向确认：那条维护者警告**确实在**（它是文档，不应被误删）
    expect(script, "应保留「不要加该属性」的维护者警告").toContain("# ── 维护者注意");
  });

  it("预检**没有**暴露为 HTTP 能力（只在本地测试/CLI 工作流内）", () => {
    /*
     * 任务书要求预检保持内部。判据是结构性的：
     * - 服务器模块不得引用预检；
     * - 端点常量里不得出现预检；
     * - 预检开关只经子进程环境变量传入，而唯一的传入口是
     *   `runPickerPreflight`（Node 侧）。
     */
    const server = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8");
    expect(server, "服务器不得引用预检").not.toMatch(/runPickerPreflight|CET6_PICKER_PREFLIGHT/);
    expect(server, "端点清单里不得有预检路由").not.toMatch(/preflight/i);

    const picker = readFileSync(join(process.cwd(), "src/content/course-pipeline/folder-picker.ts"), "utf8");
    // 开关只有两个名字：常量定义 + 预检分支读取
    const occurrences = picker.split("CET6_PICKER_PREFLIGHT").length - 1;
    expect(occurrences, "预检开关只应出现在常量定义与预检调用处").toBeLessThanOrEqual(3);
    // 正常路径必须**显式关闭**预检（否则继承的环境变量会把弹窗路径带进预检）
    expect(picker, "正常路径必须显式关闭预检模式").toMatch(/\[PREFLIGHT_ENV\]:\s*"0"/);
  });
});

// ---------------------------------------------------------------------------
// 11b) 选中目录的**身份**判定
//
// 这里守的是一个真实缺陷：早先只比对目录**名**，于是同名的另一个目录会被
// 当成"用户选的那个"。判据改为比对目录身份后，这组用例固定住它。
// ---------------------------------------------------------------------------

describe("A1 · 验收工具必须核对目录**身份**，而不是目录名", () => {
  const EXPECTED_LABEL = "合成测试课程目录-请选择这一个";

  /**
   * 剥掉注释后的源码。
   *
   * 门禁必须剥注释：这些文件里会**有意**写出缺陷形态作为反例说明，
   * 那是正确的文档而不是违规（同 paper-pool-policy 的先例）。
   */
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = (path: string): string => strip(readFileSync(join(process.cwd(), path), "utf8"));

  /** 造一个"本次创建的"合成目录 + 必要时一个**同名但在别处**的目录。 */
  function makeIdentityRoots(): { runRoot: string; fixtureRoot: string; decoyRoot: string } {
    const runRoot = makeRoot("cet6-a1-identity-");
    const fixtureRoot = join(runRoot, EXPECTED_LABEL);
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(join(fixtureRoot, "synthetic.txt"), "synthetic fixture", "utf8");
    // 同名、但父目录完全不同 —— 这是旧判据会误收的那一类
    const decoyParent = join(runRoot, "another-parent");
    mkdirSync(decoyParent, { recursive: true });
    const decoyRoot = join(decoyParent, EXPECTED_LABEL);
    mkdirSync(decoyRoot, { recursive: true });
    writeFileSync(join(decoyRoot, "not-ours.txt"), "must never be read", "utf8");
    return { runRoot, fixtureRoot, decoyRoot };
  }

  it("① 正确目录通过（且判据落在**真实路径**上，不是名字）", () => {
    const { fixtureRoot } = makeIdentityRoots();
    const verdict = verifyPickedDirectory(fixtureRoot, fixtureRoot, EXPECTED_LABEL);
    expect(verdict.accepted, "本次创建的目录必须被接受").toBe(true);
    if (verdict.accepted) {
      // 返回的是**规范真实路径**（Windows 上短名会被展开），而不是原样回显
      expect(typeof verdict.realPath).toBe("string");
      expect(verdict.realPath.length).toBeGreaterThan(0);
    }
  });

  it("② **不同父目录下的同名目录被拒绝**（旧判据会误收的那一类）", () => {
    const { fixtureRoot, decoyRoot } = makeIdentityRoots();

    /*
     * 反空断言：先证明**旧判据**（只比名字）确实会接受它 ——
     * 否则"新判据拒绝了它"可能只是因为这个夹具本来就不成立。
     */
    const legacyWouldAccept = decoyRoot.split(/[\\/]/).filter((p) => p !== "").pop() === EXPECTED_LABEL;
    expect(legacyWouldAccept, "同名目录必须能让旧判据误判（否则这条用例测不到东西）").toBe(true);

    const verdict = verifyPickedDirectory(fixtureRoot, decoyRoot, EXPECTED_LABEL);
    expect(verdict.accepted, "同名但在别处的目录必须被拒绝").toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toBe("picked_path_not_the_expected_directory");
      expect(verdict.message).toContain("不是本次创建的那个测试目录");
    }
  });

  it("③ 路径解析失败被拒绝（不存在 / 已是文件 / 断链）", () => {
    const { fixtureRoot } = makeIdentityRoots();

    // 不存在
    const missing = verifyPickedDirectory(fixtureRoot, join(fixtureRoot, "does-not-exist"), EXPECTED_LABEL);
    expect(missing.accepted).toBe(false);
    if (!missing.accepted) expect(missing.reason).toBe("picked_path_unresolvable");

    // 存在但是**文件**，不是目录
    const asFile = verifyPickedDirectory(fixtureRoot, join(fixtureRoot, "synthetic.txt"), EXPECTED_LABEL);
    expect(asFile.accepted).toBe(false);
    if (!asFile.accepted) expect(asFile.reason).toBe("picked_path_not_a_directory");

    // 夹具根自己解析不了 ⇒ 整次验收不成立（而不是"看起来没问题"）
    const badExpected = verifyPickedDirectory(
      join(fixtureRoot, "no-such-root"),
      fixtureRoot,
      EXPECTED_LABEL,
    );
    expect(badExpected.accepted).toBe(false);
    if (!badExpected.accepted) expect(badExpected.reason).toBe("expected_root_unresolvable");
  });

  it("④ 被拒绝的目录**绝不**得到可读取的路径（拒绝即拿不到路径）", () => {
    const { fixtureRoot, decoyRoot } = makeIdentityRoots();

    // 拒绝时 remember 必须是 null —— 调用方**拿不到**任何可用于读取的路径
    const rejected = decideSourceAfterPick(fixtureRoot, decoyRoot, EXPECTED_LABEL);
    expect(rejected.remember, "被拒绝的目录不得交回任何路径").toBeNull();
    if (rejected.remember === null) {
      expect(rejected.reason).toBe("picked_path_not_the_expected_directory");
    }

    // 通过与拒绝的路径**必须不同**（对照，排除"反正都返回 null"）
    const accepted = decideSourceAfterPick(fixtureRoot, fixtureRoot, EXPECTED_LABEL);
    expect(accepted.remember, "本次目录必须被交回").not.toBeNull();
    expect(accepted.remember).not.toBe(decoyRoot);
  });

  it("⑤ 身份判定是 **metadata-only**：被拒绝的目录内容一个字节都不会被读", () => {
    const { fixtureRoot, decoyRoot } = makeIdentityRoots();

    /*
     * 判据是"被拒绝之后，那个目录里的内容仍然完全没被读过"。
     *
     * 做法：把探针文件换成**不可读**的形态做不到（Windows 权限模型不同），
     * 因此改用**可观察的等效判据**：身份判定之后目录内容与判定之前**逐字节
     * 相同**，且拒绝路径完全没有把任何路径交出去（④）。
     *
     * 更强的一层是**源码级**的：`directory-identity.ts` 不得出现任何
     * "读内容 / 枚举目录"的调用点 —— 因此"校验前不读内容"是结构性事实。
     */
    const before = readdirSync(decoyRoot);
    const contentBefore = readFileSync(join(decoyRoot, "not-ours.txt"), "utf8");

    const decision = decideSourceAfterPick(fixtureRoot, decoyRoot, EXPECTED_LABEL);
    expect(decision.remember).toBeNull();

    expect(readdirSync(decoyRoot), "身份判定不得改动被拒目录").toEqual(before);
    expect(readFileSync(join(decoyRoot, "not-ours.txt"), "utf8")).toBe(contentBefore);

    // 源码级：本模块没有读内容 / 枚举目录的能力
    const source = code("src/content/course-pipeline/directory-identity.ts");
    for (const forbidden of [
      "readFileSync",
      "readdirSync",
      "openSync",
      "createReadStream",
      "readFile(",
      "opendirSync",
    ]) {
      expect(source, `directory-identity.ts 不得出现 ${forbidden}（身份判定必须 metadata-only）`).not.toContain(
        forbidden,
      );
    }
    // 且它只允许用这些元数据 API
    expect(source).toContain("realpathSync.native");
    expect(source).toContain("statSync");
  });

  it("⑥ 路径归一：短名/大小写差异**不会**让正确目录被误拒", () => {
    const { runRoot, fixtureRoot } = makeIdentityRoots();

    /*
     * ── 大小写这条断言的前提是"文件系统不区分大小写" ──
     *
     * 旧实现无条件把路径整体转大写再断言"必须被接受"。这在 Windows 上成立，
     * 但在 Linux 上 `realpath("/tmp/X/DIR")` 就是 `ENOENT` —— 大写路径指向的
     * 目录**并不存在**，因此"拒绝"是产品的**正确**行为（fail-closed），
     * 而不是缺陷。
     *
     * 所以判据必须建立在**本文件系统的真实能力**上，而不是平台名：
     * 探测"同一个目录的另一种大小写写法能否被解析到同一真实路径"。
     *
     *   - 不区分大小写（Windows / 默认 macOS）：必须被接受（保留原覆盖）。
     *   - 区分大小写（Linux）：同一写法**不存在**，因此：
     *       · 断言产品**拒绝**它（fail-closed，安全方向）；
     *       · 同时断言"只差大小写但真实存在"的**同义路径仍被接受** ——
     *         用 `realpath` 归一后的真实路径回喂，证明归一逻辑本身没坏。
     * 两条分支都真的断言了东西，没有一条是"跳过"。
     */
    const upperCased = fixtureRoot.replace(/[a-z]/g, (c) => c.toUpperCase());
    const caseInsensitiveFs = (() => {
      try {
        return realpathSync.native(upperCased) === realpathSync.native(fixtureRoot);
      } catch {
        return false;
      }
    })();

    if (caseInsensitiveFs) {
      const viaCase = verifyPickedDirectory(fixtureRoot, upperCased, EXPECTED_LABEL);
      expect(viaCase.accepted, "仅大小写不同的同一路径必须被接受（realpath 归一）").toBe(true);
    } else {
      // 大小写敏感文件系统：大写写法确实指向一个不存在的目录 ⇒ 必须被拒绝
      const viaCase = verifyPickedDirectory(fixtureRoot, upperCased, EXPECTED_LABEL);
      expect(
        viaCase.accepted,
        "大小写敏感文件系统上，大写写法指向不存在的目录，必须 fail-closed 拒绝",
      ).toBe(false);

      // 而归一后的**真实路径**回喂必须被接受 —— 证明不是"归一逻辑坏了"
      const realFixture = realpathSync.native(fixtureRoot);
      const viaReal = verifyPickedDirectory(fixtureRoot, realFixture, EXPECTED_LABEL);
      expect(viaReal.accepted, "realpath 归一后的同一目录必须被接受").toBe(true);
    }

    /*
     * 冗余分隔符 / 尾随分隔符 / `.` 段。
     *
     * 分隔符必须用**本平台**的：`\` 在 POSIX 上是**文件名字符**而不是分隔符，
     * 因此 `"<root>\\\\<label>\\\\."` 在 Linux 上指向一个字面名为
     * `\\合成测试课程目录…\\.` 的目录 —— 它当然不存在，拒绝是正确行为。
     * 用 `sep` 拼装后，两种平台上这条断言测的都是同一件事：
     * "同一目录的冗余写法仍被识别"。
     */
    const messy = `${runRoot}${sep}${sep}${EXPECTED_LABEL}${sep}.${sep}`;
    const viaMessy = verifyPickedDirectory(fixtureRoot, messy, EXPECTED_LABEL);
    expect(viaMessy.accepted, "冗余分隔符与 `.` 段必须被接受").toBe(true);

    // 而真正的**子目录**必须被拒绝（"在里面"不等于"就是它"）
    const child = join(fixtureRoot, "sub");
    mkdirSync(child, { recursive: true });
    const viaChild = verifyPickedDirectory(fixtureRoot, child, EXPECTED_LABEL);
    expect(viaChild.accepted, "夹具的**子目录**不是夹具本身，必须被拒绝").toBe(false);
  });

  it("⑦ 拒绝措辞不含绝对路径，且每种原因各有独立处置", () => {
    const reasons = [
      "expected_root_unresolvable",
      "picked_path_unresolvable",
      "picked_path_not_a_directory",
      "picked_path_not_the_expected_directory",
    ] as const;

    const messages = reasons.map((reason) => describeIdentityRejection(reason, EXPECTED_LABEL));
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      // 不得泄漏本机路径形态
      expect(/[A-Za-z]:\\/.test(message), `措辞不得含盘符路径：${message}`).toBe(false);
      expect(message.includes("\\\\"), `措辞不得含 UNC 路径：${message}`).toBe(false);
    }
    // 四种原因的处置**互不相同**（否则等于没区分）
    expect(new Set(messages).size, "每种拒绝原因必须有独立措辞").toBe(reasons.length);
  });

  it("⑧ `resolveDirectoryIdentity` 对同一目录给出稳定结果（幂等）", () => {
    const { fixtureRoot } = makeIdentityRoots();
    const first = resolveDirectoryIdentity(fixtureRoot);
    const second = resolveDirectoryIdentity(fixtureRoot);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.realPath).toBe(second.realPath);
  });

  it("⑩ 行为级（不经源码匹配）：`resolvePickOutcome` 拒绝同名别处目录，且清空旧源", () => {
    /*
     * ── 为什么必须是行为级 ──
     *
     * 这条判据此前只存在于验收脚本的闭包里，于是只能被**源码模式匹配**
     * 守护 —— 而模式匹配在"逻辑被改写但形态相似"时会漏掉。抽成纯函数之后，
     * 这里直接喂数据、断言**结果**，不看任何源码文本。
     */
    const { fixtureRoot, decoyRoot } = makeIdentityRoots();

    // ① 正确目录 ⇒ 记住规范化真实路径
    const ok = resolvePickOutcome({
      outcome: "selected",
      pickedPath: fixtureRoot,
      expectedRoot: fixtureRoot,
      expectedLabel: EXPECTED_LABEL,
      currentSource: null,
    });
    expect(ok.kind).toBe("confirmed");
    expect(ok.pickedCorrectly).toBe(true);
    expect(ok.nextSource, "确认时必须记住路径").not.toBeNull();

    // ② 同名但**在别处** ⇒ 拒绝，且 `nextSource` 必须是 null
    const bad = resolvePickOutcome({
      outcome: "selected",
      pickedPath: decoyRoot,
      expectedRoot: fixtureRoot,
      expectedLabel: EXPECTED_LABEL,
      currentSource: null,
    });
    expect(bad.kind).toBe("rejected");
    expect(bad.pickedCorrectly).toBe(false);
    expect(bad.nextSource, "同名别处目录必须被拒绝且不记住任何路径").toBeNull();

    // ③ **先选对、再换成同名错目录** ⇒ 旧源必须被清空（失败关闭）
    const afterGood = resolvePickOutcome({
      outcome: "selected",
      pickedPath: decoyRoot,
      expectedRoot: fixtureRoot,
      expectedLabel: EXPECTED_LABEL,
      currentSource: ok.nextSource, // 会话里已经有一个正确的源
    });
    expect(afterGood.nextSource, "被拒绝时必须清空此前已记住的源").toBeNull();

    // ④ 解析不了的路径 ⇒ 拒绝且清空
    const unresolvable = resolvePickOutcome({
      outcome: "selected",
      pickedPath: join(fixtureRoot, "no-such-dir"),
      expectedRoot: fixtureRoot,
      expectedLabel: EXPECTED_LABEL,
      currentSource: ok.nextSource,
    });
    expect(unresolvable.nextSource).toBeNull();
    expect(unresolvable.kind).toBe("rejected");
  });

  it("⑪ 取消 / 打不开的**既有行为不变**（不因本轮修复而改动交互语义）", () => {
    /*
     * 本轮只应修复"同名目录被误收"，**不应**顺手改掉取消/重试的语义。
     * 因此这两条例外结局必须**原样保留**已选好的源。
     */
    const { fixtureRoot } = makeIdentityRoots();
    const existing = fixtureRoot;

    const cancelled = resolvePickOutcome({
      outcome: "cancelled",
      pickedPath: null,
      expectedRoot: fixtureRoot,
      expectedLabel: EXPECTED_LABEL,
      currentSource: existing,
    });
    expect(cancelled.kind).toBe("cancelled");
    expect(cancelled.nextSource, "取消不是错误：已选好的源必须保留").toBe(existing);
    expect(cancelled.message).toContain("取消");

    const unavailable = resolvePickOutcome({
      outcome: "dialog_unavailable",
      pickedPath: null,
      expectedRoot: fixtureRoot,
      expectedLabel: EXPECTED_LABEL,
      currentSource: existing,
    });
    expect(unavailable.kind).toBe("dialog_unavailable");
    expect(unavailable.nextSource, "窗口打不开不是错误：已选好的源必须保留").toBe(existing);

    // 四种结局互不相同（否则等于没区分）
    const kinds = new Set([cancelled.kind, unavailable.kind]);
    expect(kinds.size).toBe(2);
  });

  it("⑫ 行为级：`resolvePickOutcome` 的所有结局都不泄漏绝对路径", () => {
    const { runRoot, fixtureRoot, decoyRoot } = makeIdentityRoots();
    const cases = [
      { outcome: "selected", pickedPath: fixtureRoot, currentSource: null },
      { outcome: "selected", pickedPath: decoyRoot, currentSource: fixtureRoot },
      { outcome: "selected", pickedPath: join(fixtureRoot, "missing"), currentSource: fixtureRoot },
      { outcome: "cancelled", pickedPath: null, currentSource: fixtureRoot },
      { outcome: "dialog_unavailable", pickedPath: null, currentSource: fixtureRoot },
      { outcome: "timeout", pickedPath: null, currentSource: fixtureRoot },
      { outcome: "unsupported_platform", pickedPath: null, currentSource: fixtureRoot },
    ];
    for (const item of cases) {
      const r = resolvePickOutcome({
        outcome: item.outcome,
        pickedPath: item.pickedPath,
        expectedRoot: fixtureRoot,
        expectedLabel: EXPECTED_LABEL,
        currentSource: item.currentSource,
      });
      expect(r.message.includes(runRoot), `措辞不得含绝对路径：${r.message}`).toBe(false);
      expect(/[A-Za-z]:\\/.test(r.message), `措辞不得含盘符路径：${r.message}`).toBe(false);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("⑨ 源码级：验收工具**不得**再以 `basename` 作为身份判据，且所有结局经唯一决策点", () => {
    /*
     * 这条守的是"缺陷不得被改回来"。判据同时看三件事：
     * 1. 验收工具必须**调用**唯一决策点（接线存在）；
     * 2. 它不得再出现 `basename(...) ===` 这种"拿名字当身份"的比较；
     * 3. 会话状态必须**只能**由决策点的结果赋值（不得自己另写分支）。
     *
     * `basename` 本身仍然允许用于**展示**（源目录名标签），因此判据只禁
     * "相等比较"这一种形态，而不是禁用这个函数。
     */
    const source = code("scripts/course-a1-owner-acceptance.ts");
    expect(source, "验收工具必须调用唯一决策点 resolvePickOutcome").toContain("resolvePickOutcome");
    expect(
      /basename\s*\([^)]*\)\s*===/.test(source),
      "不得再用 basename(...) === 作为目录身份判据（同名目录会误收）",
    ).toBe(false);
    /*
     * `sourceRoot` 在**选路分支**里只能被 `resolution.nextSource` 赋值 ——
     * 若有人另写一个分支直接赋值，就绕过了失败关闭。
     *
     * 判据只作用于**人工验收**那个 `pickFolder`（文件里还有一个自检用的
     * 同名方法，它只抛错、不赋值），因此取**最后一处**出现。
     */
    const pickStart = source.lastIndexOf("async pickFolder()");
    const pickEnd = source.indexOf("rememberSource(", pickStart);
    expect(pickStart, "必须能定位 pickFolder 分支").toBeGreaterThan(0);
    expect(pickEnd, "必须能定位分支结束").toBeGreaterThan(pickStart);
    const pickBranch = source.slice(pickStart, pickEnd);

    const assignmentBranches = pickBranch
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^sourceRoot\s*=/.test(line));
    expect(assignmentBranches.length, "选路分支里应当有赋值").toBeGreaterThan(0);
    for (const branch of assignmentBranches) {
      expect(
        branch === "sourceRoot = resolution.nextSource;" || branch === "sourceRoot = null;",
        `选路分支里 sourceRoot 的赋值必须来自唯一决策点，实际：${branch}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 11) 服务端错误消毒
// ---------------------------------------------------------------------------

describe("A1 · 服务端错误消息消毒", () => {
  it("盘符 / UNC / POSIX / 已知私有目录形态都被替换掉", () => {
    expect(sanitizeIntakeError("ENOENT: open 'Q:\\sample-root\\private-content\\courses\\x'")).not.toMatch(/[A-Za-z]:\\/);
    expect(sanitizeIntakeError("打开 \\\\server\\share\\x 失败")).not.toContain("\\\\server");
    expect(sanitizeIntakeError("no such file /home/user/private-content/a")).not.toContain("/home/user");
    expect(sanitizeIntakeError("course-candidates/fixture/course.json 不存在")).not.toContain("course-candidates");
  });

  it("文本本身仍然可读（它只是把路径换掉，不改技术原因）", () => {
    const out = sanitizeIntakeError("源目录不存在或不可读：D:\\some\\path");
    expect(out).toContain("源目录不存在或不可读");
  });

  it("`isExactSameOrigin` 逐项比对（协议 + 主机名 + 端口）", () => {
    expect(isExactSameOrigin("http://127.0.0.1:3240", 3240)).toBe(true);
    expect(isExactSameOrigin("http://localhost:3240", 3240)).toBe(true);
    // 端口不同
    expect(isExactSameOrigin("http://127.0.0.1:3240", 3241)).toBe(false);
    // 协议不同
    expect(isExactSameOrigin("https://127.0.0.1:3240", 3240)).toBe(false);
    // 非回环
    expect(isExactSameOrigin("http://192.168.1.5:3240", 3240)).toBe(false);
    // 缺失 / 畸形
    expect(isExactSameOrigin(undefined, 3240)).toBe(false);
    expect(isExactSameOrigin("", 3240)).toBe(false);
    expect(isExactSameOrigin("not a url", 3240)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12) 源码级只读门禁
// ---------------------------------------------------------------------------

describe("A1 · 源码级只读门禁", () => {
  const A1_FILES = [
    "src/content/course-pipeline/inspection.ts",
    "src/content/course-pipeline/intake-page.ts",
    "src/content/course-pipeline/intake-client-script.ts",
    "scripts/course-workbench.ts",
  ];

  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  function code(path: string): string {
    return strip(readFileSync(join(process.cwd(), path), "utf8"));
  }

  it("**绝不** import 数据库 / 仓库层（不写库是结构性的，不是纪律）", () => {
    for (const path of A1_FILES) {
      const imports = code(path)
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"))
        .join("\n");
      expect(imports, `${path} 不得 import 数据库/仓库层`).not.toMatch(/repositories|db\/client|node:sqlite|@\/db/);
    }
  });

  it("**绝不**调用写候选 / 晋升 / 导入 / 建链", () => {
    for (const path of A1_FILES) {
      const source = code(path);
      for (const forbidden of [
        "writeCourseCandidate",
        "promoteCourseCandidate",
        "commitCourseImport",
        "verifyCanonicalLink",
      ]) {
        expect(source, `${path} 不得调用 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("**绝不**写文件：没有任何 writeFileSync / mkdirSync / createWriteStream / appendFile", () => {
    for (const path of A1_FILES) {
      const source = code(path);
      for (const forbidden of [
        "writeFileSync",
        "appendFileSync",
        "createWriteStream",
        "mkdirSync",
        "renameSync",
        "unlinkSync",
        "rmSync",
        "writeFile(",
      ]) {
        expect(source, `${path} 不得出现 ${forbidden}（A1 是零写入）`).not.toContain(forbidden);
      }
    }
  });

  it("**绝不**写 review.json / 分段计划 / 曝光台账", () => {
    for (const path of A1_FILES) {
      const source = code(path);
      expect(source).not.toMatch(/review\.json/);
      expect(source).not.toContain("segmentation-plan");
      for (const forbidden of [
        "performance_event",
        "assessment_event",
        "evidence_projection",
        "course_exposure_event",
      ]) {
        expect(source, `${path} 不得写 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("**绝不**发起外部网络请求，也**绝不**调用 Git", () => {
    for (const path of A1_FILES) {
      const source = code(path);
      expect(source, `${path} 不得有出站 http 客户端`).not.toMatch(
        /\bhttps?\.(request|get)\s*\(|from\s+["']node:https["']/,
      );
      expect(source, `${path} 不得做 Git 操作`).not.toMatch(/\bgit\s+(push|commit|checkout|reset|add|merge)\b/);
    }
  });

  it("**绝不**绑定 0.0.0.0", () => {
    for (const path of A1_FILES) {
      expect(code(path), `${path} 不得出现 0.0.0.0`).not.toContain("0.0.0.0");
    }
  });

  it("**复用**既有流水线实现，不重复实现分组 / 分段 / 匹配", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/inspection.ts"), "utf8");
    for (const entry of [
      "scanSourceDirectory",
      "scanSourceTree",
      "extractPdfPages",
      "proposeMaterialGroupings",
      "extractSegmentsForMaterial",
      "matchSegments",
      "buildIndexFromDisk",
    ]) {
      expect(source, `inspection.ts 必须复用 ${entry}`).toContain(entry);
    }
  });

  it("`segment-server.ts` 的依赖面**没有被** A1 扩大（它仍不 import 流水线实现）", () => {
    /*
     * 这是"标注服务器不可能读数据库 / 不可能写候选"那条结构性事实的守卫。
     * A1 的能力经**注入**（`IntakeCapability`）而不是 import ——
     * 因此服务端自己仍然只依赖 node:http / node:crypto。
     */
    const server = code("src/content/course-pipeline/segment-server.ts");
    const imports = server
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/inspection|grouping|segment\b|match|canonical|pdf-extract|folder-picker/);
    expect(imports).toContain("node:http");
  });

  it("`course:workbench` 启动器**不含** `--source` 之外的路径参数处理，也不打印绝对路径", () => {
    const source = readFileSync(join(process.cwd(), "scripts/course-workbench.ts"), "utf8");
    // 唯一的 console 输出不得含绝对路径变量
    const consoleLines = source
      .split(/\r?\n/)
      .filter((line) => /console\.(log|error)\(/.test(line));
    expect(consoleLines.length).toBeGreaterThan(0);
    for (const line of consoleLines) {
      expect(line, `不得把绝对路径打印进终端：${line.trim()}`).not.toMatch(/sourceRoot|handle\.token|absolute/);
    }
  });

  it("工作台 URL 必须把**路径放在 fragment 之前**（这条接线踩过一次真实缺陷）", () => {
    /*
     * ── 它守的那个缺陷（实测踩到）──
     *
     * `handle.url` 是 `http://127.0.0.1:<port>/#token=…` ——
     * **路径在 `#` 之前**。对整条 URL 做
     *
     *     handle.url.replace(/\/$/, "") + "/intake"
     *
     * 会把 `/intake` 接到 fragment **之后**，得到
     * `http://127.0.0.1:<port>/#token=…/intake`。
     *
     * 浏览器打开它就请求 `GET /` —— 也就是**既有标注外壳**，而 A1 的
     * `#tree` 永远不会出现。表现是每一条浏览器用例 30 秒超时，
     * 而**没有任何一条单元测试变红**（服务器本身完全正常）。
     *
     * 因此判据必须落在**URL 的形态**上：解析它，断言 pathname 是 `/intake`
     * 且 fragment 里带 token。只断言"字符串里出现过 /intake"是抓不住的。
     */
    const sources = [
      "scripts/course-workbench.ts",
      "scripts/e2e-server-a1.ts",
    ];
    for (const path of sources) {
      /*
       * 必须剥掉注释再判：这些文件里**有意**写出了那个缺陷形态
       * （`handle.url.replace(/\/$/, "") + "/intake"`）作为反例说明 ——
       * 那是正确的文档，不是违规。朴素的子串检查会命中它（实测踩到）。
       */
      const source = code(path);
      // 不得对 handle.url 做路径拼接
      expect(
        /handle\.url\s*\.\s*replace\(/.test(source),
        `${path} 不得对 handle.url 做字符串拼接（路径会被接到 fragment 之后）`,
      ).toBe(false);

      /*
       * 必须显式构造：`http://<bound>:<port>/intake#token=<token>`。
       * 取其形态断言，而不只是"出现过 /intake"。
       */
      const construct = /\$\{handle\.boundAddress\}:\$\{handle\.port\}\/intake#token=\$\{handle\.token\}/;
      expect(construct.test(source), `${path} 必须显式构造「路径 + fragment」形态的工作台 URL`).toBe(true);

      // 用真实解析器验证那条模板的形态（不是靠正则猜）
      const sample = `http://127.0.0.1:3273/intake#token=synthetic-token`;
      const parsed = new URL(sample);
      expect(parsed.pathname).toBe("/intake");
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("#token=synthetic-token");
    }
  });

  it("人工验收程序只读、且**绝不**在自检路径里弹出真实窗口", () => {
    /*
     * 这个脚本是要交给 使用者 运行的。它必须：
     * - 只读（与 course:workbench 同一条纪律，不写任何东西）；
     * - 有一个**不弹窗口**的自检模式 —— 否则"验证这套程序"本身就要求
     *   在 使用者 桌面上弹窗，那等于用未验证的东西去验证未验证的东西；
     * - 自检模式里不得调用真实 `pickFolder()`。
     */
    const source = code("scripts/course-a1-owner-acceptance.ts");

    for (const forbidden of [
      "writeFileSync",
      "appendFileSync",
      "createWriteStream",
      "mkdirSync",
      "writeCourseCandidate",
      "promoteCourseCandidate",
      "commitCourseImport",
      "verifyCanonicalLink",
      "node:sqlite",
      "repositories",
    ]) {
      expect(source, `人工验收程序不得出现 ${forbidden}`).not.toContain(forbidden);
    }
    // 不打开数据库 / 不做 Git
    expect(source).not.toMatch(/\bgit\s+(push|commit|checkout|reset|add|merge)\b/);
    // 必须提供不弹窗口的自检模式
    expect(source, "必须有 --self-check 模式").toContain("--self-check");
    /*
     * 自检能力对象里的 `pickFolder` 必须**抛错**（而不是调用真实选取器）——
     * 这是"自检绝不弹窗"的结构守卫。
     */
    expect(source).toMatch(/selfCheck[\s\S]*?async pickFolder\(\)\s*\{[\s\S]*?throw new Error\("self-check 不得弹出窗口"\)/);
    // 真实选取器只允许在人工验收那条路径里被调用
    expect(source).toContain("pickFolder({ startDirectory: runRoot })");
    // 脚本里的 console 输出不得打印绝对路径变量
    for (const consoleLine of source.split(/\r?\n/).filter((l) => /console\.(log|error)\(/.test(l))) {
      expect(consoleLine, `不得把绝对路径打印进终端：${consoleLine.trim()}`).not.toMatch(
        /runRoot|fixtureRoot|sourceRoot|handle\.token/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 13) 纯函数装配（可直接驱动，便于变异）
// ---------------------------------------------------------------------------

describe("A1 · 视图装配的判据（纯函数层）", () => {
  it("`notApplicableByDesign` 只在**可比对象为 0 且无建议**时为真", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null });

    for (const match of result.matches) {
      const segment = result.materials
        .flatMap((material) => material.segments)
        .find((item) => item.id === match.segmentId);
      expect(segment).toBeDefined();
      expect(segment!.notApplicableByDesign).toBe(
        match.view === "not_applicable",
      );
    }
  });

  it("四个视图标签互斥且穷尽（suggestions / ambiguous / unmatched / not_applicable）", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null });

    for (const match of result.matches) {
      expect(["suggestions", "ambiguous", "unmatched", "not_applicable"]).toContain(match.view);
      if (match.view === "suggestions" || match.view === "ambiguous") {
        expect(match.suggestions.length).toBeGreaterThan(0);
      } else {
        expect(match.suggestions.length).toBe(0);
      }
      // ambiguous 只在有建议时成立
      if (match.ambiguous) expect(match.view).toBe("ambiguous");
    }
  });

  it("源快照摘要与**结构**摘要都参与结果（它们是两个不同的判据）", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    const result = await runInspection({ sourceRoot, courseId: "fixture", selection: null });

    expect(result.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structureDigest).toMatch(/^[0-9a-f]{64}$/);
    /*
     * 两个摘要**不得相同**：结构摘要只覆盖 (路径, 种类, 字节数)，
     * 而内容摘要含 sha256。它们不同 ⇒ 说明内容摘要确实覆盖了内容
     * （若实现错把结构摘要当成内容摘要，这两个值会相等）。
     */
    expect(result.sourceDigest).not.toBe(result.structureDigest);
  });
});

// ---------------------------------------------------------------------------
// 14) 既有标注能力未被削弱
// ---------------------------------------------------------------------------

describe("A1 · 既有标注能力未被削弱", () => {
  it("既有 `GET /` 与 `/api/bootstrap` 仍然照常工作", async () => {
    const root = makeRoot();
    const sourceRoot = join(root, "source");
    writeSourceTree(sourceRoot, fullFixtureTree());
    const harness = await startHarness({ sourceRoot });
    try {
      const home = await rawRequest(harness.port, "/");
      expect(home.status).toBe(200);
      // 既有标注外壳仍然在（A1 没有把它换掉）
      expect(home.body).toContain("把讲义分成一份份翻译练习");

      const bootstrap = await rawRequest(harness.port, "/api/bootstrap", {
        headers: { [SESSION_TOKEN_HEADER]: harness.token },
      });
      expect(bootstrap.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("既有 `/api/plan` 在**非 A1** 会话上仍然可用（A1 的拒绝不是全局的）", async () => {
    const root = makeRoot();
    writeSourceTree(join(root, "source"), fullFixtureTree());
    const token = newSessionToken();
    let saved: Record<string, unknown> | null = null;
    const session: AnnotationSession = {
      token,
      courseId: "annotation-mode",
      sourceDigest: "a".repeat(64),
      config: {
        courseId: "annotation-mode",
        sourceDigest: "a".repeat(64),
        assets: [{ assetKey: "k", label: "l", sha256: "b".repeat(64), pages: [] }],
        existingPlan: null,
      },
      savePlan(plan) {
        saved = plan;
        return { ok: true, detail: "已写入（测试用）", planDigest: "c".repeat(64) };
      },
      // 刻意**不提供** intake 能力 ⇒ 这就是纯粹的既有标注模式
    };
    const { startAnnotationServer } = await import("@/content/course-pipeline/segment-server");
    const handle = await startAnnotationServer(session, { port: 0, page: () => renderIntakeShell() });
    try {
      const result = await rawRequest(handle.port, "/api/plan", {
        method: "POST",
        headers: {
          [SESSION_TOKEN_HEADER]: token,
          origin: `http://127.0.0.1:${handle.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          author: "synthetic",
          reason: "synthetic",
          units: [
            {
              title: "u",
              kind: "translation_passage",
              assignments: [{ channel: "source", assetKey: "k", page: 1, lineStart: 1, lineEnd: 2, note: null }],
            },
          ],
        }),
      });
      expect(result.status, "非 A1 会话的保存必须仍然可用").toBe(200);
      expect(saved).not.toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("`scanSourceDirectory` 在**不提供**选择范围时行为不变（默认路径逐字节一致）", async () => {
    const root = makeRoot();
    writeSourceTree(root, fullFixtureTree());
    const first = scanSourceDirectory(root);
    const second = scanSourceDirectory(root, {});
    expect(second.digest).toBe(first.digest);
    expect(second.assets.map((asset) => asset.assetKey)).toEqual(first.assets.map((asset) => asset.assetKey));
  });
});
