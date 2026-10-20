import { describe, expect, it } from "vitest";
import { validatePaperManifest } from "@/content/paper/validator";
import {
  OFFICIAL_NUMBERED_ITEM_TOTAL,
  OFFICIAL_SECTION_ORDER,
  SECTION_IS_NUMBERED,
  SECTION_QUESTION_COUNTS,
  type PaperSectionType,
} from "@/domain/paper";
import { buildFixturePackage } from "../scripts/paper-fixture";

/**
 * 试卷 manifest 校验测试。
 *
 * 组织方式：先证明"合法的包能通过"，再逐条证明"每一种坏包都被拒绝，
 * 且错误位置精确到字段"。后者才是校验器存在的理由。
 */

function validManifest(): Record<string, unknown> {
  return buildFixturePackage().manifest;
}

/** 深拷贝后按路径改写，用于构造单点故障的坏包。 */
function mutate(mutator: (manifest: Record<string, unknown>) => void): Record<string, unknown> {
  const manifest = structuredClone(validManifest());
  mutator(manifest);
  return manifest;
}

function sections(manifest: Record<string, unknown>): Record<string, unknown>[] {
  return manifest.sections as Record<string, unknown>[];
}

function groupsOf(manifest: Record<string, unknown>, sectionIndex: number): Record<string, unknown>[] {
  return sections(manifest)[sectionIndex].groups as Record<string, unknown>[];
}

function questionsOf(
  manifest: Record<string, unknown>,
  sectionIndex: number,
  groupIndex: number,
): Record<string, unknown>[] {
  return groupsOf(manifest, sectionIndex)[groupIndex].questions as Record<string, unknown>[];
}

function issuesFor(manifest: Record<string, unknown>): Array<{ path: string; message: string }> {
  const outcome = validatePaperManifest(manifest);
  expect(outcome.ok, "预期校验失败但通过了").toBe(false);
  return outcome.issues;
}

/** 只取有官方题号的题目（写作与翻译不编号，见 SECTION_IS_NUMBERED）。 */
function numberedValues(
  sections: ReadonlyArray<{ groups: ReadonlyArray<{ questions: ReadonlyArray<{ number: number | null }> }> }>,
): number[] {
  return sections
    .flatMap((section) => section.groups.flatMap((group) => group.questions.map((q) => q.number)))
    .filter((value): value is number => value !== null);
}

describe("官方结构基准：夹具覆盖全部 8 个大题", () => {
  it("夹具本身通过校验", () => {
    const outcome = validatePaperManifest(validManifest());
    expect(outcome.issues).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it("夹具按官方顺序产出全部大题的合法 manifest", () => {
    const manifest = validManifest();
    expect(sections(manifest).map((section) => section.type)).toEqual(OFFICIAL_SECTION_ORDER);
    expect(manifest.partial).toBe(false);
  });

  it("题量符合官方值（57 题）", () => {
    const manifest = validManifest();
    let total = 0;
    for (const section of sections(manifest)) {
      const count = (section.groups as Record<string, unknown>[]).reduce(
        (sum, group) => sum + (group.questions as unknown[]).length,
        0,
      );
      expect(count, String(section.type)).toBe(SECTION_QUESTION_COUNTS[section.type as PaperSectionType]);
      total += count;
    }
    expect(total).toBe(57);
  });

  it("题号从 1 连续到 55（写作与翻译不参与官方编号）", () => {
    const manifest = validManifest();
    const numbers = numberedValues(sections(manifest) as never);
    expect(numbers).toEqual(Array.from({ length: OFFICIAL_NUMBERED_ITEM_TOTAL }, (_, index) => index + 1));
    expect(OFFICIAL_NUMBERED_ITEM_TOTAL).toBe(55);
  });

  it("写作与翻译没有官方题号（实测：源卷 KEYS 表只编号听力与阅读）", () => {
    const outcome = validatePaperManifest(validManifest());
    expect(outcome.ok).toBe(true);
    for (const type of ["writing", "translation"] as const) {
      const section = outcome.paper?.sections.find((item) => item.type === type);
      expect(SECTION_IS_NUMBERED[type], `${type} 不应参与编号`).toBe(false);
      expect(section?.groups[0].questions[0].number).toBeNull();
      expect(section?.groups[0].firstNumber).toBeNull();
    }
  });

  it("客观部分必须有题号（否则无法与源卷 KEYS 表对应）", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 1, 0)[0].number = null)));
    expect(issues.some((issue) => issue.message.includes("必须有题号"))).toBe(true);
  });

  it("主观部分不得声明题号", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 0, 0)[0].number = 1)));
    expect(issues.some((issue) => issue.message.includes("必须为 null"))).toBe(true);
  });

  it("写作/翻译组不得声明 firstNumber", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 0)[0].firstNumber = 1)));
    expect(issues.some((issue) => issue.message.includes("不得声明 firstNumber"))).toBe(true);
  });
});

