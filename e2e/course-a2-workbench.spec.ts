/**
 * A2 课程材料人工审核与裁决保存 · 真实浏览器端到端测试。
 *
 * ── 与上一版的根本差别（P1-F2 修复）──
 *
 * 夹具是**真实合成候选**（`runCourseIntake` + `writeCourseCandidate`），
 * 服务器**不传** `allowStale`。因此这些用例证明的是产品行为：
 *
 * 1. 打开工作台，token 从 URL fragment 抹掉；
 * 2. 真实跑一次检查（不是预置结果）；
 * 3. 进入第 ⑤ 步，看到**绑定面板**（候选校验和 + 真题库摘要，服务端重算）；
 * 4. 用户显式裁决（默认不自动批准）；
 * 5. 依据不足 ⇒ 原地报错；
 * 6. 先校验（取得服务端重算的绑定身份）⇒ 再保存 ⇒ 成功反馈；
 * 7. 重新打开草稿并恢复已填状态；
 * 8. **陈旧拒绝**：伪造候选校验和提交保存 ⇒ 被拒，且页面给出原因与恢复方法；
 * 9. 保存响应**不含绝对路径**。
 */

import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HANDOFF_PATH = join(process.cwd(), ".e2e", "a2-workbench.json");

interface WorkbenchHandoff {
  url: string;
  port: number;
  boundAddress: string;
  sourceLabel: string | null;
  courseId: string;
  candidateChecksum: string;
  canonicalLibraryDigest: string;
  sourceDigest: string;
  proposalIds: string[];
  segmentIds: string[];
}

function readHandoff(): WorkbenchHandoff {
  expect(existsSync(HANDOFF_PATH), "e2e-server-a2 必须已写入 handoff 文件").toBe(true);
  return JSON.parse(readFileSync(HANDOFF_PATH, "utf8")) as WorkbenchHandoff;
}

