import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExamPaperRecord } from "@/repositories/ports";
import type { Repositories } from "@/repositories/ports";
import type { PaperAsset, ExamPaperContent } from "./types";
import type { PaperProgressState } from "@/domain/paper";
import { getPapersDir, isRegularFile, papersDirDisplayLabel, resolveWithinRoot } from "./paths";
import { NormalizedPackageImporter, ManifestReadError } from "./importer";
/**
 * 内容仓库边界。
 *
 * 这是 UI / 服务层访问真题的**唯一入口**。
 *
 * 为什么页面不能直接读 private-content：
 * 1. 路径解析与信任边界必须只有一处（否则每一处都是潜在逃逸点）。
 * 2. 目录里的内容随时可能被用户手工改动，因此"读得到 / 读不到 / 内容漂移"
 *    是三种真实状态，必须由一处统一判定并如实上报，而不是各页面自行处理异常。
 * 3. 未来内容可能搬到云端或 API，届时只换本文件的实现，调用方不动。
 *
 * 命名沿用项目既有的 `*Repository`，而不是另造 ContentCatalog 之类的新词。
 */

/** 包与索引的一致性状态。每一种都对应真实可能发生的运维情形。 */
export type PackageStatus =
  /** 包存在，且 manifest 校验和与库中索引一致。 */
  | "ok"
  /** 包目录或 paper.json 不存在（用户删了 private-content，或没同步过来）。 */
  | "missing"
  /** 包存在，但 manifest 内容已变化（用户手工改过），索引已过期。 */
  | "drifted"
  /** 包存在但校验不过。详情页应显示错误而不是半成品内容。 */
  | "invalid";

export interface PaperSummary {
  record: ExamPaperRecord;
  packageStatus: PackageStatus;
  /** 包状态异常时的可读原因。 */
  packageIssue: string | null;
  progress: PaperProgressState;
}

export interface PaperDetail {
  record: ExamPaperRecord;
  content: ExamPaperContent | null;
  assets: PaperAsset[];
  packageStatus: PackageStatus;
  packageIssue: string | null;
  warnings: string[];
  progress: PaperProgressState;
}

function papersDir(): string {
  return getPapersDir();
}

/**
 * 把库中记录的包路径解析为磁盘句柄。库里的路径同样要过安全解析 —— 库不是可信来源。
 *
 * ── 失败消息的措辞纪律（独立评审 F-2 的同类根因）──
 *
 * `UnsafePathError` 的消息会**回显被拒绝的输入**（`路径不安全：<input>（<reason>）`）。
 * 而这个 `error` 字符串会经 `packageIssue` 出现在界面上。库不是可信来源：
 * 一条被污染或被手工编辑的索引行可以让任意字符串（含绝对路径）进入浏览器。
 *
 * 因此这里不把底层消息原文送出去，而是给出**不含任何输入回显**的可读原因。
 * 判定本身完全保留在 `resolveWithinRoot` 里（一点没动），变的只是措辞。
 */
function handleFor(record: ExamPaperRecord) {
  try {
    const resolved = resolveWithinRoot(papersDir(), record.packagePath, { mustExist: false });
    return { ok: true as const, ...resolved };
  } catch {
    return {
      ok: false as const,
      error:
        "索引里记录的内容包路径不安全或无法解析（可能被手工改动过）。" +
        "请重新导入该内容包以刷新索引。",
    };
  }
}

/**
 * 判定进度状态。
 *
 * 诚实性约束：目前**没有**"试卷级作答记录"这一数据来源，
 * 因此只可能返回 `untouched` 或 `reserved_mock`。
 * 不猜测、不用"练过几道题"推"部分完成" —— 那正是把估计当测量。
 */
function progressFor(record: ExamPaperRecord): PaperProgressState {
  return record.pool === "mock_reserve" ? "reserved_mock" : "untouched";
}

export interface PaperRepositoryBoundary {
  listSummaries(): PaperSummary[];
  getDetail(paperId: string): PaperDetail | null;
  /** 只做轻量包状态判定，用于列表页 —— 不解析完整结构。 */
  getPackageStatus(record: ExamPaperRecord): { status: PackageStatus; issue: string | null };
  /**
   * 把资产引用解析为**包内**的绝对路径，供服务路由流式读取。
   *
   * 为什么必须经过这里而不是让路由自己拼路径：
   * 这是全应用唯一一处"把用户可控标识变成服务端文件读取"的地方。
   * 路径解析必须只有一处（`resolveWithinRoot` 的两级防线），
   * 否则每一处都是潜在逃逸点。
   *
   * 返回 null 表示资产不存在于索引中或无法安全解析 —— 调用方必须按 404 处理，
   * 不得自行回退到任何其它路径。
   */
  resolveAssetPath(
    paperId: string,
    assetId: string,
  ): { absolutePath: string; mimeType: string; bytes: number; checksum: string } | null;
}

