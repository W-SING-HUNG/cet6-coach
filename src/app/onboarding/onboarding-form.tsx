"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, MinuteChips } from "@/components/ui/field";
import { Notice } from "@/components/ui/states";
import { submitOnboardingAction } from "@/app/actions";
import { onboardingSchema, firstIssueMessage, type OnboardingFormValues } from "@/lib/validation";
import { DEFAULT_ONBOARDING } from "@/services/onboarding";
import type { ExamGoal, LearnerProfile } from "@/domain/models";
import { SKILL_LABELS, SKILL_WEIGHTS, type Skill } from "@/domain/types";
import { minutesLabel } from "@/lib/utils";

/**
 * Onboarding 表单。
 *
 * 默认值来自 DEFAULT_ONBOARDING（使用者 已知信息），已有记录时用记录覆盖。
 * 提交前做本地校验以获得即时反馈，服务端再做一次权威校验。
 */
export function OnboardingForm({
  existing,
  existingGoal,
  diagnosticMinutes,
  itemCount,
}: {
  existing: LearnerProfile | null;
  existingGoal: ExamGoal | null;
  diagnosticMinutes: number;
  itemCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [displayName, setDisplayName] = useState(existing?.displayName ?? DEFAULT_ONBOARDING.displayName);
  const [examName, setExamName] = useState(existingGoal?.examName ?? DEFAULT_ONBOARDING.examName);
  const [examDate, setExamDate] = useState(existingGoal?.examDate ?? DEFAULT_ONBOARDING.examDate);
  const [targetScore, setTargetScore] = useState(
    String(existingGoal?.targetScore ?? DEFAULT_ONBOARDING.targetScore),
  );
  const [weekday, setWeekday] = useState(
    existing?.preferences.weekdayMinutes ?? DEFAULT_ONBOARDING.weekdayMinutes,
  );
  const [weekend, setWeekend] = useState(
    existing?.preferences.weekendMinutes ?? DEFAULT_ONBOARDING.weekendMinutes,
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setServerError(null);
    setFieldErrors({});

    const values: OnboardingFormValues = {
      displayName,
      examName,
      examDate,
      targetScore,
      weekdayMinutes: weekday,
      weekendMinutes: weekend,
    };

    const parsed = onboardingSchema.safeParse(values);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      setServerError(firstIssueMessage(parsed.error));
      return;
    }

    startTransition(async () => {
      const result = await submitOnboardingAction(values);
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      // 完成 onboarding 后直接进入诊断 —— 没有画像的计划没有意义
      router.push("/diagnostic");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-7">
      {serverError ? (
        <Notice tone="danger" title="无法保存">
          {serverError}
        </Notice>
      ) : null}

      <section className="reveal reveal-1">
        <SectionLabel index="01" title="考试目标" />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="称呼" htmlFor="displayName" error={fieldErrors.displayName}>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
            />
          </Field>
          <Field label="考试名称" htmlFor="examName" error={fieldErrors.examName} hint="用于显示，不影响算法">
            <Input id="examName" value={examName} onChange={(e) => setExamName(e.target.value)} />
          </Field>
          <Field
            label="考试日期"
            htmlFor="examDate"
            error={fieldErrors.examDate}
            hint="所有节奏计算都以这一天为终点"
          >
            <Input
              id="examDate"
              type="date"
              value={examDate}
              onChange={(e) => setExamDate(e.target.value)}
            />
          </Field>
          <Field
            label="目标分数"
            htmlFor="targetScore"
            error={fieldErrors.targetScore}
            hint="CET-6 总分 710，550 属于中上水平"
          >
            <Input
              id="targetScore"
              type="number"
              inputMode="numeric"
              min={220}
              max={710}
              value={targetScore}
              onChange={(e) => setTargetScore(e.target.value)}
              className="tabular"
            />
          </Field>
        </div>
      </section>

      <section className="reveal reveal-2">
        <SectionLabel index="02" title="每周可投入时间" />
        <p className="mb-4 text-[13px] leading-relaxed text-content-soft">
          填「一般情况」就够了。某天只有 20 分钟或者完全没时间，都在 Today 页面随时调整。
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="工作日每天"
            suffix={minutesLabel(weekday)}
            error={fieldErrors.weekdayMinutes}
          >
            <MinuteChips value={weekday} onChange={setWeekday} />
          </Field>
          <Field label="周末每天" suffix={minutesLabel(weekend)} error={fieldErrors.weekendMinutes}>
            <MinuteChips value={weekend} onChange={setWeekend} />
          </Field>
        </div>
      </section>

      <section className="reveal reveal-3">
        <SectionLabel index="03" title="接下来的诊断" />
        <div className="rounded-md border border-edge bg-surface-raised px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Metric label="预计用时" value={`约 ${diagnosticMinutes} 分钟`} />
            <Metric label="题量" value={`${itemCount} 题`} />
          </div>
          <div className="mt-4">
            <p className="mb-2 text-[13px] font-medium text-content">诊断覆盖的能力维度</p>
            <ul className="space-y-1.5">
              {(Object.keys(SKILL_WEIGHTS) as Skill[]).map((skill) => (
                <li key={skill} className="flex items-baseline gap-2 text-[13px] text-content-soft">
                  <span className="tabular w-11 shrink-0 font-mono text-[12px] text-content-faint">
                    {Math.round(SKILL_WEIGHTS[skill] * 100)}%
                  </span>
                  <span className="font-medium text-content">{SKILL_LABELS[skill]}</span>
                  <span className="text-content-faint">卷面占比，训练权重的基础</span>
                </li>
              ))}
              <li className="flex items-baseline gap-2 text-[13px] text-content-soft">
                <span className="tabular w-11 shrink-0 font-mono text-[12px] text-content-faint">—</span>
                <span className="font-medium text-content">词汇</span>
                <span className="text-content-faint">无独立分值，但影响阅读、写作、翻译</span>
              </li>
            </ul>
          </div>
          <div className="mt-4 border-t border-edge pt-4">
            <Notice tone="info">
              这是一次短诊断，用来找出你的起始薄弱项并排出第一批训练任务。
              <strong className="font-medium text-content">它不预测你的 CET-6 分数。</strong>
              听力部分因暂无音频素材，只测音形对应能力，不代表完整听力水平；真实听力理解需要素材到位后才能评估。
            </Notice>
          </div>
        </div>
      </section>

      <div className="reveal reveal-4 flex flex-col gap-3 border-t border-edge pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-content-faint">
          {existing ? "已保存过设置，这里显示的是当前值。" : "保存后会直接进入诊断。"}
        </p>
        <Button
          type="submit"
          size="lg"
          loading={pending}
          loadingText="保存中…"
          icon={<ArrowRight className="size-4" />}
        >
          {existing ? "保存并进入诊断" : "开始诊断"}
        </Button>
      </div>
    </form>
  );
}

function SectionLabel({ index, title }: { index: string; title: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="font-mono text-[11px] tracking-[0.14em] text-content-faint">{index}</span>
      <h2 className="text-lg font-semibold tracking-tight text-content">{title}</h2>
      <span aria-hidden className="h-px flex-1 bg-edge" />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[12px] text-content-faint">{label}</span>
      <span className="text-[13px] font-medium text-content">{value}</span>
    </div>
  );
}

export { Check };
