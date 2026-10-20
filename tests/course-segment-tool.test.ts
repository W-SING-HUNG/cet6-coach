import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Script } from "node:vm";
import { getCourseCandidatesDir, getCourseSegmentationPlansDir } from "@/content/paper/paths";
import { SEGMENTATION_PLAN_SCHEMA_VERSION, validatePlanShape } from "@/content/course-pipeline/segmentation-plan";
import {
  LOOPBACK_HOST,
  SESSION_TOKEN_HEADER,
  buildPlanFromSubmission,
  isAcceptableOrigin,
  isLoopbackHost,
  newSessionToken,
  startAnnotationServer,
  tokenMatches,
} from "@/content/course-pipeline/segment-server";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { ANNOTATION_CLIENT_SCRIPT } from "@/content/course-pipeline/segment-client-script";

/**
 * 本地标注工具（`pnpm course:segment`）的安全与隐私边界测试。
 *
 * ── 为什么这个工具值得单独的测试文件 ──
 *
 * 它在这个项目里是**唯一**会把私有付费材料显示在浏览器里的组件，
 * 也是**唯一**有一个网络监听端口的组件。因此它的安全属性
 * （只监听回环、token 保护写操作、零外部资源、不打印正文）
 * 是**产品契约**，不是实现细节。
 *
 * ── 断言落在哪一层 ──
 *
 * 守卫函数（Host / Origin / token）是**纯函数**，直接断言
 * （真实启动服务器再发请求也能测，但那样测到的是 Node 的 http 栈，
 * 而我们真正要固定的是"判据本身"）。源码级门禁负责"这些守卫确实
 * 被接在请求路径上、且没有别的出口"。
 */

// ---------------------------------------------------------------------------
// 请求守卫
// ---------------------------------------------------------------------------

