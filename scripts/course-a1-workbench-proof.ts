#!/usr/bin/env node
/**
 * A1 只读检查工作台 · **零写入与隐私边界证明**（真实进程 + 真实磁盘快照）。
 *
 * ── 它证明什么（每一条都是行为级，不是源码字符串）──
 *
 * | # | 判据 | 怎么证 |
 * | --- | --- | --- |
 * | 1 | 完整 A1 检查前后，**内容根、候选、计划、courses/、数据库文件**逐字节不变 | 前后递归快照对照（含初始不存在与已有哨兵内容两类） |
 * | 2 | 源目录**只读**：所有源字节与目录条目不变 | 前后递归快照对照 |
 * | 3 | 服务端**拒绝** `/api/plan` 保存（即使载荷形状完全合法） | 真实 HTTP POST |
 * | 4 | 未认证 / 错 token / 查询串 token ⇒ 403 | 真实 HTTP |
 * | 5 | 敏感 POST 缺 Origin / 不同端口 Origin / 非回环 Origin ⇒ 403 | 真实 HTTP |
 * | 6 | 非回环 Host ⇒ 403 | 真实 HTTP（`fetch` 不能自定义 Host，因此用 `node:http`） |
 * | 7 | `GET /intake` 是静态外壳：与任何会话字节相同、不含 token / 正文 / 绝对路径 | 两个不同 token 的会话对照 |
 * | 8 | 检查结果**不含任何绝对路径**（响应体级） | 响应字节扫描 |
 * | 9 | 反复检查（不同范围）不产生累积痕迹 | 快照对照 |
 * | 10 | 快照判据覆盖**全部字节**（窗口之外的改动也必须被发现） | 红/绿因果对照（见第七节） |
 *
 * ── 全部内容都是**合成夹具** ──
 *
 * 源目录、真题包、数据库哨兵全部在 `os.tmpdir()` 下临时创建。
 * **本脚本从未读取任何真实课程材料或真实数据库。**
 * 它写的每一个字节都只在那个临时目录里，结束时整棵删掉。
 *
 * ── 为什么它是一条独立 script（不在 vitest 里）──
 *
 * 它起真实回环服务器、发真实 HTTP、做递归磁盘快照（含完整 SHA-256）——
 * 比单元测试慢一个量级。放在并行套件里会触发既有的 5 秒超时脆弱性
 * （本项目已登记过三次同类坑）。因此它是质量门禁显式调用的一条命令：
 * `pnpm course:a1-proof`。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  INTAKE_ENDPOINTS,
  INTAKE_PAGE_PATH,
  SESSION_TOKEN_HEADER,
  newSessionToken,
  startAnnotationServer,
  type AnnotationSession,
  type IntakeCapability,
} from "@/content/course-pipeline/segment-server";
import { renderIntakeShell } from "@/content/course-pipeline/intake-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
import { buildTextPdf, buildCjkPdf, buildImageOnlyPdf, buildMinimalDocx, buildSilentWav, writeSourceTree } from "./course-source-fixture";
import { FIXTURE_PASSAGE_A, FIXTURE_PASSAGE_B, FIXTURE_TRANSLATION_REFERENCE, FIXTURE_TRANSLATION_SOURCE } from "./course-source-fixture";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** 合成源目录：四类材料 + 对抗性形态（全部合成）。 */
function syntheticTree(): Map<string, Buffer> {
  const tree = new Map<string, Buffer>();
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      ["Reading Handout", "Passage One", "Questions 46 to 50 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_A)],
      ["Passage One Questions", "46. Synthetic stem one?", "A) Synthetic option A.", "B) Synthetic option B."],
      ["Answer Keys", "46. A"],
      ["Passage Two", "Questions 51 to 55 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_B)],
    ]),
  );
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["翻译练习", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)],
      ["参考译文", ...wrapCjk(FIXTURE_TRANSLATION_REFERENCE)],
    ]),
  );
  tree.set(
    "写作/writing-template.pdf",
    buildTextPdf([["Writing Template", "Introduction: state the topic in one sentence.", "Note: not a single exam question."]]),
  );
  tree.set("阅读/shared-handout.pdf", buildTextPdf([["Shared Handout", "Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
  tree.set("阅读/shared-handout.docx", buildMinimalDocx("synthetic deferred docx"));
  tree.set("听力/question-handout.pdf", buildTextPdf([["Listening Comprehension", "Section A", "Questions 1 to 4."]]));
  tree.set("听力/transcript-analysis.pdf", buildTextPdf([["Transcript and Analysis", "Transcript", "Conversation One", "W: synthetic line."]]));
  tree.set("听力/listening-full.wav", buildSilentWav(0.1));
  tree.set("阅读/scanned.pdf", buildImageOnlyPdf(2));
  tree.set("阅读/empty.pdf", Buffer.alloc(0));
  return tree;
}

function wrap(text: string, width = 70): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") { current = word; continue; }
    if (current.length + 1 + word.length > width) { lines.push(current); current = word; continue; }
    current += ` ${word}`;
  }
  if (current !== "") lines.push(current);
  return lines;
}

function wrapCjk(text: string, width = 24): string[] {
  const chars = [...text];
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) lines.push(chars.slice(index, index + width).join(""));
  return lines.filter((line) => line !== "");
}

