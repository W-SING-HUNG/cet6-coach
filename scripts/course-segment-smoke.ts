#!/usr/bin/env node
/**
 * `pnpm course:segment` 的**本地冒烟验证**（合成夹具，非真实材料）。
 *
 * 目的：证明"启动标注服务器 → 页面可达 → 守卫生效 → 保存计划"
 * 这条链路在**真实进程**上成立。它不是替代单元测试，
 * 而是补上"守卫函数接在请求路径上"这一层。
 *
 * ── Level-C 复评后新增的两类证明（F1 / F4 / F7）──
 *
 * 1. **F1：服务端真实发出的客户端脚本必须能被 JS 引擎编译。**
 *    旧的 HTTP-200 + 正则断言证明不了"页面能用" —— 实测缺陷正是
 *    HTTP 200、断言全绿、而 `new Function(script)` 抛 `SyntaxError`、
 *    整页交互全死。
 *
 *    这里从**真实 HTTP 响应字节**里抽出内联脚本，交给 **V8 自己**
 *    编译（`node:vm` 的 `Script`，与 `new Function` 等价）。
 *    "页面在真实 DOM 里执行、按钮真的有反应" 由
 *    `tests/course-segment-page-execution.test.ts`（jsdom 环境）覆盖。
 *
 * 2. **F4：未认证端点不得携带私有正文与 token。**
 *    断言 `GET /`（不带任何凭据）的字节里既没有课程正文、也没有 token、
 *    也没有源绝对路径；并断言 `GET /api/bootstrap` 无 token 时被拒。
 *
 * 全部内容为合成夹具；不触碰 使用者 真实 private-content 或数据库。
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { scanSourceDirectory } from "@/content/course-pipeline/sources";
import { extractPdfPages } from "@/content/course-pipeline/pdf-extract";
import { parseSegmentationPlan, segmentationPlanDigest, validatePlanShape } from "@/content/course-pipeline/segmentation-plan";
import { newSessionToken, startAnnotationServer } from "@/content/course-pipeline/segment-server";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { writeSourceTree } from "./course-source-fixture";
import { twoUnitTranslationFixture, MULTI_UNIT_HEADER } from "./course-source-scenarios";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`);
  }
}

/** 从 HTML 里抽出内联 `<script>` 的内容（页面只有一段，且不含 src）。 */
export function extractInlineScript(html: string): string | null {
  const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  return match === null ? null : match[1];
}

/**
 * 发一个**真实 HTTP** 请求，允许覆盖 Host 头。
 *
 * `fetch` 会忽略/禁止自定义 `Host`（它是禁止修改的请求头之一），
 * 因此"非回环 Host 必须被拒"这条守卫**无法**用 fetch 验证 ——
 * 必须用底层 `node:http`。这也更贴近真实攻击面（原始 TCP 请求
 * 本来就可以带任意 Host）。
 */
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