describe("来源与核验", () => {
  it("拒绝未知来源类型", () => {
    const issues = issuesFor(mutate((m) => void (m.sourceKind = "generated")));
    expect(issues.some((issue) => issue.path === "sourceKind")).toBe(true);
  });

  it("拒绝未知核验状态", () => {
    const issues = issuesFor(mutate((m) => void (m.verificationStatus = "probably_fine")));
    expect(issues.some((issue) => issue.path === "verificationStatus")).toBe(true);
  });

  it("拒绝空来源说明（内容不能没有出处）", () => {
    const issues = issuesFor(
      mutate((m) => void ((m.provenance as Record<string, unknown>).note = "")),
    );
    expect(issues.some((issue) => issue.path === "provenance.note")).toBe(true);
  });

  it("拒绝非真题标记已核验（示例包不能冒充真题）", () => {
    const issues = issuesFor(
      mutate((m) => {
        m.sourceKind = "sample";
        m.verificationStatus = "verified";
        (m.provenance as Record<string, unknown>).verificationNote = "看起来很对";
      }),
    );
    expect(issues.some((issue) => issue.message.includes("只有 real_past_paper"))).toBe(true);
  });

  it("拒绝标记已核验但没写明核验了什么", () => {
    const issues = issuesFor(
      mutate((m) => {
        m.sourceKind = "real_past_paper";
        m.verificationStatus = "verified";
        (m.provenance as Record<string, unknown>).verificationNote = null;
      }),
    );
    expect(issues.some((issue) => issue.path === "provenance.verificationNote")).toBe(true);
  });

  it("拒绝「部分内容 + 已核验」的组合（不完整的东西不可能已核验）", () => {
    const issues = issuesFor(
      mutate((m) => {
        m.sourceKind = "real_past_paper";
        m.verificationStatus = "verified";
        (m.provenance as Record<string, unknown>).verificationNote = "逐项核对过";
        m.partial = true;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("部分内容的试卷不可能已核验"))).toBe(true);
  });

  it("接受 real_past_paper + verified + 核验说明", () => {
    const outcome = validatePaperManifest(
      mutate((m) => {
        m.sourceKind = "real_past_paper";
        m.verificationStatus = "verified";
        (m.provenance as Record<string, unknown>).verificationNote =
          "逐题核对了题面、选项与答案；听力音频与试卷场次一致。";
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.paper?.verificationStatus).toBe("verified");
  });

  it("接受 real_past_paper + unverified（已导入但尚未核验是合法状态）", () => {
    const outcome = validatePaperManifest(mutate((m) => void (m.sourceKind = "real_past_paper")));
    expect(outcome.ok).toBe(true);
    expect(outcome.paper?.verificationStatus).toBe("unverified");
  });
});

describe("试卷标识与版本", () => {
  it("拒绝非法 id 字符集", () => {
    const issues = issuesFor(mutate((m) => void (m.id = "CET6 2024/12 第一套")));
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });

  it("拒绝 contentVersion 为 0", () => {
    const issues = issuesFor(mutate((m) => void (m.contentVersion = 0)));
    expect(issues.some((issue) => issue.path === "contentVersion")).toBe(true);
  });

  it("拒绝非法场次", () => {
    const issues = issuesFor(mutate((m) => void (m.session = "Spring")));
    expect(issues.some((issue) => issue.path === "session")).toBe(true);
  });

  it("接受 9 月加考场次（历史真实存在，不是异常值）", () => {
    const outcome = validatePaperManifest(mutate((m) => void (m.session = "September")));
    expect(outcome.ok).toBe(true);
  });

  it("拒绝不可能的 examType", () => {
    const issues = issuesFor(mutate((m) => void (m.examType = "CET4")));
    expect(issues.some((issue) => issue.path === "examType")).toBe(true);
  });

  it("拒绝缺少 examDate 之外的年份范围外值", () => {
    const issues = issuesFor(mutate((m) => void (m.year = 1899)));
    expect(issues.some((issue) => issue.path === "year")).toBe(true);
  });

  it("examDate 允许为 null（不知官方确切日期时不猜）", () => {
    const outcome = validatePaperManifest(mutate((m) => void (m.examDate = null)));
    expect(outcome.ok).toBe(true);
    expect(outcome.paper?.examDate).toBeNull();
  });

  it("examDate 格式错误时拒绝", () => {
    const issues = issuesFor(mutate((m) => void (m.examDate = "2024/12/14")));
    expect(issues.some((issue) => issue.path === "examDate")).toBe(true);
  });
});

describe("多选题（听力与仔细阅读）", () => {
  it("拒绝指向不存在选项的答案", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 1, 0)[0].answer = "Z")));
    expect(issues.some((issue) => issue.path === "sections[1].groups[0].questions[0].answer")).toBe(true);
  });

  it("拒绝选项数量不是四选一", () => {
    const issues = issuesFor(
      mutate((m) => {
        questionsOf(m, 1, 0)[0].options = [
          { id: "A", label: "a" },
          { id: "B", label: "b" },
        ];
      }),
    );
    expect(issues.some((issue) => issue.message.includes("恒为四选一"))).toBe(true);
  });

  it("拒绝重复的选项 id", () => {
    const issues = issuesFor(
      mutate((m) => {
        questionsOf(m, 1, 0)[0].options = [
          { id: "A", label: "a" },
          { id: "A", label: "b" },
          { id: "C", label: "c" },
          { id: "D", label: "d" },
        ];
      }),
    );
    expect(issues.some((issue) => issue.message.includes("选项 id 重复"))).toBe(true);
  });

  it("拒绝空题干", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 1, 0)[0].stem = "")));
    expect(issues.some((issue) => issue.path.endsWith(".stem"))).toBe(true);
  });
});

