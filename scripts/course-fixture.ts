import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COURSE_MANIFEST_SCHEMA_VERSION } from "@/domain/course";

/**
 * 课程包测试夹具构造器。
 *
 * ── 三条硬约束（与试卷夹具同源，理由完全相同）──
 *
 * 1. **合成内容，且显眼可辨。** 主题是通用说明文与通用方法说明，
 *    **不是**任何真实 CET 材料，也**不是**任何真实课程材料。
 *    provider 写死为 `test_fixture_provider` —— 参数里不提供覆盖它的选项，
 *    因此"夹具冒充真实课程"在构造层面就不可能。
 * 2. **不进生产内容路径。** 只在测试临时目录 / E2E 内容根下使用；
 *    `private-content/courses/` 与 `pnpm course:import` 都不会遇到它。
 * 3. **不产生任何学习者观测。** 它是软件测试夹具。
 *
 * 放在 `scripts/` 而不是 `tests/`：单元测试与 E2E 两者都要用它，
 * 而 Playwright 禁止 spec 之间互相 import（同 `scripts/paper-fixture.ts`）。
 *
 * ── 它必须能表达的那件事 ──
 *
 * 「一份逻辑材料、多种表示」：默认夹具里
 * `material-reading` 同时有 PDF 与 DOCX 两种表示 —— 用于固定
 * "两个文件不等于两份课程材料"这条语义。
 */

/** provider 是写死常量，不是参数 —— 夹具不得冒充任何真实 provider。 */
const FIXTURE_PROVIDER = "test_fixture_provider" as const;

export function sha256Hex(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 生成一个最小的合法 PDF 字节串（不是真 PDF 渲染，但头尾结构正确）。 */
export function makeMinimalPdf(text: string): Buffer {
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${text}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

/** 生成一个最小的 DOCX 占位字节（ZIP 魔数开头，够用于校验和比对）。 */
export function makeMinimalDocx(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`docx:${text}`, "utf8")]);
}

/**
 * 生成一个最小但**合法可播放**的 WAV（0.05 秒 8kHz 单声道静音）。
 *
 * 为什么听力夹具必须给真音频字节：课程层的听力语义是"整段音频不切分"，
 * 而校验器会核对字节数与校验和。用零字节文件会让"资产校验"这条路径
 * 在测试里从未真正走过。
 */
export function makeSilentWav(durationSeconds = 0.05): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 8;
  const samples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  buffer.fill(128, 44);

  return buffer;
}

export interface CourseFixtureOptions {
  id?: string;
  title?: string;
  edition?: string | null;
  contentVersion?: number;
  /**
   * 覆盖 manifest 的序列化契约版本（用于验证未来版本被明确拒绝）。
   * 默认写入 `COURSE_MANIFEST_SCHEMA_VERSION`。
   */
  schemaVersion?: number;
  /**
   * **刻意省略** `schemaVersion` 字段。
   *
   * 用显式开关而不是"传 undefined"：`options.x ?? default` 无法区分
   * "没传"与"传了 undefined"，那样写出的用例会假装在测缺失、实际测的是默认值。
   */
  omitSchemaVersion?: boolean;
  /** 覆盖 rightsNote（用于验证"元数据变更不涨版本"）。 */
  rightsNote?: string;
  /** 覆盖 provenance.note（同上）。 */
  provenanceNote?: string;
  /** 覆盖某一段的正文（用于验证"内容变更必须涨版本"）。 */
  readingText?: string;
  /**
   * 移除默认的 DOCX 表示。
   *
   * 用途：证明"给同一份材料补一个表示"**不改变内容指纹** ——
   * 那是"一份材料多种表示"这条语义的反向证据。
   */
  dropDocxRepresentation?: boolean;
}

export interface CourseFixturePackage {
  manifest: Record<string, unknown>;
  /** 包内相对路径 → 字节内容。 */
  files: Map<string, Buffer>;
}

const DEFAULT_READING_TEXT =
  "Fixture course reading passage. This synthetic text exists only so the course " +
  "package pipeline can be exercised end to end. It is not CET material and does " +
  "not come from any course provider.";

const DEFAULT_TRANSLATION_TEXT =
  "夹具用的合成中文段落，仅用于验证翻译类课程段的校验与索引路径。它不是任何真实课程材料。";

