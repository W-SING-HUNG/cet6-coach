// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BankedClozePanel,
  CarefulReadingPanel,
  MatchingPanel,
} from "@/app/practice/papers/[paperId]/train/[sectionId]/question-kinds";
import { useTrainingSession } from "@/app/practice/papers/[paperId]/train/[sectionId]/use-training-session";
import { commitAnswer } from "@/domain/expert-training";
import type { TrainingQuestionView } from "@/services/expert-training";

/*
 * 必须显式清理：本仓库 vitest 配置是 `globals: false`，
 * 因此 @testing-library/react 的自动 cleanup 不会被注册（它依赖全局 afterEach）。
 * 不清理会让上一个用例的 DOM 留下，后续查询命中多个元素而失败 ——
 * 那是测试基础设施问题，不是产品缺陷。
 */
afterEach(cleanup);

/**
 * 作答控件的**接线**测试（v2）。
 *
 * ── 为什么这一层不可省略 ──
 * 域层的 `commitAnswer` 规则正确，并不代表组件把它接对了。
 * 只有真实渲染 + 真实事件才能守住"提交边界接在哪个事件上"——
 * 纯函数测试直接在第 4 步调用正确的时间点，永远发现不了接线错误
 * （架构门禁：组件接线必须有测试守护）。
 *
 * ── v1 → v2 的变化 ──
 * v1 有三种控件，其中两种是**文本输入**，因此重点守卫"打字不算改答案"。
 * v2 把所有作答改为**点选**（选择标号 / 选择词），打字路径不再存在。
 * 因此本文件把守卫重心移到 v2 真正新增的风险上：
 *
 * 1. **点选即提交，且带显式值** —— 否则提交边界会读到尚未更新的状态快照。
 * 2. **排除选项不得触发提交、不得改变已选答案、不得计入改答案。**
 * 3. **标记待回看不得触发提交**（它是界面状态，不是作答动作）。
 *
 * 第 2、3 条是本轮新增的语义，也正是"本地工作状态不得变成证据"这条
 * 约束在**组件层**的落点。写在这里而不是只写在域层，是因为
 * 一个误接（例如把排除按钮放进 label 内）就足以破坏它。
 */

const MCQ: TrainingQuestionView = {
  id: "q46",
  number: 46,
  order: 0,
  kind: "mcq",
  stem: "Fixture stem",
  options: [
    { id: "A", label: "Option A" },
    { id: "B", label: "Option B" },
    { id: "C", label: "Option C" },
  ],
  blankId: null,
  statement: null,
};

const MATCHING: TrainingQuestionView = {
  id: "q36",
  number: 36,
  order: 0,
  kind: "matching_statement",
  stem: null,
  options: [],
  blankId: null,
  statement: "Fixture statement",
};

const CLOZE: TrainingQuestionView = {
  id: "q26",
  number: 26,
  order: 0,
  kind: "banked_cloze_blank",
  stem: null,
  options: [],
  blankId: "1",
  statement: null,
};

const WORD_BANK = ["alpha", "bravo", "charlie"];

// ---------------------------------------------------------------------------
// 仔细阅读：点选即提交
// ---------------------------------------------------------------------------