describe("选词填空", () => {
  it("拒绝答案不在词库中的空", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 4, 0)[0].answer = "not_in_bank")));
    expect(issues.some((issue) => issue.message.includes("答案不在词库中"))).toBe(true);
  });

  it("拒绝词库词被重复使用（官方规则每词至多一次）", () => {
    const issues = issuesFor(
      mutate((m) => {
        const questions = questionsOf(m, 4, 0);
        questions[1].answer = questions[0].answer;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("词库词被重复使用"))).toBe(true);
  });

  it("拒绝重复的空位编号", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 4, 0)[1].blankId = "1")));
    expect(issues.some((issue) => issue.message.includes("空位编号重复"))).toBe(true);
  });

  it("拒绝文章缺少空位标记", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 4)[0].passage = "没有空位标记的文章。")));
    expect(issues.some((issue) => issue.path === "sections[4].groups[0].passage")).toBe(true);
  });

  it("拒绝缺少词库", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 4)[0].wordBank = null)));
    expect(issues.some((issue) => issue.path === "sections[4].groups[0].wordBank")).toBe(true);
  });

  it("拒绝混入非选词填空题型的题目", () => {
    const issues = issuesFor(
      mutate((m) => {
        questionsOf(m, 4, 0)[0].kind = "mcq";
        questionsOf(m, 4, 0)[0].stem = "混进来的选择题";
        questionsOf(m, 4, 0)[0].options = ["A", "B", "C", "D"].map((id) => ({ id, label: id }));
        questionsOf(m, 4, 0)[0].answer = "A";
      }),
    );
    expect(issues.some((issue) => issue.message.includes("只能包含 banked_cloze_blank"))).toBe(true);
  });
});

