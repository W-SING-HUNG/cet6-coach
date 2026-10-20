import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExamPaperContent, PaperAsset, PaperIssue, ValidatedPaper } from "./types";
import type { NormalizedPackageHandle, PaperPackageImporter } from "./types";
import { getPapersDir, isRegularFile, normalizeRelativePath, resolveWithinRoot } from "./paths";
import { validatePaperManifest } from "./validator";

/**
 * 规范化目录包导入器。
 *
 * 包形态（`private-content/cet6/papers/<dir>/`）：
 *
 *   paper.json          试卷 manifest（内容 + 来源 + 版本）
 *   assets/…            音频 / 图片，路径由 manifest 的 assets[].path 声明
 *
 * 校验顺序刻意如此：**先词法、再磁盘、最后语义**。
 * 路径不安全时立刻停在路径层，不去读任何文件 ——
 * 否则"读取一个越界文件"这件事本身就已经发生了。
 */

export const PAPER_MANIFEST_FILENAME = "paper.json";

export class ManifestReadError extends Error {
  constructor(
    readonly issues: PaperIssue[],
    message = "试卷包读取失败",
  ) {
    super(message);
    this.name = "ManifestReadError";
  }
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 发现内容根下的所有候选包。
 *
 * 只做一层目录枚举：包必须直接位于 `cet6/papers/<dir>/`，
 * 不允许嵌套任意深度 —— 那会让"哪些文件属于哪个包"变得不明确，
 * 也会扩大路径解析的攻击面。
 */
export class NormalizedPackageImporter implements PaperPackageImporter {
  readonly kind = "normalized_package" as const;
  readonly label = "规范化试卷包";

  constructor(private readonly papersDir: string = getPapersDir()) {}

