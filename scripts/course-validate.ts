#!/usr/bin/env node
/**
 * `pnpm course:validate` —— 校验私有内容库中的全部课程包。
 *
 * 关键性质：**只读**。它不写数据库、不改内容包、不生成文件。
 * 因此在任何时候运行它都是安全的，并且在导入前运行它就是最自然的检查动作。
 *
 * 空库时必须诚实输出「0 份」并以成功退出 —— 空课程库是合法状态，
 * 不是错误。绝不能为了"看起来有东西"而伪造内容。
 */

import { existsSync } from "node:fs";
import { getContentRoot, getCoursesDir } from "@/content/paper/paths";
import { NormalizedCourseImporter, CourseManifestReadError } from "@/content/course/importer";
import { courseContentFingerprint } from "@/content/course/fingerprint";
import { COURSE_SEGMENT_KIND_LABELS, type CourseSegmentKind } from "@/domain/course";

interface SegmentSummary {
  kind: CourseSegmentKind;
  title: string;
  hasAudio: boolean;
  hasText: boolean;
  hasTranscript: boolean;
  /** 是否有来源锚点（页码或引文）。没有锚点不影响导入，但影响可追溯性。 */
  anchored: boolean;
}

interface PackageResult {
  dir: string;
  ok: boolean;
  courseId: string | null;
  /** manifest 的序列化契约版本。与 contentVersion 是**两件不同的事**。 */
  manifestSchemaVersion: number | null;
  provider: string | null;
  title: string | null;
  edition: string | null;
  contentVersion: number | null;
  segmentCount: number;
  materialCount: number;
  /** 有几种表示的材料数量 —— 用于如实展示"一份材料多文件"这条语义。 */
  multiRepresentationMaterials: number;
  segments: SegmentSummary[];
  assetCount: number;
  assetBytes: number;
  checksum: string | null;
  fingerprint: string | null;
  issues: Array<{ path: string; message: string }>;
  warnings: string[];
}