export function createPaperCatalog(repos: Repositories): PaperRepositoryBoundary {
  const importer = new NormalizedPackageImporter(papersDir());

  function getPackageStatus(record: ExamPaperRecord): { status: PackageStatus; issue: string | null } {
    const handle = handleFor(record);
    if (!handle.ok) return { status: "invalid", issue: handle.error };

    // turbopackIgnore：私有内容根**刻意位于项目之外**（它不进 Git、不进构建产物）。
    // 不加这个标记时，Turbopack 的静态分析会把 `existsSync` 的参数视为"可能指向项目内任意位置"，
    // 于是把整个项目（含 public/）都打进服务端产物 —— 既拖慢部署，
    // 也会让"内容与代码分离"这条架构约束在构建层面失效。
    if (
      !existsSync(/* turbopackIgnore: true */ handle.absolutePath) ||
      !isRegularFile(join(handle.absolutePath, "paper.json"))
    ) {
      return {
        status: "missing",
        // 只用**展示投影**拼这条消息：它出现在界面上（列表页与详情页），
        // 因此不得含盘符/用户名等本机布局。`record.packagePath` 是使用者
        // 自己导入时给的包目录名，属于他可行动的信息，保留。
        issue: `内容包不存在：${papersDirDisplayLabel()}/${record.packagePath}`,
      };
    }

    try {
      // 轻量解析：确认结构合法且 manifest 未被改动（不读音频字节）
      const validated = importer.parse({ relativePath: record.packagePath, absolutePath: handle.absolutePath });
      if (validated.checksum !== record.manifestChecksum) {
        return {
          status: "drifted",
          issue: "内容包已改动（manifest 校验和与索引不一致）。重新导入可更新索引。",
        };
      }
      return { status: "ok", issue: null };
    } catch (error) {
      const issue =
        error instanceof ManifestReadError
          ? error.issues.map((item) => `${item.path}: ${item.message}`).join("；")
          : (error as Error).message;
      return { status: "invalid", issue };
    }
  }

  return {
    getPackageStatus,

    resolveAssetPath(paperId, assetId) {
      const record = repos.papers.getPaper(paperId);
      if (!record) return null;

      const asset = repos.papers.getAsset(paperId, assetId);
      if (!asset) return null;

      // 只服务已知的允许类型。即便索引被污染，也不把任意文件当成媒体返回。
      if (!asset.mimeType.startsWith("audio/") && !asset.mimeType.startsWith("image/")) return null;

      const handle = handleFor(record);
      if (!handle.ok) return null;

      try {
        // 资产路径已在导入时校验过，但**库不是可信来源**：
        // 这里再走一次同一个安全解析，越界即拒绝。
        const resolved = resolveWithinRoot(handle.absolutePath, asset.relativePath);
        if (!isRegularFile(resolved.absolutePath)) return null;
        return {
          absolutePath: resolved.absolutePath,
          mimeType: asset.mimeType,
          bytes: asset.bytes,
          checksum: asset.checksum,
        };
      } catch {
        return null;
      }
    },

    listSummaries(): PaperSummary[] {
      return repos.papers.listPapers().map((record) => {
        const { status, issue } = getPackageStatus(record);
        return { record, packageStatus: status, packageIssue: issue, progress: progressFor(record) };
      });
    },

    getDetail(paperId: string): PaperDetail | null {
      const record = repos.papers.getPaper(paperId);
      if (!record) return null;

      const { status, issue } = getPackageStatus(record);
      const assets = repos.papers.listAssets(paperId);

      if (status !== "ok") {
        return {
          record,
          content: null,
          assets,
          packageStatus: status,
          packageIssue: issue,
          warnings: [],
          progress: progressFor(record),
        };
      }

      const handle = handleFor(record);
      if (!handle.ok) {
        return {
          record,
          content: null,
          assets,
          packageStatus: "invalid",
          packageIssue: handle.error,
          warnings: [],
          progress: progressFor(record),
        };
      }

      try {
        const validated = importer.parse({ relativePath: record.packagePath, absolutePath: handle.absolutePath });
        return {
          record,
          content: validated.content,
          assets: validated.content.assets,
          packageStatus: "ok",
          packageIssue: null,
          warnings: validated.warnings,
          progress: progressFor(record),
        };
      } catch (error) {
        const message =
          error instanceof ManifestReadError
            ? error.issues.map((item) => `${item.path}: ${item.message}`).join("；")
            : (error as Error).message;
        return {
          record,
          content: null,
          assets,
          packageStatus: "invalid",
          packageIssue: message,
          warnings: [],
          progress: progressFor(record),
        };
      }
    },
  };
}

/** 包状态在 UI 上的展示文案。集中一处，避免各页面自行措辞。 */
export const PACKAGE_STATUS_LABELS: Record<PackageStatus, string> = {
  ok: "内容可用",
  missing: "内容包缺失",
  drifted: "内容已改动",
  invalid: "内容校验失败",
};

export { papersDir };