describe("长篇阅读（段落匹配）", () => {
  it("拒绝匹配到不存在的段落标号", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 5, 0)[0].answerParagraph = "Z")));
    expect(issues.some((issue) => issue.path === "sections[5].groups[0].questions[0].answerParagraph")).toBe(true);
  });

  it("拒绝段落标号重复", () => {
    const issues = issuesFor(
      mutate((m) => {
        const paragraphs = groupsOf(m, 5)[0].paragraphs as Record<string, unknown>[];
        paragraphs[1].label = paragraphs[0].label;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("段落标号重复"))).toBe(true);
  });

  it("拒绝缺少段落", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 5)[0].paragraphs = null)));
    expect(issues.some((issue) => issue.path === "sections[5].groups[0].paragraphs")).toBe(true);
  });

  it("保留多题共享一篇文章的关系（10 条陈述同一组）", () => {
    const outcome = validatePaperManifest(validManifest());
    const section = outcome.paper?.sections.find((item) => item.type === "reading.matching");
    expect(section?.groups).toHaveLength(1);
    expect(section?.groups[0].questions).toHaveLength(10);
    expect(section?.groups[0].paragraphs?.length).toBeGreaterThan(0);
  });
});

describe("仔细阅读：分组而不是拆散", () => {
  it("两篇文章各自成组，每组 5 题", () => {
    const outcome = validatePaperManifest(validManifest());
    const section = outcome.paper?.sections.find((item) => item.type === "reading.careful_reading");
    expect(section?.groups).toHaveLength(2);
    expect(section?.groups.map((group) => group.questions.length)).toEqual([5, 5]);
    expect(section?.groups.every((group) => group.passage !== null)).toBe(true);
  });

  it("拒绝缺少文章的仔细阅读组", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 6)[0].passage = null)));
    expect(issues.some((issue) => issue.message.includes("缺少文章"))).toBe(true);
  });
});

describe("听力：音频引用", () => {
  it("拒绝引用不存在的音频资产", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 1)[0].audioAssetId = "audio_missing")));
    expect(
      issues.some((issue) => issue.path === "sections[1].groups[0].audioAssetId"),
    ).toBe(true);
  });

  it("拒绝缺少 audioAssetId 的听力题组", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 1)[0].audioAssetId = null)));
    expect(issues.some((issue) => issue.message.includes("听力题组必须引用音频资产"))).toBe(true);
  });

  it("拒绝非听力题组引用音频", () => {
    const issues = issuesFor(
      mutate((m) => {
        const assets = m.assets as Record<string, unknown>[];
        groupsOf(m, 5)[0].audioAssetId = assets[0].id;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("非听力题组不应引用音频"))).toBe(true);
  });

  it("拒绝含听力大题但完全没有音频资产的包", () => {
    const issues = issuesFor(
      mutate((m) => {
        m.assets = [];
        for (const index of [1, 2, 3]) {
          for (const group of groupsOf(m, index)) group.audioAssetId = null;
        }
      }),
    );
    expect(issues.some((issue) => issue.message.includes("必须提供音频资产"))).toBe(true);
  });

  it("缺听力原文只是提醒，不阻断导入", () => {
    const outcome = validatePaperManifest(mutate((m) => void (groupsOf(m, 1)[0].transcript = null)));
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes("缺少听力原文"))).toBe(true);
  });
});

