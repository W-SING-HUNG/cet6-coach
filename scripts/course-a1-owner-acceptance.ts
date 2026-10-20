#!/usr/bin/env node
/**
 * `pnpm course:a1-acceptance` —— **原生文件夹选择窗口的一次性人工验收**。
 *
 * ── 它为什么存在 ──
 *
 * A1 的完整**原生 GUI** 路径（点按钮 → 系统模态窗口真的出现 →
 * 人选目录 → 路径经协议回传到本机 Node 进程 → 目录树出现）
 * **无法在无界面的自动化环境里验证**（原因见下）。既然不能假装已验证，
 * 就把它降级成一条**一次性人工验收**：使用者 点几下，脚本自动判定结果。
 *
 * ── 为什么不能自动验证（实测事实，不是推测）──
 *
 * | 事实 | 实测结果 | 后果 |
 * | --- | --- | --- |
 * | 本进程所在会话 | **3（Console）** —— 就是使用者的交互桌面 | 不是隔离会话 |
 * | 该桌面上正在发生什么 | 使用者的**实时**应用（Edge 6 个标签、ChatGPT、设置…），前台窗口 6 秒内持续是 Edge | 任何全局输入都打到用户身上 |
 * | OpenInputDesktop | 可打开（`SendInput` 会真的作用于当前桌面） | 合成键鼠**不安全** |
 * | UI Automation | 可用 | 能读，但"点击正确控件"仍需在 使用者 桌面上操作 |
 * | 私有桌面（`CreateDesktopW`） | 可创建、可向其派生进程 | 隔离**理论上**可行 |
 * | 在私有桌面跑生产脚本 | 子进程**立即退出**，`cmd` 报"系统找不到指定的路径" | 会话 0/3 桌面切换下生产脚本的 stdio 契约不成立，无法可靠驱动 |
 * | 图形自动化框架 | **未安装**（无 robotjs / nut.js / pyautogui；`python.exe` 是 0 字节 Store 占位） | 任务书明确禁止为此装重型框架 |
 *
 * 结论：**"真实原生选取"这条路径在本环境里既不能自动化、也不该用合成
 * 输入去碰 使用者的桌面。** 因此它保持**未验证**，并提供本脚本作为
 * 一次性人工验收 —— 而不是静默用 E2E 的预置源根冒充"已验证"。
 *
 * ── 它替 使用者 做完所有工程细节 ──
 *
 * 使用者 **不需要**：创建夹具、看懂日志、写 JSON、理解任何内部概念。
 * 脚本自己：
 * 1. 在系统临时目录里造一份**显眼可辨的合成夹具**（模型上下文之外、不进 Git）；
 * 2. 启动**同一个** A1 工作台（与 `course:workbench` 同一套接线）；
 * 3. 让目录选择窗口**正好开在那份夹具的上一层**（旁边只放一个文件夹）；
 * 4. 自动核对"选中的是不是本次测试目录"、"目录树是否出来了"，并把结果
 *    用大白话打印出来；
 * 5. 退出时删掉整份夹具。
 *
 * ── 隐私（硬约束）──
 *
 * **绝不**读取、打开、上传、截图任何真实课程材料。夹具全部由本脚本生成，
 * 全部在 `os.tmpdir()` 下，全部是合成字节。终端**只打印计数与目录名**，
 * 绝不打印绝对路径、绝不打印课程正文。
 *
 * 用法：
 *
 *   pnpm course:a1-acceptance                # 人工验收（会弹出文件夹选择窗口）
 *   pnpm course:a1-acceptance --self-check   # 自检：**不弹窗口、不开浏览器**
 *
 * `--self-check` 存在的理由：使用者 要运行的这套东西本身必须先被验证过，
 * 否则我等于把一个没跑过的脚本交给 使用者。它真实地跑一遍
 * 夹具构造 → 服务器启动 → 三个端点（含**子集**检查与 `/api/plan` 拒绝），
 * 只是**不调用** `pickFolder()` —— 因此不会在 使用者的桌面上弹出任何窗口。
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { request } from "node:http";
import { newSessionToken, startAnnotationServer, SESSION_TOKEN_HEADER } from "@/content/course-pipeline/segment-server";
import type { AnnotationSession, IntakeCapability } from "@/content/course-pipeline/segment-server";
import { renderIntakeShell } from "@/content/course-pipeline/intake-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
import { resolvePickOutcome } from "@/content/course-pipeline/directory-identity";
import { pickFolder } from "@/content/course-pipeline/folder-picker";
import {
  buildCjkPdf,
  buildMinimalDocx,
  buildSilentWav,
  buildTextPdf,
  writeSourceTree,
} from "./course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "./course-source-fixture";

/** 合成夹具的目录名（**显眼可辨**，绝不冒充任何真实课程）。 */
const FIXTURE_DIR_NAME = "合成测试课程目录-请选择这一个";

