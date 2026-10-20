"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { commitAnswer } from "@/domain/expert-training";

/**
 * 训练会话的**本地工作状态**。
 *
 * ── 这一层是什么、不是什么 ──
 *
 * 它是**界面工作状态**，不是学习者证据：
 * - `values` / `committed` / `changed` —— 作答草稿与"改过答案"的判定输入
 * - `marks` —— "标记待回看"（mark for review）
 * - `eliminated` —— 选项排除（划掉）
 *
 * 后两者**刻意**只活在这里。它们存在的意义是帮学习者管理**当前这一场**，
 * 因此：
 * - 不进入提交载荷（`submitReadingRunAction` 只收 responses / elapsedSeconds /
 *   changedQuestionIds）；
 * - 不写 Expert 台账，不产生 `performance_event`；
 * - 不影响正确性、判定结果、`answer_changed`、弱项或机制推断。
 *
 * 反例说明为什么必须这样：把"标记过"或"排除过某个选项"当成证据，
 * 等于从一次界面操作推出认知结论 —— 那正是措辞门禁第 3 条
 * （禁止单信号因果诊断）与 LEARNING_MODEL 第 4 节所禁止的。
 * 排除只说明"学习者当时不想选它"，可能因为读懂了，也可能因为手滑。
 *
 * 存储层：`sessionStorage`。理由是它的生命周期正确 ——
 * 一场训练的临时状态不该跨浏览器会话存活（而落库的事实由服务端负责）。
 * 关闭标签页即清空这一点在开始屏**如实说明**，不夸大持久性。
 */

export interface TrainingLocalState {
  /** 输入框当前值（每次按键更新）。 */
  values: Record<string, string>;
  /** 最后一次**提交**的值（focus/blur 边界或离散点击）。 */
  committed: Record<string, string>;
  /** 已被判定为"改过答案"的题。 */
  changed: string[];
  /** 标记待回看的题（纯本地）。 */
  marks: string[];
  /** 选项排除：questionId → 被排除的 optionId 列表（纯本地）。 */
  eliminated: Record<string, string[]>;
}

const EMPTY_STATE: TrainingLocalState = {
  values: {},
  committed: {},
  changed: [],
  marks: [],
  eliminated: {},
};

/**
 * 前缀刻意不复用 v1：
 * v1 只存三字段，键名相同但语义已扩展。用新前缀可以把
 * "旧格式被当新格式解析"这类静默错配排除掉，代价为 0（旧草稿本就该过期）。
 */
const STORAGE_PREFIX = "cet6:training-workspace:";

function storageKey(runId: string): string {
  return `${STORAGE_PREFIX}${runId}`;
}

function changeEventName(key: string): string {
  return `cet6-workspace:${key}`;
}

/**
 * 快照必须是**字符串**（原始存储值）。
 * `useSyncExternalStore` 用 `Object.is` 比较快照 —— 每次返回新对象会无限重渲染。
 */
function snapshotOf(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    // 隐私模式下 sessionStorage 可能抛错：降级为"无本地状态"，作答不受影响
    return "";
  }
}

function subscribe(key: string, onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const event = changeEventName(key);
  window.addEventListener(event, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(event, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeState(key: string, state: TrainingLocalState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
    window.dispatchEvent(new Event(changeEventName(key)));
  } catch {
    /* 写入失败不影响作答：本地状态只是便利，不是事实 */
  }
}

/**
 * 基于**存储里的最新值**做一次修改。
 *
 * ── 为什么必须这样，而不是 `writeState(key, {...state, ...})` ──
 *
 * `state` 来自当前渲染的订阅快照。同一个事件/同一 tick 内连续调用两次修改时，
 * 两次都读**同一个**旧快照，于是第二次写入会把第一次的结果整段覆盖掉。
 *
 * 这不是理论问题：产品里"点选项"这一个动作就会连续调用
 * `setValue` 再 `commitValue`（见 question-kinds 的 onChange）。
 * 早期版本靠"commitValue 会显式把值合并回去"侥幸正确，
 * 但只要再加一个字段（标记、排除）就会静默丢数据 ——
 * 实测：`setValue` + `commitValue` + `toggleMark` 三连会把作答值清空。
 *
 * 因此写入一律先读最新存储值再改。这样每次修改都建立在
 * "上一次修改的结果"之上，与调用次数和顺序无关。
 */
function updateState(key: string, update: (current: TrainingLocalState) => TrainingLocalState): void {
  writeState(key, update(parseState(snapshotOf(key))));
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function eliminationRecord(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const list = stringArray(item);
    if (list.length > 0) out[key] = list;
  }
  return out;
}

/** 容错解析：损坏或旧格式的本地状态不应让页面崩掉，最坏情况是"没有本地状态"。 */
function parseState(raw: string): TrainingLocalState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      values: stringRecord(parsed.values),
      committed: stringRecord(parsed.committed),
      changed: stringArray(parsed.changed),
      marks: stringArray(parsed.marks),
      eliminated: eliminationRecord(parsed.eliminated),
    };
  } catch {
    return EMPTY_STATE;
  }
}