describe("写作与翻译（主观题）", () => {
  it("写作允许没有参考范文（没有就是没有，不生成）", () => {
    const outcome = validatePaperManifest(validManifest());
    const writing = outcome.paper?.sections.find((item) => item.type === "writing");
    expect(writing?.groups[0].questions[0].kind).toBe("writing");
  });

  it("拒绝最少词数大于最多词数", () => {
    const issues = issuesFor(
      mutate((m) => {
        const question = questionsOf(m, 0, 0)[0];
        question.minWords = 300;
        question.maxWords = 150;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("最少词数大于最多词数"))).toBe(true);
  });

  it("拒绝翻译原文不含中文（CET-6 为汉译英）", () => {
    const questions = questionsOf(validManifest(), 7, 0);
    expect(questions[0].kind).toBe("translation");
    const issues = issuesFor(
      mutate((m) => void (questionsOf(m, 7, 0)[0].sourceText = "This is English only.")),
    );
    expect(issues.some((issue) => issue.message.includes("应包含中文"))).toBe(true);
  });

  it("拒绝在写作大题里混入选择题", () => {
    const issues = issuesFor(
      mutate((m) => {
        const question = questionsOf(m, 0, 0)[0];
        question.kind = "mcq";
        question.stem = "混进来的选择题";
        question.options = ["A", "B", "C", "D"].map((id) => ({ id, label: id }));
        question.answer = "A";
      }),
    );
    expect(issues.some((issue) => issue.message.includes("只能包含 writing"))).toBe(true);
  });
});

describe("题号与顺序", () => {
  it("拒绝题号重复（同一题号出现两次）", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 1, 1)[0].number = 1)));
    expect(issues.some((issue) => issue.message.includes("题号必须严格递增"))).toBe(true);
  });

  it("拒绝完整卷题号出现缺口", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 1, 1)[0].number = 999)));
    expect(
      issues.some((issue) => issue.message.includes("题号必须从 1 连续到") || issue.message.includes("严格递增")),
    ).toBe(true);
  });

  it("拒绝完整卷不以第 1 题开始", () => {
    const issues = issuesFor(
      mutate((m) => {
        // 所有题号整体 +1，制造"从第 2 题开始"
        for (const section of sections(m)) {
          for (const group of section.groups as Record<string, unknown>[]) {
            for (const question of group.questions as Record<string, unknown>[]) {
              question.number = (question.number as number) + 1;
            }
          }
        }
        for (const section of sections(m)) {
          for (const group of section.groups as Record<string, unknown>[]) {
            const questions = group.questions as Record<string, unknown>[];
            group.firstNumber = questions[0].number;
          }
        }
      }),
    );
    expect(issues.some((issue) => issue.message.includes("必须从第 1 题开始"))).toBe(true);
  });

  it("拒绝组内 order 不连续", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 1, 0)[2].order = 7)));
    expect(issues.some((issue) => issue.message.includes("组内顺序必须连续"))).toBe(true);
  });

  it("拒绝 firstNumber 与首题题号不一致", () => {
    const issues = issuesFor(mutate((m) => void (groupsOf(m, 1)[0].firstNumber = 99)));
    expect(issues.some((issue) => issue.path === "sections[1].groups[0].firstNumber")).toBe(true);
  });

  it("拒绝大题顺序偏离官方结构", () => {
    const issues = issuesFor(mutate((m) => void (sections(m)[1].type = "translation")));
    expect(issues.some((issue) => issue.path.startsWith("sections["))).toBe(true);
  });

  it("拒绝重复的大题类型", () => {
    const issues = issuesFor(mutate((m) => void (sections(m)[1].type = "writing")));
    expect(issues.some((issue) => issue.message.includes("大题类型重复"))).toBe(true);
  });

  it("拒绝全卷重复的题目 id", () => {
    const issues = issuesFor(
      mutate((m) => {
        questionsOf(m, 1, 1)[3].id = questionsOf(m, 1, 1)[0].id;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("全卷题目 id 重复"))).toBe(true);
  });
});

