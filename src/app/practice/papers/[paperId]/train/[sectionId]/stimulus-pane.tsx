"use client";

import { useEffect, useMemo, useRef } from "react";
import { Quote } from "lucide-react";
import { cn } from "@/lib/client-utils";
import type { ReadingTrainingSession, TrainingQuestionView } from "@/services/expert-training";

/**
 * 刺激材料栏（阅读原文 / 段落 / 词库）。
 *
 * ── 三条硬约束 ──
 *
 * 1. **原文一字不改。** 这里只做**位置标记**，不做任何改写、重排或补写。
 *    选词填空的空位是靠解析原文里本来就存在的 `[n]` 占位符得到的
 *    （见 `PaperGroup.passage` 的模型说明）—— 而不是我们往文章里插字。
 *    任何"让它读起来更顺"的改写都会破坏内容保真（由源保真门禁固定）。
 *
 * 2. **不显示答案、不做标注推断。** 材料栏里没有正确段落标记、没有
 *    "答案线索"，因为那些都会把一次测评变成阅读理解练习。
 *
 * 3. **滚动位置按材料保留。** CET-6 仔细阅读是"一篇文章 + 若干题"，
 *    长篇阅读是"一篇长文 + 10 条陈述"。学习者在同一篇材料里翻题时，
 *    滚动位置必须留住 —— 否则每翻一题都要重新找回刚才读到的位置。
 *    实现方式：只在材料**真的换了一组**时切换，并记录/恢复每组的滚动位置。
 */

export function StimulusPane({
  session,
  activeQuestion,
}: {
  session: ReadingTrainingSession;
  activeQuestion: TrainingQuestionView | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const positions = useRef<Map<string, number>>(new Map());

  /** 当前题所属的材料组；找不到时退回第一组。 */
  const activeGroup = useMemo(() => {
    if (!activeQuestion) return session.groups[0] ?? null;
    return (
      session.groups.find((group) =>
        group.questions.some((question) => question.id === activeQuestion.id),
      ) ??
      session.groups[0] ??
      null
    );
  }, [session.groups, activeQuestion]);

  const activeGroupId = activeGroup?.id ?? "";

  // 切换材料组时：先存旧位置，再恢复新位置
  const previousGroupId = useRef(activeGroupId);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (previousGroupId.current !== activeGroupId) {
      positions.current.set(previousGroupId.current, container.scrollTop);
      const restored = positions.current.get(activeGroupId) ?? 0;
      container.scrollTop = restored;
      previousGroupId.current = activeGroupId;
    }
  }, [activeGroupId]);

  if (!activeGroup) {
    return <p className="text-[13px] text-content-faint">这一部分没有材料。</p>;
  }

  const groupIndex = session.groups.findIndex((group) => group.id === activeGroup.id);
  const hasMaterial = Boolean(
    activeGroup.passage || activeGroup.paragraphs || activeGroup.wordBank,
  );

  return (
    <div ref={scrollRef} className="min-w-0">
      <MaterialHeading
        group={activeGroup}
        groupIndex={groupIndex}
        groupCount={session.groups.length}
      />

      {!hasMaterial ? (
        <p className="mt-4 text-[13px] leading-relaxed text-content-faint">
          这一组材料在内容包中为空。这不是界面问题 —— 题面本身仍然可以作答。
        </p>
      ) : null}

      {activeGroup.passage ? (
        <ClozePassage
          passage={activeGroup.passage}
          /* 选词填空：高亮"当前正在做的那一空"，让原文里的空位与本栏对得上 */
          activeBlankId={
            activeQuestion?.kind === "banked_cloze_blank" ? activeQuestion.blankId : null
          }
        />
      ) : null}

      {activeGroup.paragraphs ? <LabeledParagraphs paragraphs={activeGroup.paragraphs} /> : null}
    </div>
  );
}

