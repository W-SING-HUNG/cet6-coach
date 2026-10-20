"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, Clock, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { Notice, PendingState } from "@/components/ui/states";
import { submitTaskAction } from "@/app/actions";
import { SKILL_LABELS, type Skill, type TaskPriority } from "@/domain/types";
import type { SubmissionFeedback } from "@/services/practice";
import { cn, minutesLabel } from "@/lib/client-utils";
import type { ContentView } from "./content-view";

/**
 * 任务执行器。
 *
 * 这是产品闭环的落地点：开始 → 作答 → 提交 → 反馈 → 落库 → Today 更新。
 * 状态机刻意显式化，确保每个状态都有可见反馈：
 *   idle → answering → submitting → done | error
 */

type Phase = "answering" | "submitting" | "done" | "error";

/**
 * 任务宽度由**任务类型**决定，不是一个全局常量。
 *
 * ── 为什么这里需要一个判据，而不是统一改宽或统一留窄 ──
 *
 * 旧实现给整个执行器写死 `mx-auto max-w-2xl`。那对写作与翻译是**正确**的
 * （窄栏是长文写作的工效选择，见对被否决替代方案的说明），
 * 但它同时意味着：只要有任何"篇章型"任务落到这里，就会被压成一条窄长文。
 *
 * 本次收敛把阅读训练整体移出了这个执行器（它现在走 Expert Training 的
 * 分栏工作面），因此剩下的三种任务在宽度上其实各有所需：
 *
 * - `writing_drill` / `translation_drill`：长文本**输入**。窄栏更好：一行太长
 *   会让眼睛在换行时丢失行首，而这是写作类表单的公认工效问题。
 * - `review`：一串待勾选条目，每条可能带来源与到期信息。中等宽度足够，
 *   且比窄栏更容易扫读。
 * - 其余（词汇等）：维持窄栏。
 *
 * 判据始终是"这个任务的宽度需求是什么"，不是"窄的看起来不现代"。
 * 值得注意的是：这里**没有任何篇章型任务**，因此不存在"少见的漏网"。
 */
function widthClassFor(kind: string): string {
  switch (kind) {
    case "writing_drill":
    case "translation_drill":
      return "mx-auto max-w-2xl";
    case "review":
      return "mx-auto max-w-3xl";
    default:
      return "mx-auto max-w-2xl";
  }
}

interface TaskProp {
  id: string;
  title: string;
  kind: string;
  skill: Skill;
  priority: TaskPriority;
  rationale: string;
  estimatedMinutes: number;
  status: string;
}

interface DueItem {
  id: string;
  prompt: string;
  skill: Skill;
  dueOn: string;
}

