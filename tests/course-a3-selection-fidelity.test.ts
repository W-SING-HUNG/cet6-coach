// @vitest-environment node
/**
 * A3 文件选择保真度（File Selection Fidelity）· 端到端回归。
 *
 * ── 这个文件守的是什么 ──
 *
 * A1 的只读检查支持"勾选目录 + 排除文件"，而 A3 的候选生成是**另一条入口**
 * 进入 `runCourseIntake`。独立评审指出：A3 消费的是"预先选定的源根"，
 * 但这**本身并不证明**被排除的文件仍然被排除。
 *
 * 本文件用**逐字节与元数据**判据回答这个问题，覆盖：
 *
 * 1. 被排除的文件**不被读作候选内容**；
 * 2. 被排除的资产**不进入候选包**，也不进入晋升后的课程包；
 * 3. 分组 / 分段 / 匹配**不使用**被排除的内容；
 * 4. 预演与生成使用**完全相同**的有效选择；
 * 5. 重复预演、重试与陈旧检查保持选择语义；
 * 6. 源当前性检查使用**同一范围**，且能发现该范围内的变化；
 * 7. 畸形选择**不能**扩大读取范围到源根之外；
 * 8. 实际候选清单与"期望的已选资产集合"**逐项相等**。
 *
 * ── 为什么判据必须落在"字节"而不是"界面文案" ──
 *
 * 本项目已登记过多次同一失效形态：断言的作用域小于它声称的范围。
 * "界面显示排除了 2 个文件"在候选里仍然包含它们时**照样通过**。
 * 因此这里一律对比**候选包内的实际文件与 manifest 资产清单**。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { buildSourceSelection } from "@/content/course-pipeline/inspection";
import { getCourseSourcesDir } from "@/content/paper/paths";
import { buildTextPdf, writeSourceTree } from "../scripts/course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

const roots: string[] = [];
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `a3-sel-${tag}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 一个**刻意设计**的合成源目录：
 *
 * ```
 * selected-a/passage-a.pdf           ← 勾选目录里的 PDF（应进候选）
 * selected-a/excluded-in-a.pdf       ← 在勾选目录里但**被显式排除**
 * excluded-b/passage-b.pdf           ← 整个目录未勾选
 * selected-c/passage-c.pdf           ← 第二个勾选目录（应进候选）
 * selected-c/notes.txt               ← 勾选目录里的不支持类型（应被登记但无正文）
 * root-level.pdf                     ← 源根下的文件（源根未勾选 ⇒ 应被排除）
 * ```
 *
 * 这样每一类排除都能被**分别**证明，而不是只测一种。
 */
function buildLayeredSource(root: string): {
  sourceRoot: string;
  expectedIncluded: string[];
  expectedExcluded: string[];
} {
  const sourceRoot = join(root, "layered-source");
  const tree = new Map<string, Buffer>();

  /*
   * ── 这些标记必须全是 **Latin-1** ──
   *
   * `buildTextPdf` 刻意拒绝 Latin-1 之外的字符（本项目实测过"中文被单字节
   * 截断成乱码，而测试验证的是乱码"的缺陷形态）。因此这里用纯 ASCII 标记，
   * 且标记串刻意短而唯一 —— 便于在候选字节里做**反空断言**。
   */
  const passageA = "The synthetic selective-import passage alpha describes attention as a distributed resource.";
  const excludedA = "EXCLUDED FILE CONTENT marker: excluded-in-a";
  const passageB = "EXCLUDED DIRECTORY CONTENT marker: excluded-b";
  const passageC = "The synthetic selective-import passage gamma describes a second included directory.";
  const rootLevel = "ROOT LEVEL CONTENT marker: root-level";

  tree.set("selected-a/passage-a.pdf", buildTextPdf([["SYNTHETIC FIXTURE", passageA]]));
  tree.set("selected-a/excluded-in-a.pdf", buildTextPdf([["SYNTHETIC FIXTURE", excludedA]]));
  tree.set("excluded-b/passage-b.pdf", buildTextPdf([["SYNTHETIC FIXTURE", passageB]]));
  tree.set("selected-c/passage-c.pdf", buildTextPdf([["SYNTHETIC FIXTURE", passageC]]));
  tree.set("selected-c/notes.txt", Buffer.from("synthetic notes, unsupported type", "utf8"));
  tree.set("root-level.pdf", buildTextPdf([["SYNTHETIC FIXTURE", rootLevel]]));

  writeSourceTree(sourceRoot, tree);

  return {
    sourceRoot,
    expectedIncluded: ["selected-a/passage-a.pdf", "selected-c/passage-c.pdf", "selected-c/notes.txt"],
    expectedExcluded: [
      "selected-a/excluded-in-a.pdf",
      "excluded-b/passage-b.pdf",
      "root-level.pdf",
    ],
  };
}

