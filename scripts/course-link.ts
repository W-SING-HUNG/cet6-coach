#!/usr/bin/env node
/**
 * `pnpm course:link` —— 建立 / 查看「课程段 → 规范真题位置」的链接。
 *
 * ── 这个命令的存在理由 ──
 *
 * 系统**无法**自己知道一段课程材料对应哪道真题：课程材料按题型重新归组过，
 * 文件名、"第 1 套"、物理页码顺序、题号本身都不是证明。
 * 因此对应关系只能由**人工核验**后显式建立，本命令是那个人工入口。
 *
 * 默认是 **dry-run**：只做全部校验并打印结论，不写数据库。
 * 加 `--commit` 才写入。校验失败一律拒绝写入（fail closed）。
 *
 * ── 只读保证（含 schema）──
 *
 * 未加 `--commit` 的全部路径（默认核验、`--list`、`--segments`）使用
 * **只读数据库连接**：它们不做迁移、不建表、不写 `schema_meta`、
 * 不写任何课程行。任何写入都会在 SQLite 层以
 * `attempt to write a readonly database` 失败 —— 因此这是**结构性**保证，
 * 不依赖"记得别写"。
 *
 * 在 v8 库上，这些只读命令**不会**把它迁移到 v9；它们会如实说明
 * "课程层尚未激活"，并给出激活方式（`pnpm course:import --commit`）。
 * 迁移是**提交动作**的一部分，不属于任何预演。
 *
 * 用法：
 *   pnpm course:link --course <id> --segments
 *       列出该课程包的全部段（人工核验时用来找 segment id）
 *
 *   pnpm course:link --course <id> --list
 *       列出该课程包的全部链接及其运行时可用性（含 stale / candidate / rejected）
 *
 *   pnpm course:link --course <id> --segment <sid> --paper <pid> --section <sid> \
 *       --scope section|group|question [--group <gid>] [--question <qid>] \
 *       --status verified|candidate|rejected --ref "<核验依据>" [--note "..."]
 *       校验并（加 --commit 后）写入一条链接
 */

import { getReadOnlyRepositories, getRepositories } from "@/repositories/sqlite";
import type { Repositories } from "@/repositories/ports";
import { NormalizedCourseImporter } from "@/content/course/importer";
import { getCoursesDir, isRegularFile, resolveWithinRoot } from "@/content/paper/paths";
import {
  verifyCanonicalLink,
  getCourseLinkOverview,
  describeLinkTarget,
  listLinksForSegmentWithUsability,
} from "@/services/course-link";
import { createPackageIntegrityCache } from "@/services/course-packages";
import {
  COURSE_LINK_TARGET_SCOPES,
  COURSE_LINK_VERIFICATION_STATUSES,
  COURSE_SEGMENT_KIND_LABELS,
  type CourseLinkTargetScope,
  type CourseLinkVerificationStatus,
} from "@/domain/course";
import { join } from "node:path";

interface Args {
  course: string | null;
  segment: string | null;
  paper: string | null;
  section: string | null;
  group: string | null;
  question: string | null;
  scope: string | null;
  status: string;
  ref: string | null;
  note: string | null;
  commit: boolean;
  json: boolean;
  list: boolean;
  segments: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--") && !arg.includes("=")));
  const valueOf = (name: string): string | null => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    return null;
  };

  return {
    course: valueOf("course"),
    segment: valueOf("segment"),
    paper: valueOf("paper"),
    section: valueOf("section"),
    group: valueOf("group"),
    question: valueOf("question"),
    scope: valueOf("scope"),
    status: valueOf("status") ?? "verified",
    ref: valueOf("ref"),
    note: valueOf("note"),
    commit: flags.has("--commit"),
    json: flags.has("--json"),
    list: flags.has("--list"),
    segments: flags.has("--segments"),
  };
}

function usage(): void {
  console.log("用法见文件头注释：pnpm course:link --course <id> [--segments | --list | 核验参数]");
  console.log("");
  console.log("这是**人工核验**入口：系统无法自己知道课程段对应哪道真题。");
  console.log("默认 dry-run（只读，含 schema：不迁移、不写库）；加 --commit 才写入。");
  console.log("校验失败一律拒绝写入。");
}

/**
 * 报告"课程包不可读"的**精确原因**。
 *
 * 必须区分两种完全不同的情形，否则操作者会被引向错误的排查方向：
 *
 * - **课程层尚未激活**（库是 v8，没有课程层表）：不是"这个包不在库中"，
 *   而是"整个课程层还没被激活"。处置是 `course:import --commit`。
 * - **课程层已激活但没有这个包**：这个 id 确实没导入过。
 */
function explainCourseUnavailable(repos: Repositories, courseId: string): string {
  if (!repos.courses.isActivated()) {
    return (
      `课程层尚未激活：本库还没有课程层表（course_package 等），因此不存在任何课程索引。\n` +
      `这不是"课程包 ${courseId} 缺失"，而是整个课程层尚未启用。\n` +
      `请先运行：pnpm course:import --commit（它会执行增量 v8 → v9 迁移并写入课程索引）。`
    );
  }
  return `课程包 ${courseId} 不在索引中。先运行 pnpm course:import --commit。`;
}