/**
 * 造一份**最小的**合成课程目录。
 *
 * 刻意只有 4 个文件：使用者 在窗口里一眼就能数完，而目录树也足够
 * 展示"嵌套目录 + 多类文件"。
 */
function buildOwnerFixture(): Map<string, Buffer> {
  const tree = new Map<string, Buffer>();
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      [
        "SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL",
        "Passage One",
        "Questions 46 to 50 are based on the following passage.",
        ...wrap(FIXTURE_PASSAGE_A),
      ],
    ]),
  );
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["【合成夹具】翻译练习 · 请勿当真", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)],
      ["参考译文", ...wrapCjk(FIXTURE_TRANSLATION_REFERENCE)],
    ]),
  );
  tree.set(
    "写作/writing-template.pdf",
    buildTextPdf([
      ["Writing Template", "Introduction: state the topic and your position in one sentence."],
    ]),
  );
  tree.set("阅读/shared-handout.docx", buildMinimalDocx("synthetic deferred docx"));
  tree.set("听力/listening-sample.wav", buildSilentWav(0.1));
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

function line(text = ""): void {
  console.log(text);
}

/** 真实 HTTP 请求（`--self-check` 用；与 `course:a1-proof` 同一手法）。 */
function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * `--self-check`：验证**这套验收程序本身**能跑通，但**不弹任何窗口**。
 *
 * 它真实地做：造夹具 → 启动同一个服务器 → 走三个端点（状态 / 元数据 / 范围检查）
 * → 断言 `/api/plan` 被拒 → 断言源目录逐字节未变 → 删夹具。
 * 它刻意**不调用** `pickFolder()`：那会在 使用者的桌面上弹出一个窗口。
 */
