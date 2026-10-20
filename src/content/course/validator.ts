import { z } from "zod";
import {
  COURSE_ASSET_KINDS,
  COURSE_ASSET_MIME_BY_EXTENSION,
  type CourseAsset,
  type CourseIssue,
  type CourseMaterial,
  type CoursePackageContent,
  type CourseSegment,
} from "./types";
import { COURSE_SEGMENT_KINDS, judgeCourseManifestSchemaVersion, type CourseSegmentKind } from "@/domain/course";
import { normalizeRelativePath, UnsafePathError, pathSafetyCategory } from "@/content/paper/paths";

/**
 * 规范化课程包的校验器。
 *
 * 分两层（与试卷校验器同一个结构）：
 * 1. **本文件**：纯函数。形状（zod）+ 语义（手写遍历）。不接触文件系统，
 *    因此可以被单测穷举，也可以在 dry-run 中安全运行。
 * 2. `importer.ts`：读磁盘、比对资产字节与校验和。
 *
 * 语义校验手写而不用 zod 的 superRefine：需要一次性收集**全部**问题并给出
 * 精确位置（`segments[2].materialId`），而不是只报第一个。
 *
 * ── 一条关键的"合法状态" ──
 *
 * **没有 canonical 链接的 segment 是完全合法的。** 因此本文件里
 * **不存在**任何"每个 segment 必须有对应真题"的检查 ——
 * 课程材料按题型重新归组，本来就会包含大量不与任何真题一一对应的内容
 * （方法说明、模板、讲解）。把"未匹配"当错误会让导入在原理上不可用。
 */

// ---------------------------------------------------------------------------
// 形状 schema
// ---------------------------------------------------------------------------

const slugPattern = /^[a-z0-9][a-z0-9._-]*$/;
const slugMessage = "只能包含小写字母、数字、点、下划线与连字符，且不能以符号开头";

const nullableText = z.string().nullable().default(null);

const assetSchema = z.object({
  id: z.string().regex(slugPattern, `资产 id ${slugMessage}`),
  kind: z.enum(COURSE_ASSET_KINDS),
  path: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().min(0),
  checksum: z.string().regex(/^[0-9a-f]{64}$/, "checksum 必须是 64 位小写十六进制 sha256"),
  label: nullableText,
});

const representationSchema = z.object({
  id: z.string().regex(slugPattern, `表示 id ${slugMessage}`),
  assetId: z.string().min(1),
  label: z.string().min(1),
});

const materialSchema = z.object({
  id: z.string().regex(slugPattern, `材料 id ${slugMessage}`),
  title: z.string().min(1),
  representations: z.array(representationSchema).min(1, "每份材料至少要有一种表示"),
});

const anchorSchema = z.object({
  pageStart: z.number().int().min(1).nullable().default(null),
  pageEnd: z.number().int().min(1).nullable().default(null),
  quote: nullableText,
});

const segmentSchema = z.object({
  id: z.string().regex(slugPattern, `段 id ${slugMessage}`),
  materialId: z.string().min(1),
  kind: z.enum(COURSE_SEGMENT_KINDS),
  order: z.number().int().min(0),
  title: z.string().min(1),
  representationId: z.string().nullable().default(null),
  anchor: anchorSchema.default({ pageStart: null, pageEnd: null, quote: null }),
  audioAssetId: z.string().nullable().default(null),
  startSeconds: z.number().min(0).nullable().default(null),
  endSeconds: z.number().min(0).nullable().default(null),
  text: nullableText,
  transcript: nullableText,
  referenceTranslation: nullableText,
  notes: nullableText,
});

const provenanceSchema = z.object({
  note: z.string().min(1),
  reference: nullableText,
  /**
   * 权利说明必填。课程材料是付费内容，它的本机留存理由必须被显式写下 ——
   * 否则一个包可以静默地变成"来源不明的付费材料"。
   */
  rightsNote: z.string().min(1, "必须写下这份材料为何可以合法保存在本机（rightsNote）"),
});