describe("本地标注服务器 · 请求守卫", () => {
  it("只接受回环 Host（挡 DNS rebinding）", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:8080", "localhost", "localhost:3000", "[::1]:9000"]) {
      expect(isLoopbackHost(host), `${host} 应被接受`).toBe(true);
    }
    for (const host of [
      "evil.example",
      "0.0.0.0:8080",
      "192.168.1.5:8080",
      "127.0.0.1.evil.com",
      "example.com:127.0.0.1",
      "",
      undefined,
    ]) {
      expect(isLoopbackHost(host), `${JSON.stringify(host)} 必须被拒绝`).toBe(false);
    }
  });

  it("只接受回环 Origin；缺失 Origin 允许（同源 GET / 命令行客户端）", () => {
    expect(isAcceptableOrigin(undefined)).toBe(true);
    expect(isAcceptableOrigin("")).toBe(true);
    expect(isAcceptableOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isAcceptableOrigin("http://localhost:8080")).toBe(true);
    expect(isAcceptableOrigin("http://[::1]:8080")).toBe(true);
    // 外部来源必须被拒绝（那是"某个别的页面在替你发请求"）
    expect(isAcceptableOrigin("https://evil.example")).toBe(false);
    expect(isAcceptableOrigin("not a url")).toBe(false);
  });

  it("会话 token 不可猜测、比较是定长的、任何错误 token 一律拒绝", () => {
    const token = newSessionToken();
    expect(token.length, "32 字节 base64url ⇒ 至少 40 字符").toBeGreaterThanOrEqual(40);
    expect(newSessionToken()).not.toBe(token);

    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(token, "")).toBe(false);
    // 少一位 / 多一位 / 同位不同值 都必须拒绝（防止前缀匹配这类缺陷）
    expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(tokenMatches(token, `${token}x`)).toBe(false);
    expect(tokenMatches(token, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBe(false);
  });

  it("服务端**忽略**浏览器送来的 binding，一律按当前源快照重建", () => {
    /*
     * ── 这条守的是什么 ──
     *
     * 一个打开很久的页面可能带着**过期的**源摘要提交。若服务端信任它，
     * 就会写出一份"看起来有效"的陈旧计划 —— 而它会在下一次抽取时
     * 悄悄把旧坐标套到新源上（正是本任务最不能接受的形态）。
     *
     * 因此 binding 必须由服务端按**当前时刻**重建。
     */
    const plan = buildPlanFromSubmission({
      submitted: {
        author: "owner",
        reason: "r",
        units: [
          {
            title: "u",
            kind: "translation_passage",
            assignments: [{ channel: "source", assetKey: "k", page: 1, lineStart: 2, lineEnd: 3, note: null }],
          },
        ],
      },
      courseId: "server-side-course",
      sourceDigest: "c".repeat(64),
      currentAssetChecksums: new Map([
        ["zzz", "sha-z"],
        ["aaa", "sha-a"],
      ]),
    });

    const binding = plan.binding as {
      courseId: string;
      sourceDigest: string;
      assets: { assetKey: string; sha256: string }[];
    };
    expect(binding.courseId).toBe("server-side-course");
    expect(binding.sourceDigest).toBe("c".repeat(64));
    // 资产清单来自服务端，且**确定性排序**（否则同一份结构会得到不同校验和）
    expect(binding.assets).toEqual([
      { assetKey: "aaa", sha256: "sha-a" },
      { assetKey: "zzz", sha256: "sha-z" },
    ]);
    expect((plan.schemaVersion as number)).toBe(SEGMENTATION_PLAN_SCHEMA_VERSION);
    expect(validatePlanShape(plan).ok, "服务端构造的计划必须形状合法").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 页面（静态外壳：零外部资源、零私有数据、脚本可编译）
// ---------------------------------------------------------------------------

/**
 * 这一组守两条本轮的阻断修复：
 *
 * - **F4**：`GET /` 是**静态外壳**，不含任何私有内容与 token。
 *   因此这里的判据不是"渲染出的页面长什么样"，而是"它**不可能**
 *   携带会话数据" —— 函数签名 `renderAnnotationShell()` 不接受参数，
 *   本身就是这条边界的结构守卫。
 * - **F1**：产出的客户端脚本必须能被 **JS 引擎**编译。
 *   旧的实现让脚本成为外层模板字符串的一部分，`\n` 被外层消费，
 *   于是产出的 JS 语法非法（`new Function` 抛 SyntaxError），
 *   而 HTTP 仍是 200、正则断言全绿。
 */
describe("本地标注页面 · 静态外壳与可编译脚本", () => {
  it("外壳渲染**不接受任何参数**（结构上不可能携带会话数据）", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-page.ts"), "utf8");
    // 签名必须是零参数
    expect(source, "外壳渲染必须无参（一旦接收会话数据就会重现 F4）").toMatch(
      /export function renderAnnotationShell\(\s*\)\s*:\s*string/,
    );
    // 不得 import 任何会话/服务器类型（那是"它需要数据"的信号）
    expect(source, "外壳不得依赖 AnnotationSession").not.toContain("AnnotationSession");
    expect(source, "外壳不得 import segment-server").not.toMatch(/from\s+["']\.\/segment-server["']/);
  });

  it("渲染出的 HTML 不含任何外部资源引用", () => {
    const html = renderAnnotationShell();
    expect(html, "不得有外部 script src").not.toMatch(/<script\s+[^>]*\bsrc=/i);
    expect(html, "不得有外部 link href").not.toMatch(/<link\s+[^>]*\bhref=/i);
    expect(html, "不得有外部 iframe").not.toMatch(/<iframe/i);
    expect(html, "不得以绝对 URL 加载资源").not.toMatch(/["'(]https?:\/\//i);
    for (const forbidden of ["cdn.", "unpkg", "jsdelivr", "googleapis", "google-analytics", "gtag("]) {
      expect(html, `不得引用 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("页面是纯内联的（无模块 import、无构建步骤）", () => {
    const html = renderAnnotationShell();
    expect(html, "不得用 type=module（那会引入外部解析）").not.toMatch(/<script[^>]+type=["']module["']/i);
    expect(html, "不得有 ES import").not.toMatch(/^\s*import\s+/m);
    expect(html).toContain("<style>");
    expect(html).toContain("<script");
  });

  it("页面不向控制台打印正文（隐私：日志会被记录进自动化上下文）", () => {
    expect(renderAnnotationShell(), "页面不得有 console 调用").not.toMatch(
      /console\.(log|info|debug|warn|error)\s*\(/,
    );
  });

  it("页面带有 no-referrer（防止本机 URL 经外链泄露）", () => {
    const html = renderAnnotationShell();
    expect(html).toContain('name="referrer"');
    expect(html).toContain("no-referrer");
  });

  it("外壳**不含** bootstrap 数据块（私有数据不再内嵌进页面）", () => {
    const html = renderAnnotationShell();
    expect(html, "页面不得再有内嵌 JSON 引导块").not.toContain('id="bootstrap"');
    expect(html, "页面不得含任何 script type=application/json").not.toMatch(
      /<script[^>]+type=["']application\/json["']/i,
    );
  });

  it("外壳里除了内联脚本那一处之外**没有任何插值**", () => {
    /*
     * 判据必须**剥掉注释**再数 —— 外壳的文档注释里**有意**写着 `${…}`
     * 作为解释文字，用不剥注释的判据会误伤那句说明（本条第一次就是这么红的）。
     */
    const raw = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-page.ts"), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const interpolations = code.match(/\$\{[^}]*\}/g) ?? [];
    expect(interpolations, `外壳只允许内联脚本这一处插值，实际：${interpolations.join("、")}`).toEqual([
      "${ANNOTATION_CLIENT_SCRIPT}",
    ]);
  });
});

// ---------------------------------------------------------------------------
// F1 —— 客户端脚本必须能被 JS 引擎编译（机械门禁）
// ---------------------------------------------------------------------------

describe("本地标注页面 · F1 客户端脚本可编译（唯一转义边界）", () => {
  /** 从渲染出的 HTML 里抽出内联脚本（页面只有一段，且无 src）。 */
  function inlineScriptOf(html: string): string {
    const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (match === null) throw new Error("页面里找不到内联脚本");
    return match[1];
  }

  it("**从真实渲染页面抽出的脚本可被 V8 编译**（F1 的机械守卫）", () => {
    const script = inlineScriptOf(renderAnnotationShell());
    /*
     * 这条断言就是被复评证明缺失的那一道。
     *
     * 缺陷形态：外层模板字符串消费 `\n` ⇒ 产出的内联 JS 里字符串字面量
     * 被换行截断 ⇒ 解析失败。因此"能编译"必须由 JS 引擎自己回答，
     * 而不是靠正则去猜。
     */
    expect(() => new Script(script, { filename: "annotation-inline.js" }), "产出的客户端脚本必须语法合法").not.toThrow();
  });

  it("脚本常量本身可编译，且**不含任何插值**（唯一转义边界）", () => {
    expect(() => new Script(ANNOTATION_CLIENT_SCRIPT)).not.toThrow();
    /*
     * 不得有插值 —— 数据不进脚本（数据走 fetch + textContent）。
     * 一旦允许插值，就重新出现了"把数据安全地嵌进代码"这个问题，
     * 而那正是第二层转义的来源。
     */
    expect(ANNOTATION_CLIENT_SCRIPT, "客户端脚本不得含模板插值").not.toMatch(/\$\{/);
  });

  it("脚本里的转义字符是**原样**到达浏览器的（不被外层消费）", () => {
    /*
     * 缺陷的根因是"外层把 `\n` 解析成了真实换行"。
     * 因此这里正面断言：脚本源里**没有**裸换行出现在字符串字面量内 ——
     * 具体判据是 `\n` 转义序列在脚本里以**反斜杠 + n** 两字符存在。
     */
    expect(ANNOTATION_CLIENT_SCRIPT, "`\\n` 必须以两字符形式存在于脚本源里").toContain("\\n");
    // 且脚本里确实有需要 `\n` 的用法（confirm 的多行文案）—— 否则上面那条可能空过
    expect(ANNOTATION_CLIENT_SCRIPT, "必须存在使用换行转义的字符串字面量").toMatch(/\\n"\s*\+/);
  });

  it("客户端脚本源码里**没有反引号或 `${`**（它们会提前终结 `String.raw` 模板）", () => {
    /*
     * ── 为什么这条必须是**源码级**断言，而不是对常量取值断言 ──
     *
     * 脚本是 `String.raw` 的模板字面量。模板里一旦出现：
     *
     * - **反引号** ⇒ 模板**提前结束**，后面的 JS 变成模块顶层代码；
     * - **`${`** ⇒ 变成插值，数据开始进代码（同时破坏唯一转义边界）。
     *
     * 两者都是**语法层**的破坏，而 `ANNOTATION_CLIENT_SCRIPT` 这个常量在
     * 那种情况下根本取不到"原本想写的内容"—— 对取值断言会看到
     * 一个**被截断**的字符串，判据就恒真、证明不了任何事。
     * 因此这里直接读**源文件字节**。
     *
     * 本轮实测就踩了两次：一次是 CSS 注释里写了 `#fff1f2`（用反引号包起来），
     * 一次是注释里写了 `scrollIntoView`。两次都表现为
     * "TypeScript 解析失败"，而真实原因是模板被提前终结。
     */
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-client-script.ts"), "utf8");
    const marker = "export const ANNOTATION_CLIENT_SCRIPT = String.raw`";
    const start = source.indexOf(marker);
    expect(start, "必须能找到脚本常量的起点").toBeGreaterThan(-1);
    const body = source.slice(start + marker.length);
    // 模板体以最后一个 `` `; `` 收尾；它之前**不得**出现裸反引号
    const end = body.lastIndexOf("`;");
    expect(end, "必须能找到脚本常量的终点").toBeGreaterThan(-1);
    const template = body.slice(0, end);
    expect(template.includes("`"), "脚本模板体里不得出现反引号").toBe(false);
    expect(/\$\{/.test(template), "脚本模板体里不得出现插值").toBe(false);
  });

  it("脚本里不含 token / 正文 / 外部 URL / console（隐私与零外部资源）", () => {
    expect(ANNOTATION_CLIENT_SCRIPT, "脚本不得含外部绝对 URL").not.toMatch(/["'`]https?:\/\//);
    expect(ANNOTATION_CLIENT_SCRIPT, "脚本不得含 console 调用").not.toMatch(
      /console\.(log|info|debug|warn|error)\s*\(/,
    );
    expect(ANNOTATION_CLIENT_SCRIPT, "脚本不得有 </script 提前闭合").not.toMatch(/<\/script/i);
    // 私有数据只经带 token 的 API 取得
    expect(ANNOTATION_CLIENT_SCRIPT, "必须经 /api/bootstrap 取私有数据").toContain("/api/bootstrap");
    expect(ANNOTATION_CLIENT_SCRIPT, "必须经 /api/plan 写计划").toContain("/api/plan");
    // token 只从 fragment 读，且立刻从地址栏抹掉
    expect(ANNOTATION_CLIENT_SCRIPT, "必须从 URL fragment 读 token").toContain("window.location.hash");
    expect(ANNOTATION_CLIENT_SCRIPT, "必须立刻 replaceState 抹掉 fragment").toContain("history.replaceState");
  });

  it("正文只经 textContent 进入 DOM（不存在把正文塞进 HTML/代码的路径）", () => {
    /*
     * 判据：脚本里**不得**出现把数据拼进 HTML 的写法。
     * 允许 `createElement` + `textContent`；禁止 `innerHTML = <变量>`。
     */
    const assignments = ANNOTATION_CLIENT_SCRIPT.match(/\.innerHTML\s*=/g) ?? [];
    expect(assignments.length, `脚本不得通过 innerHTML 写入（实际 ${assignments.length} 处）`).toBe(0);
    expect(ANNOTATION_CLIENT_SCRIPT, "必须用 textContent 渲染正文").toContain("textContent");
    // 不得有 insertAdjacentHTML / document.write / eval
    for (const forbidden of ["insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(ANNOTATION_CLIENT_SCRIPT, `脚本不得使用 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 真实服务器：守卫**确实接在请求路径上**
// ---------------------------------------------------------------------------

/**
 * 发一个**真实 HTTP** 请求，允许覆盖 Host 头。
 *
 * ── 为什么不能用 `fetch` ──
 *
 * `Host` 是 fetch 规范里**禁止修改**的请求头之一，浏览器/undici 会忽略它。
 * 因此"非回环 Host 必须被拒绝"这条守卫**无法**用 fetch 验证 ——
 * 必须用底层 `node:http`。这也更贴近真实攻击面：原始 TCP 请求
 * 本来就可以带任意 Host。
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** 启动一个真实的标注服务器，返回句柄 + 记录到的保存调用。 */
async function startFixtureServer(overrides: { assetLines?: string[]; existingPlan?: unknown } = {}) {
  const saves: Record<string, unknown>[] = [];
  const token = newSessionToken();
  const session = {
    token,
    courseId: "wiring-course",
    sourceDigest: "c".repeat(64),
    config: {
      courseId: "wiring-course",
      sourceDigest: "c".repeat(64),
      assets: [
        {
          assetKey: "k",
          label: "handout.pdf",
          sha256: "sha-k",
          pages: [{ page: 1, hasTextLayer: true, lines: overrides.assetLines ?? ["合成的正文行"] }],
        },
      ],
      existingPlan: overrides.existingPlan ?? null,
    },
    savePlan: (plan: Record<string, unknown>) => {
      saves.push(plan);
      return { ok: true, detail: "测试用保存", planDigest: "a".repeat(64) };
    },
  };
  const handle = await startAnnotationServer(session, { port: 0, page: () => renderAnnotationShell() });
  return { handle, token, saves };
}

describe("本地标注服务器 · 守卫接在真实请求路径上", () => {
  it("非回环 Host 被**真实服务器**拒绝（挡 DNS rebinding）", async () => {
    const { handle } = await startFixtureServer();
    try {
      const foreign = await rawRequest(handle.port, "/", { headers: { host: "evil.example" } });
      expect(foreign.status, "非回环 Host 必须被拒绝").toBe(403);

      const lanHost = await rawRequest(handle.port, "/", { headers: { host: "192.168.1.5:8080" } });
      expect(lanHost.status, "局域网 Host 必须被拒绝").toBe(403);

      // 回环 Host 正常放行（否则守卫过严会让工具不可用）
      const loopback = await rawRequest(handle.port, "/");
      expect(loopback.status, "回环 Host 必须放行").toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("非回环 Origin 被**真实服务器**拒绝", async () => {
    const { handle, token } = await startFixtureServer();
    try {
      const foreign = await rawRequest(handle.port, "/api/bootstrap", {
        headers: { origin: "https://evil.example", [SESSION_TOKEN_HEADER]: token },
      });
      expect(foreign.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it("写操作缺少 token 时**真实服务器**拒绝，且不调用保存", async () => {
    const { handle, token, saves } = await startFixtureServer();
    try {
      const body = JSON.stringify({ author: "x", reason: "r", units: [{ title: "u", kind: "translation_passage", assignments: [] }] });
      const noToken = await rawRequest(handle.port, "/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(noToken.status, "无 token 写必须被拒绝").toBe(403);
      expect(saves.length, "被拒绝时绝不能触发保存").toBe(0);

      // **查询串里的 token 不算数** —— 它会被跨站请求带上
      const queryToken = await rawRequest(handle.port, `/api/plan?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(queryToken.status, "查询串 token 不得用于写鉴权").toBe(403);
      expect(saves.length, "查询串 token 被拒时也不得保存").toBe(0);

      // 正确的请求头才放行
      const withHeader = await rawRequest(handle.port, "/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json", [SESSION_TOKEN_HEADER]: token },
        body,
      });
      expect(withHeader.status, "正确 token 请求头必须放行").toBe(200);
      expect(saves.length, "放行时必须真的保存一次").toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("读私有数据同样需要 token（私有正文不得被任意页面取走）", async () => {
    const { handle, token } = await startFixtureServer();
    try {
      const noToken = await rawRequest(handle.port, "/api/bootstrap");
      expect(noToken.status).toBe(403);

      const withToken = await rawRequest(handle.port, "/api/bootstrap", {
        headers: { [SESSION_TOKEN_HEADER]: token },
      });
      expect(withToken.status).toBe(200);
      const payload = JSON.parse(withToken.body) as { ok: boolean; assets: unknown[] };
      expect(payload.ok).toBe(true);
      expect(payload.assets.length).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("响应头带 no-store / CSP / Referrer-Policy（不进缓存、不加载外部、不外泄 URL）", async () => {
    const { handle, token } = await startFixtureServer();
    try {
      const page = await rawRequest(handle.port, "/");
      expect(page.headers["cache-control"], "页面必须 no-store").toBe("no-store");
      expect(String(page.headers["content-security-policy"]), "页面必须带 CSP").toContain("default-src 'none'");
      /*
       * F4：fragment 里带着 token，因此整条本机 URL 都不该出现在任何
       * 外部站点的请求里。`Referrer-Policy: no-referrer` 是那一道。
       */
      expect(page.headers["referrer-policy"], "页面必须 no-referrer").toBe("no-referrer");

      const api = await rawRequest(handle.port, "/api/bootstrap", {
        headers: { [SESSION_TOKEN_HEADER]: token },
      });
      expect(api.headers["cache-control"], "JSON 响应同样必须 no-store").toBe("no-store");
      expect(api.headers["referrer-policy"], "JSON 响应同样必须 no-referrer").toBe("no-referrer");
    } finally {
      await handle.close();
    }
  });

  it("服务器**只**监听回环地址（真实绑定地址由 `server.address()` 证明）", async () => {
    const { handle } = await startFixtureServer();
    try {
      expect(handle.url.startsWith(`http://${LOOPBACK_HOST}:`), "URL 必须是回环").toBe(true);

      /*
       * ── F7：回环证明必须看**操作系统实际接受的绑定地址** ──
       *
       * 旧用例的做法是"从 127.0.0.1 访问一下端口，通了就对" —— 那条
       * 断言在把绑定改成 0.0.0.0 之后**仍然通过**（0.0.0.0 也接受回环
       * 连接），因此它证明不了任何事。
       *
       * 现在断言 `handle.boundAddress`（取自 `server.address()`）**恰好**
       * 是回环字面量。把 `listen` 的目标改成 `0.0.0.0` ⇒ 它会如实变成
       * `0.0.0.0` ⇒ 断言变红。因果性由此成立。
       */
      expect(handle.boundAddress, "绑定地址必须恰好是回环（0.0.0.0 会在这里现形）").toBe("127.0.0.1");
      expect(handle.boundAddress, "绑定地址不得是通配地址").not.toBe("0.0.0.0");
      expect(handle.boundAddress, "绑定地址不得是 IPv6 通配地址").not.toBe("::");
      expect(LOOPBACK_HOST).toBe("127.0.0.1");
    } finally {
      await handle.close();
    }
  });

  it("**绑定地址守卫是因果的**：listen 到 0.0.0.0 ⇒ server.address() 如实报 0.0.0.0", async () => {
    /*
     * ── 这条是 F7 要求的"变异/负例"证明 ──
     *
     * 上一条断言只有在"它真的会因为 0.0.0.0 而变红"时才有价值。
     * 这里用一个**临时**服务器直接把 listen 绑到 0.0.0.0，证明
     * `server.address().address` 在那时会如实报 `0.0.0.0` ——
     * 也就是证明上一条断言的判据本身有效（而不是恒真）。
     *
     * 临时服务器没有任何请求处理逻辑，观察完绑定地址立即关闭。
     */
    const { createServer } = await import("node:http");
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "0.0.0.0", () => resolve());
      });
      const address = probe.address();
      const bound = typeof address === "object" && address !== null ? address.address : null;
      expect(bound, "0.0.0.0 绑定必须被 server.address() 如实报告").toBe("0.0.0.0");
      // 生产实现从同一个来源取地址 ⇒ 那条断言在缺陷形态下必然变红
      expect(bound).not.toBe(LOOPBACK_HOST);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// F4 —— 能力边界：未认证端点不得携带私有内容与写凭据
// ---------------------------------------------------------------------------

/**
 * 复评证明的缺陷：`GET /` 无需凭据，而返回的 HTML 里同时带着
 * **完整抽取正文**与**会话 token**。于是本机任意进程只要取一次页面，
 * 就同时得到私有材料与写计划的能力。
 *
 * Host/Origin/CORS 检查**挡不住**这条 —— 恶意本机进程可以自己发请求。
 * 因此修复必须落在**能力边界**上，而不是来源检查上。
 *
 * 这一组用**合成敏感串**证明边界成立（绝不用真实材料）。
 */
describe("本地标注服务器 · F4 未认证能力边界（合成敏感数据）", () => {
  /** 一个显眼可辨的合成正文行；它出现在私有 API 里、绝不出现在静态外壳里。 */
  const SYNTHETIC_PRIVATE_LINE = "SYNTHETIC-PRIVATE-DOCUMENT-TEXT-DO-NOT-LEAK";
  const SYNTHETIC_PLAN_TITLE = "SYNTHETIC-EXISTING-PLAN-TITLE-DO-NOT-LEAK";

  function fixtureWithPrivateData() {
    return startFixtureServer({
      assetLines: [SYNTHETIC_PRIVATE_LINE, "second synthetic private line"],
      existingPlan: { units: [{ title: SYNTHETIC_PLAN_TITLE, assignments: [] }], author: "owner" },
    });
  }

  it("**未认证 `GET /` 不得包含私有正文**", async () => {
    const { handle } = await fixtureWithPrivateData();
    try {
      const page = await rawRequest(handle.port, "/");
      expect(page.status, "页面本身必须可匿名取得（浏览器导航无法带请求头）").toBe(200);
      expect(page.body, "未认证页面绝不包含抽取正文").not.toContain(SYNTHETIC_PRIVATE_LINE);
      expect(page.body, "未认证页面绝不包含计划内容").not.toContain(SYNTHETIC_PLAN_TITLE);
      expect(page.body, "未认证页面不得含资产校验和").not.toContain("sha-k");
    } finally {
      await handle.close();
    }
  });

  it("**未认证 `GET /` 不得包含会话 token**（否则等于下发写凭据）", async () => {
    const { handle, token } = await fixtureWithPrivateData();
    try {
      const page = await rawRequest(handle.port, "/");
      expect(page.body, "未认证页面绝不包含 token 值").not.toContain(token);
      /*
       * 更强的判据：**两个不同会话的页面字节必须完全相同**。
       *
       * 这条直接排除"页面里嵌了任何随会话变化的东西" —— 无论它是
       * token、课程 id、源摘要还是资产清单。判据不依赖"我知道该找哪个
       * 字段名"，因此不会因为将来新增一个字段就悄悄失效。
       */
      const other = await fixtureWithPrivateData();
      try {
        const otherPage = await rawRequest(other.handle.port, "/");
        expect(otherPage.body, "不同会话的未认证页面必须逐字节相同（页面里不得有任何会话数据）").toBe(page.body);
        expect(other.token).not.toBe(token);
      } finally {
        await other.handle.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("**未认证 `GET /` 不得包含源绝对路径**", async () => {
    const { handle } = await fixtureWithPrivateData();
    try {
      const page = await rawRequest(handle.port, "/");
      expect(page.body, "未认证页面不含盘符路径").not.toMatch(/[A-Za-z]:\\\\/);
      expect(page.body, "未认证页面不含 temp 目录").not.toContain(process.env.TEMP ?? "\u0000never");
    } finally {
      await handle.close();
    }
  });

  it("**未认证 bootstrap 必须被拒绝**（私有读也要能力）", async () => {
    const { handle, token } = await fixtureWithPrivateData();
    try {
      const anonymous = await rawRequest(handle.port, "/api/bootstrap");
      expect(anonymous.status, "无凭据读私有数据必须 403").toBe(403);
      expect(anonymous.body, "拒绝响应不得回显任何正文").not.toContain(SYNTHETIC_PRIVATE_LINE);

      // 错误 token（长度相同但值不同，排除"前缀匹配"这类缺陷）
      const wrong = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
      const badToken = await rawRequest(handle.port, "/api/bootstrap", {
        headers: { [SESSION_TOKEN_HEADER]: wrong },
      });
      expect(badToken.status, "错误 token 必须 403").toBe(403);

      // 查询串里的 token 不算（跨站请求会带上它）
      const queryToken = await rawRequest(handle.port, `/api/bootstrap?token=${token}`);
      expect(queryToken.status, "查询串 token 不得用于读鉴权").toBe(403);
    } finally {
      await handle.close();
    }
  });

  it("认证后私有数据**确实**可取（证明上面的拒绝来自守卫，而不是接口坏了）", async () => {
    const { handle, token } = await fixtureWithPrivateData();
    try {
      const authed = await rawRequest(handle.port, "/api/bootstrap", {
        headers: { [SESSION_TOKEN_HEADER]: token },
      });
      expect(authed.status, "带正确 token 必须能读到私有数据").toBe(200);
      expect(authed.body, "认证响应里应当有正文（它是发给本机浏览器的）").toContain(SYNTHETIC_PRIVATE_LINE);
      expect(authed.body).toContain(SYNTHETIC_PLAN_TITLE);
    } finally {
      await handle.close();
    }
  });

  it("**token 绝不出现在任何请求目标里**（fragment 不发给服务器）", async () => {
    const { handle, token } = await fixtureWithPrivateData();
    try {
      /*
       * ── 这条守的是 fragment 语义（RFC 3986 / WHATWG URL）──
       *
       * 句柄 URL 必须把 token 放在 `#` 之后。浏览器**不会**把 fragment
       * 发给服务器，因此它不进请求行、不进访问日志。
       *
       * 两条断言：
       * 1. URL 形态正确（`#token=` 而非 `?token=`）；
       * 2. 浏览器实际会发出的请求目标（pathname + search）里**没有** token
       *    —— 那正是服务端日志会记下的东西。
       */
      const url = new URL(handle.url);
      expect(url.hash, "token 必须在 fragment 里").toBe(`#token=${token}`);
      expect(url.search, "查询串里不得有 token").toBe("");
      expect(`${url.pathname}${url.search}`, "服务端看到的请求目标里不得含 token").not.toContain(token);

      const page = await rawRequest(handle.port, "/");
      expect(page.body).not.toContain(token);
    } finally {
      await handle.close();
    }
  });

  it("GET /api/bootstrap **不接受**仅查询串的 token（跨站请求会带上它）", async () => {
    const { handle, token } = await fixtureWithPrivateData();
    try {
      const queryOnly = await rawRequest(handle.port, `/api/bootstrap?token=${token}`);
      expect(queryOnly.status, "仅查询串 token 不得授权").toBe(403);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 工具目录布局（计划不进候选目录）
// ---------------------------------------------------------------------------

describe("本地标注工具 · 目录布局", () => {
  it("计划目录与候选目录是**两棵独立子树**（重跑抽取不会搬走计划）", () => {
    /*
     * `course:extract` 重跑时会**备份并替换**整个候选目录。
     * 若计划住在候选目录里，它会在每次重新抽取时被搬进 `.prev-*`，
     * 于是"改了源 → 重新抽取 → 计划不见了"。
     */
    const plans = getCourseSegmentationPlansDir();
    const candidates = getCourseCandidatesDir();
    expect(plans).not.toBe(candidates);
    expect(plans.startsWith(candidates), "计划不得位于候选目录之内").toBe(false);
    expect(candidates.startsWith(plans), "候选不得位于计划目录之内").toBe(false);
    expect(plans.split(/[\\/]/).pop(), "计划目录名必须稳定").toBe("course-segmentation-plans");
  });

  it("计划目录位于 private-content/ 之下，因而绝不进 Git", () => {
    const ignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(ignore, "内容根必须被忽略且不得有反向例外").toContain("/private-content/");
    expect(ignore, "不得出现重新纳入 private-content 的例外规则").not.toMatch(/^!.*private-content/m);
    // 计划目录名在内容根之下 ⇒ 被同一条规则覆盖
    expect(getCourseSegmentationPlansDir()).toContain("course-segmentation-plans");
  });
});

// ---------------------------------------------------------------------------
// 源码级约束（工具层）
// ---------------------------------------------------------------------------

describe("本地标注工具 · 架构约束（源码级）", () => {
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const TOOL_FILES = [
    "src/content/course-pipeline/segment-server.ts",
    "src/content/course-pipeline/segment-page.ts",
    "src/content/course-pipeline/segment-client-script.ts",
    "scripts/course-segment.ts",
  ];

  it("绝不 import 数据库 / 仓库层（不写库是结构性的，不是纪律）", () => {
    for (const path of TOOL_FILES) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      const imports = code
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"))
        .join("\n");
      expect(imports, `${path} 不得 import 数据库/仓库层`).not.toMatch(/repositories|db\/client|node:sqlite|@\/db/);
    }
  });

  it("绝不绑定 0.0.0.0，也绝不做 Git 操作", () => {
    for (const path of TOOL_FILES) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      /*
       * 判据：**生产代码**里不得出现 0.0.0.0 作为绑定目标。
       *
       * 注意 `segment-server.ts` 的注释里会解释"绝不 0.0.0.0" ——
       * 但那在**注释**里，`strip` 已经去掉；而绑定字面量本身不得出现。
       */
      expect(code, `${path} 不得出现 0.0.0.0`).not.toContain("0.0.0.0");
      expect(code, `${path} 不得执行 Git 操作`).not.toMatch(/\bgit\s+(push|commit|checkout|reset|add)\b/);
      expect(code, `${path} 不得调用 verifyCanonicalLink`).not.toMatch(/verifyCanonicalLink\s*\(/);
      for (const forbidden of [
        "performance_event",
        "assessment_event",
        "evidence_projection",
        "course_exposure_event",
        "skill_profile",
      ]) {
        expect(code, `${path} 不得写 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("绝不生成 review.json，也绝不晋升 / 导入 / 建链", () => {
    for (const path of TOOL_FILES) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      /*
       * 判据必须是"**写**它"，不是"**提到**它"。
       *
       * 工具的输出里**有意**写「不生成 review.json」—— 那是在如实告诉操作者
       * 计划不等于复核。用"出现过这个词"当判据会误伤那句说明
       * （本条用例第一次就是这么红的）。
       */
      expect(code, `${path} 不得写入 review.json`).not.toMatch(
        /writeFileSync\([^)]*review\.json|writeFileAtomic\([^)]*review\.json/,
      );
      expect(code, `${path} 不得调用晋升`).not.toMatch(/promoteCourseCandidate/);
      expect(code, `${path} 不得调用链接写入`).not.toMatch(/verifyCanonicalLink|appendLink/);
      expect(code, `${path} 不得调用导入`).not.toMatch(/NormalizedCourseImporter|commitCourseImport/);
    }
  });

  it("服务器只监听回环常量，且**记录真实绑定地址**（回环证明才有判据）", () => {
    const server = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8"));
    expect(server, "回环地址必须是唯一的绑定常量").toContain('LOOPBACK_HOST = "127.0.0.1"');
    // listen 调用必须用该常量，而不是字面量或其他地址
    expect(server, "listen 必须用回环常量").toMatch(/server\.listen\([^)]*LOOPBACK_HOST/);
    /*
     * ── F7：必须从 `server.address()` 取真实绑定地址 ──
     *
     * 若句柄只是回显 `LOOPBACK_HOST`，那么把 listen 改成 0.0.0.0 之后
     * 它仍然显示 127.0.0.1 —— 于是"只绑回环"这条断言恒真、证明不了任何事。
     */
    expect(server, "必须从 server.address() 取真实绑定地址").toMatch(/server\.address\(\)/);
    expect(server, "句柄必须暴露 boundAddress").toContain("boundAddress");
  });

  it("写操作必须校验 token 请求头（不得用查询串做写鉴权）", () => {
    const server = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8"));
    expect(server, "必须使用专门的 token 请求头").toContain("SESSION_TOKEN_HEADER");
    // /api/plan 分支必须先过 tokenMatches 再读 body
    const planIndex = server.indexOf('"/api/plan"');
    expect(planIndex, "必须有 /api/plan 写入口").toBeGreaterThan(0);
    const planBranch = server.slice(planIndex, planIndex + 900);
    expect(planBranch, "写入口必须先校验 token").toMatch(/tokenMatches\(/);
    expect(
      planBranch.indexOf("tokenMatches(") < planBranch.indexOf("readBody("),
      "token 校验必须先于读取请求体",
    ).toBe(true);
  });

  it("**F4：私有读端点必须校验 token，`GET /` 不得读取会话数据**", () => {
    const server = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8"));

    // 引导端点必须存在且先校验 token
    const bootstrapIndex = server.indexOf('"/api/bootstrap"');
    expect(bootstrapIndex, "必须有 /api/bootstrap 引导入口").toBeGreaterThan(0);
    const bootstrapBranch = server.slice(bootstrapIndex, bootstrapIndex + 600);
    expect(bootstrapBranch, "引导端点必须先校验 token").toMatch(/tokenMatches\(/);

    /*
     * `GET /` 分支**不得**出现会话数据。
     *
     * 这里按**大括号配对**切出该分支的完整函数体（而不是取固定长度的
     * 窗口）—— 固定窗口会溢出到后面的引导分支，从而把"引导端点用了
     * token"误判成"页面用了 token"（本条第一次就是这么红的）。
     */
    const rootMatch = /if \(request\.method === "GET" && url\.pathname === "\/"\) \{([\s\S]*?)\n  \}/.exec(server);
    expect(rootMatch, "必须能切出 GET / 分支体").not.toBeNull();
    const rootBranch = rootMatch![1];
    expect(rootBranch.length, "分支体必须非空").toBeGreaterThan(20);
    expect(rootBranch, "GET / 不得读取会话 token").not.toMatch(/session\.token/);
    expect(rootBranch, "GET / 不得下发资产").not.toMatch(/session\.config|session\.courseId|session\.sourceDigest/);
    // 页面渲染必须是**无参**调用（参数即"需要会话数据"的信号）
    expect(rootBranch, "页面渲染必须无参").toMatch(/page\(\s*\)/);
  });

  it("token 必须经 **URL fragment** 交付（fragment 不发给服务器）", () => {
    const server = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8"));
    /*
     * 判据：句柄 URL 用 `#token=`，**不得**用 `?token=`。
     *
     * 查询串会随每个同源请求发给服务器 ⇒ 进请求目标与访问日志；
     * fragment 不会。这条差别是 F4 修复的要点之一。
     */
    expect(server, "token 必须放在 fragment 里").toMatch(/#token=\$\{session\.token\}/);
    expect(server, "token 不得放在查询串里").not.toMatch(/\?token=\$\{session\.token\}/);
  });

  it("响应必须带 no-store / CSP / Referrer-Policy（不进缓存、不加载外部、不外泄 URL）", () => {
    const server = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8");
    expect(server, "必须设置 no-store").toContain('"cache-control": "no-store"');
    expect(server, "页面必须带 CSP").toContain("content-security-policy");
    expect(server, "CSP 必须默认拒绝一切外部加载").toContain("default-src 'none'");
    expect(server, "必须设置 Referrer-Policy").toContain('"referrer-policy": "no-referrer"');
  });

  it("写盘必须是**原子**的（临时文件 + rename），不得直接覆盖计划", () => {
    const cli = strip(readFileSync(join(process.cwd(), "scripts/course-segment.ts"), "utf8"));
    expect(cli, "必须有原子写实现").toMatch(/function writeFileAtomic/);
    expect(cli, "必须用 rename 提交（同文件系统内原子）").toContain("renameSync");
    // 不得直接对计划路径 writeFileSync
    expect(cli, "不得直接覆盖计划文件").not.toMatch(/writeFileSync\(\s*planPath/);
  });

  it("标注工具**绝不**把课程正文写进终端（终端输出会被记录进自动化上下文）", () => {
    const cli = strip(readFileSync(join(process.cwd(), "scripts/course-segment.ts"), "utf8"));
    const consoleLines = cli.split("\n").filter((line) => /console\.(log|error|warn)\(/.test(line));
    for (const line of consoleLines) {
      expect(line, `终端输出不得含正文：${line.trim()}`).not.toMatch(/\b(page\.lines|rawText|paragraphText|document\.pages)\b/);
    }
    // 服务器与页面都不得打印任何东西
    for (const path of ["src/content/course-pipeline/segment-server.ts"]) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      expect(code, `${path} 不得向终端打印`).not.toMatch(/console\.(log|info|debug|warn|error)\s*\(/);
    }
  });

  it("标注工具的参数里没有任何绕过开关（无 --force / --skip / --yes）", () => {
    const cli = readFileSync(join(process.cwd(), "scripts/course-segment.ts"), "utf8");
    for (const forbidden of ["--force", "--skip-gate", "--yes", "--ignore-review"]) {
      expect(cli, `不得提供 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("两个 CLI 命令都登记在 package.json，且命名遵循既有约定", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts).toHaveProperty("course:segment");
    expect(pkg.scripts).toHaveProperty("course:extract");
    expect(pkg.scripts["course:segment"]).toContain("scripts/course-segment.ts");
  });

  it("导出常量与实现一致（防止文档与代码漂移）", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(SESSION_TOKEN_HEADER).toBe("x-cet6-session-token");
  });

  it("CLI 存在且已被 package.json 指向（防止登记了不存在的脚本）", () => {
    expect(existsSync(join(process.cwd(), "scripts/course-segment.ts"))).toBe(true);
  });
});