export function TaskRunner({
  task,
  content,
  unavailableReason,
  dueItems,
}: {
  task: TaskProp;
  content: ContentView;
  unavailableReason: string | null;
  dueItems: DueItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [phase, setPhase] = useState<Phase>("answering");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SubmissionFeedback | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  // 计时起点。用 null 初始化，真实时间只在 effect 里读 ——
  // render 期间调用 Date.now() 会让渲染结果不可预测（React 纯度规则）。
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (startRef.current === null) startRef.current = Date.now();
  }, []);

  const alreadyDone = task.status === "completed";
  const blocked = unavailableReason !== null || content.kind === "listening_pending" || content.kind === "unsupported";
  const width = widthClassFor(task.kind);

  const answeredCount = useMemo(() => {
    if (content.kind === "vocabulary") {
      return Object.keys(choices).length;
    }
    if (content.kind === "review") return reviewed.size;
    return text.trim().length > 0 ? 1 : 0;
  }, [choices, reviewed, text, content.kind]);

  const requiredCount = useMemo(() => {
    if (content.kind === "vocabulary") return content.entries.length;
    if (content.kind === "review") return Math.max(dueItems.length, 1);
    return 1;
  }, [content, dueItems.length]);

  const canSubmit = !blocked && answeredCount > 0 && phase === "answering";

  function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setPhase("submitting");

    const startedAt = startRef.current ?? Date.now();
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 60000));

    startTransition(async () => {
      const result = await submitTaskAction({
        taskId: task.id,
        answers: Object.entries(choices).map(([questionId, choiceId]) => ({ questionId, choiceId })),
        writing: text,
        reviewedItemIds: [...reviewed],
        elapsedMinutes: elapsed,
      });

      if (!result.ok) {
        setError(result.error);
        setPhase("error");
        return;
      }
      setFeedback(result.data);
      setPhase("done");
      // Today 状态需要真实反映这次完成，因此拉取最新服务端数据
      router.refresh();
    });
  }

  if (alreadyDone && phase !== "done") {
    return (
      <div className={width}>
        <TaskHeader task={task} />
        <Notice tone="success" className="mt-5" title="这个任务已经完成了">
          完成记录已保存。重复提交不会产生新的训练记录，避免刷数据影响能力估计。
        </Notice>
        <div className="mt-5 flex gap-2">
          <Link href="/today">
            <Button icon={<ArrowRight className="size-4" />}>返回 Today</Button>
          </Link>
          <Link href="/progress">
            <Button variant="secondary">查看进度</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "done" && feedback) {
    return (
      <div className={width}>
        <TaskHeader task={task} />
        <FeedbackView feedback={feedback} onBack={() => router.push("/today")} />
      </div>
    );
  }

  return (
    <div className={width}>
      <TaskHeader task={task} />

      {blocked ? (
        content.kind === "listening_pending" ? (
          <PendingState
            className="mt-5"
            title={`${content.title}：音频素材待补`}
            reason={content.reason}
            required={content.required}
          />
        ) : (
          <Notice tone="warn" className="mt-5" title="这个任务当前无法执行">
            {unavailableReason ?? (content.kind === "unsupported" ? content.reason : "内容不可用。")}
          </Notice>
        )
      ) : (
        <div className="mt-5">
          {/*
            这里**刻意没有阅读分支**。
            面向学习者的阅读训练只走真实真题的 Expert Training 工作面，
            而它由 `page.tsx` 在渲染之前就分流掉了（重定向或诚实不可用）。
            因此合成阅读篇章在原理上不可能从这个路由下发到浏览器 ——
            这是路由层的保证，不是"记得别渲染"的约定。
          */}
          {content.kind === "vocabulary" ? (
            <VocabularyBody content={content} choices={choices} onChoose={(q, c) => setChoices((p) => ({ ...p, [q]: c }))} disabled={phase !== "answering"} />
          ) : null}
          {content.kind === "translation" ? (
            <TextBody source={content.sourceText} value={text} onChange={setText} disabled={phase !== "answering"} placeholder="写出你的英文译文…" rows={5} label="中文原文" />
          ) : null}
          {content.kind === "writing" ? (
            <TextBody
              source={content.prompt}
              value={text}
              onChange={setText}
              disabled={phase !== "answering"}
              placeholder="用英文作答"
              rows={10}
              label="题目"
              wordTarget={`${content.minWords}-${content.maxWords} 词`}
            />
          ) : null}
          {content.kind === "review" ? (
            <ReviewBody items={dueItems} reviewed={reviewed} onToggle={(id) =>
              setReviewed((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            } disabled={phase !== "answering"} />
          ) : null}

          {error ? (
            <Notice tone="danger" className="mt-4" title="提交失败">
              {error}
              <span className="mt-1 block text-[12px]">你的作答还在这页上，修好问题后可以直接重试。</span>
            </Notice>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
            <p className="text-[13px] text-content-faint">
              已作答 <span className="tabular text-content-soft">{answeredCount}</span> / {requiredCount}
              {content.kind === "review" && dueItems.length === 0 ? "（队列为空）" : ""}
            </p>
            <div className="flex gap-2">
              <Link href="/today">
                <Button variant="secondary" disabled={phase === "submitting"}>
                  稍后再做
                </Button>
              </Link>
              <Button
                onClick={handleSubmit}
                disabled={!canSubmit}
                loading={pending && phase === "submitting"}
                loadingText="评分中…"
                icon={<CheckCircle2 className="size-4" />}
              >
                提交作答
              </Button>
            </div>
          </div>

          {phase === "error" ? (
            <div className="mt-3">
              <Button variant="secondary" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => setPhase("answering")}>
                返回修改
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskHeader({ task }: { task: TaskProp }) {
  return (
    <header className="border-b border-edge pb-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-content-faint">
          {SKILL_LABELS[task.skill]}
        </span>
        <span className="rounded-sm border border-edge-strong px-1.5 py-px font-mono text-[10px] text-content-faint">
          {task.priority === "core" ? "核心" : task.priority === "recommended" ? "推荐" : "可选"}
        </span>
        <span className="flex items-center gap-1 font-mono text-[10px] text-content-faint">
          <Clock className="size-3" />
          {minutesLabel(task.estimatedMinutes)}
        </span>
      </div>
      <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-content sm:text-[28px]">
        {task.title}
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-content-soft">{task.rationale}</p>
    </header>
  );
}

function VocabularyBody({
  content,
  choices,
  onChoose,
  disabled,
}: {
  content: Extract<ContentView, { kind: "vocabulary" }>;
  choices: Record<string, string>;
  onChoose: (questionId: string, choiceId: string) => void;
  disabled: boolean;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {content.entries.map((entry, index) => (
        <li key={entry.id} className="rounded-md border border-edge bg-surface-raised px-4 py-4">
          <div className="mb-2 flex items-baseline gap-2.5">
            <span className="tabular font-mono text-[12px] text-content-faint">{index + 1}.</span>
            <span className="font-mono text-[12px] text-content-faint">{entry.phonetic}</span>
          </div>
          <p className="prose-reading mb-3 text-[15px] text-content">{entry.sentence}</p>
          <fieldset className="grid gap-1.5 sm:grid-cols-2" disabled={disabled}>
            <legend className="sr-only">选择正确的词</legend>
            {entry.choices.map((choice) => {
              const selected = choices[entry.id] === choice.id;
              return (
                <label
                  key={choice.id}
                  className={cn(
                    "cursor-pointer rounded-sm border px-3 py-2 text-[13px] transition-colors",
                    selected
                      ? "border-accent bg-accent-soft text-content"
                      : "border-edge text-content-soft hover:border-content-faint hover:text-content",
                    disabled && "cursor-not-allowed opacity-70",
                  )}
                >
                  <input
                    type="radio"
                    name={`v-${entry.id}`}
                    checked={selected}
                    onChange={() => onChoose(entry.id, choice.id)}
                    className="sr-only"
                  />
                  {choice.label}
                </label>
              );
            })}
          </fieldset>
        </li>
      ))}
    </ol>
  );
}

function TextBody({
  source,
  value,
  onChange,
  disabled,
  placeholder,
  rows,
  label,
  wordTarget,
}: {
  source: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder: string;
  rows: number;
  label: string;
  wordTarget?: string;
}) {
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-edge bg-surface-raised px-4 py-3.5">
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-content-faint">{label}</p>
        <p className="prose-reading whitespace-pre-line text-content">{source}</p>
      </div>
      <div>
        <Textarea
          rows={rows}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <p className="mt-1.5 text-[12px] text-content-faint">
          <span className="tabular">{words}</span> 词
          {wordTarget ? <span className="ml-2">目标 {wordTarget}</span> : null}
        </p>
      </div>
    </div>
  );
}

function ReviewBody({
  items,
  reviewed,
  onToggle,
  disabled,
}: {
  items: DueItem[];
  reviewed: Set<string>;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  if (items.length === 0) {
    return (
      <Notice tone="info" title="复习队列当前为空">
        没有任何内容进入遗忘窗口。这是一个正常状态 —— 等你做错题之后，复习项会自动出现。
        本次任务会直接记为完成。
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-content-soft">
        下面这些内容之前出过错。回顾一遍，确认记住了就勾选。
        没有勾选的项目会留在队列里，明天继续出现。
      </p>
      <ul className="overflow-hidden rounded-md border border-edge bg-surface-raised">
        {items.map((item, index) => {
          const checked = reviewed.has(item.id);
          return (
            <li
              key={item.id}
              className={cn("px-4 py-3", index !== items.length - 1 && "border-b border-edge", checked && "bg-accent-soft/50")}
            >
              <label className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-70")}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(item.id)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-content">{item.prompt}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-content-faint">
                    {item.skill} · 到期 {item.dueOn}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FeedbackView({ feedback, onBack }: { feedback: SubmissionFeedback; onBack: () => void }) {
  const passed = feedback.score >= 0.6;
  return (
    <div className="mt-5 flex flex-col gap-4">
      <div
        className={cn(
          "rounded-md border px-4 py-4",
          passed ? "border-succ/25 bg-accent-soft" : "border-warn/25 bg-warn-soft",
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className={cn("text-[17px] font-semibold", passed ? "text-accent" : "text-warn")}>
            {passed ? "完成得不错" : "已经记录，继续加强"}
          </p>
          <p className={cn("tabular text-2xl font-semibold", passed ? "text-accent" : "text-warn")}>
            {Math.round(feedback.score * 100)}
          </p>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-content-soft">
          正确 {feedback.correctCount} / {feedback.totalCount} · 用时约 {feedback.durationMinutes} 分钟
        </p>
      </div>

      <div className="rounded-md border border-edge bg-surface-raised px-4 py-4">
        <p className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-medium text-content">
          反馈
          <span
            className={cn(
              "rounded-sm border px-1.5 py-px font-mono text-[10px]",
              feedback.gradedBy === "ai"
                ? "border-accent/30 bg-accent-soft text-accent"
                : "border-edge-strong text-content-faint",
            )}
          >
            {feedback.gradedBy === "ai" ? "AI 批改" : "本地规则评分"}
          </span>
        </p>
        <p className="whitespace-pre-line text-[13px] leading-relaxed text-content-soft">{feedback.summary}</p>
        {feedback.disclaimer ? (
          <p className="mt-3 rounded-sm border border-edge bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed text-content-faint">
            {feedback.disclaimer}
          </p>
        ) : null}
      </div>

      {feedback.details.length > 0 ? (
        <div className="rounded-md border border-edge bg-surface-raised">
          <p className="border-b border-edge px-4 py-2.5 text-[13px] font-medium text-content">逐题结果</p>
          <ul>
            {feedback.details.map((detail, index) => (
              <li
                key={`${detail.questionId}-${index}`}
                className={cn("px-4 py-3", index !== feedback.details.length - 1 && "border-b border-edge")}
              >
                <div className="flex items-start gap-2.5">
                  {detail.correct ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-succ" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-relaxed text-content">{detail.prompt}</p>
                    {!detail.correct ? (
                      <p className="mt-1.5 text-[12px] leading-relaxed text-content-soft">
                        <span className="font-medium text-content">正确答案：</span>
                        {detail.correctAnswer}
                      </p>
                    ) : null}
                    {detail.explanation ? (
                      <p className="mt-1 text-[12px] leading-relaxed text-content-faint">{detail.explanation}</p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {feedback.errorTags.length > 0 || feedback.newWeaknesses.length > 0 ? (
        <Notice tone="info" title="已记录到能力画像">
          <ul className="mt-1 space-y-1">
            {feedback.errorTags.length > 0 ? (
              <li>
                错因标签：{feedback.errorTags.slice(0, 5).join("、")}
                {feedback.reviewItemsCreated > 0 ? ` · ${feedback.reviewItemsCreated} 项加入复习队列` : ""}
              </li>
            ) : null}
            {feedback.newWeaknesses.length > 0 ? (
              <li>新识别弱点：{feedback.newWeaknesses.join("、")}（后续计划会提高该模块占比）</li>
            ) : null}
          </ul>
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-edge pt-4">
        <Button onClick={onBack} icon={<ArrowRight className="size-4" />}>
          返回 Today
        </Button>
        <Link href="/progress">
          <Button variant="secondary">查看进度</Button>
        </Link>
      </div>
    </div>
  );
}
