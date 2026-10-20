"use server";

import { revalidatePath } from "next/cache";
import { getRepositories } from "@/repositories/sqlite";
import { setPaperPool } from "@/services/papers";
import { PAPER_POOLS, type PaperPool } from "@/domain/paper";
import type { ActionResult } from "@/types/actions";

/**
 * 真题库的写入入口。
 *
 * 唯一允许的写入是**学习策略**（训练池 / 模考保留），
 * 内容本身只能经 `pnpm content:import` 进入 —— 界面里没有、也不应该有
 * "在页面上编辑题目"的能力，那样内容就会有两套真相。
 */

export async function setPaperPoolAction(input: {
  paperId: string;
  pool: string;
}): Promise<ActionResult<{ paperId: string; pool: PaperPool }>> {
  const repos = getRepositories();
  const profileId = repos.learner.getProfile()?.id ?? null;
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };

  if (!PAPER_POOLS.includes(input.pool as PaperPool)) {
    return { ok: false, error: `未知的试卷归属：${input.pool}` };
  }
  const pool = input.pool as PaperPool;

  try {
    const detail = setPaperPool(repos, input.paperId, pool);
    if (!detail) return { ok: false, error: "试卷不存在。" };
    revalidatePath("/practice/papers");
    revalidatePath(`/practice/papers/${input.paperId}`);
    return { ok: true, data: { paperId: input.paperId, pool } };
  } catch (error) {
    return { ok: false, error: `保存失败：${(error as Error).message}` };
  }
}
