#!/usr/bin/env node
/**
 * 通过 service 层完成今天第一个可执行任务。
 *
 * 用途：验证"完成任务后 Today 页面内容真实变化"。
 * 该脚本与 Server Action 调用完全相同的 submitTask，因此执行结果与真实提交一致。
 */

import { getRepositories } from "@/repositories/sqlite";
import { getTaskDetail, submitTask } from "@/services/practice";
import { ensurePlan } from "@/services/plan";
import { todayISO } from "@/lib/date";

const repos = getRepositories();
const profile = repos.learner.getProfile();
if (!profile) {
  console.error("没有 profile");
  process.exitCode = 1;
} else {
  const today = todayISO();
  ensurePlan(repos, profile.id, today, { availableMinutes: 120, force: true });
  const plan = repos.plan.getPlan(profile.id, today)!;
  const pending = plan.tasks.filter((t) => t.status === "pending");
  console.log(`今日任务 ${plan.tasks.length} 项，待完成 ${pending.length} 项`);

  const task = pending.find((t) => t.kind === "reading_comprehension" || t.kind === "vocabulary_recall") ?? pending[0];
  if (!task) {
    console.error("没有可执行任务");
    process.exitCode = 1;
  } else {
    const detail = getTaskDetail(repos, task.id);
    const content = detail?.content;
    console.log(`执行任务：${task.title}（${task.kind}）`);

    const answers: Array<{ questionId: string; choiceId: string | null }> = [];
    if (content?.type === "reading_passage") {
      content.questions.forEach((q, index) => {
        answers.push({
          questionId: q.id,
          choiceId: index === 0 ? q.choices.find((c) => c.id !== q.correctChoiceId)!.id : q.correctChoiceId,
        });
      });
    } else if (content?.type === "vocabulary_set") {
      content.entries.forEach((e, index) => {
        answers.push({
          questionId: e.id,
          choiceId: index === 0 ? e.choices.find((c) => c.id !== e.correctChoiceId)!.id : e.correctChoiceId,
        });
      });
    }

    const result = await submitTask(repos, profile.id, {
      taskId: task.id,
      answers,
      writing: "",
      reviewedItemIds: [],
      elapsedMinutes: task.estimatedMinutes,
    });

    if (!result.ok) {
      console.error(`提交失败：${result.error}`);
      process.exitCode = 1;
    } else {
      console.log(
        `提交成功：正确 ${result.feedback.correctCount}/${result.feedback.totalCount}，` +
          `评分来源 ${result.feedback.gradedBy}，新增复习项 ${result.feedback.reviewItemsCreated}`,
      );
    }
  }
}