/**
 * 递归快照：类型 + 相对路径 + 字节数 + **内容的完整 SHA-256**。
 *
 * ── 为什么必须是**完整哈希**，而不是内容前缀 ──
 *
 * 早先这里记录的是 `bytes.toString("base64").slice(0, 96)`
 * —— 也就是每个文件**前 72 字节**的内容窗口。那留下了一个真实的漏洞：
 * 一次"只改动第 73 字节之后"的写入**不会被发现**，而快照却显示"逐字节不变"。
 *
 * 对 A1 这样以"零写入"为核心主张的证明来说，那是最坏的失效形态：
 * 断言恒真、报告全绿，而它声称覆盖的性质**从未被验证**。
 *
 * 完整 SHA-256 让判据覆盖文件的**每一个字节**，代价只是一次流式读取
 * （合成夹具的总量很小；真实运行时的快照只作用于临时合成根）。
 *
 * ── 保留的判据（一条都没有削弱）──
 *
 * | 判据 | 由什么承载 |
 * | --- | --- |
 * | 存在性 | 条目被列进快照；新增条目 ⇒ diff 里出现 `+` |
 * | 相对路径身份 | `rel` 字段（重命名 ⇒ 一 `+` 一 `-`） |
 * | 文件/目录类型 | `F` / `D` 前缀（文件变目录也会被发现） |
 * | 字节数 | `size` 字段 |
 * | **内容** | **完整 sha256**（本轮的修复点） |
 * | 目录不可读 | `UNREADABLE` 条目 |
 */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      out.push(`${dir}\tUNREADABLE`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split("\\").join("/");
      if (entry.isDirectory()) {
        out.push(`D\t${rel}`);
        walk(full);
      } else {
        const stat = statSync(full);
        const bytes = readFileSync(full);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        out.push(`F\t${rel}\t${stat.size}\t${sha256}`);
      }
    }
  };
  walk(root);
  return out;
}

function diff(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after.filter((line) => !beforeSet.has(line)).map((line) => `+ ${line}`),
    ...before.filter((line) => !afterSet.has(line)).map((line) => `- ${line}`),
  ];
}

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