describe("仔细阅读：点选项是唯一的作答提交边界", () => {
  it("点选项立刻提交一次，并把**显式值**传给提交边界", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onCommit = vi.fn();

    render(
      <CarefulReadingPanel
        question={MCQ}
        value={null}
        eliminated={[]}
        disabled={false}
        onChoose={onChoose}
        onCommit={onCommit}
        onToggleElimination={() => {}}
      />,
    );

    // 产品里的 radio 是 sr-only，用户点的是它的 label
    await user.click(screen.getByText("Option B"));

    expect(onCommit, "点击选项应立刻提交").toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe("q46");
    /*
     * 显式值必须传进来。
     * 原因：提交边界与值写入发生在**同一个事件**里，此时订阅快照还没更新；
     * 读快照会拿到旧值，从而把"首次选择"误判为"没选"。
     */
    expect(onCommit.mock.calls[0][1]).toBe("B");
  });

  it("A → B 的两次点击各提交一次（因此可被判定为改答案）", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <CarefulReadingPanel
        question={MCQ}
        value={null}
        eliminated={[]}
        disabled={false}
        onChoose={() => {}}
        onCommit={onCommit}
        onToggleElimination={() => {}}
      />,
    );

    await user.click(screen.getByText("Option A"));
    await user.click(screen.getByText("Option B"));

    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit.mock.calls[0][1]).toBe("A");
    expect(onCommit.mock.calls[1][1]).toBe("B");

    // 域层规则确认：A → B 是真正的"改主意"，而首次填入不是
    const first = commitAnswer(null, "A", false);
    expect(first.changed, "首次选择不算改答案").toBe(false);
    const second = commitAnswer(first.committed, "B", first.changed);
    expect(second.changed, "A → B 应算改答案").toBe(true);
  });

  it("提交中（disabled）时选项不可再点", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <CarefulReadingPanel
        question={MCQ}
        value={null}
        eliminated={[]}
        disabled
        onChoose={() => {}}
        onCommit={onCommit}
        onToggleElimination={() => {}}
      />,
    );

    await user.click(screen.getByText("Option A"));
    expect(onCommit, "禁用状态下不应产生提交").not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 选项排除：不得影响作答
// ---------------------------------------------------------------------------

describe("选项排除是纯界面动作，不触及作答语义", () => {
  it("点排除按钮**不触发任何提交**", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onCommit = vi.fn();
    const onToggleElimination = vi.fn();

    render(
      <CarefulReadingPanel
        question={MCQ}
        value={null}
        eliminated={[]}
        disabled={false}
        onChoose={onChoose}
        onCommit={onCommit}
        onToggleElimination={onToggleElimination}
      />,
    );

    // 排除按钮是选项旁边的独立按钮（**不在** label 内，因此不会顺带选中选项）
    await user.click(screen.getByRole("button", { name: /排除选项 A/ }));

    expect(onToggleElimination).toHaveBeenCalledWith("A");
    expect(onCommit, "排除不应被记为作答提交").not.toHaveBeenCalled();
    expect(onChoose, "排除不应写入作答值").not.toHaveBeenCalled();
  });

  it("排除**已选项**不会改变已选答案（作答与排除是两件事）", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onCommit = vi.fn();

    // 假定学习者已选了 A，现在把 A 划掉
    render(
      <CarefulReadingPanel
        question={MCQ}
        value="A"
        eliminated={[]}
        disabled={false}
        onChoose={onChoose}
        onCommit={onCommit}
        onToggleElimination={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /排除选项 A/ }));

    expect(onCommit, "划掉已选项不得触发提交").not.toHaveBeenCalled();
    expect(onChoose, "划掉已选项不得改动作答值").not.toHaveBeenCalled();

    // 选项本身仍然是选中的（radio 保持 checked）
    const radios = screen.getAllByRole("radio", { hidden: true });
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
  });

  it("已排除的选项可随时恢复，且恢复同样不触发提交", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <CarefulReadingPanel
        question={MCQ}
        value={null}
        eliminated={["B"]}
        disabled={false}
        onChoose={() => {}}
        onCommit={onCommit}
        onToggleElimination={() => {}}
      />,
    );

    // 已排除状态下按钮的语义变为"恢复"，并且 aria-pressed 如实表达状态
    const button = screen.getByRole("button", { name: /恢复选项 B/ });
    /*
     * 用原生属性断言而不是 `toHaveAttribute`：本仓库没有注册
     * @testing-library/jest-dom 的类型扩展，用它会让 typecheck 失败。
     * 不改动测试基建（那属于范围外），改用等价的显式读取。
     */
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await user.click(button);
    expect(onCommit).not.toHaveBeenCalled();

    // 被排除的选项文本被划掉（状态不只靠颜色表达）
    expect(screen.getByText("Option B").className).toContain("line-through");
  });
});

// ---------------------------------------------------------------------------
// 长篇阅读：段落标号点选
// ---------------------------------------------------------------------------