async function selfCheck(): Promise<void> {
  const runRoot = mkdtempSync(join(tmpdir(), "cet6-a1-selfcheck-"));
  const fixtureRoot = join(runRoot, FIXTURE_DIR_NAME);
  const fixtureTree = buildOwnerFixture();
  writeSourceTree(fixtureRoot, fixtureTree);

  let passed = 0;
  let failed = 0;
  const check = (label: string, ok: boolean, detail?: string): void => {
    if (ok) { passed += 1; line(`  ✓ ${label}`); }
    else { failed += 1; line(`  ✗ ${label}${detail === undefined ? "" : ` —— ${detail}`}`); }
  };

  line("A1 人工验收程序 · 自检（**不弹窗口、不开浏览器**）");
  line();

  // 夹具的**起点**快照（用于证明整轮自检没有改动源目录）
  const { readdirSync: rd, readFileSync: rf, statSync: st } = await import("node:fs");
  const { createHash: ch } = await import("node:crypto");
  const fixtureBefore = ((): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of rd(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { out.push(`D:${e.name}`); walk(full); }
        else out.push(`F:${e.name}:${st(full).size}:${ch("sha256").update(rf(full)).digest("hex")}`);
      }
    };
    walk(fixtureRoot);
    return out;
  })();

  let sourceRoot: string | null = fixtureRoot;
  let savedCalled = false;
  const capability: IntakeCapability = {
    async pickFolder() {
      // 自检里**绝不**调用真实 pickFolder —— 那会在 使用者 桌面上弹窗
      throw new Error("self-check 不得弹出窗口");
    },
    rememberSource(p: string) { sourceRoot = p; },
    sourceLabel() { return sourceRoot === null ? null : basename(sourceRoot); },
    hasSource() { return sourceRoot !== null && existsSync(sourceRoot); },
    async browse() {
      if (sourceRoot === null) throw new Error("还没有选择课程目录");
      return inspectSourceTree(sourceRoot);
    },
    async inspect(selection) {
      if (sourceRoot === null) throw new Error("还没有选择课程目录");
      return runInspection({ sourceRoot, courseId: "a1-acceptance", selection });
    },
    forgetSource() { sourceRoot = null; },
  };

  const token = newSessionToken();
  const session: AnnotationSession = {
    token,
    courseId: "a1-acceptance",
    sourceDigest: "",
    config: { courseId: "a1-acceptance", sourceDigest: "", assets: [], existingPlan: null },
    savePlan() {
      savedCalled = true;
      return { ok: false, detail: "A1 只读工作台不具备保存计划的能力（这是设计，不是错误）。", planDigest: "" };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: 0,
    page: () => renderAnnotationShell(),
    intakePage: () => renderIntakeShell(),
  });

  try {
    const origin = `http://127.0.0.1:${handle.port}`;
    const jsonHeaders = { "content-type": "application/json", [SESSION_TOKEN_HEADER]: token, origin };

    // 夹具
    check(`夹具含 ${fixtureTree.size} 个文件`, fixtureTree.size >= 4);
    check("夹具目录名显眼可辨（合成）", FIXTURE_DIR_NAME.includes("合成测试"));

    // 静态外壳
    const page = await rawRequest(handle.port, "/intake");
    check("`GET /intake` ⇒ 200（静态外壳）", page.status === 200, `实际 ${page.status}`);
    check("外壳不含会话 token", !page.body.includes(token));
    check("外壳不含绝对路径", !page.body.includes(runRoot) && !/[A-Za-z]:\\/.test(page.body));

    // 状态端点
    const state = await rawRequest(handle.port, "/api/intake/state", { headers: { [SESSION_TOKEN_HEADER]: token } });
    check("`GET /api/intake/state` 带 token ⇒ 200", state.status === 200, `实际 ${state.status}`);

    // 元数据端点
    const meta = await rawRequest(handle.port, "/api/intake/browse", { headers: { [SESSION_TOKEN_HEADER]: token } });
    const metaBody = JSON.parse(meta.body) as { ok: boolean; metadata: { files: unknown[] } };
    check("元数据端点返回全部夹具文件", metaBody.ok && metaBody.metadata.files.length === fixtureTree.size);

    // 范围检查（**子集**：验证 使用者 第 ④ 步真的会发生什么）
    const subset = await rawRequest(handle.port, "/api/intake/inspect", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ includeDirectories: [""], excludeFiles: ["阅读/shared-handout.docx"] }),
    });
    const subsetBody = JSON.parse(subset.body) as {
      ok: boolean;
      result: { counts: { selected: number; excluded: number }; materials: unknown[] };
    };
    check("子集检查 ⇒ 200", subset.status === 200, `实际 ${subset.status}`);
    check("排除一个文件后计数正确", subsetBody.result.counts.excluded === 1 && subsetBody.result.counts.selected === fixtureTree.size - 1,
      JSON.stringify(subsetBody.result.counts));
    check("检查响应不含绝对路径", !subset.body.includes(runRoot));

    // A1 必须拒绝保存
    const save = await rawRequest(handle.port, "/api/plan", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        author: "self-check",
        reason: "self-check",
        units: [{ title: "u", kind: "translation_passage", assignments: [{ channel: "source", assetKey: "k", page: 1, lineStart: 1, lineEnd: 2, note: null }] }],
      }),
    });
    check("`/api/plan` 被拒（400）", save.status === 400, `实际 ${save.status}`);
    check("拒绝确实走了 A1 的 savePlan", savedCalled);

    // 源目录只读：**前后完整对照**（这条断言不能是"长度 > 0"那种空判据）
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          out.push(`D:${e.name}`);
          walk(full, out);
        } else {
          const bytes = readFileSync(full);
          out.push(`F:${e.name}:${statSync(full).size}:${createHash("sha256").update(bytes).digest("hex")}`);
        }
      }
      return out;
    };
    check("检查期间源目录逐字节不变", JSON.stringify(walk(fixtureRoot)) === JSON.stringify(fixtureBefore));
    check("自检没有创建任何 courses/ / 候选 / 计划",
      !existsSync(join(runRoot, "courses")) &&
      !existsSync(join(runRoot, "course-candidates")) &&
      !existsSync(join(runRoot, "course-segmentation-plans")));
  } finally {
    await handle.close();
    rmSync(runRoot, { recursive: true, force: true });
  }

  line();
  line(`自检结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-check")) {
    await selfCheck();
    return;
  }

  // ── 1) 造夹具（全部在系统临时目录里）──
  const runRoot = mkdtempSync(join(tmpdir(), "cet6-a1-owner-"));
  const fixtureRoot = join(runRoot, FIXTURE_DIR_NAME);
  const fixtureTree = buildOwnerFixture();
  writeSourceTree(fixtureRoot, fixtureTree);
  const expectedFileCount = fixtureTree.size;

  line("CET-6 Coach · 课程材料只读检查工作台 · **原生文件夹选择窗口**人工验收");
  line("（全部内容都是合成测试夹具，不是任何真实课程材料）");
  line();
  line("────────────────────────────────────────────────────────────");
  line("请照着做（一共 5 步，大约 1 分钟）：");
  line();
  line(`  ①  程序马上会弹出「选择文件夹」窗口。`);
  line(`  ②  在窗口里选中这个文件夹：${FIXTURE_DIR_NAME}`);
  line(`      （窗口已经开在它旁边，里面只有这一个文件夹，双击进入再点「选择文件夹」即可）`);
  line(`  ③  页面上应出现「已选择：${FIXTURE_DIR_NAME}」，并列出 ${expectedFileCount} 个文件。`);
  line(`  ④  随便去掉一两个文件的勾（点文件名前面的方框），然后点「检查所选材料」。`);
  line(`  ⑤  看到「检查完成」以及四张统计卡片 = 通过。`);
  line();
  line("  想额外试「取消」也可以：再点一次「选择课程文件夹…」，直接关掉窗口，");
  line("  页面应显示「没有选择文件夹（已取消）」，然后可以再点一次重试。");
  line("────────────────────────────────────────────────────────────");
  line();
  line("  注意：这个程序**只读**。它不会修改、保存或导入任何东西。");
  line("        这个文件夹是程序刚造出来的临时夹具，退出时会自动删除。");
  line();

  // ── 2) 与 course:workbench **同一套**接线 ──
  let sourceRoot: string | null = null;
  let pickedCorrectly = false;
  let inspectionRan = false;
  let pickerAttempts = 0;
  let pickerOutcome: string | null = null;
  let newFolderHidden: boolean | null = null;

  const capability: IntakeCapability = {
    async pickFolder() {
      pickerAttempts += 1;
      // 让窗口正好开在夹具的上一层（旁边只放一个文件夹，不容易选错）
      const picked = await pickFolder({ startDirectory: runRoot });
      pickerOutcome = picked.outcome;
      newFolderHidden = picked.newFolderButtonHidden;

      /*
       * ── 所有结局都经**唯一一个**决策点收敛 ──
       *
       * 这样"能不能读盘"这件事只有一个实现（`resolvePickOutcome`），
       * 而它被单元测试按**行为**穷举 —— 不再依赖源码模式匹配。
       */
      const resolution = resolvePickOutcome({
        outcome: picked.outcome,
        pickedPath: picked.outcome === "selected" ? picked.path : null,
        expectedRoot: fixtureRoot,
        expectedLabel: FIXTURE_DIR_NAME,
        currentSource: sourceRoot,
      });

      if (resolution.kind === "confirmed") {
        /*
         * ── 自动核对：选中的是不是**本次**创建的那个目录 ──
         *
         * **只比目录名是不够的**（这正是本轮的修复点）：机器上任何地方
         * 只要有一个**同名**目录，旧判据就会接受它，随后读取并检查
         * 那个目录的内容 —— 而它可能根本不是本次夹具。
         *
         * 现在改用**真实路径身份**判定（`directory-identity.ts`）：
         * 两侧都经 `realpathSync.native` 归一后逐字符比较，
         * 并用 `path.relative` 交叉复核。任一环节无法确认即**拒绝**。
         *
         * 它是 **metadata-only** 的：只碰目录项元数据（`realpath` / `stat`），
         * **绝不打开文件、绝不枚举内容**。因此"校验通过之前不读取任何内容"
         * 是一条**结构性**事实。
         */
        pickedCorrectly = true;
        sourceRoot = resolution.nextSource;
        line(`  ✓ ${resolution.message}`);
        // 只把**身份已确认**的规范化真实路径交回
        return { ...picked, path: resolution.nextSource };
      }

      if (resolution.kind === "rejected") {
        pickedCorrectly = false;
        /*
         * 拒绝 ⇒ **清空**已记住的源（严格失败关闭）。
         *
         * 这样"界面显示拒绝"与"会话里没有可读的目录"是同一件事 ——
         * 否则 使用者 会看到一条错误，却在下方仍能对**上一个**目录继续
         * 检查，那不是诚实的失败关闭。
         */
        sourceRoot = resolution.nextSource;
        line(`  ✗ ${resolution.message}`);
        return { ...picked, path: null };
      }

      if (resolution.kind === "cancelled") {
        // 取消**不是错误**：处置与重试方式保持不变（源按原样保留）
        sourceRoot = resolution.nextSource;
        line(`  · ${resolution.message}`);
        return picked;
      }

      // 对话框打不开（平台/桌面/超时）：处置与重试方式保持不变
      sourceRoot = resolution.nextSource;
      line(`  ✗ ${resolution.message}`);
      line(`    ${picked.detail}`);
      line("    处置：再点一次「选择课程文件夹…」重试。若一直打不开，");
      line("          请确认这是正常的桌面登录会话（远程/无桌面会话下系统窗口无法显示）。");
      return picked;
    },
    rememberSource(sourcePath: string) {
      sourceRoot = sourcePath;
    },
    sourceLabel() {
      return sourceRoot === null ? null : basename(sourceRoot);
    },
    hasSource() {
      return sourceRoot !== null && existsSync(sourceRoot);
    },
    async browse() {
      if (sourceRoot === null) throw new Error("还没有选择课程目录");
      const tree = inspectSourceTree(sourceRoot);
      line(`  ✓ 目录内容已读出：${tree.files.length} 个文件（页面右侧/下方应显示同样的数量）。`);
      return tree;
    },
    async inspect(selection) {
      if (sourceRoot === null) throw new Error("还没有选择课程目录");
      const result = await runInspection({ sourceRoot, courseId: "a1-acceptance", selection });
      inspectionRan = true;
      line(`  ✓ 只读检查完成：读了 ${result.counts.selected} 个文件、跳过 ${result.counts.excluded} 个。`);
      line(`    过程里没有修改、保存或导入任何东西。`);
      return result;
    },
    forgetSource() {
      sourceRoot = null;
    },
  };

  const token = newSessionToken();
  const session: AnnotationSession = {
    token,
    courseId: "a1-acceptance",
    sourceDigest: "",
    config: { courseId: "a1-acceptance", sourceDigest: "", assets: [], existingPlan: null },
    // A1 模式：**无条件**拒绝保存（与 course:workbench 一字不差的语义）
    savePlan() {
      return { ok: false, detail: "A1 只读工作台不具备保存计划的能力（这是设计，不是错误）。", planDigest: "" };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: 0,
    page: () => renderAnnotationShell(),
    intakePage: () => renderIntakeShell(),
  });

  const url = `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`;
  line("【已经打开工作台】");
  line(`  ${url}`);
  line();
  line("  如果浏览器没有自动打开，请把上面这一整行复制到浏览器地址栏（# 之后也要复制）。");
  line();

  // 自动打开浏览器（尽力而为；失败不影响使用）
  try {
    const { spawn } = await import("node:child_process");
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    line("（未能自动打开浏览器 —— 请手动粘贴上面的网址。）");
  }

  // ── 3) 收尾：判定 + 清理 ──
  const summarize = (): void => {
    line();
    line("════════════════════════════════════════════════════════════");
    line("验收结果");
    line("════════════════════════════════════════════════════════════");
    line(`  文件夹选择窗口是否弹出：${pickerAttempts > 0 ? `是（试了 ${pickerAttempts} 次，最后一次结果：${pickerOutcome ?? "未知"}）` : "没有试过"}`);
    line(`  选中的是否是本次测试目录：${pickedCorrectly ? "是" : "否"}`);
    if (newFolderHidden === true) {
      line("  「新建文件夹」按钮是否已隐藏：是（本工具绝不在课程目录里建东西）");
    } else if (newFolderHidden === false) {
      line("  「新建文件夹」按钮是否已隐藏：**否** —— 这个宿主没有兑现该约束，请报告给维护者");
    } else {
      line("  「新建文件夹」按钮是否已隐藏：未知（窗口没成功弹出）");
    }
    line(`  是否真的完成过一次只读检查：${inspectionRan ? "是" : "否"}`);
    line();
    if (pickerAttempts > 0 && pickedCorrectly && inspectionRan) {
      line("  ✅ 这一轮看起来**全部通过**。请把上面这几行原文附到评审记录里。");
    } else {
      line("  ⚠️ 这一轮没有全部走完。请把上面这几行原文附到评审记录里（这不算失败，只是没走完）。");
    }
    line();
    line("说明：这只是**人工验收**，不是自动测试。在真正走完之前，");
    line("      「原生文件夹选择窗口」这条路径在项目里仍然记为**未验证**。");
    line("════════════════════════════════════════════════════════════");
  };

  const shutdown = (code: number): void => {
    summarize();
    try {
      if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
      line();
      line(`（临时测试文件夹已删除：${FIXTURE_DIR_NAME}）`);
    } catch {
      line(`（临时测试文件夹未能自动删除，可手动删除它：${FIXTURE_DIR_NAME}）`);
    }
    void handle.close().then(() => process.exit(code));
  };

  process.on("SIGINT", () => shutdown(0));
  line("做完上面 5 步之后，回到这个窗口按 Ctrl+C 结束并查看结果。");
  line();
  // 常驻，直到 使用者 按 Ctrl+C；结束时打印判定并删除夹具。
  await new Promise<void>(() => {
    /* 有意永不 resolve */
  });
}

main().catch((error: unknown) => {
  console.error("验收程序启动失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