const courseManifestSchema = z.object({
  id: z.string().regex(slugPattern, `课程 id ${slugMessage}`),
  /**
   * manifest 序列化契约版本。**必需**。
   *
   * 形状层用 `z.unknown().optional()` 放行一切（含缺失），把判定完全交给
   * `judgeCourseManifestSchemaVersion`。两个理由：
   *
   * 1. **错误措辞**：zod 的 `z.number().int()` 在缺失时只会说
   *    "expected nonoptional"，而操作者需要知道的是
   *    "这是文件格式版本、不是内容版本、支持哪些值"；
   * 2. **必须是第一个报出的错误**：一份按未知契约写的 JSON 里，
   *    其余字段的报错都可能是解析器误读的产物。若让 zod 先拒（比如 title
   *    也坏了），操作者会去修 title，而真正的问题是契约版本。
   *
   * 判据仍然只有一处实现（`judgeCourseManifestSchemaVersion`）。
   */
  schemaVersion: z.unknown().optional(),
  provider: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/, `provider ${slugMessage}（它是自由字符串，不是枚举）`),
  edition: nullableText,
  title: z.string().min(1),
  contentVersion: z.number().int().min(1),
  provenance: provenanceSchema,
  materials: z.array(materialSchema).min(1, "课程包至少要有一份材料"),
  segments: z.array(segmentSchema).min(1, "课程包至少要有一个段"),
  assets: z.array(assetSchema).default([]),
});

type ParsedManifest = z.infer<typeof courseManifestSchema>;

export interface CourseValidationOutcome {
  ok: boolean;
  /** 只在 `ok === true` 时非空：调用方拿不到"校验失败的半成品"。 */
  course: CoursePackageContent | null;
  issues: CourseIssue[];
  warnings: string[];
}