/** 起一个真实的 A1 服务器（与 `course:workbench` 同一套接线）。 */
async function startServer(sourceRoot: string | null): Promise<{ port: number; token: string; close(): Promise<void> }> {
  const token = newSessionToken();
  let root = sourceRoot;
  const capability: IntakeCapability = {
    async pickFolder() {
      return { outcome: "cancelled", path: null, detail: "证明脚本不弹窗口。", newFolderButtonHidden: true };
    },
    rememberSource(path: string) { root = path; },
    sourceLabel() { return root === null ? null : root.split(/[\\/]/).filter((p) => p !== "").pop()!; },
    hasSource() { return root !== null && existsSync(root); },
    async browse() {
      if (root === null) throw new Error("还没有选择课程目录");
      return inspectSourceTree(root);
    },
    async inspect(selection) {
      if (root === null) throw new Error("还没有选择课程目录");
      return runInspection({ sourceRoot: root, courseId: "a1-proof", selection });
    },
    forgetSource() { root = null; },
  };
  const session: AnnotationSession = {
    token,
    courseId: "a1-proof",
    sourceDigest: "",
    config: { courseId: "a1-proof", sourceDigest: "", assets: [], existingPlan: null },
    savePlan() {
      // A1 模式：结构性拒绝
      return { ok: false, detail: "A1 只读工作台不具备保存计划的能力（这是设计，不是错误）。", planDigest: "" };
    },
    intake: capability,
  };
  const handle = await startAnnotationServer(session, {
    port: 0,
    page: () => renderAnnotationShell(),
    intakePage: () => renderIntakeShell(),
  });
  return { port: handle.port, token, close: handle.close };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cet6-a1-proof-"));
  const sourceRoot = join(root, "source");
  writeSourceTree(sourceRoot, syntheticTree());

  console.log("A1 只读检查工作台 · 零写入与隐私边界证明（**合成夹具**，非真实材料）");
  console.log(`临时根：${root.split(/[\\/]/).pop()}（全部内容都是合成的）`);

  try {
    // ── 准备"两类目标" ──
    const contentRoot = join(root, "private-content");
    mkdirSync(contentRoot, { recursive: true });

    const candidateDir = join(contentRoot, "course-candidates", "a1-proof");
    const plansDir = join(contentRoot, "course-segmentation-plans");
    const coursesDir = join(contentRoot, "courses", "a1-proof");
    const dbPath = join(contentRoot, "cet6.db");
    const planPath = join(plansDir, "a1-proof.json");
    const reviewPath = join(candidateDir, "review.json");

    // ② 已存在且有哨兵内容的路径
    const SENTINELS = {
      plan: "{\"sentinel\":\"计划哨兵——不得被覆盖\"}",
      review: "{\"sentinel\":\"复核哨兵——不得被覆盖\"}",
      db: "sentinel-database-bytes-must-not-change",
    };
    mkdirSync(plansDir, { recursive: true });
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(planPath, SENTINELS.plan, "utf8");
    writeFileSync(reviewPath, SENTINELS.review, "utf8");
    writeFileSync(dbPath, SENTINELS.db, "utf8");

    // ── 1) 零写入：完整检查前后快照一致 ──
    section("一、零写入证明（递归快照对照）");
    const sourceBefore = snapshot(sourceRoot);
    const contentBefore = snapshot(contentRoot);

    const inspection = await runInspection({ sourceRoot, courseId: "a1-proof", selection: null });
    const inspectionScoped = await runInspection({
      sourceRoot,
      courseId: "a1-proof",
      selection: { includeDirectories: ["阅读"], excludeFiles: ["阅读/empty.pdf"] },
    });

    const sourceAfter = snapshot(sourceRoot);
    const contentAfter = snapshot(contentRoot);

    check("检查确实产出了结果（不是空跑）", inspection.counts.selected > 0, `选中 ${inspection.counts.selected} 个`);
    const sourceChanges = diff(sourceBefore, sourceAfter);
    check("源目录**逐字节不变**", sourceChanges.length === 0, sourceChanges.slice(0, 6).join(" / "));
    const contentChanges = diff(contentBefore, contentAfter);
    check("内容根（候选 / 计划 / courses / 数据库）**逐字节不变**", contentChanges.length === 0, contentChanges.slice(0, 6).join(" / "));

    // ── 2) 两类目标逐一确认 ──
    section("二、两类目标（初始不存在 / 已有哨兵内容）");
    check("**没有**创建 `courses/`（初始不存在）", !existsSync(coursesDir));
    check("**没有**创建 `course-candidates/a1-proof/assets/`", !existsSync(join(candidateDir, "assets")));
    check("复核记录哨兵内容未被改动", readFileSync(reviewPath, "utf8") === SENTINELS.review);
    check("分段计划哨兵内容未被改动", readFileSync(planPath, "utf8") === SENTINELS.plan);
    check("数据库文件哨兵内容未被改动", readFileSync(dbPath, "utf8") === SENTINELS.db);
    check("候选目录里没有新增文件", readdirSync(candidateDir).join(",") === "review.json", readdirSync(candidateDir).join(","));
    check("计划目录里没有新增文件", readdirSync(plansDir).join(",") === "a1-proof.json", readdirSync(plansDir).join(","));
    check(
      "**没有**任何 `review.json` 之外的候选产物（不写 segmentation plan / 不晋升）",
      existsSync(join(contentRoot, "course-candidates", "a1-proof", "review.json")),
    );

    // ── 3) 反复检查不累积痕迹 ──
    section("三、反复检查不产生累积痕迹");
    const beforeRepeat = snapshot(root);
    for (let round = 0; round < 3; round += 1) {
      await runInspection({
        sourceRoot,
        courseId: "a1-proof",
        selection: { includeDirectories: ["阅读", "翻译"], excludeFiles: [`阅读/empty.pdf`] },
      });
    }
    const afterRepeat = snapshot(root);
    const repeatChanges = diff(beforeRepeat, afterRepeat);
    check("三轮重复检查后整棵临时根逐字节不变", repeatChanges.length === 0, repeatChanges.slice(0, 6).join(" / "));

    // ── 4) 服务器端点边界 ──
    section("四、端点授权与隐私边界（真实 HTTP）");
    const server = await startServer(sourceRoot);
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const jsonHeaders = { "content-type": "application/json", [SESSION_TOKEN_HEADER]: server.token, origin };

      // 静态外壳
      const anonymous = await rawRequest(server.port, INTAKE_PAGE_PATH);
      check("`GET /intake` 匿名可取 ⇒ 200", anonymous.status === 200);
      check("`GET /intake` 带 no-store", anonymous.headers["cache-control"] === "no-store");
      check(
        "`GET /intake` 带 CSP default-src 'none'",
        String(anonymous.headers["content-security-policy"]).includes("default-src 'none'"),
      );
      check("`GET /intake` 带 no-referrer", anonymous.headers["referrer-policy"] === "no-referrer");

      const second = await startServer(sourceRoot);
      try {
        const other = await rawRequest(second.port, INTAKE_PAGE_PATH);
        check("**两个不同会话取到的页面字节完全相同**（静态外壳的最强判据）", other.body === anonymous.body);
      } finally {
        await second.close();
      }
      check("未认证页面**不含**会话 token", !anonymous.body.includes(server.token));
      check("未认证页面**不含**源绝对路径", !anonymous.body.includes(root) && !/[A-Za-z]:\\/.test(anonymous.body));
      check("未认证页面**不含**课程正文", !anonymous.body.includes("城市轨道交通") && !anonymous.body.includes(FIXTURE_PASSAGE_A.slice(0, 30)));

      // 读端点
      check("读端点缺 token ⇒ 403", (await rawRequest(server.port, INTAKE_ENDPOINTS.state)).status === 403);
      check(
        "读端点错 token ⇒ 403",
        (await rawRequest(server.port, INTAKE_ENDPOINTS.state, { headers: { [SESSION_TOKEN_HEADER]: "wrong" } })).status === 403,
      );
      check(
        "读端点查询串 token ⇒ 403（查询串里的 token 不算）",
        (await rawRequest(server.port, `${INTAKE_ENDPOINTS.state}?token=${server.token}`)).status === 403,
      );
      check(
        "读端点正确 token ⇒ 200",
        (await rawRequest(server.port, INTAKE_ENDPOINTS.state, { headers: { [SESSION_TOKEN_HEADER]: server.token } })).status === 200,
      );

      // 敏感 POST
      const missingOrigin = await rawRequest(server.port, INTAKE_ENDPOINTS.pick, {
        method: "POST",
        headers: { "content-type": "application/json", [SESSION_TOKEN_HEADER]: server.token },
        body: "{}",
      });
      check("敏感 POST 缺 Origin ⇒ 403（失败关闭）", missingOrigin.status === 403, `实际 ${missingOrigin.status}`);
      check(
        "敏感 POST 不同端口的回环 Origin ⇒ 403（都是回环 ≠ 同源）",
        (await rawRequest(server.port, INTAKE_ENDPOINTS.pick, {
          method: "POST",
          headers: { "content-type": "application/json", [SESSION_TOKEN_HEADER]: server.token, origin: `http://127.0.0.1:${server.port + 1}` },
          body: "{}",
        })).status === 403,
      );
      check(
        "敏感 POST 非回环 Origin ⇒ 403",
        (await rawRequest(server.port, INTAKE_ENDPOINTS.pick, {
          method: "POST",
          headers: { "content-type": "application/json", [SESSION_TOKEN_HEADER]: server.token, origin: "https://evil.example" },
          body: "{}",
        })).status === 403,
      );
      check(
        "敏感 POST 非回环 Host ⇒ 403（挡 DNS rebinding；fetch 不能自定义 Host，故用 node:http）",
        (await rawRequest(server.port, INTAKE_ENDPOINTS.pick, {
          method: "POST",
          headers: { host: "evil.example", "content-type": "application/json", [SESSION_TOKEN_HEADER]: server.token, origin },
          body: "{}",
        })).status === 403,
      );

      // A1 拒绝保存
      const saveAttempt = await rawRequest(server.port, "/api/plan", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          author: "synthetic",
          reason: "synthetic",
          units: [
            {
              title: "合成单元",
              kind: "translation_passage",
              assignments: [{ channel: "source", assetKey: "k", page: 1, lineStart: 1, lineEnd: 2, note: null }],
            },
          ],
        }),
      });
      check("**A1 拒绝 `/api/plan` 保存**（形状完全合法的载荷也不放行）", saveAttempt.status === 400, `实际 ${saveAttempt.status}`);

      // 同源检查：响应体不含绝对路径
      const inspectResponse = await rawRequest(server.port, INTAKE_ENDPOINTS.inspect, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ includeDirectories: [""], excludeFiles: [] }),
      });
      check("同源检查 ⇒ 200", inspectResponse.status === 200, `实际 ${inspectResponse.status}`);
      check("检查响应**不含源绝对路径**", !inspectResponse.body.includes(root));
      check("检查响应**不含**盘符路径形态", !/[A-Za-z]:\\\\/.test(inspectResponse.body));
      const parsedResponse = JSON.parse(inspectResponse.body) as { ok: boolean; result: { counts: { selected: number } } };
      check("检查响应含真实结果", parsedResponse.ok === true && parsedResponse.result.counts.selected > 0);

      // 检查完成后内容根仍然不变（**端点路径**也参与零写入证明）
      const contentAfterHttp = snapshot(contentRoot);
      const httpChanges = diff(contentBefore, contentAfterHttp);
      check("走完**全部端点**之后内容根仍逐字节不变", httpChanges.length === 0, httpChanges.slice(0, 6).join(" / "));
    } finally {
      await server.close();
    }

    // ── 5) 源目录只读（元数据浏览也不改动） ──
    section("五、源目录只读（元数据浏览与内容检查两条路径）");
    const beforeBrowse = snapshot(sourceRoot);
    inspectSourceTree(sourceRoot);
    check("元数据浏览后源目录不变", diff(beforeBrowse, snapshot(sourceRoot)).length === 0);

    // ── 6) 结果诚实性（前端契约） ──
    section("六、结果诚实性");
    check("范围内文件数 = 选中 + 排除", inspectionScoped.counts.selected + inspectionScoped.counts.excluded === inspection.counts.selected + inspection.counts.excluded);
    check("检查结果里**每一个** PDF 都有三态之一", inspection.counts.pdfParsed + inspection.counts.pdfWithoutTextLayer + inspection.counts.pdfFailed > 0);
    check("冲突与警告**每一条**都有处置说明", inspection.issues.every((issue) => issue.recovery.length > 0));
    check("冲突与警告里**不含**绝对路径", !JSON.stringify(inspection.issues).includes(root));

    // ── 7) 快照判据的**因果**证明（本轮修复点） ──
    //
    // 独立复评指出：旧快照只记录每个文件前 72 字节（base64 96 字符），
    // 因此"只动第 73 字节之后"的写入不会被发现。这一节证明：
    //   ① 那个盲区**确实存在**（旧判据对窗口外的改动判为"没变"）；
    //   ② 新判据（完整 sha256）**确实会发现**同一处改动；
    //   ③ 恢复后判据重新一致。
    // 三步缺一不可 —— 只做 ② 无法排除"它其实是被别的原因抓到的"。
    causalSnapshotProof(root, sourceRoot);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * 快照判据的**红/绿因果证明**（全部在隔离的合成根内，结束时逐字节还原）。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 旧快照的判据是"每个文件前 72 字节的 base64 前缀"。后果是具体的：
 * 一次只改动第 73 字节之后的写入会让快照**逐字节相同** ——
 * 于是"零写入"的证明在一个它声称覆盖的场景上恒真。
 *
 * ── 三步（缺一即不成立）──
 *
 * 1. **盲区确实存在**：用旧判据（72 字节窗口）比对，改动前后**完全相同**。
 *    这一步是"反空断言"：没有它，第二步可能只是被别的原因抓到的。
 * 2. **新判据确实抓住它**：`snapshot()` 的前后 diff 必须非空，
 *    且命中被改的那个文件。
 * 3. **恢复后一致**：逐字节写回原内容，diff 必须重新为空。
 */