/** 材料组标题：只在有多组时才提"第几篇"，避免单篇也加一层无意义标签。 */
function MaterialHeading({
  group,
  groupIndex,
  groupCount,
}: {
  group: ReadingTrainingSession["groups"][number];
  groupIndex: number;
  groupCount: number;
}) {
  return (
    <div className="mb-4 border-b border-edge pb-3">
      <p className="flex items-center gap-2 text-[12px] font-medium text-content-faint">
        <Quote className="size-3.5 shrink-0" />
        {groupCount > 1 ? `材料 ${groupIndex + 1} / ${groupCount}` : "阅读材料"}
        {group.firstNumber !== null ? (
          <span className="tabular font-normal">· 对应第 {group.firstNumber} 题起</span>
        ) : null}
      </p>
      {/*
        题组说明优先用真题自带的操作指令；没有时给出产品级说明。
        两者都只陈述"该怎么做"，不做任何内容改写。
      */}
      <p className="mt-2 text-[12.5px] leading-relaxed text-content-soft">
        {group.instructions ?? "按真题原样作答。下文的材料与题目都来自这份试卷本身，未做任何改写。"}
      </p>
    </div>
  );
}

/**
 * 选词填空原文。
 *
 * 把原文里本来就有的 `[n]` 占位符渲染成可见的空位标记。
 * **这不是改写**：文本的每一个字符都原样保留，只是把 `[n]`
 * 这个标记从纯文本升格为可辨识的界面元素 ——
 * 否则学习者在一大段文字里根本找不到第 7 空在哪里。
 */
function ClozePassage({
  passage,
  activeBlankId,
}: {
  passage: string;
  activeBlankId: string | null;
}) {
  const parts = useMemo(() => {
    // 只按 [数字] 切分。其余内容原样保留在 parts 里。
    const segments: Array<{ type: "text" | "blank"; value: string }> = [];
    const pattern = /\[(\d+)\]/g;
    let lastIndex = 0;
    let match = pattern.exec(passage);

    while (match !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: "text", value: passage.slice(lastIndex, match.index) });
      }
      segments.push({ type: "blank", value: match[1] });
      lastIndex = match.index + match[0].length;
      match = pattern.exec(passage);
    }
    if (lastIndex < passage.length) {
      segments.push({ type: "text", value: passage.slice(lastIndex) });
    }
    return segments;
  }, [passage]);

  return (
    <div className="prose-reading whitespace-pre-line text-content">
      {parts.map((part, index) =>
        part.type === "text" ? (
          <span key={index}>{part.value}</span>
        ) : (
          <span
            key={index}
            data-blank={part.value}
            className={cn(
              "tabular mx-0.5 inline-flex min-w-8 items-center justify-center rounded-sm border px-1.5 py-0.5 align-baseline font-sans text-[12px] font-semibold not-italic",
              part.value === activeBlankId
                ? "border-accent bg-accent text-surface-raised"
                : "border-edge-strong bg-surface-sunken text-content-soft",
            )}
          >
            {part.value}
          </span>
        ),
      )}
    </div>
  );
}

/**
 * 长篇阅读的带标号段落。
 *
 * 标号做成**左侧粘性标签**：长篇阅读是 10 条陈述配 A–O 共 15 段，
 * 学习者会反复"读一句陈述 → 回来找段落"。标号必须始终看得见，
 * 否则滚到段落中间就不知道这是哪一段了。
 */
function LabeledParagraphs({
  paragraphs,
}: {
  paragraphs: { label: string; text: string }[];
}) {
  return (
    <ol className="flex flex-col gap-4">
      {paragraphs.map((paragraph) => (
        <li key={paragraph.label} id={`para-${paragraph.label}`} className="flex gap-3 scroll-mt-4">
          <span
            aria-hidden
            className="tabular sticky top-0 h-fit shrink-0 rounded-sm border border-edge-strong bg-surface-sunken px-2 py-0.5 text-[12px] font-semibold text-content-soft"
          >
            {paragraph.label}
          </span>
          <p className="prose-reading min-w-0 text-[15px] text-content">
            <span className="sr-only">段落 {paragraph.label}：</span>
            {paragraph.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