export function formatCourseIssuePath(path: ReadonlyArray<string | number | symbol>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (typeof segment === "string") {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out === "" ? "<course>" : out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function validateCourseManifest(raw: unknown): CourseValidationOutcome {
  /**
   * ── 第一步：manifest 契约版本，**在形状校验之前**判定 ──
   *
   * 为什么必须先于 zod：一份按**未知契约**写的 JSON，其字段形状可能与当前
   * 解析器完全不同。若先跑 zod，操作者拿到的会是一串"title 缺失 / segments
   * 不是数组"之类的**误读产物**，而真正的原因是"这份文件不是按我能读的契约
   * 写的"。
   *
   * 读原始输入而不是 parsed.data：zod 在形状层面失败时根本不会产出
   * parsed.data，那样这条判定就永远不会执行。
   */
  const rawSchemaVersion =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).schemaVersion
      : undefined;

  const schemaJudgement = judgeCourseManifestSchemaVersion(rawSchemaVersion);
  if (!schemaJudgement.ok) {
    return {
      ok: false,
      course: null,
      issues: [{ path: "schemaVersion", message: schemaJudgement.message }],
      warnings: [],
    };
  }

  const parsed = courseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      course: null,
      issues: parsed.error.issues.map((issue) => ({
        path: formatCourseIssuePath(issue.path),
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const issues: CourseIssue[] = [];
  const warnings: string[] = [];

  const assets = normalizeAssets(parsed.data, issues);
  const assetIds = new Set(assets.map((asset) => asset.id));
  const materials = normalizeMaterials(parsed.data, assetIds, issues, warnings);
  const materialIds = new Set(materials.map((material) => material.id));
  const segments = normalizeSegments(parsed.data, materialIds, assetIds, issues, warnings);

  if (issues.length > 0) {
    return { ok: false, course: null, issues, warnings };
  }

  const course: CoursePackageContent = {
    id: parsed.data.id,
    schemaVersion: schemaJudgement.version,
    provider: parsed.data.provider,
    edition: parsed.data.edition,
    title: parsed.data.title,
    contentVersion: parsed.data.contentVersion,
    provenance: {
      note: parsed.data.provenance.note,
      reference: parsed.data.provenance.reference,
      rightsNote: parsed.data.provenance.rightsNote,
    },
    materials,
    segments,
    assets,
  };

  return { ok: true, course, issues: [], warnings };
}

// ---------------------------------------------------------------------------
// 资产
// ---------------------------------------------------------------------------

function normalizeAssets(manifest: ParsedManifest, issues: CourseIssue[]): CourseAsset[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const result: CourseAsset[] = [];

  manifest.assets.forEach((asset, index) => {
    const base = `assets[${index}]`;

    if (seenIds.has(asset.id)) {
      issues.push({ path: `${base}.id`, message: `资产 id 重复：${asset.id}` });
    }
    seenIds.add(asset.id);

    let relativePath: string | null = null;
    try {
      relativePath = normalizeRelativePath(asset.path);
    } catch (error) {
      // 措辞纪律同 paper validator（F-2 同类根因）：不回显 manifest 声明的
      // 路径原文，只给分类原因。判定本身一点没松。
      const reason =
        error instanceof UnsafePathError
          ? `资产路径不合法（${pathSafetyCategory(error)}）。它必须是包内的相对路径，不得含 ..、绝对路径、盘符或 UNC。`
          : "资产路径无法解析。";
      issues.push({ path: `${base}.path`, message: reason });
    }

    if (relativePath === null) return;

    if (seenPaths.has(relativePath)) {
      issues.push({ path: `${base}.path`, message: `资产路径重复：${relativePath}` });
    }
    seenPaths.add(relativePath);

    const expectedMime = mimeForCoursePath(relativePath);
    if (expectedMime === null) {
      issues.push({
        path: `${base}.path`,
        message:
          `不支持的资产扩展名：${relativePath}（允许 ` +
          `${Object.keys(COURSE_ASSET_MIME_BY_EXTENSION).join(" / ")}）`,
      });
    } else if (asset.mimeType !== expectedMime) {
      // 刻意不信任 manifest 声明的 MIME：以扩展名为准，声明不符即拒绝
      issues.push({
        path: `${base}.mimeType`,
        message: `声明的 MIME 与扩展名不符：声明 ${asset.mimeType}，${relativePath} 应为 ${expectedMime}`,
      });
    }

    const expectedKind = kindForMime(expectedMime);
    if (expectedKind !== null && asset.kind !== expectedKind) {
      issues.push({
        path: `${base}.kind`,
        message: `资产类型与扩展名不符：声明 ${asset.kind}，${relativePath} 应为 ${expectedKind}`,
      });
    }

    result.push({
      id: asset.id,
      kind: asset.kind,
      relativePath,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      checksum: asset.checksum,
      label: asset.label,
    });
  });

  return result;
}

export function mimeForCoursePath(relativePath: string): string | null {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return COURSE_ASSET_MIME_BY_EXTENSION[lower.slice(dot)] ?? null;
}

function kindForMime(mime: string | null): CourseAsset["kind"] | null {
  if (mime === null) return null;
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return "document";
}

// ---------------------------------------------------------------------------
// 材料与表示
// ---------------------------------------------------------------------------

/**
 * 材料与表示。
 *
 * ── 这里防的是哪一种真实错误 ──
 *
 * "同一份讲义有 PDF 与 DOCX 两个文件" 不得变成 "两份课程材料"。
 * 模型上它已经不可能（文件是 `representations`），本函数再补两条：
 *
 * 1. **同一资产不能被同一材料引用两次**（那只是同一个文件写了两行）；
 * 2. 同一资产也**不得被两份不同材料引用** —— 一个文件不能同时是两份逻辑内容，
 *    否则"这份材料有几个文件"与"这个文件属于哪份材料"两个问题的答案会互相矛盾。
 */
function normalizeMaterials(
  manifest: ParsedManifest,
  assetIds: Set<string>,
  issues: CourseIssue[],
  warnings: string[],
): CourseMaterial[] {
  const seenIds = new Set<string>();
  const assetOwners = new Map<string, string>();
  const result: CourseMaterial[] = [];

  manifest.materials.forEach((material, index) => {
    const base = `materials[${index}]`;

    if (seenIds.has(material.id)) {
      issues.push({ path: `${base}.id`, message: `材料 id 重复：${material.id}` });
    }
    seenIds.add(material.id);

    const seenRepresentationIds = new Set<string>();
    const seenAssets = new Set<string>();

    const representations = material.representations.map((representation, repIndex) => {
      const repBase = `${base}.representations[${repIndex}]`;

      if (seenRepresentationIds.has(representation.id)) {
        issues.push({ path: `${repBase}.id`, message: `表示 id 重复：${representation.id}` });
      }
      seenRepresentationIds.add(representation.id);

      if (!assetIds.has(representation.assetId)) {
        issues.push({
          path: `${repBase}.assetId`,
          message: `引用了不存在的资产：${representation.assetId}`,
        });
      }

      if (seenAssets.has(representation.assetId)) {
        issues.push({
          path: `${repBase}.assetId`,
          message:
            `同一份材料重复引用同一个资产：${representation.assetId}。` +
            `同一文件只应是同一种表示，重复声明不会让它变成两种形态。`,
        });
      }
      seenAssets.add(representation.assetId);

      const owner = assetOwners.get(representation.assetId);
      if (owner && owner !== material.id) {
        issues.push({
          path: `${repBase}.assetId`,
          message:
            `资产 ${representation.assetId} 同时被材料 ${owner} 与 ${material.id} 引用。` +
            `一个文件只能属于一份逻辑材料 —— 否则"这份材料有几个文件"与"这个文件属于哪份材料"会互相矛盾。`,
        });
      }
      assetOwners.set(representation.assetId, material.id);

      return {
        id: representation.id,
        assetId: representation.assetId,
        label: representation.label,
      };
    });

    if (representations.length > 1) {
      warnings.push(
        `${base}：这份材料有 ${representations.length} 种表示（${representations
          .map((item) => item.label)
          .join(" / ")}）—— 它们是同一份逻辑内容，不是多份材料。`,
      );
    }

    result.push({ id: material.id, title: material.title, representations });
  });

  return result;
}

// ---------------------------------------------------------------------------
// 段
// ---------------------------------------------------------------------------

const TEXT_BEARING_KINDS: CourseSegmentKind[] = [
  "reading_passage",
  "translation_passage",
  "writing_template",
  "method_note",
];

const AUDIO_KINDS: CourseSegmentKind[] = [
  "listening_conversation",
  "listening_passage",
  "listening_recording",
];

function normalizeSegments(
  manifest: ParsedManifest,
  materialIds: Set<string>,
  assetIds: Set<string>,
  issues: CourseIssue[],
  warnings: string[],
): CourseSegment[] {
  const seenIds = new Set<string>();
  const result: CourseSegment[] = [];

  manifest.segments.forEach((segment, index) => {
    const base = `segments[${index}]`;

    if (seenIds.has(segment.id)) {
      issues.push({ path: `${base}.id`, message: `段 id 重复：${segment.id}` });
    }
    seenIds.add(segment.id);

    if (!materialIds.has(segment.materialId)) {
      issues.push({
        path: `${base}.materialId`,
        message: `引用了不存在的材料：${segment.materialId}`,
      });
    }

    // ---- 锚点 ----
    const { pageStart, pageEnd } = segment.anchor;
    if (pageStart !== null && pageEnd !== null && pageEnd < pageStart) {
      issues.push({
        path: `${base}.anchor.pageEnd`,
        message: `页码区间的结束页小于起始页：${pageStart} → ${pageEnd}`,
      });
    }
    // 页码只在某个具体表示的页码体系里成立 —— 因此必须声明是哪一个。
    // 否则"第 12 页"指向哪份文件（PDF 还是 DOCX）根本不可知。
    if (pageStart !== null && segment.representationId === null) {
      issues.push({
        path: `${base}.representationId`,
        message: "声明了页码锚点，必须同时声明它属于哪一种表示（representationId）",
      });
    }
    // 反之，若声明了表示，页码可以缺省（例如只用 quote 定位），这是合法的。
    if (segment.representationId !== null) {
      const material = manifest.materials.find((item) => item.id === segment.materialId);
      const known = material?.representations.some((rep) => rep.id === segment.representationId) ?? false;
      if (!known) {
        issues.push({
          path: `${base}.representationId`,
          message: `表示 ${segment.representationId} 不属于该段声明的材料 ${segment.materialId}`,
        });
      }
    }
    if (pageStart === null && pageEnd !== null) {
      issues.push({
        path: `${base}.anchor.pageStart`,
        message: "只声明了结束页而没有起始页",
      });
    }
    if (pageStart === null && pageEnd === null && segment.anchor.quote === null) {
      // 提醒而非阻断：一个段落完全可以只有正文而没有来源锚点
      // （例如课程自编的方法说明）。但"能定位回源件"是它的价值所在。
      warnings.push(`${base}：没有页码锚点也没有引文，无法定位回源件（不影响导入）。`);
    }

    // ---- 音频 ----
    if (segment.audioAssetId !== null) {
      if (!assetIds.has(segment.audioAssetId)) {
        issues.push({
          path: `${base}.audioAssetId`,
          message: `引用了不存在的音频资产：${segment.audioAssetId}`,
        });
      }
    }
    if (AUDIO_KINDS.includes(segment.kind) && segment.audioAssetId === null) {
      issues.push({
        path: `${base}.audioAssetId`,
        message: `${segment.kind} 必须引用整段音频资产（本层不做音频切分）`,
      });
    }
    if (!AUDIO_KINDS.includes(segment.kind) && segment.audioAssetId !== null) {
      issues.push({
        path: `${base}.audioAssetId`,
        message: `非听力段不应引用音频：${segment.kind}`,
      });
    }

    // ---- 时间区间 ----
    if (segment.startSeconds !== null && segment.endSeconds !== null) {
      if (segment.endSeconds <= segment.startSeconds) {
        issues.push({
          path: `${base}.endSeconds`,
          message: `时间区间的结束必须大于开始：${segment.startSeconds} → ${segment.endSeconds}`,
        });
      }
    } else if ((segment.startSeconds === null) !== (segment.endSeconds === null)) {
      issues.push({
        path: `${base}.startSeconds`,
        message: "时间区间必须同时给出开始与结束，或都不给",
      });
    }
    if ((segment.startSeconds !== null || segment.endSeconds !== null) && segment.audioAssetId === null) {
      issues.push({
        path: `${base}.startSeconds`,
        message: "声明了时间区间却没有引用音频资产",
      });
    }

    // ---- 内容 ----
    if (TEXT_BEARING_KINDS.includes(segment.kind) && segment.text === null && segment.notes === null) {
      issues.push({
        path: `${base}.text`,
        message: `${segment.kind} 必须有正文或说明（text / notes 至少一项）`,
      });
    }
    if (segment.kind === "translation_passage" && segment.text === null) {
      issues.push({ path: `${base}.text`, message: "翻译段必须有中文原文（text）" });
    }
    if (segment.kind === "translation_passage" && segment.referenceTranslation === null) {
      // 提醒而非阻断：有的翻译讲义只给语言点、不给整段参考译文，那是真实形态。
      warnings.push(`${base}：翻译段没有课程参考译文（referenceTranslation）。`);
    }
    if (segment.kind.startsWith("listening_") && segment.transcript === null) {
      warnings.push(`${base}：听力段没有文字稿（transcript），只能按音频处理。`);
    }

    result.push({
      id: segment.id,
      materialId: segment.materialId,
      kind: segment.kind,
      order: segment.order,
      title: segment.title,
      representationId: segment.representationId,
      anchor: { pageStart, pageEnd, quote: segment.anchor.quote },
      audioAssetId: segment.audioAssetId,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text,
      transcript: segment.transcript,
      referenceTranslation: segment.referenceTranslation,
      notes: segment.notes,
    });
  });

  // 段内顺序必须连续：order 是呈现顺序，不是自由标签。
  // 与试卷的题组内顺序同一条规则（避免"声明顺序"与"数组顺序"两个真相）。
  const byMaterial = new Map<string, number[]>();
  result.forEach((segment) => {
    const list = byMaterial.get(segment.materialId) ?? [];
    list.push(segment.order);
    byMaterial.set(segment.materialId, list);
  });
  for (const [materialId, orders] of byMaterial) {
    const sorted = [...orders].sort((a, b) => a - b);
    for (const [position, value] of sorted.entries()) {
      if (value !== position) {
        issues.push({
          path: `segments[*].order`,
          message:
            `材料 ${materialId} 的段顺序必须从 0 连续：位置 ${position} 期望 order=${position}，实际 ${value}`,
        });
        break;
      }
    }
  }

  return result;
}
