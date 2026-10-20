#!/usr/bin/env node
/**
 * `pnpm course:review <course-id> [--promote]` —— 课程候选的复核门禁与晋升。
 *
 * ── 这条命令是"机器抽取"与"运行时课程包"之间唯一的通道 ──
 *
 * 它的默认行为是**只读预演**：现场重算摘要、求值门禁、打印结论。
 * 只有显式 `--promote` 且门禁 `PROMOTABLE` 时才会复制到 `courses/<id>/`。
 *
 * ── 它**不**做这些事（每一条都由测试守护）──
 *
 * - 不打开数据库（**不 import 任何数据库模块**）
 * - 不创建 canonical 链接（**不调用** `verifyCanonicalLink`）
 * - 不写课程曝光、不写 Expert 台账、不改 planner / `mock_reserve`
 * - 不生成 `review.json`（工具从不生成它 —— 否则"人工复核"就只是一句话）
 * - 不自动刷新人的决定（复核陈旧就必须重新复核，绝不自动沿用）
 *
 * 用法：
 *   pnpm course:review <course-id>              预演门禁
 *   pnpm course:review <course-id> --json       JSON 输出
 *   pnpm course:review <course-id> --promote    门禁通过后晋升
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCourseCandidatesDir, getCourseSourcesDir, getCoursesDir } from "@/content/paper/paths";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import {
  checkCandidateAssets,
  checkSourceCurrentness,
  evaluatePromotionGate,
  gatherPromotionInputs,
  promoteCourseCandidate,
  readStoredCandidate,
  validateCourseReviewFile,
  validateWithProduction,
  buildLinkPlan,
  CourseCandidateMissingError,
} from "@/content/course-pipeline/review";
import type { PromotionGate, SourceLocator } from "@/content/course-pipeline/types";
import { assertSafeCourseId, isPathSafetyError, sanitizeForDisplay } from "@/content/course-pipeline/containment";

/**
 * 人可读地描述源定位符。
 *
 * **绝不打印绝对路径** —— 候选里本来就只存相对定位符或"外部源"这个事实。
 */
function describeLocator(locator: SourceLocator): string {
  return locator.kind === "standard"
    ? `标准源树内的相对路径 \`${sanitizeForDisplay(locator.locator)}\`（可自动重新清点以证明源新鲜度）`
    : // 外部源的 label 是**任意本机目录名**，可能含 shell 元字符甚至换行 ⇒ 必须消毒
      `外部源根「${sanitizeForDisplay(locator.label)}」（**刻意不记录位置**；需要 --source-root 才能证明源新鲜度）`;
}

interface Args {
  courseId: string | null;
  promote: boolean;
  json: boolean;
  out: string | null;
  papersDir: string | null;
  sourceRoot: string | null;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return value.startsWith("--") ? null : value;
}

function parseArgs(): Args {
  const flags = new Set(["--json", "--promote", "--out", "--papers-dir", "--source-root"]);
  const positional: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (flags.has(token)) {
      if (token === "--out" || token === "--papers-dir" || token === "--source-root") index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    positional.push(token);
  }
  return {
    courseId: positional[0] ?? null,
    promote: process.argv.includes("--promote"),
    json: process.argv.includes("--json"),
    out: argValue("--out"),
    papersDir: argValue("--papers-dir"),
    sourceRoot: argValue("--source-root"),
  };
}