describe("完整性：完整卷缺大题必须拒绝", () => {
  it("缺少某一个大题时失败并指认缺哪一个", () => {
    const issues = issuesFor(
      mutate((m) => {
        const list = sections(m);
        list.splice(3, 1);
      }),
    );
    expect(issues.some((issue) => issue.message.includes("缺少大题"))).toBe(true);
  });

  it("显式声明 partial 后不再按完整性拒绝（降级为提醒）", () => {
    // 用夹具自身的 omitSections：它正确地保留被省略部分占用的官方题号，
    // 因此这份包「题号严格递增、但少了 10 道听力讲座题（第 17–26 题）」
    const manifest = buildFixturePackage({
      omitSections: ["listening.talk_report_lecture"],
    }).manifest;

    const outcome = validatePaperManifest(manifest);
    expect(outcome.ok, JSON.stringify(outcome.issues)).toBe(true);
    expect(outcome.paper?.partial).toBe(true);
    expect(outcome.paper?.sections).toHaveLength(7);

    const numbers = numberedValues(outcome.paper?.sections ?? []);
    // 编号仍是试卷原样：从 1 起，讲座占位 17–26 空缺，选词填空仍从 27 开始
    expect(numbers[0]).toBe(1);
    expect(numbers).not.toContain(17);
    expect(numbers).toContain(27);
    // 47 = 55 − 8：省略了听力讲座（10 题）后剩余 45 个编号题，
    // 且尾部编号保持原样（仔细阅读仍到 55）
    expect(numbers).toHaveLength(45);
    expect(numbers[numbers.length - 1]).toBe(55);
  });

  it("partial 包中题量不符官方值的大题只提醒、不拒绝", () => {
    const manifest = mutate((m) => {
      m.partial = true;
      // 从仔细阅读第二组删掉一题：该大题变为 9 题 ≠ 官方 10 题
      questionsOf(m, 6, 1).pop();
    });
    const outcome = validatePaperManifest(manifest);
    expect(outcome.ok, JSON.stringify(outcome.issues)).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes("官方题量"))).toBe(true);
  });

  it("partial 包保留官方题号缺口（缺的部分占着原题号，不重排）", () => {
    const manifest = buildFixturePackage({ omitSections: ["reading.matching"] }).manifest;
    const outcome = validatePaperManifest(manifest);
    expect(outcome.ok, JSON.stringify(outcome.issues)).toBe(true);

    const numbers = numberedValues(outcome.paper?.sections ?? []);
    // 严格递增，但有缺口：长篇阅读占第 37–46 题，被省略后仔细阅读仍从 47 开始
    for (let index = 1; index < numbers.length; index += 1) {
      expect(numbers[index]).toBeGreaterThan(numbers[index - 1]);
    }
    expect(numbers).toContain(47);
    expect(numbers).not.toContain(37);
  });
  it("partial 包题号仍然禁止乱序与重复", () => {
    const issues = issuesFor(
      mutate((m) => {
        const list = sections(m);
        list.splice(3, 1);
        m.partial = true;
        // 把后面某题号改小，制造逆序
        questionsOf(m, 4, 0)[0].number = 5;
      }),
    );
    expect(issues.some((issue) => issue.message.includes("题号必须严格递增"))).toBe(true);
  });
});