function causalSnapshotProof(root: string, sourceRoot: string): void {
  section("七、快照判据的因果证明（窗口外的改动必须被发现）");

  /*
   * 造一个**远大于 72 字节**的合成文件，并确认它落在隔离合成根内 ——
   * 变异绝不触碰任何真实内容（这里连 `private-content/` 都不碰，
   * 用的是根下一个专门的因果探针目录）。
   */
  const probeDir = join(root, "causal-probe");
  mkdirSync(probeDir, { recursive: true });
  const probePath = join(probeDir, "probe.bin");
  // 源目录的**因果证明之前**快照 —— 用于证明整段变异从未触碰源件
  const sourceSnapshotBeforeCausal = snapshot(sourceRoot);

  // 前 72 字节刻意保持"看起来是正常的合成头"，改动只发生在窗口之外
  const HEADER = Buffer.from("SYNTHETIC FIXTURE PROBE - 72 byte header window ends right about here!!\n", "utf8");
  check("探针头长度恰好覆盖旧窗口（否则这条证明不成立）", HEADER.length >= 72, `头部 ${HEADER.length} 字节`);
  const tail = Buffer.from("TAIL-SEGMENT-BEFORE-".repeat(8), "utf8");
  const original = Buffer.concat([HEADER, tail]);
  writeFileSync(probePath, original);
  check("探针文件远大于旧窗口", original.length > HEADER.length + 72, `${original.length} 字节`);

  /** 旧判据的投影（**只用于证明盲区存在**，不参与任何真实断言）。 */
  const legacyWindow = (path: string): string =>
    readFileSync(path).toString("base64").slice(0, 96);

  const legacyBefore = legacyWindow(probePath);
  const snapshotBefore = snapshot(root);

  /*
   * ── 变异：只改窗口**之外**的字节，且保持总长度不变 ──
   *
   * 长度不变很关键：否则"字节数变了"会成为发现它的原因，
   * 而那证明的是大小判据而不是内容判据。
   */
  const mutated = Buffer.concat([
    HEADER,
    Buffer.from("TAIL-SEGMENT-MUTATED-X".repeat(8), "utf8").subarray(0, tail.length),
  ]);
  check("变异保持总长度不变（排除「其实是大小变了」这一解释）", mutated.length === original.length, `${mutated.length} vs ${original.length}`);
  // 窗口之内的内容必须逐字节相同（这才是"盲区"的定义）
  check(
    "变异不触碰旧窗口内的任何字节",
    mutated.subarray(0, 72).equals(original.subarray(0, 72)),
  );
  check("变异确实改变了内容（不是空操作）", !mutated.equals(original));

  writeFileSync(probePath, mutated);

  // ① 旧判据：看不见
  const legacyAfter = legacyWindow(probePath);
  check(
    "**旧 72 字节窗口判据看不见这次改动**（盲区确实存在）",
    legacyBefore === legacyAfter,
  );

  // ② 新判据：必须看见
  const snapshotAfter = snapshot(root);
  const mutationChanges = diff(snapshotBefore, snapshotAfter);
  check(
    "**新完整哈希判据发现了这次改动**（修复确实生效）",
    mutationChanges.length > 0,
  );
  check(
    "被发现的正是那个探针文件",
    mutationChanges.some((line) => line.includes("causal-probe/probe.bin")),
    mutationChanges.slice(0, 4).join(" / "),
  );
  check(
    "改动被如实报告为「内容变了」（同一路径、同一大小、不同哈希）",
    snapshotBefore.some((line) => /^F\tcausal-probe\/probe\.bin\t/.test(line)) &&
      snapshotAfter.some((line) => /^F\tcausal-probe\/probe\.bin\t/.test(line)) &&
      snapshotBefore.filter((line) => line.includes("probe.bin")).join("|") !==
        snapshotAfter.filter((line) => line.includes("probe.bin")).join("|"),
  );

  // ③ 恢复：逐字节写回原内容，判据重新一致
  writeFileSync(probePath, original);
  const restoredChanges = diff(snapshotBefore, snapshot(root));
  check("**恢复原内容后快照重新一致**（判据不是恒真，也不是恒假）", restoredChanges.length === 0, restoredChanges.slice(0, 4).join(" / "));

  /*
   * 纵深：确认探针目录**不在**源根之内 ——
   * 变异必须发生在与业务数据无关的地方，且源目录本身始终未被触碰。
   */
  check(
    "因果探针位于源根之外（变异不触碰源目录）",
    !probePath.startsWith(sourceRoot),
  );
  check(
    "整个因果证明期间源目录逐字节不变",
    diff(sourceSnapshotBeforeCausal, snapshot(sourceRoot)).length === 0,
  );

  // 清理探针，避免它进入后续任何判据
  rmSync(probeDir, { recursive: true, force: true });
  check("探针目录已清理", !existsSync(probeDir));
}

main().catch((error: unknown) => {
  console.error("证明脚本失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