function usage(): never {
  console.error("用法: pnpm course:review <course-id> [--promote] [--json] [--source-root <dir>]");
  console.error("");
  console.error("  （无 --promote）  预演：现场重算摘要 + 求值门禁，不写任何文件");
  console.error("  --promote        门禁全部通过时晋升为规范化课程包到 courses/<id>/");
  console.error("  --json           JSON 输出");
  console.error("  --out <dir>      候选目录（默认 private-content/course-candidates）");
  console.error("  --papers-dir <dir>  canonical 真题包目录");
  console.error("  --source-root <dir> 当前源目录（**外部源**抽取的候选必需，用于证明源未漂移）");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.courseId === null) usage();

  /*
   * ── 第一道防线：在 CLI 边界校验课程 id（F-B）──
   *
   * 与 service 层的检查**互相独立**。这里先拒，是为了给出面向操作者的
   * 清晰措辞（"你给的不是一个课程 id"），而不是让它一路走到路径解析再报错。
   * 但**安全性不依赖这一层** —— `readStoredCandidate` 自己也会拒绝。
   */
  try {
    assertSafeCourseId(args.courseId);
  } catch (error) {
    console.error(`拒绝：${(error as Error).message}`);
    console.error("");
    console.error("课程 id 是候选包的**目录名**，必须是单个 slug 段：");
    console.error("  只允许小写字母/数字/点/下划线/连字符，且以小写字母或数字开头。");
    console.error("  不得含路径分隔符、不得是 . 或 ..、不得是绝对路径/盘符路径/UNC。");
    process.exit(2);
  }

  const candidatesDir = args.out === null ? getCourseCandidatesDir() : resolve(args.out);

  console.log("CET-6 Coach · 课程候选复核门禁（course:review）");
  console.log(`候选：${args.courseId}`);
  console.log(`模式：${args.promote ? "晋升（--promote）" : "预演（不写任何文件）"}`);
  console.log("");
  console.log("说明：本命令**不打开数据库**、**不创建 canonical 链接**。");
  console.log("      晋升只把规范化课程包复制到 courses/ —— 那是全部。");
  console.log("");

  // ── 1) 读取候选（只读）──
  let stored;
  try {
    stored = readStoredCandidate(args.courseId, candidatesDir);
  } catch (error) {
    if (error instanceof CourseCandidateMissingError) {
      console.error(error.message);
      process.exit(1);
    }
    // 路径安全拒绝（含 service 层的容纳检查）→ 正常失败，不打堆栈
    if (isPathSafetyError(error)) {
      console.error(`拒绝：${(error as Error).message}`);
      console.error("候选目录必须位于 course-candidates/ **之内** —— 拒绝读取根之外的任何位置。");
      process.exit(2);
    }
    throw error;
  }

  const metadata = stored.metadata;

  // ── 2) 现场重算摘要（**不信任 candidate.json 缓存**）──
  //
  // ── F-A：记录的子摘要**是诊断缓存，不是信任输入** ──
  //
  // 门禁的权威判据是**现场重算**：它对 course.json 的原始字节、
  // 以及分组/分段/匹配的**实际内容**重新取摘要。`candidate.json` 里记录的
  // 子摘要只是那一次计算的快照。
  //
  // 因此：**只改记录的子摘要**（内容没动）时，候选并不因此"内容被篡改" ——
  // 它只是一个过期的缓存值。这里必须**措辞如实**，不能一边把它标成红色的
  // 完整性问题、一边又给出 PROMOTABLE（那会自相矛盾）。
  //
  // 唯一真正的**身份**判据是 `candidateChecksum`：它由现场重算的五个子摘要
  // 合成，因此"改了内容"必然让它与记录值不符 —— 那才是阻断项。
  console.log("一、候选身份（现场重算，不信候选里缓存的值）");
  const cached = metadata.digests;
  const recomputed = stored.recomputed;
  const digestRows: [string, string, string][] = [
    ["源快照 sourceDigest", cached.sourceDigest, recomputed.sourceDigest],
    ["课程包 courseChecksum", cached.courseChecksum, recomputed.courseChecksum],
    ["分组 groupingDigest", cached.groupingDigest, recomputed.groupingDigest],
    ["分段 segmentationDigest", cached.segmentationDigest, recomputed.segmentationDigest],
    ["匹配 matchingDigest", cached.matchingDigest, recomputed.matchingDigest],
  ];
  const staleCacheRows: string[] = [];
  for (const [label, storedValue, actual] of digestRows) {
    const same = storedValue === actual;
    if (!same) staleCacheRows.push(label);
    // 用"缓存/过期"的措辞，而不是"完整性失败" —— 见上面的说明
    console.log(
      `  ${same ? "✓" : "·"} ${label}：${actual.slice(0, 16)}…` +
        (same ? "" : `（记录的缓存值 ${storedValue.slice(0, 16)}… 已过期）`),
    );
  }
  const checksumMatches = cached.candidateChecksum === recomputed.candidateChecksum;
  console.log(`  候选校验和（现场，权威）：${recomputed.candidateChecksum}`);
  console.log(`  候选校验和（记录）：      ${cached.candidateChecksum}`);
  console.log(
    checksumMatches
      ? "  ✓ 两者一致 —— 候选自洽（内容与记录相符）。"
      : "  ✗ **两者不一致**：候选内容（course.json 或内容摘要）与记录不符 —— 这是阻断项。",
  );
  if (staleCacheRows.length > 0 && checksumMatches) {
    console.log(
      `  说明：${staleCacheRows.join("、")} 的记录值与现场重算不同，但**候选校验和一致** ⇒ ` +
        `内容没有被改动，只是某些**派生的诊断字段**过期。` +
        `权威判据是现场重算值，因此这不构成完整性问题。`,
    );
  }
  console.log("");

  // ── 3) 复核记录 ──
  const reviewPath = join(stored.candidateDir, "review.json");
  let review = null as ReturnType<typeof validateCourseReviewFile>["file"];
  let reviewErrors: string[] = [];

  console.log("二、人工复核记录");
  if (!existsSync(reviewPath)) {
    console.log("  **没有 review.json。**");
    console.log("  工具**从不**生成它 —— 复核只能由人签出。没有它就不可晋升。");
  } else {
    /*
     * ── F-D：JSON 解析必须被守卫 ──
     *
     * 早先这里是裸 `JSON.parse(readFileSync(...))`。一份被截断/语法错误的
     * review.json 会让整条命令**崩进外层错误处理器**（打堆栈、exitCode=1），
     * 而不是报告一个正常的"复核记录无效"状态。
     *
     * 那在语义上是错的：坏文件是一个**可预期的失败状态**，不是程序缺陷。
     * 正确行为：报告无效 ⇒ 门禁不 PROMOTABLE ⇒ 零交接 ⇒ 零晋升 ⇒ 不碰数据库。
     */
    let parsedReview: ReturnType<typeof validateCourseReviewFile>;
    try {
      parsedReview = validateCourseReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
    } catch (error) {
      parsedReview = {
        ok: false,
        file: null,
        errors: [
          `review.json 不是合法 JSON（解析失败）：${(error as Error).message}`,
          "请修正或重写 review.json —— 工具**从不**生成它，因此它一定是由人生成的。",
        ],
      };
    }
    const parsed = parsedReview;
    review = parsed.file;
    reviewErrors = parsed.errors;
    if (parsed.ok && parsed.file) {
      console.log(`  复核者：${parsed.file.reviewer}（${parsed.file.reviewedAt}）`);
      console.log(`  绑定候选校验和：${parsed.file.candidateChecksum ?? "**未绑定**"}`);
      console.log(`  复核时 canonical 库：${parsed.file.canonicalLibraryDigest.slice(0, 16)}…`);
      console.log(`  分组裁决 ${parsed.file.materialGroupings.length} 条 · 段裁决 ${parsed.file.segments.length} 条 · 匹配裁决 ${parsed.file.matches.length} 条`);
      console.log(`  已核验范围：${parsed.file.verifiedScope.join("；")}`);
      if (parsed.file.notVerified.length > 0) {
        console.log(`  **未**核验：${parsed.file.notVerified.join("；")}`);
      }
    } else {
      console.log("  ✗ **复核记录无效**（⟹ 门禁不可能是 PROMOTABLE、零交接、零晋升）：");
      for (const error of reviewErrors) console.log(`      ${error}`);
    }
  }
  console.log("");

  // ── 4) 匹配裁决现状 ──
  console.log("三、canonical 匹配（**建议，非核验**）");
  // 复核者需要看到**段的标题**而不只是一个 id —— 否则无法把建议与手里的材料对上。
  const segmentById = new Map(
    metadata.segmentation.materials.flatMap((material) => material.segments.map((s) => [s.id, s] as const)),
  );
  let accepted = 0;
  let rejected = 0;
  let unmatched = 0;
  for (const match of metadata.matching.segments) {
    if (match.suggestions.length === 0) continue;
    const top = match.suggestions[0];
    const title = segmentById.get(match.segmentId)?.title ?? "";
    console.log(
      `  ${match.segmentId}${title === "" ? "" : `（${title}）`}：${match.label}` +
        `（top ${top.score.toFixed(4)}）${match.ambiguous ? " **歧义**" : ""}`,
    );
    for (const suggestion of match.suggestions.slice(0, 3)) {
      console.log(`      ${suggestion.score.toFixed(4)}  ${suggestion.target.label}`);
    }
  }
  for (const decision of review?.matches ?? []) {
    if (decision.disposition === "accepted_suggestion") accepted += 1;
    else if (decision.disposition === "rejected_suggestion") rejected += 1;
    else unmatched += 1;
  }
  console.log("");
  console.log(`  裁决：接受建议 ${accepted} · 否决建议 ${rejected} · 有意不匹配 ${unmatched}`);
  console.log("  **接受建议 ≠ verified 链接。** 它只表示「已准备好让人显式建链」。");
  console.log("");

  // ── 5) canonical 库现状（陈旧检测的依据）──
  const indexResult = buildIndexFromDisk(
    args.papersDir === null ? undefined : resolve(args.papersDir),
  );
  const currentCanonicalDigest = indexResult.index.summary.digest;
  console.log("四、canonical 库现状");
  console.log(`  库摘要：${currentCanonicalDigest}`);
  console.log(`  真题包：${indexResult.index.summary.papers.length} 份`);
  if (indexResult.failures.length > 0) {
    console.log(`  ✗ ${indexResult.failures.length} 份真题包读取失败（失败关闭）：`);
    for (const failure of indexResult.failures) {
      console.log(`      ${failure.packagePath}：${failure.reason}`);
    }
  }
  console.log(
    review !== null && review.canonicalLibraryDigest === currentCanonicalDigest
      ? "  ✓ 与复核时一致 —— 匹配证据仍然成立。"
      : "  ✗ 与复核时**不一致**（或没有复核记录）—— 旧匹配分数**不得**沿用，必须重跑抽取并重新复核。",
  );
  console.log("");

  // ── 6) 源当前性（F10）与候选包完整性 ──
  //
  // 源当前性是**晋升前必须证明**的一件事：候选的全部证据都建立在
  // 抽取当时的那一份源字节上。若源在抽取之后被改动，候选就陈旧了 ——
  // 而这件事以前完全没有被检查。
  const standardSourcesRoot = getCourseSourcesDir();
  const sourceCurrentness = checkSourceCurrentness({
    stored,
    standardSourcesRoot,
    sourceRootOverride: args.sourceRoot,
  });

  const assetIntegrity = checkCandidateAssets(stored.candidateDir, metadata);
  const productionValidation = validateWithProduction(stored.candidateDir, args.courseId);
  const canonicalLibraryComplete = indexResult.failures.length === 0;

  console.log("五、源当前性（**晋升前必须证明**源未漂移）");
  console.log(`  定位符：${describeLocator(metadata.inventory.sourceLocator)}`);
  if (sourceCurrentness.state === "current") {
    console.log(`  ✓ 源未漂移（重新清点摘要一致：${sourceCurrentness.currentDigest?.slice(0, 16)}…）`);
  } else if (sourceCurrentness.state === "drifted") {
    console.log(`  ✗ **源已漂移**：${sourceCurrentness.detail}`);
    console.log(`      候选记录：${sourceCurrentness.recordedDigest.slice(0, 16)}…`);
    console.log(`      当前清点：${sourceCurrentness.currentDigest?.slice(0, 16)}…`);
  } else {
    console.log(`  ✗ **无法证明源未漂移**：${sourceCurrentness.detail}`);
  }
  console.log("");

  console.log("六、候选包完整性");
  console.log(
    assetIntegrity.ok
      ? "  ✓ 资产齐备，字节数与 sha256 均与 course.json 声明一致。"
      : `  ✗ 资产问题：${assetIntegrity.issues.join("；")}`,
  );
  console.log(
    productionValidation.ok
      ? "  ✓ 通过**生产同一个** NormalizedCourseImporter 校验。"
      : `  ✗ 生产校验器拒绝：${productionValidation.issues.join("；")}`,
  );
  console.log(
    canonicalLibraryComplete
      ? "  ✓ canonical 库完整（没有读不出来的真题包）。"
      : `  ✗ **canonical 库不完整**（${indexResult.failures.length} 份读取失败）—— ` +
        `课程包仍可晋升，但**接受建议的建链交接不可信**。`,
  );
  console.log("");

  // ── 7) 门禁（磁盘侧事实统一采集，与测试共用一份实现）──
  const gate = evaluatePromotionGate(
    gatherPromotionInputs({
      stored,
      review,
      reviewErrors,
      canonical: { digest: currentCanonicalDigest, complete: canonicalLibraryComplete },
      standardSourcesRoot,
      sourceRootOverride: args.sourceRoot,
    }),
  );

  console.log(`七、门禁结论：${gate.status}`);
  for (const check of gate.checks) {
    console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log("");
  console.log(gate.summary);
  console.log("");

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          courseId: args.courseId,
          promote: args.promote,
          status: gate.status,
          checks: gate.checks,
          candidateChecksum: recomputed.candidateChecksum,
          canonicalLibraryDigest: currentCanonicalDigest,
          canonicalLibraryComplete,
          sourceCurrentness: {
            state: sourceCurrentness.state,
            locatorKind: sourceCurrentness.locatorKind,
            changedAssets: sourceCurrentness.changedAssets,
          },
          review: review === null ? null : { reviewer: review.reviewer, reviewedAt: review.reviewedAt },
          matches: { accepted, rejected, unmatched },
        },
        null,
        2,
      ),
    );
  }

  if (!args.promote) {
    console.log("（未指定 --promote，候选保持原位。）");
    console.log("");
    // F12：交接计划**绑定门禁** —— 非 PROMOTABLE 时零命令
    printHandoff(stored, review, gate);
    return;
  }

  // ── 8) 晋升 ──
  const result = promoteCourseCandidate({
    stored,
    gate,
    review,
    coursesDir: getCoursesDir(),
    candidateDir: stored.candidateDir,
  });

  if (!result.ok) {
    console.error(`拒绝晋升：${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`已晋升到：${result.targetDir}`);
  console.log(`  复制：${result.copied.join("、")}`);
  console.log(`  明确**未**复制：${result.excluded.join("、")}（候选/复核元数据不进运行时课程目录）`);
  console.log(`  晋升后内容指纹：${result.contentFingerprint}`);
  console.log("");
  console.log("晋升**没有**做这些事（刻意）：");
  console.log("  · 没有创建 canonical 链接（没有任何 verified 链接）；");
  console.log("  · 没有写课程曝光 / Expert 台账；");
  console.log("  · 没有改 planner / mock_reserve / 试卷 untouched 选择；");
  console.log("  · 没有打开数据库。");
  console.log("");
  console.log("下一步：");
  console.log("  pnpm course:validate            # 只读校验课程包");
  console.log("  pnpm course:import              # 预演导入（不写库）");
  console.log("  pnpm course:import --commit     # 真正写入课程索引");
  console.log("");
  // F12：晋升成功 ⇒ gate 必为 PROMOTABLE，因此这里必然输出计划（若有 accepted_suggestion）
  printHandoff(stored, review, gate);
}

/**
 * 已复核链接**交接计划**：只打印命令，**绝不执行**。
 *
 * 这是本流水线与"运行时真相"之间刻意留下的那一道人工动作。
 * `accepted_suggestion` 是"人认为这条候选映射对"，而 `verified` 链接是一条
 * 绑定到具体内容版本的运行时真相 —— 两者之间必须隔着一次**显式授权**。
 *
 * ── `gate` 是必需参数（F12）──
 *
 * 交接计划只有在门禁 `PROMOTABLE` 时才允许产出。这不是"调用方记得判断"，
 * 而是 `buildLinkPlan` 自身要求传入 gate 并在内部失败关闭 ——
 * 因此本函数即使写错顺序，也不可能打印出建链命令。
 */
function printHandoff(
  stored: ReturnType<typeof readStoredCandidate>,
  review: ReturnType<typeof validateCourseReviewFile>["file"],
  gate: PromotionGate,
): void {
  const plan = buildLinkPlan({
    stored,
    review,
    gate,
  });

  // ── 门禁未通过：明确抑制，且**零命令** ──
  if (!plan.allowed) {
    console.log("【链接交接已抑制】");
    console.log(`  ${plan.reason}`);
    console.log("  → **没有输出任何 course:link 命令。**");
    console.log("");
    return;
  }

  console.log("【已复核链接交接计划】");
  if (plan.entries.length === 0) {
    console.log("  没有任何 `accepted_suggestion` —— 因此没有待建链接。");
    console.log("  课程包可以完全未匹配地存在，那是**合法状态**。");
    console.log("");
    return;
  }

  console.log(`  共 ${plan.entries.length} 条已接受的候选映射。以下是**建议命令**：`);
  console.log("");
  for (const entry of plan.entries) {
    console.log(`  # ${entry.segmentId} [${entry.segmentKind}] ${entry.segmentTitle}`);
    // 人写的证据**只在这里**展示，绝不进入命令（见下）
    console.log(`  #   复核依据（自由文本，仅供人阅读）：${entry.reviewEvidence}`);
    console.log(`  #   --ref 标识符：${entry.ref}`);
    console.log(`  ${entry.command}`);
    console.log("");
  }
  console.log("  **这些命令没有被执行，也不会被自动执行。**");
  console.log("  `accepted_suggestion` 不是 verified 链接；把它变成运行时真相需要");
  console.log("  使用者的**显式授权**。命令默认是 dry-run（未加 --commit），");
  console.log("  因此即使被误执行也只做校验、不写库。");
  console.log("");
  console.log("  关于 --ref：命令里放的是**受控标识符**（`course-review:...`），");
  console.log("  不是上面的自由文本。理由：复核依据是人写的散文，可能含引号、");
  console.log("  反引号、`$(...)`、分号、换行，而本机是 Windows/PowerShell（反斜杠不是");
  console.log("  转义字符）—— 把散文塞进命令会产生既不可移植、又能被当作 shell 语法");
  console.log("  执行的字符串。人写的证据留在 review.json 里，由该标识符指向它。");
  console.log("");
}

main().catch((error: unknown) => {
  console.error("复核失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