describe("长篇阅读：段落标号点选取代文本输入", () => {
  it("点标号立刻提交，并带上该标号", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <MatchingPanel
        question={MATCHING}
        value={null}
        disabled={false}
        paragraphLabels={["A", "B", "C", "D"]}
        onChoose={() => {}}
        onCommit={onCommit}
        onShowMaterial={() => {}}
      />,
    );

    await user.click(screen.getByText("C"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe("q36");
    expect(onCommit.mock.calls[0][1]).toBe("C");
  });

  it("替换答案：B → D 各提交一次，且域层判为改答案", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <MatchingPanel
        question={MATCHING}
        value={null}
        disabled={false}
        paragraphLabels={["A", "B", "C", "D"]}
        onChoose={() => {}}
        onCommit={onCommit}
        onShowMaterial={() => {}}
      />,
    );

    await user.click(screen.getByText("B"));
    await user.click(screen.getByText("D"));

    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit.mock.calls[1][1]).toBe("D");

    const first = commitAnswer(null, "B", false);
    const second = commitAnswer(first.committed, "D", first.changed);
    expect(second.changed, "B → D 应算改答案").toBe(true);
  });

  it("只渲染真实存在的段落标号（不凭空造段落）", () => {
    render(
      <MatchingPanel
        question={MATCHING}
        value={null}
        disabled={false}
        paragraphLabels={["A", "B"]}
        onChoose={() => {}}
        onCommit={() => {}}
        onShowMaterial={() => {}}
      />,
    );

    expect(screen.getAllByRole("radio", { hidden: true })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 选词填空：词库点选
// ---------------------------------------------------------------------------

describe("选词填空：词库点选与替换", () => {
  /*
    注意：`onAssign(word)` **只收一个参数** —— 独占式转移的作用域
    （同组兄弟空）由 `useTrainingSession.assignExclusiveValue` 内部处理。
    因此这里断言 `calls[0][0]`，不再有第二个 questionId 参数。
  */
  it("点词立刻提交该词", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();

    render(
      <BankedClozePanel
        question={CLOZE}
        value={null}
        disabled={false}
        wordBank={WORD_BANK}
        usedElsewhere={[]}
        onAssign={onAssign}
        onClear={() => {}}
        onShowMaterial={() => {}}
      />,
    );

    await user.click(screen.getByText("bravo"));
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign.mock.calls[0][0]).toBe("bravo");
  });

  it("替换答案：alpha → charlie 各提交一次（同一空内替换）", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();

    render(
      <BankedClozePanel
        question={CLOZE}
        value={null}
        disabled={false}
        wordBank={WORD_BANK}
        usedElsewhere={[]}
        onAssign={onAssign}
        onClear={() => {}}
        onShowMaterial={() => {}}
      />,
    );

    await user.click(screen.getByText("alpha"));
    await user.click(screen.getByText("charlie"));

    expect(onAssign).toHaveBeenCalledTimes(2);
    expect(onAssign.mock.calls[0][0]).toBe("alpha");
    expect(onAssign.mock.calls[1][0]).toBe("charlie");
  });

  it("已被其它空使用的词仍然可点（点击即转移），且视觉上退后", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();

    render(
      <BankedClozePanel
        question={CLOZE}
        value={null}
        disabled={false}
        wordBank={WORD_BANK}
        usedElsewhere={["bravo"]}
        onAssign={onAssign}
        onClear={() => {}}
        onShowMaterial={() => {}}
      />,
    );

    /*
      这里点的是**已被其它空占用**的词。
      它必须仍然可点 —— 点击的语义是"把这个词移过来"，
      硬性禁用会制造一个无法从界面纠正的状态。
      真正防止"两空同时持有"的是 hook 里的原子转移，不是禁用。
    */
    await user.click(screen.getByText("bravo"));
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign.mock.calls[0][0]).toBe("bravo");
  });

  it("清空这一空走提交边界（域层会把 changed 回滚）", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    render(
      <BankedClozePanel
        question={CLOZE}
        value="alpha"
        disabled={false}
        wordBank={WORD_BANK}
        usedElsewhere={[]}
        onAssign={() => {}}
        onClear={onClear}
        onShowMaterial={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /清空这一空/ }));
    expect(onClear).toHaveBeenCalledTimes(1);

    // 域层规则：清空后最终为空 → changed 必须回滚为 false，不编造"改过答案"的证据
    const filled = commitAnswer(null, "alpha", false);
    const cleared = commitAnswer(filled.committed, "", filled.changed);
    expect(cleared.changed, "清空后不得保留'改过'的结论").toBe(false);
    expect(cleared.committed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 本地工作状态层：标记 / 排除不得成为作答证据
// ---------------------------------------------------------------------------

describe("本地工作状态层（useTrainingSession）", () => {
  it("标记待回看不产生任何作答值或改答案记录", () => {
    const { result } = renderHook(() => useTrainingSession("run-marks"));

    act(() => {
      result.current.toggleMark("q46");
    });

    expect(result.current.markedIds.has("q46")).toBe(true);
    expect(result.current.state.values, "标记不应写入作答值").toEqual({});
    expect(result.current.state.changed, "标记不应被记为改答案").toEqual([]);
    expect(result.current.answeredCount, "标记不等于已作答").toBe(0);

    act(() => {
      result.current.toggleMark("q46");
    });
    expect(result.current.markedIds.has("q46")).toBe(false);
  });

  it("排除选项不写入作答值、不改 commmitted、不计入 changed", () => {
    const { result } = renderHook(() => useTrainingSession("run-eliminate"));

    act(() => {
      result.current.toggleElimination("q46", "B");
    });

    expect(result.current.isEliminated("q46", "B")).toBe(true);
    expect(result.current.state.values, "排除不得写入作答值").toEqual({});
    expect(result.current.state.committed, "排除不得写入已提交值").toEqual({});
    expect(result.current.state.changed, "排除不得被记为改答案").toEqual([]);
    expect(result.current.answeredCount).toBe(0);
  });

  it("排除与作答互不干扰：先排除再选另一个选项", () => {
    const { result } = renderHook(() => useTrainingSession("run-mixed"));

    act(() => {
      result.current.toggleElimination("q46", "A");
    });
    act(() => {
      result.current.setValue("q46", "B");
      result.current.commitValue("q46", "B");
    });

    expect(result.current.isEliminated("q46", "A")).toBe(true);
    expect(result.current.state.values.q46).toBe("B");
    expect(result.current.answeredCount).toBe(1);
    // 首次选择不构成改答案
    expect(result.current.state.changed).toEqual([]);
  });

  it("改答案语义在本地状态层与域层一致：A → B 记为改过", () => {
    const { result } = renderHook(() => useTrainingSession("run-changed"));

    act(() => {
      result.current.setValue("q46", "A");
      result.current.commitValue("q46", "A");
    });
    expect(result.current.state.changed, "首次选择不算改答案").toEqual([]);

    act(() => {
      result.current.setValue("q46", "B");
      result.current.commitValue("q46", "B");
    });
    expect(result.current.state.changed, "A → B 应记为改过答案").toEqual(["q46"]);
  });

  it("清空作答会回滚 changed（最终未作答的题不产生'改过'结论）", () => {
    const { result } = renderHook(() => useTrainingSession("run-clear"));

    act(() => {
      result.current.setValue("q46", "A");
      result.current.commitValue("q46", "A");
      result.current.setValue("q46", "B");
      result.current.commitValue("q46", "B");
    });
    expect(result.current.state.changed).toEqual(["q46"]);

    act(() => {
      result.current.clearValue("q46");
    });

    expect(result.current.state.values.q46).toBe("");
    expect(result.current.state.changed, "清空后不得保留'改过'的结论").toEqual([]);
    expect(result.current.answeredCount, "清空后不再是已作答").toBe(0);
  });

  it("reset 清空全部本地状态（提交成功后调用）", () => {
    const { result } = renderHook(() => useTrainingSession("run-reset"));

    act(() => {
      result.current.setValue("q46", "A");
      result.current.commitValue("q46", "A");
      result.current.toggleMark("q46");
      result.current.toggleElimination("q46", "C");
    });
    expect(result.current.answeredCount).toBe(1);

    act(() => {
      result.current.reset();
    });

    expect(result.current.state.values).toEqual({});
    expect(result.current.state.marks).toEqual([]);
    expect(result.current.state.eliminated).toEqual({});
    expect(result.current.answeredCount).toBe(0);
  });
});

/**
 * 选词填空的"每词至多使用一次"（F-1）。
 *
 * ── 被修的真实缺陷 ──
 * 独立评审复现的路径：把 X 填进 A → 翻到 B → 点同一个 X
 * → 结果是 `values = { A: X, B: X }`，两空同时持有同一个词。
 * 这违反界面自己写下的规则，并把一个**不可能的状态**送进提交载荷。
 *
 * 正确语义是**转移**：B 取得 X，A 被清空。
 *
 * ── 为什么测试落在 hook 层 ──
 * 转移必须在**一次**状态写入内完成（否则会重现已登记过的
 * "同 tick 多次修改互相覆盖"，还会产生可见的中间态）。
 * 因此被守护的不变量是"写入的原子性 + 最终状态"，
 * 而这两点只有直接驱动 hook/SessionStorage 才能稳定断言。
 */
describe("选词填空：跨空转移（每词至多一次）", () => {
  /** A、B、C 是同一题组里的三个空。 */
  const SIBLINGS = ["A", "B", "C"];
  /** 读回浏览器存储里的原始状态 —— 转移的真相在存储里，不是组件 props。 */
  const stored = (runId: string) =>
    JSON.parse(sessionStorage.getItem(`cet6:training-workspace:${runId}`) ?? "{}") as {
      values?: Record<string, string>;
      committed?: Record<string, string>;
      changed?: string[];
      marks?: string[];
      eliminated?: Record<string, string[]>;
    };

  it("1) 空 → 选 X：只有该空持有 X", () => {
    const { result } = renderHook(() => useTrainingSession("f1-1"));
    act(() => {
      result.current.assignExclusiveValue("A", "X", SIBLINGS);
    });

    expect(result.current.state.values.A).toBe("X");
    expect(result.current.answeredCount).toBe(1);
  });

  it("2) A=X → B 选 X：A 被清空，B 取得 X，全组只有一个持有者", () => {
    const { result } = renderHook(() => useTrainingSession("f1-2"));

    act(() => {
      result.current.assignExclusiveValue("A", "X", SIBLINGS);
    });
    expect(result.current.state.values.A).toBe("X");

    // 评审复现的确切一步：在 B 上点同一个 X
    act(() => {
      result.current.assignExclusiveValue("B", "X", SIBLINGS);
    });

    expect(result.current.state.values.A, "原持有者必须被清空").toBe("");
    expect(result.current.state.values.B).toBe("X");
    expect(
      Object.entries(result.current.state.values).filter(([, v]) => v === "X"),
      "同一个词只能有一个持有者",
    ).toHaveLength(1);

    // 存储里也只有一份（断言真相层，而不只是组件派生值）
    const raw = stored("f1-2");
    expect(Object.values(raw.values ?? {}).filter((v) => v === "X")).toHaveLength(1);
    expect(raw.committed?.A, "原持有者的 committed 必须一并清空").toBe("");
  });

  it("3) A=X → B=Y → B 选 X：A 清空，B=X，且 B 的改答案语义对 Y → X 成立", () => {
    const { result } = renderHook(() => useTrainingSession("f1-3"));

    act(() => {
      result.current.assignExclusiveValue("A", "X", SIBLINGS);
    });
    act(() => {
      result.current.assignExclusiveValue("B", "Y", SIBLINGS);
    });
    expect(result.current.state.changed, "首次填入不算改答案").toEqual([]);

    act(() => {
      result.current.assignExclusiveValue("B", "X", SIBLINGS);
    });

    expect(result.current.state.values.A).toBe("");
    expect(result.current.state.values.B).toBe("X");
    // Y → X 是真正的改主意，因此 B 应被记为改过答案
    expect(result.current.state.changed, "同一空内 Y → X 应记为改过答案").toEqual(["B"]);
  });

  it("4) A 曾改过答案后因转移失去 X：A 清空，且 changed 结论按域层语义回滚", () => {
    const { result } = renderHook(() => useTrainingSession("f1-4"));

    // A: X → Y（这使得 A 被标记为改过答案）
    act(() => {
      result.current.assignExclusiveValue("A", "X", SIBLINGS);
    });
    act(() => {
      result.current.assignExclusiveValue("A", "Y", SIBLINGS);
    });
    expect(result.current.state.changed, "A 先 X 后 Y，应记为改过").toEqual(["A"]);

    // B 把 Y 抢走 → A 被清空
    act(() => {
      result.current.assignExclusiveValue("B", "Y", SIBLINGS);
    });

    expect(result.current.state.values.A, "A 最终为空").toBe("");
    expect(
      result.current.state.changed.includes("A"),
      "最终未作答的题不得保留'改过答案'的结论",
    ).toBe(false);
  });

  it("5) 无关的 C 完全不受影响", () => {
    const { result } = renderHook(() => useTrainingSession("f1-5"));

    act(() => {
      result.current.assignExclusiveValue("C", "Z", SIBLINGS);
    });
    act(() => {
      result.current.assignExclusiveValue("A", "X", SIBLINGS);
    });
    act(() => {
      result.current.assignExclusiveValue("B", "X", SIBLINGS);
    });

    expect(result.current.state.values.C, "无关空必须原样保留").toBe("Z");
    expect(result.current.state.committed.C).toBe("Z");

    const raw = stored("f1-5");
    expect(raw.values?.C).toBe("Z");
  });

  it("6) 已损坏状态（X 同时在 A 与 B）在分配到 C 时自愈为只有 C=X", () => {
    const runId = "f1-6";
    // 直接写入一个"两空同时持有 X"的脏状态，模拟历史缺陷留下的数据
    sessionStorage.setItem(
      `cet6:training-workspace:${runId}`,
      JSON.stringify({
        values: { A: "X", B: "X", C: "" },
        committed: { A: "X", B: "X", C: "" },
        changed: [],
        marks: [],
        eliminated: {},
      }),
    );

    const { result } = renderHook(() => useTrainingSession(runId));

    act(() => {
      result.current.assignExclusiveValue("C", "X", SIBLINGS);
    });

    expect(result.current.state.values.A, "自愈：A 被清空").toBe("");
    expect(result.current.state.values.B, "自愈：B 被清空").toBe("");
    expect(result.current.state.values.C).toBe("X");
    expect(
      Object.values(result.current.state.values).filter((v) => v === "X"),
      "自愈后只剩一个持有者",
    ).toHaveLength(1);
  });

  it("7) 转移不破坏标记与排除（本地界面状态原样保留）", () => {
    const { result } = renderHook(() => useTrainingSession("f1-7"));

    act(() => {
      result.current.assignExclusiveValue("A", "X", SIBLINGS);
      result.current.toggleMark("A");
      result.current.toggleElimination("A", "C");
    });

    act(() => {
      result.current.assignExclusiveValue("B", "X", SIBLINGS);
    });

    expect(result.current.state.values.A).toBe("");
    // 标记与排除是**空的**属性，不是"持有 X"的属性 —— 转移不该清掉它们
    expect(result.current.markedIds.has("A"), "标记必须保留").toBe(true);
    expect(result.current.isEliminated("A", "C"), "排除必须保留").toBe(true);
  });

  it("大小写不同的同一个词也被视为同一词（与判分归一化口径一致）", () => {
    const { result } = renderHook(() => useTrainingSession("f1-case"));

    act(() => {
      result.current.assignExclusiveValue("A", "Alpha", SIBLINGS);
    });
    act(() => {
      result.current.assignExclusiveValue("B", "alpha", SIBLINGS);
    });

    expect(result.current.state.values.A, "大小写不应绕过唯一性").toBe("");
    expect(result.current.state.values.B).toBe("alpha");
  });
});
