import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 半自动导入流水线的架构约束。
 *
 * 这些守卫针对的是**流程本身**的性质，而不是某个函数的行为：
 * 一旦某条约束被削弱（例如候选包被挪进导入器能看见的目录），
 * 所有单元测试仍然会通过，但"人工复核门禁"这件事会在无声中失效。
 * 因此必须用测试把流程边界钉住。
 */

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

describe("候选包与可导入包在物理上分离", () => {
  it("候选目录不在导入器的发现范围内", () => {
    // 导入器只枚举 cet6/papers/*。候选必须放在别处，
    // 否则"候选永远不可被导入"就只是一句注释。
    const paths = read("src/content/paper/paths.ts");
    expect(paths).toContain("getCandidatesDir");
    expect(paths).toMatch(/getCandidatesDir[\s\S]{0,200}join\(getContentRoot\(\), "candidates"\)/);

    // 导入器的 discover 只读 papersDir
    const importer = read("src/content/paper/importer.ts");
    expect(importer).toContain("getPapersDir");
    expect(importer).not.toContain("getCandidatesDir");
  });

  it("内容校验与导入命令不接触候选目录", () => {
    for (const file of ["scripts/content-validate.ts", "scripts/content-import.ts"]) {
      const source = read(file);
      expect(source, `${file} 不应接触候选目录`).not.toContain("getCandidatesDir");
    }
  });
});

describe("门禁是失败关闭的", () => {
  it("默认状态是 REVIEW_REQUIRED，只有全部检查通过才 IMPORTABLE", () => {
    const gate = read("src/content/pipeline/gate.ts");
    expect(gate).toContain('failed.length === 0 ? "IMPORTABLE" : "REVIEW_REQUIRED"');
    // 必须有显式的人工复核检查 —— 否则"测试通过"就等于"可导入"
    expect(gate).toContain("human_review_completed");
    expect(gate).toContain("all_blocking_items_resolved");
  });

  it("门禁不包含任何自动批准或猜测兜底的分支", () => {
    const gate = read("src/content/pipeline/gate.ts");
    for (const forbidden of ["autoApprove", "assume", "fallback", "guess", "bestGuess"]) {
      expect(gate.toLowerCase(), `门禁不应包含 ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });

  it("晋升要求门禁 IMPORTABLE，且不覆盖已存在的包", () => {
    const script = read("scripts/papers-review.ts");
    expect(script).toContain('if (gate.status !== "IMPORTABLE")');
    expect(script).toContain("拒绝晋升");
    expect(script).toMatch(/existsSync\(targetDir\)/);
    // 晋升前必须用**生产同一个**校验器验证
    expect(script).toContain("NormalizedPackageImporter");
  });
});

describe("人工裁决必须有证据，且不得静默修正", () => {
  it("修正文件要求证据与理由非空", () => {
    const corrections = read("src/content/pipeline/corrections.ts");
    expect(corrections).toContain("evidence");
    expect(corrections).toContain("evidence.trim().length < 10");
    expect(corrections).toContain("resolves");
  });

  it("不允许改写源件文本的修正类型", () => {
    const corrections = read("src/content/pipeline/corrections.ts");
    // 只允许两种收窄的修正类型；不得存在通用的文本替换
    expect(corrections).toContain('"relabel_option"');
    expect(corrections).toContain('"uphold_primary_answer"');
    expect(corrections).not.toContain('"replace_text"');
    expect(corrections).not.toContain('"set_text"');
  });

  it("答案分歧的裁定不改写答案本身", () => {
    // uphold_primary_answer 只登记，不改动内容：它必须校验"包内答案 == 主源值"
    const corrections = read("src/content/pipeline/corrections.ts");
    expect(corrections).toMatch(/uphold_primary_answer[\s\S]{0,1200}located\.question\.answer !== correction\.primary/);
  });

  it("人工复核记录不得由工具生成", () => {
    // review-record.ts 只做校验与转换，不得有写文件的动作
    const record = read("src/content/pipeline/review-record.ts");
    expect(record).not.toContain("writeFileSync");
    expect(record).not.toContain("mkdirSync");
  });

  it("修正的重复应用是幂等的", () => {
    // extract 与 review 都会应用修正；若第二次应用被视为失败，
    // 就会逼出"每次 review 前先手工回滚"的脆弱流程。
    const corrections = read("src/content/pipeline/corrections.ts");
    expect(corrections).toContain("幂等");
    expect(corrections).toMatch(/findOption\(paper, correction\.questionId, correction\.to\)/);
  });
});

describe("来源权威性边界", () => {
  it("源保真比对区分主源与第三方", () => {
    const fidelity = read("src/content/pipeline/fidelity.ts");
    expect(fidelity).toContain("primary");
    expect(fidelity).toContain("third_party");
    // 第三方字段必须判 UNVERIFIABLE 而不是参与比对后失败
    expect(fidelity).toMatch(/origin !== "primary"[\s\S]{0,200}UNVERIFIABLE/);
  });

  it("答案验证不使用「官方」这一档位", () => {
    const verify = read("src/content/pipeline/answer-verify.ts");
    expect(verify).toContain("single_source");
    expect(verify).toContain("cross_source_agree");
    expect(verify).toContain("cross_source_conflict");
    // 不存在官方答案来源，因此不得出现把第三方称为官方的档位
    expect(verify).not.toContain("official");
  });

  it("听力题干来源按第三方披露", () => {
    const candidate = read("src/content/pipeline/candidate.ts");
    expect(candidate).toContain("third_party_transcript");
    // 缺题干时阻断，而不是留空或让工具补写
    expect(candidate).toContain("listening_stem_not_in_primary_source");
  });
});

describe("检测器按语义锚点工作，不按页码或固定字符串位置", () => {
  it("不使用页码硬编码", () => {
    const detect = read("src/content/pipeline/detect.ts");
    for (const forbidden of ["page === 3", "page === 2", "pageNumber ===", "第 3 页", "第 2 页"]) {
      expect(detect, `检测器不应硬编码 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("小节标题必须自我证明才能算锚点", () => {
    const detect = read("src/content/pipeline/detect.ts");
    expect(detect).toContain("looksLikeRealPart");
    expect(detect).toContain("findSubsections");
    // 大题标题必须验证其后确实有小节/题组锚点，否则源件末页的 KEYS 分节标题
    // 会被当成第二个大题
    expect(detect).toMatch(/looksLikeRealPart[\s\S]{0,900}DIRECTIONS_PREFIX\.test/);
  });

  it("大题标题的验证覆盖 KEYS 表分节标题这一真实反例", () => {
    const detect = read("src/content/pipeline/detect.ts");
    expect(detect).toContain("KEYS");
    expect(detect).toContain("rejected");
  });
});

describe("包序列化必须符合磁盘契约", () => {
  it("paper.json 的资产字段名是 path（不是 relativePath）", () => {
    // 内存模型用 relativePath，磁盘契约用 path。直接序列化内存模型
    // 会写出 relativePath，让包无法通过生产校验器（实测踩到）。
    const candidate = read("src/content/pipeline/candidate.ts");
    expect(candidate).toContain("toManifestJson");
    expect(candidate).toMatch(/toManifestJson[\s\S]{0,1600}path: asset\.relativePath/);
  });

  it("校验器的资产 schema 要求 path", () => {
    const validator = read("src/content/paper/validator.ts");
    expect(validator).toMatch(/path:\s*z\.string\(\)\.min\(1\)/);
  });
});