export interface TrainingSessionApi {
  state: TrainingLocalState;
  /** 输入过程中的值更新（每次按键）。**不触碰** changed / marks / eliminated。 */
  setValue: (questionId: string, value: string) => void;
  /** 提交边界：更新 committed 与 changed。判定规则来自域层纯函数 `commitAnswer`。 */
  commitValue: (questionId: string, explicitValue?: string) => void;
  /**
   * **选词填空专用**：把一个词独占式分配给当前空。
   *
   * 真实规则是"每个词至多使用一次"，因此点一个已被其它空占用的词
   * **不是复制，而是转移**：原持有者被清空，当前空取得该词。
   *
   * 整个转移在**一次** `updateState` 里完成（见实现处的注释说明为什么
   * 不能用"先清 A、再设 B"两步）。它还会顺带**自愈**已经损坏的本地状态：
   * 若同一个词被多个兄弟空同时持有（历史缺陷留下的状态），
   * 则清掉除当前目标以外的全部持有者。
   */
  assignExclusiveValue: (
    questionId: string,
    value: string,
    siblingQuestionIds: string[],
  ) => void;
  /**
   * 清空某一空的作答。
   *
   * 与 `commitValue(id, "")` 等价（`commitAnswer` 在最终为空时会**回滚**
   * `changed` —— 填了又删掉不构成"改过答案"），这里只是给界面一个明确的入口。
   */
  clearValue: (questionId: string) => void;
  /** 标记 / 取消标记待回看。纯本地，无证据语义。 */
  toggleMark: (questionId: string) => void;
  /** 排除 / 恢复一个选项。**不改变已选答案**，也不计数为改答案。 */
  toggleElimination: (questionId: string, optionId: string) => void;
  /** 清空本地状态（提交成功后调用）。 */
  reset: () => void;
  /** 已作答（非空值）计数。 */
  answeredCount: number;
  answeredIds: Set<string>;
  markedIds: Set<string>;
  isEliminated: (questionId: string, optionId: string) => boolean;
}