/**
 * 构造一份合法的课程包夹具。
 *
 * 结构刻意覆盖全部七种 segment 种类中的六种 + 一份多表示材料：
 * - `material-reading`：PDF + DOCX 两种表示（同一逻辑内容）
 * - `reading.a` / `reading.b`：两段阅读篇章（同一材料的两次出现）
 * - `listening.1`：长对话（整段音频 + 文字稿）
 * - `translation.1`：翻译段（原文 + 参考译文 + 语言点）
 * - `writing.1`：写作模板
 * - `method.1`：方法说明
 */
export function buildCourseFixture(options: CourseFixtureOptions = {}): CourseFixturePackage {
  const id = options.id ?? "fixture-course-a";
  const files = new Map<string, Buffer>();
  const assets: Record<string, unknown>[] = [];

  function addAsset(
    assetId: string,
    kind: "document" | "audio" | "image",
    relativePath: string,
    mimeType: string,
    bytes: Buffer,
    label: string,
  ): void {
    files.set(relativePath, bytes);
    assets.push({
      id: assetId,
      kind,
      path: relativePath,
      mimeType,
      bytes: bytes.length,
      checksum: sha256Hex(bytes),
      label,
    });
  }

  addAsset(
    "handout-pdf",
    "document",
    "assets/handout.pdf",
    "application/pdf",
    makeMinimalPdf("fixture reading handout"),
    "讲义 PDF 版",
  );
  // 只在需要 DOCX 表示时才声明 DOCX 资产。
  // 这样 `dropDocxRepresentation` 模拟的是**包本来就只有 PDF** 的真实形态
  // （文件确实少了），而不是"文件还在、只是没人引用它"。
  if (!options.dropDocxRepresentation) {
    addAsset(
      "handout-docx",
      "document",
      "assets/handout.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      makeMinimalDocx("fixture reading handout"),
      "讲义 DOCX 版",
    );
  }
  addAsset(
    "listening-audio",
    "audio",
    "assets/listening-full.wav",
    "audio/wav",
    makeSilentWav(),
    "整段听力录音（不切分）",
  );
  // 听力讲义是**另一份逻辑材料**，因此必须有它自己的资产：
  // 一个文件不能同时属于两份材料（校验器会拒绝 —— 见 validator 的 assetOwners）。
  addAsset(
    "listening-handout-pdf",
    "document",
    "assets/listening-handout.pdf",
    "application/pdf",
    makeMinimalPdf("fixture listening handout"),
    "听力讲义 PDF 版",
  );

  const readingRepresentations = options.dropDocxRepresentation
    ? [{ id: "pdf", assetId: "handout-pdf", label: "PDF 版" }]
    : [
        { id: "pdf", assetId: "handout-pdf", label: "PDF 版" },
        { id: "docx", assetId: "handout-docx", label: "DOCX 版" },
      ];

  const manifest: Record<string, unknown> = {
    id,
    // 序列化契约版本。默认写受支持的那一版；`omitSchemaVersion` 用于
    // 验证"缺失必须被明确拒绝"，`schemaVersion` 用于验证未来版本被拒绝。
    ...(options.omitSchemaVersion
      ? {}
      : { schemaVersion: options.schemaVersion ?? COURSE_MANIFEST_SCHEMA_VERSION }),
    provider: FIXTURE_PROVIDER,
    edition: options.edition === undefined ? "fixture-edition" : options.edition,
    title: options.title ?? "夹具课程包（合成内容，不是任何真实课程材料）",
    contentVersion: options.contentVersion ?? 1,
    provenance: {
      note:
        options.provenanceNote ??
        "自动化测试夹具：结构仿照课程包，内容为合成通用文本，不是任何真实课程材料。",
      reference: "scripts/course-fixture.ts",
      rightsNote: options.rightsNote ?? "合成夹具，无第三方权利，可自由用于测试。",
    },
    materials: [
      {
        id: "material-reading",
        title: "夹具阅读讲义（同一逻辑材料，两种表示）",
        representations: readingRepresentations,
      },
      {
        id: "material-listening",
        title: "夹具听力讲义",
        representations: [{ id: "pdf", assetId: "listening-handout-pdf", label: "PDF 版" }],
      },
    ],
    segments: [
      {
        id: "reading.a",
        materialId: "material-reading",
        kind: "reading_passage",
        order: 0,
        title: "夹具阅读篇章 A",
        representationId: "pdf",
        anchor: { pageStart: 1, pageEnd: 3, quote: "Fixture course reading passage." },
        text: options.readingText ?? DEFAULT_READING_TEXT,
        notes: "夹具语言点：仅用于验证 notes 字段被保留。",
      },
      {
        id: "reading.b",
        materialId: "material-reading",
        kind: "reading_passage",
        order: 1,
        title: "夹具阅读篇章 B",
        representationId: "pdf",
        anchor: { pageStart: 4, pageEnd: 5, quote: "Second occurrence in the same handout." },
        text: "Fixture second reading passage. Synthetic text for pipeline validation only.",
      },
      {
        id: "listening.1",
        materialId: "material-listening",
        kind: "listening_conversation",
        order: 0,
        title: "夹具听力长对话",
        representationId: null,
        anchor: { pageStart: null, pageEnd: null, quote: "Fixture listening conversation." },
        audioAssetId: "listening-audio",
        // 显式声明"没有时间区间"：整段音频不切分是本层的硬约束，
        // 而"不声明"与"声明为 null"在夹具里必须都能被区分地测到。
        startSeconds: null,
        endSeconds: null,
        transcript: "Fixture transcript. Synthetic dialogue text, not real CET audio content.",
      },
      {
        id: "translation.1",
        materialId: "material-reading",
        kind: "translation_passage",
        order: 2,
        title: "夹具翻译段落",
        representationId: "pdf",
        anchor: { pageStart: 6, pageEnd: 6, quote: "夹具用的合成中文段落" },
        text: DEFAULT_TRANSLATION_TEXT,
        referenceTranslation: "Fixture reference translation. It is a course reference, not the only correct rendering.",
        notes: "夹具语言点：主次关系与术语一致性。",
      },
      {
        id: "writing.1",
        materialId: "material-reading",
        kind: "writing_template",
        order: 3,
        title: "夹具写作模板",
        representationId: "pdf",
        anchor: { pageStart: 7, pageEnd: 7, quote: "Fixture writing template." },
        text: "Fixture writing template: introduction, two body paragraphs, conclusion.",
      },
      {
        id: "method.1",
        materialId: "material-reading",
        kind: "method_note",
        order: 4,
        title: "夹具方法说明",
        representationId: null,
        anchor: { pageStart: null, pageEnd: null, quote: null },
        notes: `夹具方法说明：这一段刻意没有页码锚点，用于验证「无锚点是合法状态」。`,
      },
    ],
    assets,
  };

  return { manifest, files };
}