/** 打印该课程包的全部段，供人工核验时挑选 segment id。**只读。** */
function printSegments(courseId: string): boolean {
  // 只读 repository：不迁移、不建表、不写版本号（见脚本头部说明）。
  const repos = getReadOnlyRepositories();
  const record = repos.courses.getPackage(courseId);
  if (!record) {
    console.error(explainCourseUnavailable(repos, courseId));
    return false;
  }

  const resolved = resolveWithinRoot(getCoursesDir(), record.packagePath, { mustExist: false });
  if (!isRegularFile(join(resolved.absolutePath, "course.json"))) {
    console.error(`课程包文件缺失：private-content/courses/${record.packagePath}`);
    return false;
  }

  const parsed = new NormalizedCourseImporter().parse({
    relativePath: record.packagePath,
    absolutePath: resolved.absolutePath,
  });

  console.log(`课程包 ${record.id}（v${record.contentVersion}）· provider ${record.provider}`);
  console.log(`标题：${record.title}`);
  console.log("");
  console.log(`共 ${parsed.content.segments.length} 个段：`);
  for (const segment of parsed.content.segments) {
    console.log(`  ${segment.id}`);
    console.log(
      `    ${COURSE_SEGMENT_KIND_LABELS[segment.kind]} · ${segment.title}` +
        ` · 材料 ${segment.materialId} · order ${segment.order}`,
    );
    const anchor =
      segment.anchor.pageStart !== null
        ? `第 ${segment.anchor.pageStart}–${segment.anchor.pageEnd ?? segment.anchor.pageStart} 页` +
          (segment.representationId ? `（${segment.representationId}）` : "")
        : segment.anchor.quote
          ? `引文：${segment.anchor.quote.slice(0, 48)}…`
          : "无来源锚点";
    console.log(`    锚点：${anchor}`);
    if (segment.audioAssetId) console.log(`    音频：${segment.audioAssetId}（整段，不切分）`);
  }

  console.log("");
  console.log(
    "未匹配是合法状态。只有人工核验过的段才应建立链接 —— " +
      "文件名 / 套别号 / 页码顺序 / 题号本身都不是证明。",
  );
  return true;
}

