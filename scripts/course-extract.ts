#!/usr/bin/env node
/**
 * `pnpm course:extract` —— 私有源目录 → 可复核的候选课程包。
 *
 * ── 这条命令**不打开数据库** ──
 *
 * 它是纯文件系统操作：读源目录、抽 PDF 文本层、生成候选。
 * 匹配所需的 canonical 内容由**磁盘上的规范化真题包**提供
 * （见 `course-pipeline/canonical.ts`）—— 刻意不走 `getRepositories()`。
 *
 * 理由不只是"不需要"，而是本项目已经踩过一次的缺陷形态：一个自称只读的命令
 * 经由迁移-capable 的连接工厂打开库，**打开本身**就把 使用者的 v8 库迁成了 v9
 * （见 `content-policy/LEARNING_MODEL.md` 的只读路径约束）。这里**根本不 import 任何数据库模块**，
 * 因此"不写库"是结构性事实，而不是纪律要求。
 *
 * ── 它绝不创建 `verified` canonical 链接 ──
 *
 * 机器匹配只产**建议**。高分、精确指纹、文件名、套别号、题号都不是人工核验。
 *
 * 用法：
 *   pnpm course:extract --source <dir> --id <course-id> [选项]
 *
 * 必填：
 *   --source <dir>        私有源目录（原始课程材料所在处）
 *   --id <course-id>      课程 id（小写字母/数字/._-）
 *
 * 选填：
 *   --title <text>        课程标题（默认取 source 目录名）
 *   --provider <slug>     提供方（自由字符串，默认 "local"）
 *   --edition <text>      版次标签
 *   --content-version <n> 内容版本（对已晋升课程的语义修正才递增；默认 1）
 *   --note <text>         来源说明
 *   --rights-note <text>  权利说明（这份材料为何可合法留在本机）
 *   --papers-dir <dir>    canonical 真题包目录（默认 private-content/cet6/papers）
 *   --out <dir>           候选输出目录（默认 private-content/course-candidates）
 *   --plan <file>         人工分段计划（**显式给出即强制**；不可用则失败关闭）
 *   --no-plan             明确**忽略**已存在的计划，走自动分段
 *   --json                以 JSON 输出报告
 *   --dry-run             只清点与抽取，**不写任何文件**
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCourseCandidatesDir, getCourseSegmentationPlansDir, getCourseSourcesDir } from "@/content/paper/paths";
import { sanitizeForDisplay } from "@/content/course-pipeline/containment";
import { runCourseIntake, candidateDirNameOf } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { parseSegmentationPlan } from "@/content/course-pipeline/segmentation-plan";
import { TEXT_EXTRACTION_DEFERRED } from "@/content/course-pipeline/types";

interface Args {
  source: string | null;
  id: string | null;
  title: string | null;
  provider: string;
  edition: string | null;
  contentVersion: number;
  note: string | null;
  rightsNote: string | null;
  papersDir: string | null;
  out: string | null;
  plan: string | null;
  noPlan: boolean;
  json: boolean;
  dryRun: boolean;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return value.startsWith("--") ? null : value;
}

function parseArgs(): Args {
  const contentVersionRaw = argValue("--content-version");
  const contentVersion = contentVersionRaw === null ? 1 : Number(contentVersionRaw);
  return {
    source: argValue("--source"),
    id: argValue("--id"),
    title: argValue("--title"),
    provider: argValue("--provider") ?? "local",
    edition: argValue("--edition"),
    contentVersion: Number.isFinite(contentVersion) && contentVersion >= 1 ? Math.floor(contentVersion) : 1,
    note: argValue("--note"),
    rightsNote: argValue("--rights-note"),
    papersDir: argValue("--papers-dir"),
    out: argValue("--out"),
    plan: argValue("--plan"),
    noPlan: process.argv.includes("--no-plan"),
    json: process.argv.includes("--json"),
    dryRun: process.argv.includes("--dry-run"),
  };
}

function usage(): never {
  console.error("用法: pnpm course:extract --source <dir> --id <course-id> [选项]");
  console.error("");
  console.error("  --source <dir>        必填：私有源目录");
  console.error("  --id <course-id>      必填：课程 id（小写字母/数字/._-）");
  console.error("  --title <text>        课程标题（默认取源目录名）");
  console.error("  --provider <slug>     提供方（自由字符串，默认 local）");
  console.error("  --edition <text>      版次标签");
  console.error("  --content-version <n> 内容版本（默认 1）");
  console.error("  --note <text>         来源说明");
  console.error("  --rights-note <text>  权利说明");
  console.error("  --papers-dir <dir>    canonical 真题包目录");
  console.error("  --out <dir>           候选输出目录");
  console.error("  --plan <file>         人工分段计划；**显式给出即强制**，不可用则非零退出");
  console.error("  --no-plan             忽略已存在的计划，强制走自动分段");
  console.error("  --json                JSON 输出");
  console.error("  --dry-run             只抽取，不写任何文件");
  console.error("");
  console.error("退出码：0 成功；1 源/环境问题；2 参数问题；3 **计划失败关闭**（PLAN_* 错误码）。");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.source === null || args.id === null) usage();

  const sourceRoot = resolve(args.source);
  if (!existsSync(sourceRoot)) {
    console.error(`源目录不存在：${sanitizeForDisplay(args.source, 200)}`);
    process.exit(1);
  }

  // 课程 id 必须合法 —— 它会成为候选目录名与包内 id
  let candidateDirName: string;
  try {
    candidateDirName = candidateDirNameOf(args.id);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  const candidatesRoot = args.out === null ? getCourseCandidatesDir() : resolve(args.out);
  const candidateDir = join(candidatesRoot, candidateDirName);

  const sourceLabel = sourceRoot.split(/[\\/]/).filter((part) => part !== "").pop() ?? "source";

  /*
   * ── 人工分段计划：**显式可选输入** ──
   *
   * 自动分段仍是默认。计划只在"人明确提供了它"或"默认位置存在一份"时生效。
   *
   * 位置刻意**不在候选目录里**：`course:extract` 重跑会备份并替换整个候选目录，
   * 计划放在那里会在每次重新抽取时被搬进 `.prev-*`。
   *
   * 计划路径**只出现在内存里** —— 它绝不进入候选文件（任务书明确禁止
   * 持久化绝对计划路径）。候选只记录计划的**校验和**。
   *
   * ── F5：显式 `--plan` **必须失败关闭** ──
   *
   * | 情形 | 语义 |
   * | --- | --- |
   * | `--plan` **未提供** | 自动分段是合法的（默认路径） |
   * | 默认位置**恰好**有一份计划 | 自动加载它（既有行为不变） |
   * | `--plan <path>` **显式提供** | 那份计划是**强制的** |
   *
   * 显式给出的计划若不存在 / 读不了 / 坏 JSON / 校验不过 / 陈旧 /
   * 绑错课程 —— 命令必须**非零退出**，且**绝不**静默改走自动分段。
   *
   * 原因是实测过的 fail-open：`course:extract --plan <不存在的文件>`
   * 退出 0 并按自动分段跑。操作者以为自己的结构生效了，实际没有 ——
   * 那正是"静默分叉"，也是本任务最不能接受的形态。
   */
  const planPath =
    args.plan !== null
      ? resolve(args.plan)
      : join(getCourseSegmentationPlansDir(), `${args.id}.json`);

  /**
   * 显式 `--plan` 的失败关闭出口。
   *
   * 错误码刻意**机器可读**（`PLAN_*`），便于脚本与门禁分类，而不必解析中文句子。
   * 消息里**只出现文件名**（绝不打印绝对路径 —— 与 F-C 同一套纪律）。
   */
  function failClosedPlan(code: string, detail: string): never {
    const label = sanitizeForDisplay(planPath.split(/[\\/]/).pop() ?? "", 80);
    console.error(`计划失败关闭：${code}`);
    console.error(`  ${detail}`);
    console.error("");
    console.error("  说明：**显式**给出 --plan 时那份计划是强制的。");
    console.error("        工具**绝不**在计划不可用时静默改走自动分段 ——");
    console.error("        那会让\"我明明写了计划\"与\"系统按自动结果跑\"两个事实悄悄分叉。");
    console.error("        计划文件名（仅展示）：" + label);
    console.error("");
    console.error("  处置（二选一）：");
    console.error("    · 修好计划后重跑本命令；或");
    console.error("    · 明确改走自动分段：加 --no-plan，或去掉 --plan 让默认位置决定。");
    process.exit(3);
  }

  let planInput: { raw: string } | undefined;
  let planSource: string;
  if (args.noPlan) {
    if (args.plan !== null) {
      // --plan 与 --no-plan 同时给出是自相矛盾的输入 —— 不猜，直接拒绝
      console.error("参数冲突：--plan 与 --no-plan 不能同时提供。");
      console.error("  要么给 --plan <file>（计划强制生效），要么给 --no-plan（明确走自动分段）。");
      process.exit(2);
    }
    planSource = "（--no-plan：明确忽略自动加载的计划，走自动分段）";
  } else if (args.plan !== null) {
    /*
     * ── 显式 --plan：强制 ──
     *
     * 这里提前判"能不能读"，因为接下来的失败都必须是**可见的**失败。
     * 注意顺序：先判存在性（最常见），再读（权限/IO），再交给流水线校验形状。
     */
    if (!existsSync(planPath)) {
      failClosedPlan(
        "PLAN_NOT_FOUND",
        `--plan 指定的计划文件不存在。`,
      );
    }
    let raw: string;
    try {
      raw = readFileSync(planPath, "utf8");
    } catch (error) {
      failClosedPlan(
        "PLAN_UNREADABLE",
        `--plan 指定的计划文件无法读取：${sanitizeForDisplay((error as Error).message, 200)}`,
      );
    }
    planInput = { raw };
    /*
     * 形状层先在这里判一次，让"坏 JSON / 契约不认识"直接```非零退出``，
     * 而不是等到流水线走完再回退自动分段。
     */
    const shape = parseSegmentationPlan(raw);
    if (!shape.ok) {
      failClosedPlan(
        "PLAN_INVALID",
        `--plan 指定的计划未通过解析/形状校验（${shape.issues.length} 项）：` +
          shape.issues
            .slice(0, 5)
            .map((issue) => `${issue.code}@${issue.where}`)
            .join("、"),
      );
    }
    const planLabel = sanitizeForDisplay(planPath.split(/[\\/]/).pop() ?? "", 80);
    planSource = `（--plan 指定的计划，**强制生效**，文件名：${planLabel}）`;
  } else if (existsSync(planPath)) {
    planInput = { raw: readFileSync(planPath, "utf8") };
    // **只显示文件名** —— 绝对路径不进终端输出（与 F-C 同一套纪律）
    const planLabel = sanitizeForDisplay(planPath.split(/[\\/]/).pop() ?? "", 80);
    planSource = `（默认位置自动加载，文件名：${planLabel}）`;
  } else {
    planSource = "（默认位置没有计划 ⇒ 走自动分段）";
  }

  console.log(`CET-6 Coach · 课程导入与匹配流水线（course:extract）`);
  /*
   * ── 源目录路径必须**消毒后**才打印（F-C）──
   *
   * 路径是**任意本机字符串**：可能含 `$()`、反引号、分号、`&`、引号。
   * 直接在终端打印它，会让输出里出现"看起来可粘贴、实际会被 shell 展开"的文本。
   * 与 --source-root 提示同一套纪律：一律经 `sanitizeForDisplay`。
   */
  console.log(`源目录：${sanitizeForDisplay(sourceRoot, 200)}`);
  console.log(`课程 id：${args.id}`);
  console.log(`模式：${args.dryRun ? "只抽取（--dry-run，不写任何文件）" : "生成候选包"}`);
  console.log(`人工分段计划：${planSource}`);
  console.log("");
  console.log("说明：本命令**不打开数据库**。匹配只读磁盘上的规范化真题包；");
  console.log("      机器匹配只产生**建议**，**绝不**创建 verified canonical 链接。");
  console.log("");

  const result = await runCourseIntake({
    sourceRoot,
    courseId: args.id,
    provider: args.provider,
    edition: args.edition,
    title: args.title ?? sourceLabel,
    contentVersion: args.contentVersion,
    provenance: {
      note: args.note ?? `由 pnpm course:extract 从私有源目录「${sourceLabel}」抽取（未人工核验）。`,
      reference: null,
      // 权利说明是必填：付费材料留在本机的前提必须被显式写下
      rightsNote:
        args.rightsNote ??
        "本机私有材料，仅用于个人备考。权利说明由使用者在复核 review.json 时补充确认。",
    },
    papersDir: args.papersDir === null ? undefined : resolve(args.papersDir),
    // 人工分段计划是**显式可选输入**；不提供时行为与以前完全一致
    segmentationPlan: planInput,
    // 标准源树根：源若在其内，候选会记录一个**安全相对定位符**，
    // 于是复核/晋升可以自动重新清点源来证明未漂移（F10）。
    standardSourcesRoot: getCourseSourcesDir(),
  });

  for (const stage of result.stages) {
    console.log(`【${stage.name}】`);
    console.log(`    ${stage.detail}`);
    for (const warning of stage.warnings.slice(0, 4)) console.log(`    ! ${warning}`);
    if (stage.warnings.length > 4) console.log(`    ! …另有 ${stage.warnings.length - 4} 条`);
    console.log("");
  }

  // ── 人工分段计划的处置（校验失败 ⇒ 明确的失败，不是静默忽略）──
  //
  // 这里只打印**安全元数据**：问题码、位置标签、计数。
  // 计划正文与任何课程内容都**不进终端**（打印纪律与隐私边界一致）。
  const planOutcome = result.segmentationPlan;
  if (planInput !== undefined) {
    console.log("【人工分段计划】");
    if (planOutcome.applied) {
      // planDigest 在 applied 时必非 null（见 plan-resolve 的构造）
      const digest = planOutcome.planDigest ?? "";
      console.log(`    ✓ 已采用（计划校验和 ${digest.slice(0, 16)}…）`);
      console.log(`      单元 ${planOutcome.plan?.units.length ?? 0} 个 · 引用资产 ${planOutcome.referencedAssetKeys.length} 个`);
      console.log(
        `      通道行数：原文 ${planOutcome.channelLineCounts.source} · ` +
          `参考译文 ${planOutcome.channelLineCounts.referenceTranslation} · ` +
          `讲解 ${planOutcome.channelLineCounts.notes} · ` +
          `显式家具 ${planOutcome.channelLineCounts.ignoredFurniture}`,
      );
      if (planOutcome.unassigned.length > 0) {
        console.log(`      ✗ **未指派内容 ${planOutcome.unassigned.length} 行** —— 阻断，必须修正计划`);
      } else {
        console.log("      ✓ 覆盖率完整（每一行都被某个通道接住，或被显式标为家具）");
      }
      console.log("    注意：计划是**结构输入**，**不是**复核记录。");
      console.log("          review.json 仍然必须由人签出 —— 计划不减少任何复核要求。");
    } else {
      /*
       * ── 计划未被采用 ──
       *
       * **显式 `--plan` 与"默认位置恰好有一份"的后果必须不同**（F5）：
       *
       * - **显式**：那份计划是强制的 ⇒ **非零退出，不写出任何候选**。
       *   否则操作者会得到一份按自动分段产出的候选，而他以为自己
       *   给的结构生效了 —— 静默分叉。
       * - **默认位置**：自动加载是"尽力而为"的便利，不是人的显式声明。
       *   保持既有行为（回退自动分段 + 阻断事项），且明确打印出来。
       */
      const explicitlyGiven = args.plan !== null;
      console.log(`    ✗ **计划未被采用**（${planOutcome.issues.length} 项问题）`);
      for (const issue of planOutcome.issues.slice(0, 10)) {
        console.log(`      · [${issue.code}] ${issue.where}`);
        console.log(`          ${issue.detail}`);
      }
      if (planOutcome.issues.length > 10) {
        console.log(`      …另有 ${planOutcome.issues.length - 10} 项`);
      }
      if (explicitlyGiven) {
        console.error("");
        console.error("计划失败关闭：PLAN_REJECTED");
        console.error(
          `  --plan 指定的计划被拒绝（${planOutcome.issues.length} 项问题：` +
            `${planOutcome.issues
              .slice(0, 5)
              .map((issue) => issue.code)
              .join("、")}）。`,
        );
        console.error("");
        console.error("  说明：**显式**给出 --plan 时那份计划是强制的，因此本命令**非零退出**，");
        console.error("        且**没有**写出任何候选（不会留下一份按自动分段产出的候选）。");
        console.error("        这条差异正是为了避免\"我明明写了计划、系统却按自动结果跑\"。");
        console.error("");
        console.error("  处置（二选一）：");
        console.error("    · 修正计划后重跑本命令；或");
        console.error("    · 明确改走自动分段：加 --no-plan，或去掉 --plan 让默认位置决定。");
        process.exit(3);
      }
      console.log("    **绝不静默忽略一份有问题的计划** —— 当前候选带阻断级事项，");
      console.log("    门禁不可能 PROMOTABLE。请修正计划后重新运行本命令。");
      console.log("    （本计划来自**默认位置**，因此这里保持既有语义：候选仍生成，便于人检查。）");
    }
    console.log("");
  }

  // ── 抽取状态汇总（每一种"没抽到文本"都必须有名字）──
  const deferred = result.documents.filter((doc) => doc.state === "deferred");
  if (deferred.length > 0) {
    console.log(`【${TEXT_EXTRACTION_DEFERRED}】`);
    console.log(
      `    ${deferred.length} 个文件在 V1 **不被解析**（DOCX 等）。它们已登记为资产/表示，` +
        `但绝不假装抽到了文本。`,
    );
    for (const doc of deferred) {
      const asset = result.inventory.assets.find((item) => item.assetKey === doc.assetKey);
      console.log(`      - ${asset?.relativePath ?? doc.assetKey}`);
    }
    console.log("");
  }

  const noText = result.documents.filter((doc) => doc.pagesWithoutTextLayer.length > 0);
  if (noText.length > 0) {
    console.log("【无文本层（**不做 OCR**）】");
    for (const doc of noText) {
      const asset = result.inventory.assets.find((item) => item.assetKey === doc.assetKey);
      console.log(`      - ${asset?.relativePath ?? doc.assetKey}：第 ${doc.pagesWithoutTextLayer.join("、")} 页`);
    }
    console.log("");
  }

  if (result.inventory.rejected.length > 0) {
    console.log("【被拒绝的路径（未读取）】");
    for (const rejected of result.inventory.rejected.slice(0, 10)) {
      console.log(`      ✗ ${rejected.relativePath}：${rejected.reason}`);
    }
    console.log("");
  }

  // ── 材料与段 ──
  console.log("【候选逻辑材料与课程段】");
  for (const proposal of result.grouping.proposals) {
    const segments = result.segmentation.find((material) => material.materialProposalId === proposal.id);
    const flag = proposal.reviewRequired ? " ⚠需复核" : "";
    console.log(`  ${proposal.title}${flag}`);
    console.log(`      表示：${proposal.representations.map((rep) => `${rep.label}(${rep.sourceRelativePath})`).join("、")}`);
    console.log(`      依据：${proposal.basis.join("；")}`);
    for (const segment of segments?.segments ?? []) {
      const marker = segment.reviewRequired ? " ⚠" : "";
      console.log(`      - [${segment.kind}] ${segment.title}${marker}`);
    }
    if ((segments?.segments.length ?? 0) === 0) {
      console.log(`      - （不产出课程段：没有内容证据时不得发明段）`);
    }
  }
  console.log("");

  // ── 匹配建议（**只是建议**）──
  console.log("【canonical CET-6 候选匹配（建议，非核验）】");
  console.log(`  canonical 库：${result.archive.metadata.matching.canonicalLibrary.papers.length} 份真题包`);
  for (const paper of result.archive.metadata.matching.canonicalLibrary.papers) {
    console.log(`      - ${paper.paperId} v${paper.contentVersion}（${paper.targetCount} 个可比大题）`);
  }
  console.log("");
  let anySuggestion = false;
  for (const segment of result.archive.metadata.matching.segments) {
    if (segment.suggestions.length === 0) continue;
    anySuggestion = true;
    console.log(`  ${segment.segmentId} → ${segment.label}${segment.ambiguous ? " **歧义**" : ""}`);
    for (const suggestion of segment.suggestions.slice(0, 3)) {
      console.log(`      ${suggestion.score.toFixed(4)}  ${suggestion.target.label}`);
      console.log(
        `          证据：projectionExact=${suggestion.evidence.projectionExact} ` +
          `bodyContainment=${suggestion.evidence.bodyContainment} ` +
          `bodyJaccard=${suggestion.evidence.bodyJaccard} ` +
          `stemOverlap=${suggestion.evidence.stemOverlap ?? "—"} ` +
          `optionOverlap=${suggestion.evidence.optionOverlap ?? "—"} ` +
          `structural=${suggestion.evidence.structuralConsistency}`,
      );
    }
    if (segment.ambiguityNote !== null) console.log(`      ⚠ ${segment.ambiguityNote}`);
  }
  if (!anySuggestion) {
    console.log("  （没有任何段产生匹配建议）");
    console.log(
      "  **未匹配是合法状态**：它意味着当前 canonical 库无法有把握地识别这些材料，" +
        "**不**意味着材料是伪造的或不是真题材料。",
    );
  }
  console.log("");
  console.log("  提醒：分数只是**排序元数据**。文件名 / 套别号 / 物理顺序 / 裸题号 / 课程答案");
  console.log("        都**未参与打分**。任何分数都**不是**人工核验。");
  console.log("");

  // ── 复核事项 ──
  const blocking = result.archive.review.filter((item) => item.severity === "blocking");
  const advisory = result.archive.review.filter((item) => item.severity === "advisory");
  console.log(`【复核事项】阻断级 ${blocking.length} 条 · 提示级 ${advisory.length} 条`);
  for (const item of blocking.slice(0, 15)) {
    console.log(`  ✗ [${item.code}] ${item.where}`);
    console.log(`      ${item.detail}`);
  }
  if (blocking.length > 15) console.log(`  …另有 ${blocking.length - 15} 条阻断级事项`);
  console.log("");

  const checksum = result.archive.metadata.digests.candidateChecksum;
  console.log(`【候选校验和】${checksum}`);
  console.log("  ↑ review.json 的 candidateChecksum 必须填此值。");
  console.log("    源内容 / course.json / 分组 / 分段 / 匹配证据 / canonical 库**任一**变化都会让它失效，");
  console.log("    旧复核随即陈旧，晋升会被拒绝。");
  console.log("");
  console.log("【本次 canonical 库摘要】" + result.archive.metadata.matching.canonicalLibrary.digest);
  console.log("  ↑ review.json 的 canonicalLibraryDigest 必须填此值（库变了旧匹配即失效）。");
  if (result.archive.metadata.matching.canonicalLibrary.readFailures.length > 0) {
    console.log(
      `  ⚠ 该库**不完整**（${result.archive.metadata.matching.canonicalLibrary.readFailures.length} 份读取失败）：` +
        `课程包仍可晋升，但**接受建议的建链交接会失败关闭**。`,
    );
  }
  console.log("");
  // 源定位符决定"晋升时能否自动证明源未漂移"
  const locator = result.archive.metadata.inventory.sourceLocator;
  if (locator.kind === "standard") {
    console.log("【源定位符】标准源树内的相对路径：" + locator.locator);
    console.log("  → 复核/晋升时会**自动**重新清点该源并比对摘要（无需再给路径）。");
  } else {
    /*
     * ── 为什么这里**不**打印带原始路径的可粘贴命令（F-C）──
     *
     * 外部源根的绝对路径是**任意的本机字符串**，可能含 `$()`、反引号、
     * 引号、分号、管道、`&`、换行。把 `--source-root "<path>"` 拼进一行
     * 命令会产生"看起来可执行、复制粘贴就可能执行任意命令"的文本 ——
     * 而 PowerShell 的双引号串**会**展开 `$()`。
     *
     * F11 已经确立过这条纪律（自由文本不得被当作安全 shell 文本输出）。
     * 与 F11 同样，这里不发明跨 shell 的转义库，而是**不输出原始路径**：
     * 路径单独作为**仅展示**文本打印，命令只作为**不含任何路径**的模板。
     */
    console.log(`【源定位符】外部源根「${sanitizeForDisplay(locator.label)}」—— **刻意不记录位置**（绝对路径不落盘）。`);
    console.log("  → 复核/晋升时必须**再次**提供当前源目录才能证明源未漂移。");
    console.log("");
    console.log("  做法：重新运行 course:review，并传入 --source-root 指向原始外部目录。");
    console.log("  命令模板（请自行替换占位符；<PATH> 需按你的 shell 规则引用）：");
    console.log("      pnpm course:review <course-id> --source-root <PATH> [--promote]");
    console.log("");
    console.log("  说明：模板里**不含**任何真实路径 —— 外部路径是任意本机字符串，");
    console.log("        直接拼进命令可能被 shell 当作语法（例如 PowerShell 展开 $()）。");
    console.log(`        候选的目录名标签（仅展示，已省略控制字符与 shell 元字符）：${sanitizeForDisplay(locator.label)}`);
  }
  console.log("");

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: args.dryRun,
          wroteFiles: !args.dryRun,
          courseId: args.id,
          candidateChecksum: checksum,
          canonicalLibraryDigest: result.archive.metadata.matching.canonicalLibrary.digest,
          inventory: {
            files: result.inventory.assets.length,
            digest: result.inventory.digest,
            rejected: result.inventory.rejected.length,
          },
          materials: result.grouping.proposals.length,
          segments: result.archive.manifest.segments.length,
          // 分段模式证据（**安全元数据**：计数、校验和、问题码；绝不含正文）
          segmentationMode: result.archive.metadata.segmentation.modeEvidence,
          segmentationPlan: {
            provided: planInput !== undefined,
            applied: planOutcome.applied,
            planDigest: planOutcome.planDigest,
            unitCount: planOutcome.plan?.units.length ?? 0,
            channelLineCounts: planOutcome.channelLineCounts,
            unassignedLineCount: planOutcome.unassigned.length,
            issueCodes: planOutcome.issues.map((issue) => `${issue.code}@${issue.where}`),
          },
          review: { blocking: blocking.length, advisory: advisory.length },
          stages: result.stages,
        },
        null,
        2,
      ),
    );
  }

  if (args.dryRun) {
    console.log("（--dry-run：没有写入任何文件。）");
    return;
  }

  // ── 写候选包 ──
  //
  // 只在 `course-candidates/<id>/` 下写。**绝不触碰 `courses/`。**
  if (existsSync(candidateDir)) {
    // 重新抽取同一门课：旧候选先备份再替换。
    // 刻意**不**静默覆盖 —— 旧候选可能带着一份已签署的 review.json。
    const backup = `${candidateDir}.prev-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      const { cpSync } = await import("node:fs");
      cpSync(candidateDir, backup, { recursive: true });
      rmSync(candidateDir, { recursive: true, force: true });
      console.log(`已存在旧候选，已备份到：${backup}`);
    } catch (error) {
      console.error(`无法备份旧候选，中止（不覆盖）：${(error as Error).message}`);
      process.exit(1);
    }
  }

  mkdirSync(candidatesRoot, { recursive: true });
  writeCourseCandidate(result.archive, candidateDir);

  console.log(`已写出候选包：${candidateDir}`);
  console.log("");
  console.log("下一步（**人工**）：");
  if (planOutcome.applied) {
    console.log("  0. 若这套分段结构不对，用 `pnpm course:segment " + args.id + "` 打开本地标注界面修改计划，");
    console.log("     然后**重新运行本命令**（候选必须从输入重新生成，绝不在原地改写）。");
  } else if (result.archive.metadata.segmentation.modeEvidence.mode === "automatic") {
    console.log("  0. 若自动分段不成立，用 `pnpm course:segment " + args.id + "` 在本地标注界面上");
    console.log("     人工定义结构（保存计划）后**重新运行本命令**。");
  }
  console.log("  1. 打开 candidate.json，逐条核对 inventory / grouping / segmentation / matching 证据；");
  console.log(`  2. 写 ${join(candidateDir, "review.json")}（绑定上面的 candidateChecksum）—— 工具**从不**生成它；`);
  console.log(`  3. pnpm course:review ${args.id}                    # 预演门禁`);
  console.log(`     pnpm course:review ${args.id} --promote          # 通过后晋升为规范化课程包`);
  console.log("");
  console.log("注意：候选包位于 course-candidates/，**生产导入器看不见它**。");
  console.log("      晋升**不**创建任何 canonical 链接 —— 那需要另行显式核验。");
  console.log("      人工分段计划**不会**被复制进课程包 —— 它是输入，不是内容。");
}

main().catch((error: unknown) => {
  console.error("抽取失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