describe("资产声明", () => {
  it("拒绝不支持的扩展名", () => {
    const issues = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[0].path = "assets/track.flac")),
    );
    expect(issues.some((issue) => issue.message.includes("不支持的资产扩展名"))).toBe(true);
  });

  it("拒绝 MIME 与扩展名不符（不信任 manifest 的声明）", () => {
    const issues = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[0].mimeType = "audio/mpeg")),
    );
    expect(issues.some((issue) => issue.message.includes("声明的 MIME 与扩展名不符"))).toBe(true);
  });

  it("拒绝 kind 与扩展名不符", () => {
    const issues = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[0].kind = "image")),
    );
    expect(issues.some((issue) => issue.message.includes("资产类型与扩展名不符"))).toBe(true);
  });

  it("拒绝资产路径逃逸内容根", () => {
    const malicious = "../../../secret.mp3";
    const issues = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[0].path = malicious)),
    );
    const hit = issues.find((issue) => issue.path === "assets[0].path");
    expect(hit, "越界资产路径必须被拒绝").toBeDefined();

    /*
     * 独立评审 F-2 之后，这条消息不再回显 manifest 里声明的路径原文 ——
     * manifest 是外部数据，回显它等于让一个 JSON 字段决定界面文本。
     * 因此断言两件事：分类原因仍然可读，且原文**不出现**。
     */
    expect(hit!.message).toContain("上跳");
    expect(hit!.message).not.toContain(malicious);
    expect(hit!.message).not.toContain("secret.mp3");
  });

  it("拒绝资产路径为绝对路径", () => {
    const issues = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[0].path = "C:/windows/win.ini")),
    );
    const hit = issues.find((issue) => issue.path === "assets[0].path");
    expect(hit, "盘符路径必须被拒绝").toBeDefined();
    // 分类原因可读，但原文不回显（F-2 同类根因）。
    expect(hit!.message).toContain("盘符");
    expect(hit!.message).not.toContain("C:/windows/win.ini");
    expect(hit!.message).not.toContain("win.ini");
  });

  it("拒绝重复的资产 id 与路径", () => {
    const duplicateId = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[1].id = (m.assets as Record<string, unknown>[])[0].id)),
    );
    expect(duplicateId.some((issue) => issue.message.includes("资产 id 重复"))).toBe(true);

    const duplicatePath = issuesFor(
      mutate(
        (m) => void ((m.assets as Record<string, unknown>[])[1].path = (m.assets as Record<string, unknown>[])[0].path),
      ),
    );
    expect(duplicatePath.some((issue) => issue.message.includes("资产路径重复"))).toBe(true);
  });

  it("拒绝非法 checksum 格式", () => {
    const issues = issuesFor(
      mutate((m) => void ((m.assets as Record<string, unknown>[])[0].checksum = "NOT_A_HASH")),
    );
    expect(issues.some((issue) => issue.path === "assets[0].checksum")).toBe(true);
  });
});

describe("错误定位必须精确到字段", () => {
  it("深层问题给出完整路径而不是「试卷无效」", () => {
    const issues = issuesFor(mutate((m) => void (questionsOf(m, 6, 1)[4].answer = "ZZZ")));
    expect(issues.some((issue) => issue.path === "sections[6].groups[1].questions[4].answer")).toBe(true);
  });

  it("一次报告全部问题，而不是只报第一个", () => {
    const issues = issuesFor(
      mutate((m) => {
        questionsOf(m, 6, 0)[0].answer = "X";
        questionsOf(m, 6, 0)[1].answer = "Y";
      }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("整卷级问题使用 <paper> 或明确的顶层路径", () => {
    const issues = issuesFor(mutate((m) => void delete m.sections));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path).toContain("sections");
  });
});

describe("形状校验：缺字段与错类型", () => {
  it("拒绝缺少 paper id", () => {
    const issues = issuesFor(mutate((m) => void delete m.id));
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });

  it("拒绝 score 为字符串这类类型错误", () => {
    const issues = issuesFor(mutate((m) => void (m.year = "2024")));
    expect(issues.some((issue) => issue.path === "year")).toBe(true);
  });

  it("拒绝完全不是对象的内容", () => {
    const outcome = validatePaperManifest("not a paper");
    expect(outcome.ok).toBe(false);
    expect(outcome.paper).toBeNull();
  });

  it("拒绝 JSON 解析后的数组", () => {
    const outcome = validatePaperManifest([]);
    expect(outcome.ok).toBe(false);
  });
});