export function useTrainingSession(runId: string): TrainingSessionApi {
  const key = storageKey(runId);

  const raw = useSyncExternalStore(
    useCallback((onChange: () => void) => subscribe(key, onChange), [key]),
    useCallback(() => snapshotOf(key), [key]),
    // 服务端快照恒为空：本地状态只存在于浏览器，因此首屏两侧渲染一致
    () => "",
  );

  const state = useMemo(() => parseState(raw), [raw]);

  const setValue = useCallback(
    (questionId: string, value: string) => {
      updateState(key, (current) => ({
        ...current,
        values: { ...current.values, [questionId]: value },
      }));
    },
    [key],
  );

  const commitValue = useCallback(
    (questionId: string, explicitValue?: string) => {
      updateState(key, (current) => {
        const raw = explicitValue ?? current.values[questionId] ?? "";
        const result = commitAnswer(
          current.committed[questionId] ?? null,
          raw,
          current.changed.includes(questionId),
        );
        return {
          ...current,
          // 显式提交离散选项时同时把值写回，保证受控输入与本地状态一致
          values:
            explicitValue === undefined
              ? current.values
              : { ...current.values, [questionId]: explicitValue },
          committed: { ...current.committed, [questionId]: result.committed ?? "" },
          changed: result.changed
            ? current.changed.includes(questionId)
              ? current.changed
              : [...current.changed, questionId]
            : current.changed.filter((id) => id !== questionId),
        };
      });
    },
    [key],
  );

  /**
   * 选词填空：把一个词**独占式**分配给当前空（跨空转移）。
   *
   * ── 为什么必须是"一次 updateState 里的多字段事务" ──
   *
   * 反例（被独立评审证明的真实缺陷）：学习者把 `X` 填进第 1 空，
   * 翻到第 2 空再点同一个 `X` —— 结果是 `values = { A: X, B: X }`，
   * 两个空同时持有同一个词。这违反界面自己写下的规则
   * "每个词至多使用一次"，并把一个**不可能的状态**送进提交载荷。
   *
   * 修法不能是"先 `clearValue(A)`，再 `commitValue(B, X)`"这类多步写入：
 * 本层已经踩过"同一 tick 内多次修改互相覆盖"的坑，
   * 而且中间态（A 已清、B 未设）会让 UI 闪一下、也让"改过答案"的
   * 判定跨越两个中间状态而变得不可预测。
   *
   * 因此这里在一个 `updateState` 回调里：
   *   1. 找出所有**其它**兄弟空中持有该词的空（大小写不敏感，与判分归一化一致）
   *   2. 逐个清空：`values[x] = ""`，并用**同一个** `commitAnswer` 语义重算
   *      `committed` 与 `changed` —— 清空后 `changed` 会按域层规则**回滚为 false**
   *      （最终未作答的题不存在"改过答案"）
   *   3. 把词分配给当前空，同样走 `commitAnswer`
   *   4. `marks` / `eliminated` / 无关题目的 values、committed、changed 原样保留
   *
   * 第 1 步同时承担**自愈**职责：如果本地状态里已经有多个持有者
   * （历史缺陷留下的脏数据），这次操作会把它们全部清掉，只留当前目标。
   *
   * ── 不涉及证据 ──
   * "把词从 A 挪到 B"是**界面内的工作状态整理**，不是学习者行为证据。
   * 它不产生新观测、不写台账、不影响判定；能进入台账的仍然只有
   * 提交那一刻的 answers 与 changedQuestionIds。
   */
  const assignExclusiveValue = useCallback(
    (questionId: string, value: string, siblingQuestionIds: string[]) => {
      updateState(key, (current) => {
        const word = value.trim();
        if (word === "") return current;
        // 与域层 `normalizeAnswerValue` 相同的比较口径：去空白 + 大小写折叠
        const sameWord = (candidate: string) =>
          candidate.trim().toLowerCase() === word.toLowerCase();

        const values = { ...current.values };
        const committed = { ...current.committed };
        /*
         * 用数组（而不是 Set）维护 changed：这是为了让**输出顺序与内容**
         * 与既有 `commitValue` 完全一致 —— 两处若用不同实现，
         * "改过答案"的数组在同等操作下会得出不同的排列，
         * 让测试与调试都变得不可预期。
         */
        let changed = [...current.changed];

        /** 用域层 `commitAnswer` 语义重算一题的 committed / changed。 */
        const applyCommit = (id: string, raw: string) => {
          const result = commitAnswer(committed[id] ?? null, raw, changed.includes(id));
          committed[id] = result.committed ?? "";
          changed = result.changed
            ? changed.includes(id)
              ? changed
              : [...changed, id]
            : changed.filter((candidate) => candidate !== id);
        };

        // 1 + 2) 清掉除当前空以外的所有持有者（自愈：可能有多个）
        for (const siblingId of siblingQuestionIds) {
          if (siblingId === questionId) continue;
          if (!sameWord(values[siblingId] ?? "")) continue;
          values[siblingId] = "";
          applyCommit(siblingId, "");
        }

        // 3) 当前空取得该词
        values[questionId] = word;
        applyCommit(questionId, word);

        // 4) marks / eliminated 未在此处触碰，因此原样保留
        return { ...current, values, committed, changed };
      });
    },
    [key],
  );

  const clearValue = useCallback(
    (questionId: string) => {
      commitValue(questionId, "");
    },
    [commitValue],
  );

  const toggleMark = useCallback(
    (questionId: string) => {
      updateState(key, (current) => {
        const marked = current.marks.includes(questionId);
        return {
          ...current,
          marks: marked
            ? current.marks.filter((id) => id !== questionId)
            : [...current.marks, questionId],
        };
      });
    },
    [key],
  );

  const toggleElimination = useCallback(
    (questionId: string, optionId: string) => {
      updateState(key, (current) => {
        const previous = current.eliminated[questionId] ?? [];
        const next = previous.includes(optionId)
          ? previous.filter((id) => id !== optionId)
          : [...previous, optionId];
        const eliminated = { ...current.eliminated };
        if (next.length === 0) delete eliminated[questionId];
        else eliminated[questionId] = next;
        /*
         * 关键约束：这里**只**改 eliminated。
         * values / committed / changed 一律不动 —— 排除一个选项不等于改答案，
         * 也不等于把已选答案取消（学习者可能先选了它、再划掉另两个）。
         */
        return { ...current, eliminated };
      });
    },
    [key],
  );

  const reset = useCallback(() => {
    writeState(key, EMPTY_STATE);
  }, [key]);

  const answeredIds = useMemo(
    () =>
      new Set(
        Object.entries(state.values)
          .filter(([, value]) => value.trim() !== "")
          .map(([id]) => id),
      ),
    [state.values],
  );

  const markedIds = useMemo(() => new Set(state.marks), [state.marks]);

  const isEliminated = useCallback(
    (questionId: string, optionId: string) =>
      (state.eliminated[questionId] ?? []).includes(optionId),
    [state.eliminated],
  );

  return {
    state,
    setValue,
    commitValue,
    assignExclusiveValue,
    clearValue,
    toggleMark,
    toggleElimination,
    reset,
    answeredCount: answeredIds.size,
    answeredIds,
    markedIds,
    isEliminated,
  };
}
