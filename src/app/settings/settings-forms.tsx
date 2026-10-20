"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, MinuteChips } from "@/components/ui/field";
import { Notice } from "@/components/ui/states";
import { updateGoalAction, updatePreferencesAction } from "@/app/actions";
import { settingsGoalSchema, settingsPreferencesSchema } from "@/lib/validation";
import { minutesLabel } from "@/lib/client-utils";
import type { ExamGoal, LearnerProfile } from "@/domain/models";

/**
 * Settings 表单。
 *
 * 两组设置分开保存：改考试目标不该顺带重置学习时间。
 * 每组都有独立的 loading / success / error 状态。
 */
export function SettingsForms({
  profile,
  goal,
  defaults,
}: {
  profile: LearnerProfile;
  goal: ExamGoal | null;
  defaults: {
    examName: string;
    examDate: string;
    targetScore: number;
    weekdayMinutes: number;
    weekendMinutes: number;
  };
}) {
  return (
    <div className="flex flex-col gap-8">
      <GoalForm profile={profile} goal={goal} defaults={defaults} />
      <PreferencesForm profile={profile} />
    </div>
  );
}

function GoalForm({
  goal,
  defaults,
}: {
  profile: LearnerProfile;
  goal: ExamGoal | null;
  defaults: { examName: string; examDate: string; targetScore: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "ok" | "err"; message: string } | null>(null);

  const [examName, setExamName] = useState(goal?.examName ?? defaults.examName);
  const [examDate, setExamDate] = useState(goal?.examDate ?? defaults.examDate);
  const [targetScore, setTargetScore] = useState(String(goal?.targetScore ?? defaults.targetScore));

  const dirty =
    examName !== (goal?.examName ?? defaults.examName) ||
    examDate !== (goal?.examDate ?? defaults.examDate) ||
    Number(targetScore) !== (goal?.targetScore ?? defaults.targetScore);

  function submit() {
    setStatus(null);
    const parsed = settingsGoalSchema.safeParse({ examName, examDate, targetScore });
    if (!parsed.success) {
      setStatus({ type: "err", message: parsed.error.issues[0]?.message ?? "输入无效" });
      return;
    }
    startTransition(async () => {
      const result = await updateGoalAction(parsed.data);
      if (!result.ok) {
        setStatus({ type: "err", message: result.error });
        return;
      }
      setStatus({ type: "ok", message: "考试目标已保存，今日计划已按新目标重建。" });
      router.refresh();
    });
  }

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-3 text-[15px] font-semibold tracking-tight text-content">
        考试目标
        <span aria-hidden className="h-px flex-1 bg-edge" />
      </h2>
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="考试名称">
          <Input value={examName} onChange={(e) => setExamName(e.target.value)} />
        </Field>
        <Field label="考试日期" hint="所有节奏以此为终点">
          <Input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} />
        </Field>
        <Field label="目标分数" hint="220 - 710">
          <Input
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

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          onClick={submit}
          loading={pending}
          loadingText="保存中…"
          disabled={!dirty}
          icon={<Save className="size-4" />}
        >
          保存目标
        </Button>
        {!dirty ? <span className="text-[12px] text-content-faint">没有修改</span> : null}
        {status ? (
          <span className={status.type === "ok" ? "text-[12px] text-accent" : "text-[12px] text-danger"}>
            {status.message}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function PreferencesForm({ profile }: { profile: LearnerProfile }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "ok" | "err"; message: string } | null>(null);

  const [weekday, setWeekday] = useState(profile.preferences.weekdayMinutes);
  const [weekend, setWeekend] = useState(profile.preferences.weekendMinutes);

  const dirty =
    weekday !== profile.preferences.weekdayMinutes || weekend !== profile.preferences.weekendMinutes;

  function submit() {
    setStatus(null);
    const parsed = settingsPreferencesSchema.safeParse({ weekdayMinutes: weekday, weekendMinutes: weekend });
    if (!parsed.success) {
      setStatus({ type: "err", message: parsed.error.issues[0]?.message ?? "输入无效" });
      return;
    }
    startTransition(async () => {
      const result = await updatePreferencesAction(parsed.data);
      if (!result.ok) {
        setStatus({ type: "err", message: result.error });
        return;
      }
      setStatus({ type: "ok", message: "常规时间已保存，今日计划已重建。" });
      router.refresh();
    });
  }

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-3 text-[15px] font-semibold tracking-tight text-content">
        常规可投入时间
        <span aria-hidden className="h-px flex-1 bg-edge" />
      </h2>
      <p className="mb-4 text-[13px] leading-relaxed text-content-soft">
        这是默认值，用来决定「今天应该排多少任务」。某天时间不同时，在 Today 页面直接调整即可，
        不会影响这里的常规设置。
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="工作日每天" suffix={minutesLabel(weekday)}>
          <MinuteChips value={weekday} onChange={setWeekday} />
        </Field>
        <Field label="周末每天" suffix={minutesLabel(weekend)}>
          <MinuteChips value={weekend} onChange={setWeekend} />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          onClick={submit}
          loading={pending}
          loadingText="保存中…"
          disabled={!dirty}
          icon={<Save className="size-4" />}
        >
          保存时间
        </Button>
        {!dirty ? <span className="text-[12px] text-content-faint">没有修改</span> : null}
        {status ? (
          <span className={status.type === "ok" ? "text-[12px] text-accent" : "text-[12px] text-danger"}>
            {status.message}
          </span>
        ) : null}
      </div>

      <Notice tone="info" className="mt-4">
        Weekday 默认 {profile.preferences.weekdayMinutes} 分钟，weekend 默认{" "}
        {profile.preferences.weekendMinutes} 分钟。低于 20 分钟会自动进入短日模式，只保留核心任务。
      </Notice>
    </section>
  );
}