function main(): void {
  const contentRoot = getContentRoot();
  const coursesDir = getCoursesDir();

  console.log("CET-6 Coach · 私有课程库校验");
  console.log(`内容根：${contentRoot}`);
  console.log(`课程目录：${coursesDir}`);
  console.log("");

  if (!existsSync(coursesDir)) {
    console.log("0 份课程包（目录不存在）");
    console.log("");
    console.log("把课程包放到上面这个目录里，每个包一个子目录，内含 course.json 与 assets/。");
    console.log("格式说明见 docs/course-package.md。");
    console.log("");
    console.log("结果：PASS（空课程库是合法状态）");
    return;
  }

  const importer = new NormalizedCourseImporter(coursesDir);
  const handles = importer.discover();

  if (handles.length === 0) {
    console.log("0 份课程包（目录存在但没有任何含 course.json 的子目录）");
    console.log("");
    console.log("结果：PASS（空课程库是合法状态）");
    return;
  }

  const results: PackageResult[] = handles.map((handle) => {
    try {
      const validated = importer.validate(handle);
      const content = validated.content;
      return {
        dir: handle.relativePath,
        ok: true,
        courseId: content.id,
        manifestSchemaVersion: content.schemaVersion,
        provider: content.provider,
        title: content.title,
        edition: content.edition,
        contentVersion: content.contentVersion,
        segmentCount: content.segments.length,
        materialCount: content.materials.length,
        multiRepresentationMaterials: content.materials.filter(
          (material) => material.representations.length > 1,
        ).length,
        segments: content.segments.map((segment) => ({
          kind: segment.kind,
          title: segment.title,
          hasAudio: segment.audioAssetId !== null,
          hasText: segment.text !== null,
          hasTranscript: segment.transcript !== null,
          anchored: segment.anchor.pageStart !== null || segment.anchor.quote !== null,
        })),
        assetCount: content.assets.length,
        assetBytes: content.assets.reduce((sum, asset) => sum + asset.bytes, 0),
        checksum: validated.checksum,
        fingerprint: courseContentFingerprint(content),
        issues: [],
        warnings: validated.warnings,
      };
    } catch (error) {
      const issues =
        error instanceof CourseManifestReadError
          ? error.issues
          : [{ path: "<package>", message: (error as Error).message }];
      return {
        dir: handle.relativePath,
        ok: false,
        courseId: null,
        manifestSchemaVersion: null,
        provider: null,
        title: null,
        edition: null,
        contentVersion: null,
        segmentCount: 0,
        materialCount: 0,
        multiRepresentationMaterials: 0,
        segments: [],
        assetCount: 0,
        assetBytes: 0,
        checksum: null,
        fingerprint: null,
        issues,
        warnings: [],
      };
    }
  });

  let problemCount = 0;

  for (const result of results) {
    const marker = result.ok ? "\u2713" : "\u2717";
    console.log(`${marker} ${result.dir}`);
    if (!result.ok) {
      for (const issue of result.issues) {
        console.log(`    ${issue.path}: ${issue.message}`);
        problemCount += 1;
      }
      console.log("");
      continue;
    }

    const edition = result.edition ? ` · ${result.edition}` : "";
    console.log(`    id: ${result.courseId}   v${result.contentVersion}`);
    // 明确分开打印：manifest 契约版本 ≠ 内容版本。
    // 这两个数字含义不同，混在一行会让排查者以为它们是同一件事的两个说法。
    console.log(
      `    manifest schemaVersion: ${result.manifestSchemaVersion ?? "—"}（文件格式契约版本）` +
        `   contentVersion: ${result.contentVersion}（语义内容版本）`,
    );
    console.log(`    provider: ${result.provider}${edition}`);
    console.log(`    标题：${result.title}`);
    console.log(`    材料 ${result.materialCount} 份 · 段 ${result.segmentCount} 个`);
    if (result.multiRepresentationMaterials > 0) {
      console.log(
        `    其中 ${result.multiRepresentationMaterials} 份材料有多种表示（同一逻辑内容的不同文件，**不是**多份材料）`,
      );
    }

    for (const segment of result.segments) {
      const flags: string[] = [];
      if (segment.hasAudio) flags.push("音频");
      if (segment.hasText) flags.push("正文");
      if (segment.hasTranscript) flags.push("文字稿");
      if (!segment.anchored) flags.push("无来源锚点");
      console.log(
        `      - ${COURSE_SEGMENT_KIND_LABELS[segment.kind]}：${segment.title}` +
          (flags.length > 0 ? `（${flags.join(" · ")}）` : ""),
      );
    }

    console.log(
      `    资产：${result.assetCount} 个 · ${(result.assetBytes / 1024 / 1024).toFixed(1)} MB · 磁盘校验和已核对`,
    );
    console.log(`    manifest sha256: ${result.checksum?.slice(0, 16)}…`);
    console.log(`    内容指纹: ${result.fingerprint?.slice(0, 16)}…（判"是否同一版内容"用它，不用整包校验和）`);
    for (const warning of result.warnings) console.log(`    ! ${warning}`);
    console.log("");
  }

  const ok = results.filter((result) => result.ok).length;
  const failed = results.length - ok;
  const providers = new Set(results.filter((r) => r.ok).map((r) => r.provider));
  const segmentTotal = results.reduce((sum, r) => sum + r.segmentCount, 0);

  console.log(`共发现 ${results.length} 份课程包：${ok} 份校验通过，${failed} 份未通过`);
  if (ok > 0) {
    console.log(`覆盖 ${providers.size} 个 provider，合计 ${segmentTotal} 个课程段`);
    console.log(
      "注意：课程层不是第二个题库。课程段可以不匹配任何真题 —— 未匹配是合法状态，" +
        "链接由人工核验后经 `pnpm course:link` 建立。",
    );
  }
  console.log("");
  console.log(failed === 0 ? "结果：PASS" : `结果：FAIL（${problemCount} 处问题）`);

  if (failed > 0) process.exitCode = 1;
}

main();