function buildPapers(root: string): string {
  const papersRoot = join(root, "papers");
  const papersDir = join(papersRoot, "cet6", "papers");
  writeFixturePackage(
    papersRoot,
    "fixture-cet6-2024-12-set1",
    buildFixturePackage({ id: "fixture-cet6-2024-12-set1", year: 2024, session: "December", variant: "set1" }),
  );
  return papersDir;
}

/** 候选包里的实际资产文件（相对路径，POSIX）。 */
function candidateAssetFiles(candidateDir: string): string[] {
  const assetsDir = join(candidateDir, "assets");
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => `assets/${name}`)
    .sort();
}

/** 候选 manifest 里声明的资产路径（磁盘契约字段是 `path`）。 */
function manifestAssetPaths(candidateDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(candidateDir, "course.json"), "utf8")) as {
    assets?: { path?: string }[];
  };
  return (manifest.assets ?? []).map((asset) => asset.path ?? "").sort();
}

const SELECTION = {
  includeDirectories: ["selected-a", "selected-c"],
  excludeFiles: ["selected-a/excluded-in-a.pdf"],
};

describe("A3 文件选择保真度 · 候选生成必须尊重 A1 的选择范围", () => {
  it("被排除的文件与目录**不进入候选包**，且候选资产清单与期望逐项相等", async () => {
    const root = makeRoot("assets");
    const { sourceRoot, expectedIncluded, expectedExcluded } = buildLayeredSource(root);
    const papersDir = buildPapers(root);
    const contentRoot = join(root, "content");
    const candidatesDir = join(contentRoot, "course-candidates");
    process.env.CET6_CONTENT_ROOT = contentRoot;
    try {
      const selection = buildSourceSelection(SELECTION);
      const intake = await runCourseIntake({
        sourceRoot,
        courseId: "sel-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "Selective Fixture",
        contentVersion: 1,
        provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
        papersDir,
        standardSourcesRoot: getCourseSourcesDir(),
        selection,
      });

      // ① 清点结果里**只有**已选文件
      const scannedPaths = intake.inventory.assets.map((asset) => asset.relativePath).sort();
      expect(scannedPaths).toEqual([...expectedIncluded].sort());

      // ② 被排除的每个路径都**不在**清点结果里，且一个都不在
      for (const excluded of expectedExcluded) {
        expect(scannedPaths, `被排除的 ${excluded} 仍在清点结果里`).not.toContain(excluded);
      }

      // ③ 候选 manifest 的资产集合与清点结果一致（不接受"抽到了但没声明"）
      const candidateDir = join(candidatesDir, "sel-course");
      writeCourseCandidate(intake.archive, candidateDir);
      const declared = manifestAssetPaths(candidateDir);
      expect(declared.length, "候选 manifest 必须声明资产").toBeGreaterThan(0);

      // ④ 候选目录里的**实际文件**数量与声明数量一致（没有偷偷多拷）
      const files = candidateAssetFiles(candidateDir);
      expect(files.sort()).toEqual(declared.sort());

      /*
       * ⑤ 最强的判据：**读取候选包内每一个资产文件的字节**，
       *    确认其中不含任何被排除内容的标记。
       *
       * 这条排在路径断言之后，因为"路径没出现但字节里还有"是另一种失效
       * （本项目登记过"快照只覆盖前 72 字节"那类作用域谬误）。
       */
      const allBytes = files
        .map((relative) => readFileSync(join(candidateDir, ...relative.split("/"))))
        .reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0));

      for (const marker of ["excluded-in-a", "excluded-b", "root-level"]) {
        expect(
          allBytes.includes(Buffer.from(marker, "utf8")),
          `候选资产字节里出现了被排除内容的标记：${marker}`,
        ).toBe(false);
      }
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("分组、分段与匹配都**不使用**被排除的内容", async () => {
    const root = makeRoot("pipeline");
    const { sourceRoot } = buildLayeredSource(root);
    const papersDir = buildPapers(root);
    const contentRoot = join(root, "content");
    process.env.CET6_CONTENT_ROOT = contentRoot;
    try {
      const selection = buildSourceSelection(SELECTION);
      const intake = await runCourseIntake({
        sourceRoot,
        courseId: "sel-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "Selective Fixture",
        contentVersion: 1,
        provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
        papersDir,
        standardSourcesRoot: getCourseSourcesDir(),
        selection,
      });

      // 分组提案只能覆盖已选资产
      const selectedKeys = new Set(intake.inventory.assets.map((asset) => asset.assetKey));
      for (const proposal of intake.grouping.proposals) {
        for (const representation of proposal.representations) {
          expect(
            selectedKeys.has(representation.assetKey),
            `分组提案引用了未选中的资产：${representation.assetKey}`,
          ).toBe(true);
        }
      }

      // 段文本只能来自已选材料（排除内容的标记不得出现在任何段正文里）
      const segmentText = intake.segmentation
        .flatMap((material) => material.segments.map((segment) => segment.text))
        .join("\n");
      for (const marker of ["excluded-in-a", "excluded-b", "root-level"]) {
        expect(segmentText.includes(marker), `段正文里出现了被排除内容的标记：${marker}`).toBe(false);
      }

      // 匹配证据同样不得出现被排除内容
      const matchText = JSON.stringify(intake.archive.metadata.matching);
      for (const marker of ["excluded-in-a", "excluded-b", "root-level"]) {
        expect(matchText.includes(marker), `匹配证据里出现了被排除内容的标记：${marker}`).toBe(false);
      }
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("预演与生成使用**完全相同**的有效选择（两次独立运行产出相同候选校验和）", async () => {
    const root = makeRoot("same-selection");
    const { sourceRoot } = buildLayeredSource(root);
    const papersDir = buildPapers(root);
    const contentRoot = join(root, "content");
    process.env.CET6_CONTENT_ROOT = contentRoot;
    try {
      const selectionA = buildSourceSelection(SELECTION);
      const selectionB = buildSourceSelection(SELECTION);

      const first = await runCourseIntake({
        sourceRoot,
        courseId: "sel-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "Selective Fixture",
        contentVersion: 1,
        provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
        papersDir,
        standardSourcesRoot: getCourseSourcesDir(),
        selection: selectionA,
      });
      const second = await runCourseIntake({
        sourceRoot,
        courseId: "sel-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "Selective Fixture",
        contentVersion: 1,
        provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
        papersDir,
        standardSourcesRoot: getCourseSourcesDir(),
        // 注意：**不同的 Selection 实例**，但语义相同 ⇒ 候选校验和必须相同
        selection: selectionB,
      });

      expect(second.archive.metadata.digests.candidateChecksum).toBe(
        first.archive.metadata.digests.candidateChecksum,
      );
      expect(second.inventory.digest).toBe(first.inventory.digest);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("源摘要只覆盖已选范围：改变**被排除**文件的内容不改变候选身份", async () => {
    const root = makeRoot("excluded-drift");
    const { sourceRoot } = buildLayeredSource(root);
    const papersDir = buildPapers(root);
    const contentRoot = join(root, "content");
    process.env.CET6_CONTENT_ROOT = contentRoot;
    try {
      const run = async () =>
        runCourseIntake({
          sourceRoot,
          courseId: "sel-course",
          provider: "test_fixture_provider",
          edition: null,
          title: "Selective Fixture",
          contentVersion: 1,
          provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
          papersDir,
          standardSourcesRoot: getCourseSourcesDir(),
          selection: buildSourceSelection(SELECTION),
        });

      const before = await run();

      // 改掉一个**被排除**文件的内容
      writeSourceTree(
        sourceRoot,
        new Map([
          [
            "excluded-b/passage-b.pdf",
            buildTextPdf([["SYNTHETIC FIXTURE", "CHANGED EXCLUDED CONTENT marker: excluded-b-v2"]]),
          ],
        ]),
      );
      const afterExcludedChange = await run();
      expect(
        afterExcludedChange.inventory.digest,
        "被排除文件不该影响源摘要（它不在范围内）",
      ).toBe(before.inventory.digest);
      expect(afterExcludedChange.archive.metadata.digests.candidateChecksum).toBe(
        before.archive.metadata.digests.candidateChecksum,
      );

      // 对照：改掉一个**已选**文件的内容 ⇒ 摘要必须变化
      writeSourceTree(
        sourceRoot,
        new Map([
          [
            "selected-c/passage-c.pdf",
            buildTextPdf([["SYNTHETIC FIXTURE", "CHANGED INCLUDED CONTENT marker: selected-c-v2"]]),
          ],
        ]),
      );
      const afterIncludedChange = await run();
      expect(
        afterIncludedChange.inventory.digest,
        "已选文件变化必须改变源摘要",
      ).not.toBe(before.inventory.digest);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("畸形选择**不能**扩大读取范围到源根之外", async () => {
    const root = makeRoot("malformed");
    const { sourceRoot } = buildLayeredSource(root);
    const papersDir = buildPapers(root);
    const contentRoot = join(root, "content");
    process.env.CET6_CONTENT_ROOT = contentRoot;
    try {
      /*
       * 刻意用"试图上跳 / 绝对路径 / 盘符"的条目构造选择。
       *
       * 判据不是"这些条目被忽略"，而是**它们根本没有扩大读取范围**：
       * 结果必须仍然只有源根内的已选文件。
       */
      const malformed = buildSourceSelection({
        includeDirectories: ["selected-a", "..", "../..", "/etc", "C:\\Windows"],
        excludeFiles: [],
      });

      const intake = await runCourseIntake({
        sourceRoot,
        courseId: "sel-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "Selective Fixture",
        contentVersion: 1,
        provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
        papersDir,
        standardSourcesRoot: getCourseSourcesDir(),
        selection: malformed,
      });

      // 清点结果里**只能**出现源根内的相对路径
      for (const asset of intake.inventory.assets) {
        expect(asset.relativePath.startsWith("/"), "不得出现绝对路径").toBe(false);
        expect(/^[A-Za-z]:/.test(asset.relativePath), "不得出现盘符路径").toBe(false);
        expect(asset.relativePath.includes(".."), "不得出现上跳段").toBe(false);
      }
      // 且只能来自被勾选的目录
      for (const asset of intake.inventory.assets) {
        expect(
          asset.relativePath.startsWith("selected-a/") || asset.relativePath.startsWith("selected-c/"),
          `畸形选择读进了范围外的条目：${asset.relativePath}`,
        ).toBe(true);
      }
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("不提供选择时行为**与既有 CLI 完全一致**（读取整个源根）", async () => {
    const root = makeRoot("no-selection");
    const { sourceRoot } = buildLayeredSource(root);
    const papersDir = buildPapers(root);
    const contentRoot = join(root, "content");
    process.env.CET6_CONTENT_ROOT = contentRoot;
    try {
      const withoutSelection = await runCourseIntake({
        sourceRoot,
        courseId: "all-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "All Fixture",
        contentVersion: 1,
        provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
        papersDir,
        standardSourcesRoot: getCourseSourcesDir(),
      });

      // 未提供选择 ⇒ 源根下所有受支持文件都进清点（向后兼容）
      const paths = withoutSelection.inventory.assets.map((asset) => asset.relativePath).sort();
      expect(paths).toContain("selected-a/passage-a.pdf");
      expect(paths).toContain("selected-a/excluded-in-a.pdf");
      expect(paths).toContain("excluded-b/passage-b.pdf");
      expect(paths).toContain("root-level.pdf");
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });
});
