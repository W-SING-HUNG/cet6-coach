"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Send, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { Notice, PendingState } from "@/components/ui/states";
import { startDiagnosticAction, submitDiagnosticAction } from "@/app/actions";
import { DIMENSION_LABELS, type DiagnosticDimension } from "@/domain/types";
import { cn } from "@/lib/utils";
import type { DiagnosticAnswerInput } from "@/types/actions";

/**
 * 诊断执行器。
 *
 * 交互决策：一次一题（减少认知负担），但允许回看修改。
 * 状态覆盖：loading（开始）、submitting（提交）、error（可重试）、disabled（未作答时提交按钮不可用，但可跳过）。
 */

interface RunnerItem {
  id: string;
  dimension: DiagnosticDimension;
  type: "mcq" | "short_text" | "pending_media";
  difficulty: number;
  prompt: string;
  passage: string | null;
  choices: { id: string; label: string }[] | null;
  pendingReason: string | null;
  estimatedSeconds: number;
}

type AnswerState = Record<string, { choiceId: string | null; text: string; skipped: boolean }>;

export function DiagnosticRunner({ items }: { items: RunnerItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [phase, setPhase] = useState<"idle" | "starting" | "submitting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerState>({});

  const current = items[index];
  const answer = answers[current?.id ?? ""] ?? { choiceId: null, text: "", skipped: false };
  const isLast = index === items.length - 1;

  const answeredCount = useMemo(
    () => Object.values(answers).filter((a) => a.choiceId || a.text.trim() || a.skipped).length,
    [answers],
  );

  function update(next: Partial<{ choiceId: string | null; text: string; skipped: boolean }>) {
    setAnswers((prev) => ({
      ...prev,
      [current.id]: { ...answer, ...next },
    }));
  }

  function go(delta: number) {
    setError(null);
    setIndex((i) => Math.min(items.length - 1, Math.max(0, i + delta)));
  }

  function handleSubmit() {
    setError(null);
    setPhase("starting");

    startTransition(async () => {
      const started = await startDiagnosticAction();
      if (!started.ok) {
        setError(started.error);
        setPhase("idle");
        return;
      }

      setPhase("submitting");
      const payload: DiagnosticAnswerInput[] = items.map((item) => {
        const stored = answers[item.id];
        return {
          itemId: item.id,
          dimension: item.dimension,
          choiceId: stored?.choiceId ?? null,
          text: stored?.text?.trim() ? stored.text : null,
          skipped: stored?.skipped ?? !(stored?.choiceId || stored?.text?.trim()),
        };
      });

      const result = await submitDiagnosticAction({ sessionId: started.data.sessionId, answers: payload });
      if (!result.ok) {
        setError(result.error);
        setPhase("idle");
        return;
      }
      router.push("/diagnostic/result");
    });
  }

  const busy = phase !== "idle";
  const canSubmit = answeredCount > 0;

  return (
    <div className="flex flex-col gap-5">
      <ProgressHeader index={index} total={items.length} answered={answeredCount} dimension={current.dimension} />

      {error ? (
        <Notice tone="danger" title="提交失败">
          {error}
        </Notice>
      ) : null}

      {current.type === "pending_media" ? (
        <PendingState
          title={current.prompt}
          reason={current.pendingReason ?? "本题需要音频素材，Phase 1 尚未内置。"}
          required={[
            "该项目不参与计分，只用于验证 pending 状态链路",
            "听力维度的分数由其余可计分题目得出，置信度会相应降低",
          ]}
        />
      ) : (
        <div className="rounded-md border border-edge bg-surface-raised px-4 py-5 sm:px-6 sm:py-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="rounded-sm border border-edge-strong px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-content-faint">
              {DIMENSION_LABELS[current.dimension]}
            </span>
            <span className="font-mono text-[10px] text-content-faint">
              难度 {"●".repeat(current.difficulty)}
              {"○".repeat(3 - current.difficulty)}
            </span>
            {current.estimatedSeconds > 0 ? (
              <span className="ml-auto font-mono text-[10px] text-content-faint">建议 {current.estimatedSeconds}s</span>
            ) : null}
          </div>

          {current.passage ? (
            <div className="mb-4 rounded-sm border border-edge bg-surface px-4 py-3.5">
              <p className="prose-reading whitespace-pre-line text-content">{current.passage}</p>
            </div>
          ) : null}

          <p className="mb-4 text-[17px] leading-relaxed text-content">{current.prompt}</p>

          {current.type === "mcq" && current.choices ? (
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend className="sr-only">选择一个答案</legend>
              {current.choices.map((choice) => {
                const selected = answer.choiceId === choice.id;
                return (
                  <label
                    key={choice.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-sm border px-3.5 py-2.5 text-[14px] transition-colors",
                      selected
                        ? "border-accent bg-accent-soft text-content"
                        : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:text-content",
                      busy && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name={`q-${current.id}`}
                      value={choice.id}
                      checked={selected}
                      onChange={() => update({ choiceId: choice.id, skipped: false })}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[11px]",
                        selected ? "border-accent bg-accent text-surface-raised" : "border-edge-strong text-content-faint",
                      )}
                    >
                      {selected ? <Check className="size-3" strokeWidth={3} /> : choice.id.toUpperCase()}
                    </span>
                    <span>{choice.label}</span>
                  </label>
                );
              })}
            </fieldset>
          ) : (
            <div className="flex flex-col gap-2">
              <Textarea
                rows={current.dimension === "writing" ? 8 : 4}
                value={answer.text}
                disabled={busy}
                onChange={(e) => update({ text: e.target.value, skipped: false })}
                placeholder={
                  current.dimension === "writing"
                    ? "用英文作答。不计字数也算分，但过短会影响评分。"
                    : "写出你的英文译文。"
                }
              />
              <CharCount text={answer.text} dimension={current.dimension} />
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => update({ choiceId: null, text: "", skipped: true })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[12px] transition-colors",
                answer.skipped
                  ? "border-warn/40 bg-warn-soft text-warn"
                  : "border-edge-strong text-content-faint hover:border-content-faint hover:text-content-soft",
                busy && "cursor-not-allowed opacity-60",
              )}
            >
              <SkipForward className="size-3.5" />
              {answer.skipped ? "已标记跳过" : "跳过这题"}
            </button>
            {answer.skipped ? (
              <span className="text-[12px] text-content-faint">跳过会降低该维度的置信度，不会被记为答错。</span>
            ) : null}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => go(-1)} disabled={index === 0 || busy} icon={<ArrowLeft className="size-4" />}>
          上一题
        </Button>

        <div className="flex items-center gap-2">
          {!isLast ? (
            <Button variant="secondary" onClick={() => go(1)} disabled={busy}>
              下一题
              <ArrowRight className="size-4" />
            </Button>
          ) : null}
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={pending && busy}
            loadingText={phase === "starting" ? "创建会话…" : "评分中…"}
            icon={<Send className="size-4" />}
          >
            {isLast ? "提交诊断" : "提交诊断"}
          </Button>
        </div>
      </div>

      {!canSubmit ? (
        <p className="text-center text-[13px] text-content-faint">
          至少作答一题才能提交。全部跳过不会产生任何结论。
        </p>
      ) : null}
    </div>
  );
}

function ProgressHeader({
  index,
  total,
  answered,
  dimension,
}: {
  index: number;
  total: number;
  answered: number;
  dimension: DiagnosticDimension;
}) {
  const progress = (index + 1) / total;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-[12px]">
        <span className="font-mono text-content-faint">
          第 {index + 1} / {total} 题 · {DIMENSION_LABELS[dimension]}
        </span>
        <span className="tabular text-content-faint">已作答 {answered}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              "h-0.5 flex-1 rounded-full",
              i < index ? "bg-accent/55" : i === index ? "bg-accent" : "bg-edge",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function CharCount({ text, dimension }: { text: string; dimension: DiagnosticDimension }) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const target = dimension === "writing" ? "目标 60-90 词" : null;
  return (
    <p className="text-[12px] text-content-faint">
      <span className="tabular">{words}</span> 词
      {target ? <span className="ml-2">{target}</span> : null}
    </p>
  );
}
