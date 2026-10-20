import { describe, expect, it } from "vitest";
import { validateCourseManifest } from "@/content/course/validator";
import {
  courseContentFingerprint,
  projectCourseForFingerprint,
} from "@/content/course/fingerprint";
import {
  buildCourseFixture,
  minimalCourseManifest,
  sha256Hex,
  FIXTURE_PROVIDER,
} from "../scripts/course-fixture";

/**
 * 课程包 manifest 校验器测试。
 *
 * 这一层是**纯函数**（不接触文件系统），因此可以穷举各种畸形输入。
 * 资产字节与磁盘的比对在 `course-import.test.ts` 覆盖。
 *
 * 夹具全部来自 `scripts/course-fixture.ts`：合成内容、provider 写死为
 * `test_fixture_provider`，因此不可能冒充任何真实课程材料。
 */

function validManifest(): Record<string, unknown> {
  return buildCourseFixture().manifest;
}

/** 深拷贝一份 manifest，便于逐字段破坏。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type AnyRecord = Record<string, unknown>;

function segmentsOf(manifest: AnyRecord): AnyRecord[] {
  return manifest.segments as AnyRecord[];
}

function materialsOf(manifest: AnyRecord): AnyRecord[] {
  return manifest.materials as AnyRecord[];
}

describe("课程包校验：合法包", () => {
  it("夹具包校验通过，且覆盖六种段种类", () => {
    const outcome = validateCourseManifest(validManifest());
    expect(outcome.issues).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.course).not.toBeNull();

    const kinds = outcome.course!.segments.map((segment) => segment.kind).sort();
    expect(kinds).toEqual(
      [
        "listening_conversation",
        "method_note",
        "reading_passage",
        "reading_passage",
        "translation_passage",
        "writing_template",
      ].sort(),
    );
  });

  it("校验失败时拿不到半成品（course 为 null）", () => {
    const manifest = clone(validManifest());
    manifest.title = "";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.course).toBeNull();
    expect(outcome.issues.length).toBeGreaterThan(0);
  });

  it("provider 是自由字符串：没有被硬编码成任何具体 provider", () => {
    const manifest = clone(validManifest());
    manifest.provider = "another_provider";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
    expect(outcome.course!.provider).toBe("another_provider");
  });

  it("provider 不接受任意字符串（必须是 slug，防止把展示名塞进标识）", () => {
    const manifest = clone(validManifest());
    manifest.provider = "瑞斯拜 / RSVP";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "provider")).toBe(true);
  });
});

describe("课程包校验：畸形 manifest", () => {
  it("缺少必填字段（title）被拒绝", () => {
    const manifest = clone(validManifest());
    delete manifest.title;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "title")).toBe(true);
  });

  it("JSON 层不是对象时被拒绝且不抛异常", () => {
    for (const bogus of [null, undefined, 42, "course", []]) {
      const outcome = validateCourseManifest(bogus);
      expect(outcome.ok).toBe(false);
      expect(outcome.course).toBeNull();
    }
  });

  it("rightsNote 缺失时拒绝 —— 付费材料的本机留存理由必须被写下", () => {
    const manifest = clone(validManifest()) as AnyRecord;
    (manifest.provenance as AnyRecord).rightsNote = "";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "provenance.rightsNote")).toBe(true);
  });

  it("材料为空数组时拒绝（空包不是合法课程包）", () => {
    const manifest = clone(validManifest());
    manifest.materials = [];
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
  });

  it("contentVersion 必须 ≥ 1", () => {
    const manifest = clone(validManifest());
    manifest.contentVersion = 0;
    expect(validateCourseManifest(manifest).ok).toBe(false);
  });
});

describe("课程包校验：重复 id", () => {
  it("材料 id 重复被拒绝，且报出精确位置", () => {
    const manifest = clone(validManifest());
    const materials = materialsOf(manifest);
    materials[1].id = materials[0].id as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "materials[1].id")).toBe(true);
  });

  it("段 id 重复被拒绝", () => {
    const manifest = clone(validManifest());
    const segments = segmentsOf(manifest);
    segments[1].id = segments[0].id as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[1].id")).toBe(true);
  });

  it("资产 id 重复被拒绝", () => {
    const manifest = clone(validManifest());
    const assets = manifest.assets as AnyRecord[];
    assets[1].id = assets[0].id as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "assets[1].id")).toBe(true);
  });

  it("资产路径重复被拒绝（两个 id 指向同一个文件是自相矛盾的）", () => {
    const manifest = clone(validManifest());
    const assets = manifest.assets as AnyRecord[];
    assets[1].path = assets[0].path as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "assets[1].path")).toBe(true);
  });

  it("表示的 id 在材料内重复被拒绝", () => {
    const manifest = clone(validManifest());
    const material = materialsOf(manifest)[0];
    const reps = material.representations as AnyRecord[];
    reps[1].id = reps[0].id as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(
      outcome.issues.some((issue) => issue.path === "materials[0].representations[1].id"),
    ).toBe(true);
  });
});

describe("课程包校验：断开的引用", () => {
  it("段引用了不存在的材料被拒绝", () => {
    const manifest = clone(validManifest());
    segmentsOf(manifest)[0].materialId = "does-not-exist";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[0].materialId")).toBe(true);
  });

  it("表示引用了不存在的资产被拒绝", () => {
    const manifest = clone(validManifest());
    const reps = materialsOf(manifest)[0].representations as AnyRecord[];
    reps[0].assetId = "missing-asset";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(
      outcome.issues.some((issue) => issue.path === "materials[0].representations[0].assetId"),
    ).toBe(true);
  });

  it("听力段引用了不存在的音频资产被拒绝", () => {
    const manifest = clone(validManifest());
    const listening = segmentsOf(manifest).find((segment) => segment.kind === "listening_conversation")!;
    listening.audioAssetId = "missing-audio";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path.endsWith("audioAssetId"))).toBe(true);
  });

  it("页码锚点声明了不存在的表示被拒绝", () => {
    const manifest = clone(validManifest());
    segmentsOf(manifest)[0].representationId = "nope";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[0].representationId")).toBe(true);
  });

  it("一个文件同时被两份材料引用被拒绝（文件只能属于一份逻辑材料）", () => {
    const manifest = clone(validManifest());
    const materials = materialsOf(manifest);
    const listeningReps = materials[1].representations as AnyRecord[];
    // 把听力材料的表示指向阅读材料已经在用的资产
    listeningReps[0].assetId = (materials[0].representations as AnyRecord[])[0].assetId as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(
      outcome.issues.some((issue) => issue.message.includes("同时被材料")),
    ).toBe(true);
  });
});

describe("课程包校验：一份逻辑材料的多种表示", () => {
  it("PDF + DOCX 两种表示**不等于**两份课程材料", () => {
    const manifest = clone(validManifest());
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);

    // 关键断言：材料数是 2（阅读 + 听力），而不是 3（PDF/DOCX 被拆成两份）
    expect(outcome.course!.materials).toHaveLength(2);

    const reading = outcome.course!.materials.find((material) => material.id === "material-reading")!;
    expect(reading.representations).toHaveLength(2);
    expect(reading.representations.map((rep) => rep.assetId).sort()).toEqual([
      "handout-docx",
      "handout-pdf",
    ]);

    // 并且两者指向**不同的文件**（不是同一个文件写了两遍）
    const paths = outcome.course!.assets
      .filter((asset) => reading.representations.some((rep) => rep.assetId === asset.id))
      .map((asset) => asset.relativePath)
      .sort();
    expect(paths).toEqual(["assets/handout.docx", "assets/handout.pdf"]);
  });

  it("多表示的材料会产生一条提醒（说明它们是同一逻辑内容）", () => {
    const outcome = validateCourseManifest(validManifest());
    expect(outcome.warnings.some((warning) => warning.includes("同一份逻辑内容"))).toBe(true);
  });

  it("同一材料重复引用同一资产被拒绝", () => {
    const manifest = clone(validManifest());
    const reps = materialsOf(manifest)[0].representations as AnyRecord[];
    reps[1].assetId = reps[0].assetId as string;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes("重复引用同一个资产"))).toBe(true);
  });
});

describe("课程包校验：未匹配是合法状态", () => {
  it("校验器里**不存在**任何'段必须有 canonical 匹配'的检查", () => {
    // 夹具里没有任何 canonical 链接信息，而它必须校验通过。
    const manifest = clone(validManifest());
    expect(JSON.stringify(manifest)).not.toContain("canonical");
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
    expect(outcome.course!.segments.length).toBeGreaterThan(0);
  });

  it("没有页码锚点也没有引文的段是合法的（只产生提醒）", () => {
    const manifest = clone(validManifest());
    const method = segmentsOf(manifest).find((segment) => segment.kind === "method_note")!;
    expect((method.anchor as AnyRecord).pageStart).toBeNull();
    expect((method.anchor as AnyRecord).quote).toBeNull();

    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes("无法定位回源件"))).toBe(true);
  });

  it("翻译段没有参考译文是合法的（只产生提醒）", () => {
    const manifest = clone(validManifest());
    const translation = segmentsOf(manifest).find((s) => s.kind === "translation_passage")!;
    translation.referenceTranslation = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes("没有课程参考译文"))).toBe(true);
  });
});

describe("课程包校验：不安全路径 / 路径穿越", () => {
  const unsafePaths = [
    "../outside.pdf",
    "../../etc/passwd.pdf",
    "assets/../../escape.pdf",
    "/absolute/path.pdf",
    "C:/windows/system32/evil.pdf",
    "C:\\windows\\evil.pdf",
    "//server/share/evil.pdf",
    "./assets/ok.pdf",
    "",
  ];

  for (const unsafe of unsafePaths) {
    it(`拒绝不安全路径：${JSON.stringify(unsafe)}`, () => {
      const manifest = clone(validManifest());
      (manifest.assets as AnyRecord[])[0].path = unsafe;
      const outcome = validateCourseManifest(manifest);
      expect(outcome.ok).toBe(false);
      expect(outcome.issues.some((issue) => issue.path === "assets[0].path")).toBe(true);
    });
  }

  it("合法相对路径被接受，并规范化为 POSIX 风格", () => {
    const manifest = clone(validManifest());
    (manifest.assets as AnyRecord[])[0].path = "assets\\nested\\handout.pdf";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
    expect(outcome.course!.assets[0].relativePath).toBe("assets/nested/handout.pdf");
  });
});

describe("课程包校验：资产 MIME 与扩展名", () => {
  it("不支持的扩展名被拒绝", () => {
    const manifest = clone(validManifest());
    (manifest.assets as AnyRecord[])[0].path = "assets/evil.exe";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes("不支持的资产扩展名"))).toBe(true);
  });

  it("声明的 MIME 与扩展名不符被拒绝（不信任 manifest 声明）", () => {
    const manifest = clone(validManifest());
    (manifest.assets as AnyRecord[])[0].mimeType = "audio/mpeg";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "assets[0].mimeType")).toBe(true);
  });

  it("kind 与扩展名不符被拒绝", () => {
    const manifest = clone(validManifest());
    (manifest.assets as AnyRecord[])[0].kind = "audio";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "assets[0].kind")).toBe(true);
  });

  it("checksum 必须是 64 位小写十六进制", () => {
    const manifest = clone(validManifest());
    (manifest.assets as AnyRecord[])[0].checksum = "ABC";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "assets[0].checksum")).toBe(true);
  });
});

describe("课程包校验：锚点与时间区间", () => {
  it("页码结束页小于起始页被拒绝", () => {
    const manifest = clone(validManifest());
    (segmentsOf(manifest)[0].anchor as AnyRecord).pageEnd = 0;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
  });

  it("声明页码却没有声明所属表示被拒绝（页码只在某个表示的页码体系里成立）", () => {
    const manifest = clone(validManifest());
    segmentsOf(manifest)[0].representationId = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[0].representationId")).toBe(true);
  });

  it("只声明结束页而没有起始页被拒绝", () => {
    const manifest = clone(validManifest());
    const anchor = segmentsOf(manifest)[0].anchor as AnyRecord;
    anchor.pageStart = null;
    anchor.pageEnd = 5;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[0].anchor.pageStart")).toBe(true);
  });

  it("时间区间结束不晚于开始被拒绝", () => {
    const manifest = clone(validManifest());
    const listening = segmentsOf(manifest).find((s) => s.kind === "listening_conversation")!;
    listening.startSeconds = 30;
    listening.endSeconds = 10;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path.endsWith("endSeconds"))).toBe(true);
  });

  it("时间区间只给一半被拒绝", () => {
    const manifest = clone(validManifest());
    const listening = segmentsOf(manifest).find((s) => s.kind === "listening_conversation")!;
    listening.startSeconds = 10;
    listening.endSeconds = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
  });

  it("**整段音频不切分**：没有时间区间也是合法的（本阶段不产生区间）", () => {
    const manifest = clone(validManifest());
    const listening = segmentsOf(manifest).find((s) => s.kind === "listening_conversation")!;
    expect(listening.startSeconds).toBeNull();
    expect(listening.endSeconds).toBeNull();
    expect(listening.audioAssetId).toBe("listening-audio");

    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
  });
});

describe("课程包校验：段种类的内容要求", () => {
  it("听力段缺少音频被拒绝", () => {
    const manifest = clone(validManifest());
    const listening = segmentsOf(manifest).find((s) => s.kind === "listening_conversation")!;
    listening.audioAssetId = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes("必须引用整段音频资产"))).toBe(true);
  });

  it("非听力段引用音频被拒绝", () => {
    const manifest = clone(validManifest());
    segmentsOf(manifest)[0].audioAssetId = "listening-audio";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.message.includes("非听力段不应引用音频"))).toBe(true);
  });

  it("翻译段缺少中文原文被拒绝", () => {
    const manifest = clone(validManifest());
    const translation = segmentsOf(manifest).find((s) => s.kind === "translation_passage")!;
    translation.text = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path.endsWith(".text"))).toBe(true);
  });

  it("阅读段既无正文也无说明被拒绝", () => {
    const manifest = clone(validManifest());
    const reading = segmentsOf(manifest)[0];
    reading.text = null;
    reading.notes = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
  });

  it("听力段没有文字稿只产生提醒（不阻断）", () => {
    const manifest = clone(validManifest());
    const listening = segmentsOf(manifest).find((s) => s.kind === "listening_conversation")!;
    listening.transcript = null;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes("没有文字稿"))).toBe(true);
  });

  it("未登记的段种类被拒绝", () => {
    const manifest = clone(validManifest());
    segmentsOf(manifest)[0].kind = "video_clip";
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[0].kind")).toBe(true);
  });
});

describe("课程包校验：段顺序", () => {
  it("同一材料内段顺序必须从 0 连续", () => {
    const manifest = clone(validManifest());
    const readingSegments = segmentsOf(manifest).filter((s) => s.materialId === "material-reading");
    expect(readingSegments.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    expect(validateCourseManifest(manifest).ok).toBe(true);
  });

  it("顺序出现缺口被拒绝（声明顺序不能有两个真相）", () => {
    const manifest = clone(validManifest());
    const readingSegments = segmentsOf(manifest).filter((s) => s.materialId === "material-reading");
    readingSegments[4].order = 9;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path === "segments[*].order")).toBe(true);
  });
});

describe("课程内容指纹：判'是否同一版内容'", () => {
  it("同一份 manifest 得到同一个指纹（稳定序列化，与键序无关）", () => {
    const a = validateCourseManifest(validManifest()).course!;
    const b = validateCourseManifest(validManifest()).course!;
    expect(courseContentFingerprint(a)).toBe(courseContentFingerprint(b));
  });

  it("**元数据变更不改变指纹**：改 rightsNote / provenance 不影响内容身份", () => {
    const base = validateCourseManifest(validManifest()).course!;
    const changed = validateCourseManifest(
      buildCourseFixture({
        rightsNote: "另一份合成夹具声明，内容未变。",
        provenanceNote: "另一段来源说明，内容未变。",
      }).manifest,
    ).course!;

    expect(changed.provenance.rightsNote).not.toBe(base.provenance.rightsNote);
    expect(courseContentFingerprint(changed)).toBe(courseContentFingerprint(base));
  });

  it("provider / edition 变更不改变指纹（它们是声明，不是内容）", () => {
    const base = validateCourseManifest(validManifest()).course!;
    const manifest = clone(validManifest());
    manifest.provider = "other_provider";
    manifest.edition = "2030 上半年";
    const changed = validateCourseManifest(manifest).course!;

    expect(courseContentFingerprint(changed)).toBe(courseContentFingerprint(base));
  });

  it("**内容变更改变指纹**：改一段正文即改变身份", () => {
    const base = validateCourseManifest(validManifest()).course!;
    const changed = validateCourseManifest(
      buildCourseFixture({ readingText: "A completely different fixture passage body." }).manifest,
    ).course!;

    expect(courseContentFingerprint(changed)).not.toBe(courseContentFingerprint(base));
  });

  it("加一个表示（补一个 DOCX 版本）**不改变指纹** —— 同一逻辑内容", () => {
    const withDocx = validateCourseManifest(validManifest()).course!;
    const withoutDocx = validateCourseManifest(
      buildCourseFixture({ dropDocxRepresentation: true }).manifest,
    ).course!;

    expect(withDocx.materials[0].representations).toHaveLength(2);
    expect(withoutDocx.materials[0].representations).toHaveLength(1);
    // 文件级事实（资产清单）确实不同……
    expect(withDocx.assets.length).not.toBe(withoutDocx.assets.length);
    // ……但**内容身份相同**：给同一份讲义补一个导出格式不是新内容。
    expect(courseContentFingerprint(withoutDocx)).toBe(courseContentFingerprint(withDocx));
  });

  it("排版差异（空白/大小写）不改变指纹", () => {
    const base = validateCourseManifest(validManifest()).course!;
    const originalText = base.segments.find((segment) => segment.id === "reading.a")!.text!;

    // 同一段文字的**排版变体**：全大写 + 换行与多余空白。
    // 这不是"另一段内容"，因此身份必须不变。
    const variant = `  ${originalText.toUpperCase().replace(/[ \t]+/g, "\n\n   ")}   `;
    const changed = validateCourseManifest(buildCourseFixture({ readingText: variant }).manifest).course!;

    expect(changed.segments.find((segment) => segment.id === "reading.a")!.text).not.toBe(originalText);
    expect(courseContentFingerprint(changed)).toBe(courseContentFingerprint(base));
  });

  it("指纹投影只包含内容字段，不包含协议/校验和/页码体系之外的元数据", () => {
    const course = validateCourseManifest(validManifest()).course!;
    const projection = projectCourseForFingerprint(course);
    const serialized = JSON.stringify(projection);

    // 不包含：provider、edition、provenance、rightsNote、资产校验和、绝对路径
    expect(serialized).not.toContain(FIXTURE_PROVIDER);
    expect(serialized).not.toContain("rightsNote");
    expect(serialized).not.toContain("fixture-edition");
    expect(serialized).not.toContain("application/pdf");
    expect(serialized).not.toContain("C:\\");
    expect(serialized).not.toContain("/home/");

    // 包含：正文、标题、段身份
    expect(serialized).toContain("reading.a");
    expect(serialized).toContain("fixture course reading passage");
  });

  it("指纹是 sha256 十六进制", () => {
    const course = validateCourseManifest(validManifest()).course!;
    expect(courseContentFingerprint(course)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("课程包校验：最小夹具自洽", () => {
  it("最小夹具本身校验通过，且资产校验和与它的字节一致", () => {
    const manifest = minimalCourseManifest();
    const outcome = validateCourseManifest(manifest);
    expect(outcome.issues).toEqual([]);
    expect(outcome.ok).toBe(true);
    // 自洽性：声明的 checksum 确实等于那段字节的 sha256
    const asset = (manifest.assets as AnyRecord[])[0];
    expect(asset.checksum).toBe(sha256Hex(Buffer.from("fixture-pdf!", "utf8")));
  });
});
