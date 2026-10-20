#!/usr/bin/env node
/**
 * 由外部进程向服务器使用的同一个数据库写入一次完整诊断，
 * 用于验证"诊断完成后 Today 页面才可用"这一真实状态转换。
 */

import { getRepositories } from "@/repositories/sqlite";
import { getDiagnosticItems, startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { ensurePlan } from "@/services/plan";
import { todayISO } from "@/lib/date";

const repos = getRepositories();
const profile = repos.learner.getProfile();
if (!profile) {
  console.error("没有 profile，请先运行 seed-onboard.ts");
  process.exitCode = 1;
} else {
  const items = getDiagnosticItems();
  const session = startDiagnostic(repos, profile.id);

  const result = submitDiagnostic(repos, {
    sessionId: session.id,
    answers: items
      .filter((i) => i.type !== "pending_media")
      .map((item) => {
        // 刻意让阅读/词汇薄弱，使后续计划有明确侧重
        const weak = item.dimension === "reading" || item.dimension === "vocabulary";
        return {
          itemId: item.id,
          dimension: item.dimension,
          choiceId:
            item.type === "mcq"
              ? weak
                ? item.choices!.find((c) => c.id !== item.correctChoiceId)!.id
                : item.correctChoiceId!
              : null,
          text: item.type === "short_text" ? (weak ? "incomplete" : (item.rubricPoints ?? []).join(" and ")) : null,
          skipped: false,
        };
      }),
  });

  if (!result.ok) {
    console.error(`诊断提交失败：${result.error}`);
    process.exitCode = 1;
  } else {
    ensurePlan(repos, profile.id, todayISO(), { generatedBy: "diagnostic_initial" });
    console.log(`诊断完成，profile=${profile.id}`);
  }
}