/** 把夹具写入磁盘，返回包目录。 */
export function writeCourseFixture(
  contentRoot: string,
  packageDirName: string,
  fixture: CourseFixturePackage,
): string {
  const dir = join(contentRoot, "courses", packageDirName);
  mkdirSync(dir, { recursive: true });
  for (const [relativePath, bytes] of fixture.files) {
    const target = join(dir, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(dir, "course.json"), `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
  return dir;
}

/**
 * 一份**最小合法**的课程 manifest，供"字段级"用例按需破坏某一项后使用。
 *
 * 它自带一条自洽的资产声明（`a1`），因此纯校验器用例可以直接用；
 * 但它**不能**交给导入器（导入器会去磁盘核对字节与校验和）。
 * 需要走完整导入路径的用例请用 `buildCourseFixture` + `writeCourseFixture`。
 */
export function minimalCourseManifest(): Record<string, unknown> {
  return {
    id: "minimal-course",
    schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
    provider: FIXTURE_PROVIDER,
    edition: null,
    title: "最小夹具课程",
    contentVersion: 1,
    provenance: {
      note: "最小夹具",
      reference: null,
      rightsNote: "合成夹具，无第三方权利。",
    },
    materials: [
      {
        id: "m1",
        title: "夹具材料",
        representations: [{ id: "r1", assetId: "a1", label: "PDF 版" }],
      },
    ],
    segments: [
      {
        id: "s1",
        materialId: "m1",
        kind: "method_note",
        order: 0,
        title: "夹具段",
        representationId: null,
        anchor: { pageStart: null, pageEnd: null, quote: null },
        text: "fixture",
      },
    ],
    assets: [
      {
        id: "a1",
        kind: "document",
        path: "assets/a.pdf",
        mimeType: "application/pdf",
        bytes: 12,
        checksum: sha256Hex(Buffer.from("fixture-pdf!", "utf8")),
        label: null,
      },
    ],
  };
}

export { FIXTURE_PROVIDER };