function printLinks(courseId: string): boolean {
  // 只读 repository：`--list` 是检查命令，绝不该改动 schema。
  const repos = getReadOnlyRepositories();
  const record = repos.courses.getPackage(courseId);
  if (!record) {
    console.error(explainCourseUnavailable(repos, courseId));
    return false;
  }

  const overview = getCourseLinkOverview(repos, courseId);
  console.log(`课程包 ${courseId}（当前 v${overview.currentContentVersion ?? "—"}）`);
  console.log(`段总数：${overview.totalSegments ?? "—"}`);
  console.log(
    `运行时目标（已按语义去重）：可用 ${overview.verifiedUsable} · 已失效 ${overview.staleVerified} · ` +
      `候选 ${overview.candidates} · 已否决 ${overview.rejected}`,
  );
  // 审计行数与运行时目标数**必须分开显示**：同一目标被独立复核/修正多次时，
  // 前者会大于后者。合成一个数字会让"复核了两次"看起来像"两个对应关系"。
  console.log(
    `不可变复核行（审计历史，不去重）：verified ${overview.verifiedRows} 条` +
      (overview.verifiedRows > overview.verifiedUsable
        ? ` —— 其中 ${overview.verifiedRows - overview.verifiedUsable} 条与其它行指向同一语义目标`
        : ""),
  );
  console.log(
    `已匹配的段：${overview.matchedSegmentIds.length} 个` +
      (overview.matchedSegmentIds.length > 0 ? `（${overview.matchedSegmentIds.join(" / ")}）` : ""),
  );

  const allLinks = repos.courses.listLinksForCourse(courseId);
  if (allLinks.length === 0) {
    console.log("");
    console.log("该课程包没有任何链接。**未匹配是合法状态** —— 不影响包本身的可用性。");
    return true;
  }

  // 每次列表调用共用一份包读取缓存（一次调用内不重复读同一份包）。
  const cache = createPackageIntegrityCache();

  console.log("");
  const segmentIds = [...new Set(allLinks.map((link) => link.segmentId))].sort();
  for (const segmentId of segmentIds) {
    console.log(`段 ${segmentId}`);
    for (const view of listLinksForSegmentWithUsability(repos, courseId, segmentId, cache)) {
      const state = view.runtimeUsable ? "可用" : "不可用";
      console.log(`  [${view.link.verificationStatus} · ${state}] ${describeLinkTarget(view.link)}`);
      console.log(
        `    课程版本 v${view.link.courseContentVersion} · 复核引用：${view.link.verificationRef}` +
          (view.link.note ? ` · 注解：${view.link.note}` : ""),
      );
      console.log(`    复核时间：${view.link.createdAt} · 身份 ${view.link.id.slice(0, 12)}…`);
      if (view.unusableReason) console.log(`    原因：${view.unusableReason}`);
    }
  }
  return true;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.course) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (args.segments) {
    if (!printSegments(args.course)) process.exitCode = 1;
    return;
  }

  if (args.list) {
    if (!printLinks(args.course)) process.exitCode = 1;
    return;
  }

  // ---- 核验并（可选）写入一条链接 ----
  if (!args.segment || !args.paper || !args.section || !args.scope) {
    console.error("缺少必要参数：--segment / --paper / --section / --scope");
    console.error("");
    usage();
    process.exitCode = 1;
    return;
  }

  if (!COURSE_LINK_TARGET_SCOPES.includes(args.scope as CourseLinkTargetScope)) {
    console.error(`未登记的目标粒度：${args.scope}（允许 ${COURSE_LINK_TARGET_SCOPES.join(" / ")}）`);
    process.exitCode = 1;
    return;
  }
  if (!COURSE_LINK_VERIFICATION_STATUSES.includes(args.status as CourseLinkVerificationStatus)) {
    console.error(
      `未登记的核验状态：${args.status}（允许 ${COURSE_LINK_VERIFICATION_STATUSES.join(" / ")}）`,
    );
    process.exitCode = 1;
    return;
  }

  /*
   * ── 只读 / 写入在这里**分岔**（本次修复第二轮：与 course:import 同一类缺陷）──
   *
   * 早先这里无条件 `getRepositories()`，因此**默认的 dry-run 核验**
   * 也会在旧库上执行迁移。核验本身完全不写库（`dryRun` 时不落任何行），
   * 所以它没有理由具备写入能力。
   *
   * 现在：未 `--commit` ⇒ 只读连接（迁移在原理上不可达）；
   * `--commit` ⇒ 写路径（显式请求数据库变更）。
   *
   * **失败关闭不得把用户静默带进迁移**：若一条 `--commit` 的链接命令
   * 因为核验不通过而拒绝写入，它**不会**顺带迁移 —— 迁移只发生在
   * "确实要写课程索引"的 `course:import --commit` 上。
   * 链接写入本身不需要新的 schema 变更（表已在激活时建好）。
   */
  const repos = args.commit ? getRepositories() : getReadOnlyRepositories();
  const record = repos.courses.getPackage(args.course);
  if (!record) {
    console.error(explainCourseUnavailable(repos, args.course));
    process.exitCode = 1;
    return;
  }

  const paper = repos.papers.getPaper(args.paper);
  if (!paper) {
    console.error(`真题卷 ${args.paper} 不在索引中。链接必须指向一份已导入的真卷。`);
    process.exitCode = 1;
    return;
  }

  console.log("CET-6 Coach · 课程链接核验");
  console.log(`课程包：${record.id} v${record.contentVersion}（${record.title}）`);
  console.log(`课程段：${args.segment}`);
  console.log(`目标卷：${paper.id} v${paper.contentVersion}`);
  console.log(`目标粒度：${args.scope}`);
  console.log(`核验状态：${args.status}`);
  console.log(
    `模式：${args.commit ? "写入（--commit）" : "预演（dry-run，不写数据库，含 schema）"}`,
  );
  console.log("");

  const result = verifyCanonicalLink(repos, {
    courseId: args.course,
    // 刻意取**当前**版本：链接只能绑定当前版本，不能为旧版建链接。
    courseContentVersion: record.contentVersion,
    segmentId: args.segment,
    paperId: args.paper,
    paperContentVersion: paper.contentVersion,
    sectionId: args.section,
    groupId: args.group,
    questionId: args.question,
    targetScope: args.scope as CourseLinkTargetScope,
    verificationStatus: args.status as CourseLinkVerificationStatus,
    verificationRef: args.ref ?? "",
    note: args.note,
    // dry-run 走**同一段判据**，只是不写库 —— 因此预演结论与真实写入一致。
    dryRun: !args.commit,
  });

  if (!result.ok) {
    console.log("校验未通过，**未写入任何数据**：");
    for (const issue of result.issues) console.log(`  ${issue.path}: ${issue.message}`);
    console.log("");
    console.log("结果：FAIL（fail closed）");
    process.exitCode = 1;
    return;
  }

  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  console.log(`链接身份（由声明推导，重复写入幂等）：${result.link.id}`);
  console.log(`指向：${describeLinkTarget(result.link)}`);
  console.log("");

  if (!args.commit) {
    console.log("这是预演。核实无误后加 --commit 真正写入。");
    console.log("");
    console.log("结果：PASS（预演，未写入任何数据）");
    return;
  }

  if (!result.created) {
    // 幂等命中：这一份声明已经在库里。**不是失败** —— 重跑不该报错。
    console.log("这份核验声明已存在，未产生新行（幂等）。");
    console.log("");
    console.log("结果：PASS（无变化）");
    return;
  }

  console.log("已写入链接。");
  console.log("");
  console.log("结果：PASS");
  console.log("");
  console.log(
    "提醒：链接绑定的是**当前**版本。课程包或真题卷升版后，这条链接会立即变为不可用，" +
      "必须对新版重新核验 —— 系统不会自动沿用旧复核。",
  );
}

main();
