#!/usr/bin/env node
/**
 * `pnpm content:validate` —— 校验私有内容库中的全部试卷包。
 *
 * 关键性质：**只读**。它不写数据库、不改内容包、不生成文件。
 * 因此在任何时候运行它都是安全的，并且在导入前运行它就是最自然的检查动作。
 *
 * 空库时必须诚实输出「0 份」并以成功退出 —— 空内容库是合法状态，
 * 不是错误。绝不能为了"看起来有东西"而伪造内容。
 */

import { existsSync } from "node:fs";
import { getContentRoot, getPapersDir } from "@/content/paper/paths";
import { NormalizedPackageImporter, ManifestReadError } from "@/content/paper/importer";
import { SECTION_LABELS, type PaperSectionType } from "@/domain/paper";

interface PackageResult {
  dir: string;
  ok: boolean;
  paperId: string | null;
  title: string | null;
  sourceKind: string | null;
  verificationStatus: string | null;
  contentVersion: number | null;
  sections: Array<{ type: PaperSectionType; questions: number; groups: number; hasAudio: boolean }>;
  questionCount: number;
  assetCount: number;
  assetBytes: number;
  checksum: string | null;
  issues: Array<{ path: string; message: string }>;
  warnings: string[];
}

function main(): void {
  const contentRoot = getContentRoot();
  const papersDir = getPapersDir();

  console.log("CET-6 Coach · 私有内容库校验");
  console.log(`内容根：${contentRoot}`);
  console.log(`试卷目录：${papersDir}`);
  console.log("");

  if (!existsSync(papersDir)) {
    console.log("0 份试卷包（目录不存在）");
    console.log("");
    console.log(`把试卷包放到上面这个目录里，每个包一个子目录，内含 paper.json 与 assets/。`);
    console.log("格式说明见 docs/past-paper-package.md。");
    console.log("");
    console.log("结果：PASS（空内容库是合法状态）");
    return;
  }

  const importer = new NormalizedPackageImporter(papersDir);
  const handles = importer.discover();

  if (handles.length === 0) {
    console.log("0 份试卷包（目录存在但没有任何含 paper.json 的子目录）");
    console.log("");
    console.log("结果：PASS（空内容库是合法状态）");
    return;
  }

  const results: PackageResult[] = handles.map((handle) => {
    try {
      const validated = importer.validate(handle);
      const content = validated.content;
      return {
        dir: handle.relativePath,
        ok: true,
        paperId: content.id,
        title: `${content.year} / ${content.session} / ${content.variant}`,
        sourceKind: content.sourceKind,
        verificationStatus: content.verificationStatus,
        contentVersion: content.contentVersion,
        sections: content.sections.map((section) => ({
          type: section.type,
          questions: section.groups.reduce((sum, group) => sum + group.questions.length, 0),
          groups: section.groups.length,
          hasAudio: section.groups.some((group) => group.audioAssetId !== null),
        })),
        questionCount: content.sections.reduce(
          (sum, section) => sum + section.groups.reduce((groupSum, group) => groupSum + group.questions.length, 0),
          0,
        ),
        assetCount: content.assets.length,
        assetBytes: content.assets.reduce((sum, asset) => sum + asset.bytes, 0),
        checksum: validated.checksum,
        issues: [],
        warnings: validated.warnings,
      };
    } catch (error) {
      const issues =
        error instanceof ManifestReadError
          ? error.issues
          : [{ path: "<package>", message: (error as Error).message }];
      return {
        dir: handle.relativePath,
        ok: false,
        paperId: null,
        title: null,
        sourceKind: null,
        verificationStatus: null,
        contentVersion: null,
        sections: [],
        questionCount: 0,
        assetCount: 0,
        assetBytes: 0,
        checksum: null,
        issues,
        warnings: [],
      };
    }
  });

  let worldProblems = 0;

  for (const result of results) {
    const marker = result.ok ? "\u2713" : "\u2717";
    console.log(`${marker} ${result.dir}`);
    if (!result.ok) {
      for (const issue of result.issues) {
        console.log(`    ${issue.path}: ${issue.message}`);
        worldProblems += 1;
      }
      console.log("");
      continue;
    }

    console.log(`    id: ${result.paperId}   v${result.contentVersion}`);
    console.log(`    来源：${result.sourceKind} · 核验：${result.verificationStatus}`);
    console.log(`    共 ${result.questionCount} 题 · ${result.sections.length} 个大题`);
    for (const section of result.sections) {
      const audio = section.hasAudio ? " · 含音频" : "";
      console.log(
        `      - ${SECTION_LABELS[section.type]}：${section.questions} 题 / ${section.groups} 组${audio}`,
      );
    }
    console.log(
      `    资产：${result.assetCount} 个 · ${(result.assetBytes / 1024 / 1024).toFixed(1)} MB · 磁盘校验和已核对`,
    );
    console.log(`    manifest sha256: ${result.checksum?.slice(0, 16)}…`);
    for (const warning of result.warnings) console.log(`    ! ${warning}`);

    // 内容策略提醒：非真题来源必须显式暴露，防止夹具冒充真题
    if (result.sourceKind === "test_fixture") {
      console.log(`    ! 这是测试夹具（test_fixture），不会被当作真题使用`);
    } else if (result.sourceKind === "sample") {
      console.log(`    ! 这是示例包（sample），不是真题`);
    }
    console.log("");
  }

  const ok = results.filter((result) => result.ok).length;
  const failed = results.length - ok;
  const real = results.filter((result) => result.sourceKind === "real_past_paper").length;
  // 三种核验状态分开计数。
  // 早先把「非 verified」全部算成 unverified，会让 partially_verified 的卷子
  // 在汇总里被显示为"未核验"，与上方逐包的明细自相矛盾。
  const unverified = results.filter(
    (result) => result.sourceKind === "real_past_paper" && result.verificationStatus === "unverified",
  ).length;
  const partially = results.filter(
    (result) => result.sourceKind === "real_past_paper" && result.verificationStatus === "partially_verified",
  ).length;
  const verified = results.filter(
    (result) => result.sourceKind === "real_past_paper" && result.verificationStatus === "verified",
  ).length;

  console.log(`共发现 ${results.length} 份试卷包：${ok} 份校验通过，${failed} 份未通过`);
  console.log(
    `其中标记为 real_past_paper 的来源：${real} 份` +
      (real > 0 ? `（已核验 ${verified} · 部分核验 ${partially} · 未核验 ${unverified}）` : ""),
  );
  console.log("");
  console.log(failed === 0 ? "结果：PASS" : `结果：FAIL（${worldProblems} 处问题）`);

  if (failed > 0) process.exitCode = 1;
}

main();
