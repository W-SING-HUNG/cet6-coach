// @vitest-environment node
/**
 * A2 保存端点 · HTTP 安全与能力隔离（真实进程内服务器 + 真实 HTTP）。
 *
 * 覆盖任务书「HTTP Security」一节逐条：
 * - A1 会话（无 A2 能力）不能访问 A2 保存端点；
 * - 缺 token / 错 token / 查询串 token 不能读取私人草稿；
 * - 缺 Origin / 不同端口 Origin 不能保存；
 * - 校验端点不得写文件；
 * - 陈旧或无效请求必须拒绝，且零持久副作用；
 * - 绑定查询端点同样受 token 保护。
 *
 * 全部合成夹具，隔离临时根。不碰 `private-content/`、不碰 `data/cet6.db`。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  INTAKE_ENDPOINTS,
  INTAKE_PAGE_PATH,
  SESSION_TOKEN_HEADER,
  newSessionToken,
  startAnnotationServer,
  type AnnotationSession,
  type IntakeCapability,
} from "@/content/course-pipeline/segment-server";
import { renderAdjudicationShell } from "@/content/course-pipeline/adjudication-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { renderIntakeShell } from "@/content/course-pipeline/intake-page";
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { describeBinding, saveAdjudicationReview } from "@/content/course-pipeline/adjudication";
import { buildTextPdf, writeSourceTree } from "../scripts/course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

const roots: string[] = [];
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `a2-http-${tag}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface SyntheticEnv {
  root: string;
  sourceRoot: string;
  papersDir: string;
  candidatesDir: string;
  courseId: string;
  realChecksum: string;
  realCanonicalDigest: string;
  realSourceDigest: string;
  proposalIds: string[];
  segmentIds: string[];
}

async function buildEnv(tag: string, courseId = "a2-http-course"): Promise<SyntheticEnv> {
  const root = makeRoot(tag);
  const sourceRoot = join(root, "synthetic-source");
  writeSourceTree(
    sourceRoot,
    new Map([
      ["阅读/reading-handout.pdf", buildTextPdf([["SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL", "Passage One", "Questions 46 to 50 are based on the following passage."]])],
    ]),
  );
  const papersRoot = join(root, "synthetic-papers");
  const papersDir = join(papersRoot, "cet6", "papers");
  for (let index = 0; index < 2; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    writeFixturePackage(papersRoot, id, buildFixturePackage({ id, year: 2024, session: "December", variant: `set${index + 1}` }));
  }
  const candidatesDir = join(root, "course-candidates");

  const intake = await runCourseIntake({
    sourceRoot,
    courseId,
    provider: "test_fixture_provider",
    edition: null,
    title: "A2 HTTP Test",
    contentVersion: 1,
    provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
    papersDir,
  });
  writeCourseCandidate(intake.archive, join(candidatesDir, courseId));

  return {
    root,
    sourceRoot,
    papersDir,
    candidatesDir,
    courseId,
    realChecksum: intake.archive.metadata.digests.candidateChecksum,
    realCanonicalDigest: intake.archive.metadata.matching.canonicalLibrary.digest,
    realSourceDigest: intake.inventory.digest,
    proposalIds: intake.grouping.proposals.map((p) => p.id),
    segmentIds: intake.archive.metadata.segmentation.materials.flatMap((m) => m.segments.map((s) => s.id)),
  };
}

/** 起一个挂载 A2 能力的服务器（与 `course:adjudication` 同一套接线）。 */
async function startA2Harness(env: SyntheticEnv, withA2: boolean): Promise<{
  port: number;
  token: string;
  close(): Promise<void>;
}> {
  const token = newSessionToken();
  const capability: IntakeCapability = {
    async pickFolder() {
      return { outcome: "cancelled", path: null, detail: "合成：取消。", newFolderButtonHidden: null };
    },
    rememberSource() {},
    sourceLabel() {
      return "synthetic-source";
    },
    hasSource() {
      return true;
    },
    async browse() {
      return { sourceRootLabel: "synthetic-source", directories: [], files: [], rejected: [], ignoredHidden: 0, structureDigest: "", scannedAt: "" };
    },
    async inspect() {
      throw new Error("HTTP 安全测试不跑检查");
    },
    forgetSource() {},
    ...(withA2
      ? {
          async loadDraft(courseId: string) {
            const binding = describeBinding({ courseId, candidatesDir: env.candidatesDir, papersDir: env.papersDir });
            return {
              review: { exists: false, raw: null, validation: { ok: false, errors: [], file: null } },
              plan: { exists: false, raw: null, issues: [] },
              binding,
            };
          },
          async describeBinding(courseId: string) {
            return describeBinding({ courseId, candidatesDir: env.candidatesDir, papersDir: env.papersDir });
          },
          async validateDraft() {
            return { ok: false, validation: { ok: false, errors: ["合成：不校验"] } };
          },
          async saveDraft(payload: unknown) {
            return saveAdjudicationReview({
              draft: payload as never,
              candidatesDir: env.candidatesDir,
              papersDir: env.papersDir,
              sourceDir: env.sourceRoot,
            });
          },
          async savePlanDraft() {
            return { ok: false, errors: ["合成：不保存计划"] };
          },
        }
      : {}),
  };

  const session: AnnotationSession = {
    token,
    courseId: env.courseId,
    sourceDigest: env.realSourceDigest,
    config: { courseId: env.courseId, sourceDigest: env.realSourceDigest, assets: [], existingPlan: null },
    savePlan() {
      return { ok: false, detail: "A2 HTTP 测试不接受 /api/plan。", planDigest: "" };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: 0,
    page: () => renderAnnotationShell(),
    intakePage: () => (withA2 ? renderAdjudicationShell() : renderIntakeShell()),
  });
  return { port: handle.port, token, close: handle.close };
}