/**
 * 在 jsdom 之外做**引擎级语法门禁**的说明（见文件头）：
 *
 * 这里不再自带 DOM 模拟。真实 DOM 执行（渲染行数、按钮点击真的生效）
 * 由 `tests/course-segment-page-execution.test.ts` 覆盖 —— 那边用
 * vitest 的 `jsdom` 环境，因而不需要给 jsdom 装类型（本项目零新增依赖）。
 */

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cet6-segment-smoke-"));
  const sourceRoot = join(root, "source");
  writeSourceTree(sourceRoot, twoUnitTranslationFixture());

  console.log("本地标注工具冒烟验证（**合成夹具**，非真实材料）\n");

  // ── 1) 抽取（与 course:segment 同一套实现）──
  const inventory = scanSourceDirectory(sourceRoot);
  const asset = inventory.assets.find((a) => a.kind === "pdf")!;
  const document = await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/")));
  const lineCountByPage = new Map<number, number>();
  for (const page of document.pages) if (page.hasTextLayer) lineCountByPage.set(page.page, page.lines.length);

  console.log("一、抽取");
  check("清点出 1 个 PDF 资产", inventory.assets.length === 1);
  check("抽出 4 页且全部有文本层", document.pages.length === 4 && document.pages.every((p) => p.hasTextLayer));

  // ── 2) 启动服务器（端口 0 ⇒ 系统分配）──
  const planPath = join(root, "plan.json");
  const token = newSessionToken();
  const config = {
    courseId: "smoke-course",
    sourceDigest: inventory.digest,
    assets: [
      {
        assetKey: asset.assetKey,
        label: asset.basename,
        sha256: asset.sha256,
        pages: document.pages.map((p) => ({ page: p.page, hasTextLayer: p.hasTextLayer, lines: p.hasTextLayer ? p.lines : [] })),
      },
    ],
    existingPlan: null,
  };
  const session = {
    token,
    courseId: config.courseId,
    sourceDigest: config.sourceDigest,
    config,
    savePlan(plan: Record<string, unknown>) {
      const shape = validatePlanShape(plan);
      if (!shape.ok || shape.plan === null) {
        return { ok: false, detail: `形状不合法：${shape.issues.map((i) => i.code).join("、")}`, planDigest: "" };
      }
      writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      return { ok: true, detail: "已写入（冒烟用）", planDigest: segmentationPlanDigest(shape.plan) };
    },
  };

  const handle = await startAnnotationServer(session, { port: 0, page: () => renderAnnotationShell() });

  console.log("\n二、服务器绑定");
  check("URL 使用回环地址", handle.url.startsWith("http://127.0.0.1:"));
  check("**token 在 URL fragment 里**（不是查询串）", handle.url.includes("#token=") && !handle.url.includes("?token="));
  check("端口由系统分配（非 0）", handle.port > 0);
  /*
   * ── F7：回环证明必须看**真实绑定地址** ──
   *
   * `boundAddress` 来自 `server.address()`。若把 `listen` 改成 0.0.0.0，
   * 这里会如实变成 `0.0.0.0` —— 因此这条断言在那种改动下**会红**。
   * （"回显常量"的写法在同样改动下仍然显示 127.0.0.1，证明不了任何事。）
   */
  check("实际绑定地址是回环（来自 server.address()）", handle.boundAddress === "127.0.0.1");

  // ── 3) 守卫：非回环 Host 必须被拒绝 ──
  console.log("\n三、请求守卫（真实 HTTP）");
  // `fetch` 禁止自定义 Host ⇒ 必须用原始请求来验证这条守卫
  const foreignHost = await rawRequest(handle.port, "/", { headers: { host: "evil.example" } });
  check("非回环 Host ⇒ 403", foreignHost.status === 403);

  const foreignOrigin = await rawRequest(handle.port, "/api/bootstrap", {
    headers: { origin: "https://evil.example", "x-cet6-session-token": token },
  });
  check("非回环 Origin ⇒ 403", foreignOrigin.status === 403);

  // 回环 Host + 无 Origin 是正常的（同源 GET）
  const loopbackOnly = await rawRequest(handle.port, "/");
  check("回环 Host ⇒ 页面可访问", loopbackOnly.status === 200);

  // ── 4) F4：未认证页面**不含任何私有数据** ──
  console.log("\n四、未认证页面（静态外壳）");
  const page = await fetch(`http://127.0.0.1:${handle.port}/`);
  const html = await page.text();
  check("GET / ⇒ 200", page.status === 200);
  check("Cache-Control: no-store", page.headers.get("cache-control") === "no-store");
  check("带 CSP 且默认拒绝外部", (page.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));
  check("带 Referrer-Policy: no-referrer", page.headers.get("referrer-policy") === "no-referrer");
  check("HTML 不含外部 script src", !/<script\s+[^>]*\bsrc=/i.test(html));
  check("HTML 不含外部 link href", !/<link\s+[^>]*\bhref=/i.test(html));

  /*
   * ── F4 的核心断言：未认证 GET / 不得含私有内容与写凭据 ──
   *
   * 这三条正是被复评证明的缺陷形态（旧实现把正文与 token 都塞进了页面）。
   */
  check("**未认证页面不含会话 token**", !html.includes(token));
  check(
    "**未认证页面不含课程正文**",
    !html.includes("城市轨道交通") && !html.includes(MULTI_UNIT_HEADER) && !html.includes("Operators of urban rail"),
  );
  check("**未认证页面不含源绝对路径**", !html.includes(root) && !/[A-Za-z]:\\\\/.test(html));
  check("未认证页面不含任何资产行文本", !document.pages.some((p) => p.lines.some((line) => line.length > 10 && html.includes(line))));

  /*
   * ── 产品语言门禁（这一轮新增）──
   *
   * 使用者 第一次打开页面时看不懂它 —— 根因之一就是**可见标签用的是内部枚举名**。
   * 因此这里对**真实响应字节**断言：四类控件显示的是中文产品语言，
   * 而 `source` / `ignored_furniture` 这类名字**只**允许出现在
   * 不可见的 `data-channel` 属性里。
   *
   * 判据刻意不写成"HTML 里不含 source" —— 那样会误伤属性与说明文字。
   * 真正的判据是：**可见文本**（标签与解释句）里不得出现英文枚举名。
   */
  console.log("\n四·补充、产品语言（可见标签不得是内部枚举名）");
  for (const visible of ["中文原文", "课程参考译文", "老师讲解 / 语言点", "页眉页脚（忽略）"]) {
    check(`可见标签「${visible}」存在`, html.includes(visible));
  }
  // 四类控件必须各带一句解释（`.cat-help` 的文案）
  check("页眉页脚带一句人能懂的解释", html.includes("每页重复出现、不是课程正文的内容"));
  check("参考译文说明可以跳过", html.includes("没有可以跳过"));
  /*
   * 判据：**标签文本**里不得出现内部枚举名。用带尖括号的标签形态来锚定，
   * 避免把 `data-channel="source"`（不可见属性）与脚本里的同名常量误判成泄露。
   */
  check(
    "可见标签里没有英文枚举名",
    !/>\s*(Source|Reference Translation|Notes|Furniture|source|notes|ignored_furniture)\s*</.test(html),
  );
  // 「怎么用？」与首次打开的引导都必须在**静态外壳**里（它无需凭据即可取得）
  check("带首次打开的引导标题", html.includes("把这份讲义分成一份份翻译练习"));
  check("带三步引导", html.includes("① 新建一份练习") && html.includes("② 标出原文、参考译文和老师讲解") && html.includes("③ 全部处理完后检查并保存"));
  check("带「开始标注」主按钮", html.includes("开始标注"));
  check("带可重开的「怎么用？」控件", html.includes("怎么用？"));
  // 主操作与保存文案必须是产品语言
  check("新建练习的文案是产品语言", html.includes("+ 新建一份翻译练习"));
  check("保存文案是「检查并保存」", html.includes("检查并保存"));
  check("带「撤销上一步」", html.includes("撤销上一步"));

  // ── 5) F4：未认证的 bootstrap 必须被拒 ──
  console.log("\n五、私有引导端点（token 保护）");
  const noToken = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap`);
  check("无 token 读引导数据 ⇒ 403", noToken.status === 403);
  const badToken = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap`, {
    headers: { "x-cet6-session-token": `${token}x` },
  });
  check("错误 token 读引导数据 ⇒ 403", badToken.status === 403);
  // 查询串里的 token **不算**（它会被跨站请求带上）
  const queryToken = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap?token=${token}`);
  check("查询串 token 不得用于读鉴权 ⇒ 403", queryToken.status === 403);
  const withToken = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap`, {
    headers: { "x-cet6-session-token": token },
  });
  check("带 token 读引导数据 ⇒ 200", withToken.status === 200);
  const bootstrapPayload = (await withToken.json()) as { ok: boolean; assets: unknown[] };
  check("返回资产（正文只发给本机浏览器）", bootstrapPayload.ok && bootstrapPayload.assets.length === 1);

  // ── 6) F1：真实响应字节里的内联脚本必须能被 **JS 引擎**编译 ──  console.log("\n六、F1 客户端脚本（从真实响应字节抽出，交给 V8 编译）");
  const inlineScript = extractInlineScript(html);
  check("响应里能抽出一段内联脚本", inlineScript !== null && inlineScript.length > 1000);
  if (inlineScript !== null) {
    /*
     * ── 这条断言就是 F1 的机械守卫 ──
     *
     * 缺陷形态：外层模板字符串吃掉 `\n`，产出的内联 JS 里字符串字面量
     * 被换行截断 ⇒ `Script` 抛 `SyntaxError` ⇒ 整页交互全死，而 HTTP 200。
     *
     * `node:vm` 的 `Script` 与浏览器 `new Function` 走同一个解析器，
     * 因此"能编译"就是"浏览器能执行"的进程内证据。
     */
    let compileError: string | null = null;
    try {
      new Script(inlineScript, { filename: "annotation-page-inline.js" });
    } catch (error) {
      compileError = (error as Error).message;
    }
    check(
      `内联脚本可被 V8 编译${compileError === null ? "" : `（实际报错：${compileError}）`}`,
      compileError === null,
    );
    // 不得含 token / 正文 / 绝对 URL（脚本里只有同源 fetch）
    check("脚本里不含会话 token", !inlineScript.includes(token));
    check("脚本里不含课程正文", !inlineScript.includes("城市轨道交通") && !inlineScript.includes(MULTI_UNIT_HEADER));
    check("脚本里不含外部绝对 URL", !/["'`]https?:\/\//.test(inlineScript));
    check("脚本里不含 console 调用", !/console\.(log|info|debug|warn|error)\s*\(/.test(inlineScript));
    // 读私有数据的路径必须是**带 token 的 API**，不是页面内嵌
    check("脚本经 /api/bootstrap 取私有数据", inlineScript.includes("/api/bootstrap"));
  }

  // ── 7) 写端点：token 保护 + 服务端重建 binding ──
  console.log("\n七、写端点（token 保护）");
  const furniture = [1, 2, 3, 4].map((p) => ({
    channel: "ignored_furniture",
    assetKey: asset.assetKey,
    page: p,
    lineStart: 1,
    lineEnd: 1,
    note: "重复页眉",
  }));
  const body = {
    author: "smoke",
    reason: "冒烟验证",
    // 浏览器**试图**伪造 binding —— 服务端必须忽略它
    binding: { courseId: "HOSTILE", sourceDigest: "f".repeat(64), assets: [] },
    units: [
      {
        title: "练习 1",
        kind: "translation_passage",
        assignments: [
          { channel: "source", assetKey: asset.assetKey, page: 1, lineStart: 2, lineEnd: lineCountByPage.get(1)!, note: null },
          { channel: "reference_translation", assetKey: asset.assetKey, page: 2, lineStart: 2, lineEnd: lineCountByPage.get(2)!, note: null },
          ...furniture,
        ],
      },
      {
        title: "练习 2",
        kind: "translation_passage",
        assignments: [
          { channel: "source", assetKey: asset.assetKey, page: 3, lineStart: 2, lineEnd: lineCountByPage.get(3)!, note: null },
          { channel: "reference_translation", assetKey: asset.assetKey, page: 4, lineStart: 2, lineEnd: lineCountByPage.get(4)!, note: null },
        ],
      },
    ],
  };

  const badWrite = await fetch(`http://127.0.0.1:${handle.port}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  check("写操作缺 token ⇒ 403", badWrite.status === 403);
  check("被拒绝时不写盘", !existsSync(planPath));

  const goodWrite = await fetch(`http://127.0.0.1:${handle.port}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cet6-session-token": token },
    body: JSON.stringify(body),
  });
  const writeResult = (await goodWrite.json()) as { ok: boolean; planDigest: string };
  check("带 token 写 ⇒ 200", goodWrite.status === 200 && writeResult.ok);
  check("回传计划校验和", /^[0-9a-f]{64}$/.test(writeResult.planDigest));
  check("计划已落盘", existsSync(planPath));

  // ── 8) 落盘的计划：服务端重建了 binding（忽略浏览器的伪造值）──
  const saved = parseSegmentationPlan(readFileSync(planPath, "utf8"));
  console.log("\n八、落盘计划");
  check("落盘计划可被解析", saved.ok && saved.plan !== null);
  check("binding.courseId 来自服务端（不是浏览器伪造的 HOSTILE）", saved.plan!.binding.courseId === "smoke-course");
  check("binding.sourceDigest 来自当前源", saved.plan!.binding.sourceDigest === inventory.digest);
  check("binding.assets 来自服务端校验和", saved.plan!.binding.assets[0].sha256 === asset.sha256);
  check("两个单元都在", saved.plan!.units.length === 2);
  check("计划校验和与回传值一致", segmentationPlanDigest(saved.plan!) === writeResult.planDigest);

  // ── 9) 计划里没有绝对路径、没有本机布局 ──
  const raw = readFileSync(planPath, "utf8");
  check("计划里不含绝对路径", !/[A-Za-z]:\\\\|\\\\Users\\\\|\/home\//.test(raw));
  check("计划里不含临时目录根名", !raw.includes(root.split(/[\\/]/).pop()!));
  /*
   * 注意判据必须是"**路径形态**"，不是"出现过某个词"。
   * 源根目录名恰好是 `source`，而 `"channel": "source"` 是**契约里的通道名**
   * ——用"出现过 source"当判据会误伤它（本条第一次就是这么红的）。
   * 真正的判据是：有没有出现**路径分隔**的形态（`/source/` 或 `\source\`）。
   */
  check("计划里不含源目录**路径**", !/[\\/]source[\\/]/.test(raw));
  check("计划里不含页眉正文（结构里没有课程文本）", !raw.includes(MULTI_UNIT_HEADER));
  check("计划里不含任何中文原文/译文（纯结构文件）", !raw.includes("城市轨道交通") && !raw.includes("Operators of urban rail"));

  await handle.close();
  rmSync(root, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("冒烟验证失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