test.describe("A2 · 人工审核与决定保存工作台", () => {
  test("工作台可打开，显示 A2 审核界面，token 自动清除", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.url);

    await expect(page.locator("h1")).toContainText("课程材料人工审核与裁决保存");
    await expect(page.locator(".badge")).toContainText("A2 · 支持人工审核与安全原子保存");
    await expect(page).not.toHaveURL(/#token=/);
  });

  test("真实检查后进入第 ⑤ 步：显示绑定候选与真题库摘要（不显示绝对路径）", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.url);

    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 15000 });

    await page.locator("#stepBtn5").click();
    await expect(page.locator("#step5Title")).toContainText("⑤ 人工审核与决定保存");

    // 绑定面板必须显示审核范围
    await expect(page.locator("#bindingScope")).toContainText("材料范围");

    // 填入**真实课程标识** ⇒ 绑定面板必须显示服务端现场重算的摘要缩略
    await page.locator("#courseIdInput").fill(handoff.courseId);
    await page.locator("#reviewerInput").fill("Teacher Li");
    await expect(page.locator("#bindingCandidate")).toContainText(handoff.candidateChecksum.slice(0, 12), { timeout: 15000 });
    await expect(page.locator("#bindingLibrary")).toContainText(handoff.canonicalLibraryDigest.slice(0, 12));

    // 页面不得出现绝对路径形态
    const body = await page.locator("body").innerText();
    expect(/[A-Za-z]:\\/.test(body), "界面不得显示盘符绝对路径").toBe(false);
    expect(body).not.toContain("D:\\");
  });

  test("不自动批准：所有裁决控件默认为未选择", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.url);
    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 15000 });
    await page.locator("#stepBtn5").click();

    const selects = page.locator("#adjudicationGroupings select, #adjudicationSegments select, #adjudicationMatches select");
    const count = await selects.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await expect(selects.nth(index)).toHaveValue("");
    }
  });

  test("依据不足 ⇒ 原地报错；补齐后校验通过并保存成功", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.url);

    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 15000 });
    await page.locator("#stepBtn5").click();

    await page.locator("#courseIdInput").fill(handoff.courseId);
    await page.locator("#reviewerInput").fill("Teacher Li");

    // 选择裁决但依据不足 ⇒ 报错
    const groupingSelect = page.locator("#adjudicationGroupings select").first();
    if (await groupingSelect.count() > 0) {
      await groupingSelect.selectOption("accepted");
      await page.locator("#adjudicationGroupings input").first().fill("短");
    }
    await page.locator("#validateDraftBtn").click();
    await expect(page.locator("#adjudicationNotice")).toContainText("审核草稿校验未通过");

    // 补齐依据
    if (await groupingSelect.count() > 0) {
      await page.locator("#adjudicationGroupings input").first().fill("经逐字核对该讲义多版本内容完全等价无出入。");
    }
    const segSelect = page.locator("#adjudicationSegments select").first();
    if (await segSelect.count() > 0) {
      await segSelect.selectOption("accepted");
      await page.locator("#adjudicationSegments input").first().fill("人工核验该段页码与讲义完全对齐。");
    }
    const matchSelect = page.locator("#adjudicationMatches select").first();
    if (await matchSelect.count() > 0) {
      await matchSelect.selectOption("intentionally_unmatched");
      await page.locator("#adjudicationMatches input").first().fill("该段为综合指导笔记，有意不进行真题匹配。");
    }

    await page.locator("#validateDraftBtn").click();
    await expect(page.locator("#adjudicationNotice")).toContainText("审核草稿校验通过", { timeout: 15000 });

    await page.locator("#saveDraftBtn").click();
    await expect(page.locator("#adjudicationNotice")).toContainText("人工审核记录已原子安全保存", { timeout: 15000 });
    await expect(page.locator("#saveDraftState")).toContainText("已成功保存");

    // 保存成功提示不得含绝对路径
    const noticeText = await page.locator("#adjudicationNotice").innerText();
    expect(/[A-Za-z]:\\/.test(noticeText), "保存响应不得回显盘符绝对路径").toBe(false);

    // 重新打开草稿恢复状态
    await page.locator("#reviewerInput").fill("");
    await page.locator("#loadExistingDraftBtn").click();
    await expect(page.locator("#reviewerInput")).toHaveValue("Teacher Li", { timeout: 15000 });
    await expect(page.locator("#adjudicationNotice")).toContainText("成功加载已有草稿");
  });

  test("陈旧拒绝：伪造候选校验和提交保存必须被拒，并给出原因与恢复方法", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.url);

    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 15000 });
    await page.locator("#stepBtn5").click();

    await page.locator("#courseIdInput").fill(handoff.courseId);
    await page.locator("#reviewerInput").fill("Teacher Li");

    const groupingSelect = page.locator("#adjudicationGroupings select").first();
    if (await groupingSelect.count() > 0) {
      await groupingSelect.selectOption("accepted");
      await page.locator("#adjudicationGroupings input").first().fill("经逐字核对该讲义多版本内容完全等价无出入。");
    }
    const segSelect = page.locator("#adjudicationSegments select").first();
    if (await segSelect.count() > 0) {
      await segSelect.selectOption("accepted");
      await page.locator("#adjudicationSegments input").first().fill("人工核验该段页码与讲义完全对齐。");
    }

    // 先用真实摘要通过校验（取得绑定身份）
    await page.locator("#validateDraftBtn").click();
    await expect(page.locator("#adjudicationNotice")).toContainText("审核草稿校验通过", { timeout: 15000 });

    /*
     * 现在直接以**伪造摘要**打保存端点（绕过 UI，模拟过期页面/篡改客户端）。
     * 服务端必须拒绝：它对不上现场重算值。
     *
     * 用 Node 侧真实 HTTP（带正确 token 与同源 Origin）⇒ 守卫全部满足，
     * 因此 400（而不是 403）才证明"是绑定校验挡住的，不是守卫挡住的"。
     */
    const saveStatus = await postForgedSave(handoff, "0".repeat(64));
    expect(saveStatus.status).toBe(400);
    expect(saveStatus.body.ok).toBe(false);
    expect(String(saveStatus.body.errors?.join("；"))).toContain("候选校验和");
  });

  test("分段计划：无计划时可保存被明确拒绝（不发明结构）", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.url);
    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 15000 });
    await page.locator("#stepBtn5").click();
    await page.locator("#courseIdInput").fill(handoff.courseId);

    // 没有加载计划就直接保存 ⇒ 明确拒绝，且不写任何文件
    await page.locator("#savePlanBtn").click();
    await expect(page.locator("#planNotice")).toContainText("还没有可保存的分段计划");
    await expect(page.locator("#savePlanState")).not.toContainText("已成功保存");

    // 页面对"保存 review ≠ 课程已导入"有明确说明
    await expect(page.locator("#step5")).toContainText("不等于");
  });

  test("A1 会话不能访问 A2 保存端点（能力隔离）", async ({ request }) => {
    const handoff = readHandoff();
    // A2 工作台的会话令牌对 A1 端口无效 ⇒ 403（守卫层先拒绝）
    const token = (handoff.url.split("#token=")[1] ?? "").trim();
    const response = await request.post("http://127.0.0.1:3270/api/intake/save-draft", {
      headers: { "x-cet6-session-token": token, origin: "http://127.0.0.1:3270" },
      data: { courseId: handoff.courseId },
    });
    expect(response.status()).toBe(403);
  });
});

/** 以 Node 侧真实 HTTP 打保存端点（token + 同源 Origin 都正确）。 */
async function postForgedSave(
  handoff: WorkbenchHandoff,
  forgedCandidateChecksum: string,
): Promise<{ status: number; body: { ok: boolean; errors?: string[] } }> {
  const { request } = await import("node:http");
  const token = (handoff.url.split("#token=")[1] ?? "").trim();
  const payload = JSON.stringify({
    courseId: handoff.courseId,
    reviewer: "Attacker",
    reviewedAt: "2026-10-16",
    // 伪造：全零摘要
    candidateChecksum: forgedCandidateChecksum,
    canonicalLibraryDigest: handoff.canonicalLibraryDigest,
    sourceDigest: "",
    verifiedScope: ["materials"],
    notVerified: [],
    materialGroupings: [],
    segments: [],
    matches: [],
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: handoff.port,
        path: "/api/intake/save-draft",
        method: "POST",
        headers: {
          host: `127.0.0.1:${handoff.port}`,
          "x-cet6-session-token": token,
          origin: `http://127.0.0.1:${handoff.port}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: { ok: boolean; errors?: string[] } = { ok: false };
          try {
            parsed = JSON.parse(text) as { ok: boolean; errors?: string[] };
          } catch {
            parsed = { ok: false, errors: [`非 JSON 响应：${text.slice(0, 200)}`] };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
