/**
 * canonical 库的**只读**读取（从磁盘上的规范化真题包）。
 *
 * ── 为什么这里刻意不打开数据库 ──
 *
 * 本流水线是**文件系统工具**。它需要 canonical 内容来算相似度，而 canonical
 * 内容的规范来源是**磁盘上的规范化包**（正文不落库）。
 *
 * 更关键的是本项目已经踩过一次的缺陷形态：一个自称"只读/预演"的命令
 * 经由 `getRepositories()` → `openDatabase()` 打开库，而**打开本身就执行迁移**，
 * 结果把 使用者的 v8 库迁成了 v9。
 *
 * 因此本模块**根本不 import 任何数据库模块**。这不是"打开之后小心别写"，
 * 而是**在原理上不具备写库能力** —— 没有连接，就没有写。
 *
 * ── 索引与磁盘不一致时的处置 ──
 *
 * 由于不读库，本模块**不知道**"库里登记的校验和是多少"。它只报告
 * "磁盘上现有哪些包、它们的校验和是什么"。若包被改动过，
 * 匹配会基于**当前盘上的内容**进行 —— 那正是我们想要的（匹配的是现实）。
 * 而"盘上的内容是否与库中索引一致"由既有的 `course:import` 预演负责报告。
 *
 * 包读不出来时**失败关闭**：不静默跳过。少一个包会让匹配在不知情的情况下
 * 少一批候选 —— 那会让"未匹配"这个结论变得不可信。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExamPaperContent } from "@/content/paper/types";
import { NormalizedPackageImporter, ManifestReadError } from "@/content/paper/importer";
import { getPapersDir } from "@/content/paper/paths";
import type { CanonicalIndex } from "./match";
import { buildCanonicalIndex } from "./match";

export interface LoadedCanonicalPaper {
  paperId: string;
  content: ExamPaperContent;
  /** `paper.json` 的 sha256。 */
  checksum: string;
}

export interface CanonicalLoadResult {
  papers: LoadedCanonicalPaper[];
  /** 读不出来的包（必须可见 —— 静默跳过会让"未匹配"不可信）。 */
  failures: { packagePath: string; reason: string }[];
  /** 与匹配无关的事实披露（例如某卷没有听力文字稿）。 */
  warnings: string[];
}

/**
 * 读取 canonical 真题库。
 *
 * **只读**：只调用导入器的 `parse`（不核资产字节、不写、不迁移）。
 * 刻意用 `parse` 而不是 `validate`：本流水线不负责验证真题包的完整性
 * （那是 `content:validate` / `content:import` 的职责），它只需要内容。
 * 用 `validate` 会让每次匹配都去哈希几十 MB 的音频。
 */
export function loadCanonicalLibrary(papersDir: string = getPapersDir()): CanonicalLoadResult {
  const failures: CanonicalLoadResult["failures"] = [];
  const warnings: string[] = [];

  if (!existsSync(/* turbopackIgnore: true */ papersDir)) {
    return {
      papers: [],
      failures: [],
      warnings: [
        `canonical 真题库目录不存在（${papersDir}）。` +
          `没有任何 canonical 内容可比对 —— 此时所有段都会判为「未匹配」，那是**合法**状态。`,
      ],
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(/* turbopackIgnore: true */ papersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return {
      papers: [],
      failures: [],
      warnings: [`无法枚举真题库目录：${(error as Error).message}`],
    };
  }

  const importer = new NormalizedPackageImporter(papersDir);
  const papers: LoadedCanonicalPaper[] = [];

  for (const name of entries) {
    const absolutePath = join(papersDir, name);
    if (!existsSync(/* turbopackIgnore: true */ join(absolutePath, "paper.json"))) continue;

    try {
      const parsed = importer.parse({ relativePath: name, absolutePath });
      papers.push({
        paperId: parsed.content.id,
        content: parsed.content,
        checksum: parsed.checksum,
      });

      // 与匹配直接相关的事实披露：听力段需要 transcript 才有内容证据
      const listeningSections = parsed.content.sections.filter((section) => section.type.startsWith("listening."));
      const groupsWithoutTranscript = listeningSections.flatMap((section) =>
        section.groups.filter((group) => group.transcript === null).map((group) => `${section.id}/${group.id}`),
      );
      if (groupsWithoutTranscript.length > 0) {
        warnings.push(
          `真题包 ${name} 有 ${groupsWithoutTranscript.length} 个听力题组没有文字稿 —— ` +
            `听力段对它们**没有文本证据可比**（音频不会为了匹配而被读取或转写）。`,
        );
      }
    } catch (error) {
      const reason =
        error instanceof ManifestReadError
          ? error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；")
          : (error as Error).message;
      // **失败关闭**：读不出来的包必须让调用方知道。
      failures.push({ packagePath: name, reason });
    }
  }

  return { papers, failures, warnings };
}

/** 读取 canonical 库并构建**临时内存索引**。 */
export function buildIndexFromDisk(papersDir: string = getPapersDir()): {
  index: CanonicalIndex;
  failures: CanonicalLoadResult["failures"];
  warnings: string[];
} {
  const loaded = loadCanonicalLibrary(papersDir);
  const index = buildCanonicalIndex(
    loaded.papers.map((paper) => ({
      paperId: paper.paperId,
      content: paper.content,
      checksum: paper.checksum,
    })),
    // 读不出来的包进入索引摘要 ⇒ 库从不完整变完整会改变摘要 ⇒ 旧复核陈旧
    loaded.failures,
  );
  return { index, failures: loaded.failures, warnings: loaded.warnings };
}