  discover(): NormalizedPackageHandle[] {
    // turbopackIgnore：私有内容根刻意位于项目之外，见 catalog.ts 的说明。
    // 不加标记会让整个项目被追踪进服务端产物。
    if (!existsSync(/* turbopackIgnore: true */ this.papersDir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(/* turbopackIgnore: true */ this.papersDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }

    const handles: NormalizedPackageHandle[] = [];
    for (const name of entries.sort()) {
      const absolutePath = join(this.papersDir, name);
      if (!existsSync(/* turbopackIgnore: true */ join(absolutePath, PAPER_MANIFEST_FILENAME))) continue;
      handles.push({ relativePath: name, absolutePath });
    }
    return handles;
  }

  /**
   * 只解析并做语义/形状校验，**不读资产字节**。
   *
   * 存在的理由：详情页每次渲染都去哈希几十 MB 的音频是浪费。
   * 导入与 dry-run 用 `validate`（全量校验）；页面读取用本方法，
   * 资产的真实性靠比对「包内声明的 checksum」与「库中索引的 checksum」来判断 ——
   * 这是同样的可信度，但不需要读盘。两者若不一致，页面会如实报出漂移。
   */
  parse(handle: NormalizedPackageHandle): ValidatedPaper {
    return this.readAndValidate(handle, { verifyAssets: false });
  }

  /**
   * 解析 + **逐个校验资产的真实字节与校验和**，不产生任何写入。
   *
   * 失败时抛出 `ManifestReadError`，携带精确到字段位置的问题列表。
   */
  validate(handle: NormalizedPackageHandle): ValidatedPaper {
    return this.readAndValidate(handle, { verifyAssets: true });
  }

  private readAndValidate(
    handle: NormalizedPackageHandle,
    options: { verifyAssets: boolean },
  ): ValidatedPaper {
    const issues: PaperIssue[] = [];

    const manifestPath = resolveWithinRoot(handle.absolutePath, PAPER_MANIFEST_FILENAME);
    if (!isRegularFile(manifestPath.absolutePath)) {
      throw new ManifestReadError([{ path: PAPER_MANIFEST_FILENAME, message: "包内缺少 paper.json" }]);
    }

    const rawText = readFileSync(/* turbopackIgnore: true */ manifestPath.absolutePath, "utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (error) {
      throw new ManifestReadError([
        { path: PAPER_MANIFEST_FILENAME, message: `JSON 解析失败：${(error as Error).message}` },
      ]);
    }

    const outcome = validatePaperManifest(parsedJson);
    if (!outcome.ok || !outcome.paper) {
      throw new ManifestReadError(outcome.issues);
    }

    const paper = outcome.paper;
    const assets = options.verifyAssets ? this.verifyAssets(handle, paper, issues) : paper.assets;

    if (issues.length > 0) {
      throw new ManifestReadError(issues);
    }

    return {
      content: { ...paper, assets },
      checksum: sha256(rawText),
      packageRelativePath: handle.relativePath,
      warnings: outcome.warnings,
    };
  }

  /**
   * 校验每个资产的真实字节与校验和。
   *
   * 为什么必须比对磁盘而不是相信 manifest：
   * manifest 是外部数据。若只信它声明的 checksum，"包内容与索引不一致"这件事
   * 就永远无法被发现 —— 用户看到的会是"音频打不开"，而不是"包已损坏"。
   */
  private verifyAssets(handle: NormalizedPackageHandle, paper: ExamPaperContent, issues: PaperIssue[]): PaperAsset[] {
    const verified: PaperAsset[] = [];

    paper.assets.forEach((asset, index) => {
      const base = `assets[${index}]`;
      let resolved: { absolutePath: string; relativePath: string };
      try {
        resolved = resolveWithinRoot(handle.absolutePath, asset.relativePath);
      } catch {
        /*
         * ── 措辞纪律（独立评审 F-2 的同类根因）──
         *
         * `UnsafePathError` 的消息会回显被拒绝的 `asset.relativePath`。
         * 这个字符串最终会经 `packageIssue` 出现在界面上，而 manifest 是
         * **外部数据**（使用者自己写的 JSON）。回显它等于让一个 JSON 字段
         * 决定浏览器里出现什么文本。
         *
         * 判定完全保留在 `resolveWithinRoot` 里（拒绝即拒绝，一点没松），
         * 变的只是不给原因字符串。这里刻意**不区分**"路径越界"与"文件不存在"
         * —— 两者都是"这个资产此刻不可用"，而对使用者可行动的下一步相同
         * （确认文件已随包放置、manifest 里的 path 是包内相对路径）。
         * 把分类细节加回来只会诱使下一个人为了"更精确"而重新引入回显。
         */
        issues.push({
          path: `${base}.path`,
          message:
            "这个资产当前不可用（路径越出了包目录，或文件没有随包一起放置）。" +
            "请确认文件已就位且 manifest 里的 path 是包内相对路径，然后重新导入。",
        });
        return;
      }

      if (!isRegularFile(resolved.absolutePath)) {
        issues.push({
          path: `${base}.path`,
          // 同上：不回显 manifest 声明的路径原文。
          message: "资产文件不存在或不是常规文件。请确认文件已随包一起放置。",
        });
        return;
      }

      const size = statSync(/* turbopackIgnore: true */ resolved.absolutePath).size;
      if (size !== asset.bytes) {
        issues.push({
          path: `${base}.bytes`,
          message: `字节数不符：manifest 声明 ${asset.bytes}，磁盘实际 ${size}`,
        });
        return;
      }

      const actual = sha256(readFileSync(/* turbopackIgnore: true */ resolved.absolutePath));
      if (actual !== asset.checksum) {
        issues.push({
          path: `${base}.checksum`,
          message: `校验和不符：manifest 声明 ${asset.checksum.slice(0, 12)}…，磁盘实际 ${actual.slice(0, 12)}…`,
        });
        return;
      }

      verified.push(asset);
    });

    return verified;
  }

  /** 供导入器与命令使用：包目录的可读名称。 */
  static displayName(handle: NormalizedPackageHandle): string {
    return basename(handle.absolutePath);
  }

  /** 供诊断输出使用：包内声明的资产总字节数（不含未声明文件）。 */
  static declaredAssetBytes(paper: ExamPaperContent): number {
    return paper.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  }
}

/** 便捷入口：不做任何写入地校验一个包。 */
export function validatePaperPackage(handle: NormalizedPackageHandle, importer?: NormalizedPackageImporter) {
  return (importer ?? new NormalizedPackageImporter()).validate(handle);
}

export { normalizeRelativePath };