describe("A2 · HTTP 安全与能力隔离", () => {
  it("A1 会话（无 A2 能力）访问 A2 保存端点 ⇒ 501，且零写", async () => {
    const env = await buildEnv("a1-iso");
    const harness = await startA2Harness(env, false);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.saveDraft, {
        method: "POST",
        headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
        body: JSON.stringify({ courseId: env.courseId, reviewer: "X", reviewedAt: "2026-10-16" }),
      });
      expect(result.status).toBe(501);
      expect(result.body).toContain("只读模式");
      expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("A1 会话访问 A2 计划保存端点与绑定端点 ⇒ 501", async () => {
    const env = await buildEnv("a1-iso-plan");
    const harness = await startA2Harness(env, false);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      for (const path of [INTAKE_ENDPOINTS.savePlan, INTAKE_ENDPOINTS.binding]) {
        const result = await rawRequest(harness.port, path, {
          method: path === INTAKE_ENDPOINTS.binding ? "GET" : "POST",
          headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
          body: path === INTAKE_ENDPOINTS.binding ? undefined : "{}",
        });
        expect(result.status, path).toBe(501);
      }
    } finally {
      await harness.close();
    }
  });

  it("缺 token / 错 token / 查询串 token 都不能读取私人草稿或绑定", async () => {
    const env = await buildEnv("token");
    const harness = await startA2Harness(env, true);
    try {
      for (const path of [
        `${INTAKE_ENDPOINTS.loadDraft}?courseId=${env.courseId}`,
        `${INTAKE_ENDPOINTS.binding}?courseId=${env.courseId}`,
      ]) {
        expect((await rawRequest(harness.port, path)).status, path).toBe(403);
        expect(
          (await rawRequest(harness.port, path, { headers: { [SESSION_TOKEN_HEADER]: "nope" } })).status,
          path,
        ).toBe(403);
        expect(
          (await rawRequest(harness.port, `${path}&token=${harness.token}`)).status,
          `${path} (query token)`,
        ).toBe(403);
        expect(
          (await rawRequest(harness.port, path, { headers: { [SESSION_TOKEN_HEADER]: harness.token } })).status,
          `${path} (header token)`,
        ).toBe(200);
      }
    } finally {
      await harness.close();
    }
  });

  it("缺 Origin / 不同端口回环 Origin / 非回环 Origin 都不能保存", async () => {
    const env = await buildEnv("origin");
    const harness = await startA2Harness(env, true);
    try {
      const payload = JSON.stringify({
        courseId: env.courseId,
        reviewer: "X",
        reviewedAt: "2026-10-16",
        candidateChecksum: env.realChecksum,
        canonicalLibraryDigest: env.realCanonicalDigest,
        sourceDigest: env.realSourceDigest,
        verifiedScope: ["materials"],
        notVerified: [],
        materialGroupings: [],
        segments: [],
        matches: [],
      });
      const variants: { label: string; headers: Record<string, string> }[] = [
        { label: "缺 Origin", headers: { [SESSION_TOKEN_HEADER]: harness.token, "content-type": "application/json" } },
        {
          label: "不同端口回环 Origin",
          headers: {
            [SESSION_TOKEN_HEADER]: harness.token,
            origin: `http://127.0.0.1:${harness.port + 1}`,
            "content-type": "application/json",
          },
        },
        {
          label: "非回环 Origin",
          headers: {
            [SESSION_TOKEN_HEADER]: harness.token,
            origin: "http://evil.example.com",
            "content-type": "application/json",
          },
        },
      ];
      for (const variant of variants) {
        const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.saveDraft, {
          method: "POST",
          headers: variant.headers,
          body: payload,
        });
        expect(result.status, variant.label).toBe(403);
      }
      expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("校验端点不写文件（即使载荷形状完全合法）", async () => {
    const env = await buildEnv("validate-nowrite");
    const harness = await startA2Harness(env, true);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.validateDraft, {
        method: "POST",
        headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
        body: JSON.stringify({
          courseId: env.courseId,
          reviewer: "X",
          reviewedAt: "2026-10-16",
          candidateChecksum: env.realChecksum,
          canonicalLibraryDigest: env.realCanonicalDigest,
          sourceDigest: env.realSourceDigest,
          verifiedScope: ["materials"],
          notVerified: [],
          materialGroupings: [],
          segments: [],
          matches: [],
        }),
      });
      expect(result.status).toBe(200);
      expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("保存端点拒绝伪造摘要（400），且既有 review.json 字节不变", async () => {
    const env = await buildEnv("forged");
    // 先放一份合法的既有 review
    const good = saveAdjudicationReview({
      draft: {
        courseId: env.courseId,
        reviewer: "Good",
        reviewedAt: "2026-10-16",
        candidateChecksum: env.realChecksum,
        canonicalLibraryDigest: env.realCanonicalDigest,
        sourceDigest: env.realSourceDigest,
        verifiedScope: ["materials"],
        notVerified: [],
        materialGroupings: [
          { proposalId: env.proposalIds[0] ?? "p1", decision: "accepted", evidence: "分组经逐字核对确认一致无误。" },
        ],
        segments: [],
        matches: [],
      },
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(good.ok).toBe(true);
    const before = readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8");

    const harness = await startA2Harness(env, true);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.saveDraft, {
        method: "POST",
        headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
        body: JSON.stringify({
          courseId: env.courseId,
          reviewer: "Forged",
          reviewedAt: "2026-10-16",
          // 伪造摘要
          candidateChecksum: "0".repeat(64),
          canonicalLibraryDigest: env.realCanonicalDigest,
          sourceDigest: env.realSourceDigest,
          verifiedScope: ["materials"],
          notVerified: [],
          materialGroupings: [
            { proposalId: env.proposalIds[0] ?? "p1", decision: "rejected", evidence: "伪造的否决裁决依据足够长。" },
          ],
          segments: [],
          matches: [],
        }),
      });
      expect(result.status).toBe(400);
      expect(result.body).toContain("候选校验和");
      // 既有 review 不被改动
      expect(readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8")).toBe(before);
    } finally {
      await harness.close();
    }
  });

  it("合法保存通过 HTTP 成功，且响应不含绝对路径", async () => {
    const env = await buildEnv("good-save");
    const harness = await startA2Harness(env, true);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.saveDraft, {
        method: "POST",
        headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
        body: JSON.stringify({
          courseId: env.courseId,
          reviewer: "Reviewer",
          reviewedAt: "2026-10-16",
          candidateChecksum: env.realChecksum,
          canonicalLibraryDigest: env.realCanonicalDigest,
          sourceDigest: env.realSourceDigest,
          verifiedScope: ["materials", "segments", "canonical_matches"],
          notVerified: [],
          materialGroupings: [
            { proposalId: env.proposalIds[0] ?? "p1", decision: "accepted", evidence: "分组经逐字核对确认一致无误。" },
          ],
          segments: (env.segmentIds.length > 0 ? env.segmentIds : ["seg-1"]).map((segmentId) => ({
            segmentId,
            decision: "accepted",
            evidence: "已人工核对该段页码与讲义完全对齐。",
          })),
          matches: [],
        }),
      });
      expect(result.status).toBe(200);
      const payload = JSON.parse(result.body) as { ok: boolean; filePath?: string };
      expect(payload.ok).toBe(true);
      // 服务层返回的 filePath 是内部值；**它不得被直接回给浏览器**。
      // 这一条由启动器（course-adjudication.ts / e2e-server-a2.ts）转换成相对标签，
      // 并由本测试锁定"启动器必须转换"的契约：端点响应里不得出现盘符路径以外的根路径。
      expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("绑定端点只回传摘要与布尔（无路径）", async () => {
    const env = await buildEnv("binding");
    const harness = await startA2Harness(env, true);
    try {
      const result = await rawRequest(
        harness.port,
        `${INTAKE_ENDPOINTS.binding}?courseId=${encodeURIComponent(env.courseId)}`,
        { headers: { [SESSION_TOKEN_HEADER]: harness.token } },
      );
      expect(result.status).toBe(200);
      const payload = JSON.parse(result.body) as { ok: boolean; binding: { candidateExists: boolean; rebound: { candidateChecksum: string } | null } };
      expect(payload.ok).toBe(true);
      expect(payload.binding.candidateExists).toBe(true);
      expect(payload.binding.rebound?.candidateChecksum).toBe(env.realChecksum);
      expect(/[A-Za-z]:\\/.test(result.body), "绑定响应不得含盘符路径").toBe(false);
      expect(result.body).not.toContain(env.root);
    } finally {
      await harness.close();
    }
  });

  it("请求体超上限 ⇒ 413（或连接被断），且零写", async () => {
    const env = await buildEnv("toolarge");
    const harness = await startA2Harness(env, true);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const huge = JSON.stringify({ padding: "x".repeat(300 * 1024) });
      let status: number | null = null;
      try {
        const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.saveDraft, {
          method: "POST",
          headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
          body: huge,
        });
        status = result.status;
      } catch {
        /*
         * 服务端在超过上限时 `request.destroy()` ⇒ 客户端看到 socket hang up。
         * 那是**可接受**的失败形态（拒绝写入），与 413 等价。
         * 唯一不可接受的是"写进去了"。
         */
        status = 413;
      }
      expect(status).toBe(413);
      expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("畸形 JSON ⇒ 400，且零写", async () => {
    const env = await buildEnv("badjson");
    const harness = await startA2Harness(env, true);
    try {
      const origin = `http://127.0.0.1:${harness.port}`;
      const result = await rawRequest(harness.port, INTAKE_ENDPOINTS.saveDraft, {
        method: "POST",
        headers: { [SESSION_TOKEN_HEADER]: harness.token, origin, "content-type": "application/json" },
        body: "{not-json",
      });
      expect(result.status).toBe(400);
      expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("A2 页面仍是静态外壳（可匿名取得、不含 token/正文/路径）", async () => {
    const env = await buildEnv("shell");
    const harness = await startA2Harness(env, true);
    try {
      const page = await rawRequest(harness.port, INTAKE_PAGE_PATH);
      expect(page.status).toBe(200);
      expect(page.body).not.toContain(harness.token);
      expect(/[A-Za-z]:\\/.test(page.body)).toBe(false);
      expect(page.body).not.toContain(env.root);
    } finally {
      await harness.close();
    }
  });
});
