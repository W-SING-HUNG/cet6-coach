import { createHash } from "node:crypto";
import type { CoursePackageContent } from "./types";
import { normalizeForFingerprint, stableStringify } from "@/content/pipeline/fingerprint";

/**
 * 课程内容的规范指纹。
 *
 * ── 与试卷指纹的关系 ──
 *
 * 分工完全相同（见 `exam_paper.content_fingerprint` 的迁移说明）：
 * - **manifest checksum**（`course.json` 的 sha256）判"文件是否被改动过"；
 * - **本指纹**判"这是不是同一版**内容**"。
 *
 * 为什么必须拆开：只改 `provenance.rightsNote` 或改一期课程标签时，
 * 整包校验和会变。若用它判内容，就会把纯元数据变更判成"内容实质变化"
 * 并强制递增 `contentVersion` —— 而涨版本会错误地暗示内容是另一版，
 * 使所有已核验的 canonical 链接**无谓地变成 stale**。
 *
 * ── 指纹覆盖什么（这条边界是本模块的全部价值）──
 *
 * **纳入**（内容本身）：
 * - 材料 id 与标题
 * - 段 id / kind / order / 标题 / 锚点（引文与页码）
 * - 段的 `text` / `transcript` / `referenceTranslation` / `notes`
 * - 段引用的音频资产 id 与时间区间（结构性绑定，不是文件字节）
 * - 段锚定的表示 id（页码只在该表示的页码体系里成立）
 *
 * **排除**（声明或文件级事实，不该影响内容身份）：
 * - **`schemaVersion`（manifest 序列化契约版本）** —— 这是本文件最关键的
 *   一处排除。它描述"这份 JSON 该按哪一版契约解析"，不是课程内容。
 *   如果把它纳入指纹，一次纯粹的序列化格式升级（新增可选字段、调整字段形状）
 *   就会被判成"内容实质变化"，进而**让一批本来完全成立的人工复核链接失效**。
 *   格式升级不得使复核失效；内容升级必须。
 * - `provider` / `edition` / `provenance` / `rightsNote`（来源与权利是**声明**）
 * - 资产的 `path` / `bytes` / `checksum` / `mimeType`
 *   （同一份讲义重新导出一次 PDF 会改变校验和，但内容没变 ——
 *   与试卷指纹排除音频校验和是同一条理由）
 * - **未被任何段引用的表示**：给一份材料补一个 DOCX 版本，
 *   内容是同一份，不得因此涨版本（这正是"一份材料多种表示"要保护的语义）
 *
 * 规范化沿用试卷指纹的 `normalizeForFingerprint`（折叠空白、统一撇号、
 * 小写化、跨 CJK 折叠空格）：同一内容在不同工具导出下的排版差异
 * 不应改变身份。
 */

/** 指纹算法版本。指纹含义变化时必须递增，否则历史指纹会被重解释。 */
export const COURSE_FINGERPRINT_ALGORITHM_VERSION = 1;

/**
 * 指纹的规范投影。
 *
 * 返回结构化对象而不是直接拼字符串：测试可以断言"哪些内容参与了身份"，
 * 而不必去猜哈希值。
 */
export interface CourseFingerprintProjection {
  algorithmVersion: number;
  title: string;
  materials: Array<{ id: string; title: string }>;
  segments: Array<{
    id: string;
    materialId: string;
    kind: string;
    order: number;
    title: string;
    representationId: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    quote: string | null;
    audioAssetId: string | null;
    startSeconds: number | null;
    endSeconds: number | null;
    text: string | null;
    transcript: string | null;
    referenceTranslation: string | null;
    notes: string | null;
  }>;
}

function text(value: string | null): string | null {
  return value === null ? null : normalizeForFingerprint(value);
}

export function projectCourseForFingerprint(course: CoursePackageContent): CourseFingerprintProjection {
  return {
    algorithmVersion: COURSE_FINGERPRINT_ALGORITHM_VERSION,
    title: normalizeForFingerprint(course.title),
    materials: [...course.materials]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((material) => ({ id: material.id, title: normalizeForFingerprint(material.title) })),
    segments: [...course.segments]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((segment) => ({
        id: segment.id,
        materialId: segment.materialId,
        kind: segment.kind,
        order: segment.order,
        title: normalizeForFingerprint(segment.title),
        representationId: segment.representationId,
        pageStart: segment.anchor.pageStart,
        pageEnd: segment.anchor.pageEnd,
        quote: text(segment.anchor.quote),
        audioAssetId: segment.audioAssetId,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        text: text(segment.text),
        transcript: text(segment.transcript),
        referenceTranslation: text(segment.referenceTranslation),
        notes: text(segment.notes),
      })),
  };
}

export function courseContentFingerprint(course: CoursePackageContent): string {
  return createHash("sha256")
    .update(stableStringify(projectCourseForFingerprint(course)))
    .digest("hex");
}
