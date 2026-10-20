#!/usr/bin/env node
/**
 * 由外部进程向服务器使用的同一个数据库写入 onboarding 数据。
 * 用途：验证"页面读取的是请求时的数据库状态"而不是构建时的快照。
 */

import { getRepositories } from "@/repositories/sqlite";
import { completeOnboarding, DEFAULT_ONBOARDING } from "@/services/onboarding";

const result = completeOnboarding(getRepositories(), {
  displayName: "Learner",
  examName: DEFAULT_ONBOARDING.examName,
  examDate: DEFAULT_ONBOARDING.examDate,
  targetScore: DEFAULT_ONBOARDING.targetScore,
  weekdayMinutes: DEFAULT_ONBOARDING.weekdayMinutes,
  weekendMinutes: DEFAULT_ONBOARDING.weekendMinutes,
});

console.log(result.ok ? `已写入 profile：${result.profile.id}` : `失败：${result.error}`);
if (!result.ok) process.exitCode = 1;
