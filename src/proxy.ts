import { NextResponse, type NextRequest } from "next/server";
import {
  isCanonicalHostHeader,
  isLoopbackHostHeader,
  trustedLocalOrigin,
} from "@/lib/loopback-guard";

/**
 * 集中式本地请求边界（Next.js 16 `proxy.ts`，旧称 `middleware.ts`）。
 *
 * ── 为什么需要它 ──
 *
 * 敏感 POST 端点（`/api/course/reveal`）有自己的 Host/Origin 守卫，
 * 但那**只覆盖那一个路径**。初始的课程页 GET、RSC 预取、HTML 导航
 * 都没有任何请求边界 —— 一个带 `Host: evil.example` 的 GET 会照样拿到页面。
 *
 * 那一类请求的问题不只是"读到内容"：DNS rebinding 的场景是
 * **浏览器**带着恶意域名访问本服务，而同源策略在 rebinding 下帮不上忙。
 * 因此 GET/HTML/RSC 也必须被挡在外面，且必须在**同一个地方**挡 ——
 * 逐个路由自己判，就等于指望"每个新路由都记得加"。
 *
 * ── 判据 ──
 *
 * 只接受 Host 属于回环的请求。这里刻意用**宽松**的回环判据
 * （`isLoopbackHostHeader`），而不是"必须等于某个端口"：
 *
 * - Host 头里的端口是**客户端**提供的，它可能因代理、端口转发而与实际
 *   监听端口不同；
 * - 而本产品可能以不同端口启动（开发 3100、各 E2E 实例 3199~3265）；
 * - 真正的**同源**判定属于带 `Origin` 的写请求，那由
 *   `lib/loopback-guard.ts` 的精确判据负责。
 *
 * 两层判据各管一件事：
 *
 * | 层 | 判据 | 挡住 |
 * | --- | --- | --- |
 * | 本文件（全部请求） | Host 是回环 | LAN 访问、DNS rebinding |
 * | 敏感 POST（`/api/course/reveal`） | Origin **精确同一来源** | 跨站写、另一个本地服务 |
 *
 * ── 它**不**做的事 ──
 *
 * 不做鉴权、不读数据库、不碰课程内容。它只是一道网络边界，
 * 因此对所有路由一视同仁，且保持极轻。
 */

export function proxy(request: NextRequest): NextResponse | undefined {
  const host = request.headers.get("host");

  if (!isLoopbackHostHeader(host ?? undefined)) {
    /*
     * 失败关闭：非回环 Host 一律拒绝。
     *
     * 用 421（Misdirected Request）而不是 403：语义更准确 ——
     * "服务器无法为这个 Host 的请求服务"。响应体刻意不含任何页面内容，
     * 因此它不会成为信息泄漏面。
     */
    return new NextResponse("只接受来自本机回环地址的请求。", {
      status: 421,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  /*
   * ── 非规范回环主机名：一律拒绝（读与写都拒）──
   *
   * 回环的主机名不止一个：`127.0.0.1`、`localhost`、`[::1]`。它们都能连到
   * 本服务，但在浏览器眼里是**不同来源**。只有规范来源能完成写操作
   * （见 `lib/loopback-guard.ts` 的精确判据）。
   *
   * ── 为什么写请求必须在这里就拒，而不是留给下游 ──
   *
   * 实测（Next 16.4.2，真实进程内服务器 + 原始 HTTP）：
   * Next 自己的 Server Actions CSRF 门禁把 `Origin` 与 **`Host` 头**相比
   * （`action-handler.js` 的 `parseHostHeader(req.headers)` 不传
   * `originDomain`，于是直接采信客户端给的值）。当两者都写成同一个
   * 别名（`Host: localhost:3265` + `Origin: http://localhost:3265`）时，
   * 该门禁**通过**，action 正常执行并**写入了数据库**
   * （实测：`weekday_minutes` 由 60 变为 137，`updated_at` 同步更新）。
   *
   * 也就是说：别名的写通路**不是**理论推断，是实测存在的。下游端点
   * 并非都像 `/api/course/reveal` 那样自己做精确 Origin 校验，因此
   * 统一边界必须自己兜住 —— 这正是本文件存在的理由。
   * 在这里拒绝，就不会有任何 action 被执行、不会产生任何数据库副作用。
   *
   * ── 为什么读请求给引导页、写请求给纯文本 ──
   *
   * 读请求的失败是"人走错了地址"，给一份可点的引导是安全且有用的。
   * 写请求的失败**不应该**被渲染成页面（它不来自人肉导航），
   * 因此返回简短纯文本 + 状态码，调用方从状态码即可判断。
   */

  /** 规范来源（协议 + 主机名 + 端口）——**完全由部署配置决定**。 */
  const canonical = new URL(trustedLocalOrigin());

  const method = request.method.toUpperCase();
  const isReadMethod = method === "GET" || method === "HEAD";

  if (!isCanonicalHostHeader(host ?? undefined)) {
    if (isReadMethod) {
      /*
       * ── 规范链接：**只**从 `trustedLocalOrigin()` 拼出 ──
       *
       * 历史缺陷（本轮修复）：上一版把 Host 头里的端口拿来拼引导链接，
       * 于是 `Host: localhost:9999` 打在本服务上会生成
       * `http://127.0.0.1:9999/...` —— 一个指向**另一项本地服务**的链接。
       * 这不仅违背"可信来源不能来自客户端请求头"的设计原则，
       * 而且会把使用者引导到别的进程上去（那看起来像是成功了）。
       *
       * 因此现在：协议、主机名、端口**三者全部**取自 `trustedLocalOrigin()`。
       * 请求只能贡献经过处理的**路径与查询**。
       *
       * 多实例（开发 3100、E2E 3199~3265）仍然正确：每个实例都通过
       * `PORT` 或 `CET6_LOCAL_ORIGIN` 声明自己的来源，`trustedLocalOrigin()`
       * 因此返回**该实例自己**的端口，不是全局写死的 3100。
       */
      const canonicalUrl = `${canonical.origin}${safePathAndQuery(request)}`;
      return canonicalAddressGuidance(canonicalUrl);
    }

    /*
     * 写请求（POST / PUT / PATCH / DELETE 等）：失败关闭，不引导、
     * 不转发、不执行。响应体不含任何私人内容。
     */
    return new NextResponse("这个操作只能从本应用的规范本地地址发起。", {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  }

  return undefined;
}

/**
 * 从请求中取出**可安全拼进 URL 的**路径与查询。
 *
 * ── 为什么不是直接拼 `request.nextUrl.pathname` ──
 *
 * 路径与查询是请求方唯一能贡献的部分，因此必须假定它是敌意的：
 *
 * - 以 `//` 开头会被浏览器解释成**协议相对 URL**（`//evil.example/x`
 *   ⇒ `http://evil.example/x`），从而把引导链接变成开放重定向；
 * - 含 `\` 的形态在部分解析器里同样被当作分隔符；
 * - 控制字符与空白会被用来截断或混淆。
 *
 * 处理：拒绝不安全的形态并回退到 `/`，其余原样保留（保留是为了让
 * "点一下就到原页面"这件事成立）。查询串只接受常规字符集。
 */
function safePathAndQuery(request: NextRequest): string {
  const rawPath = request.nextUrl.pathname ?? "/";
  const rawSearch = request.nextUrl.search ?? "";

  /*
   * 必须恰好以单个 `/` 开头：`//` 与 `/\` 都是协议相对 URL 的形态，
   * 拼上 `canonical.origin` 之后会把主机名换掉。
   */
  const pathIsSafe =
    rawPath.startsWith("/") &&
    !rawPath.startsWith("//") &&
    !rawPath.startsWith("/\\") &&
    !rawPath.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(rawPath);

  const path = pathIsSafe ? rawPath : "/";

  // 查询串：`?` 开头，其余只允许 URL 查询里合法的字符。
  const searchIsSafe =
    rawSearch === "" ||
    (rawSearch.startsWith("?") &&
        !/[\u0000-\u001f\u007f\\]/.test(rawSearch));

  return `${path}${searchIsSafe ? rawSearch : ""}`;
}

/**
 * 规范访问地址引导页（唯一实现）。
 *
 * ── 刻意不用模板字符串拼 HTML ──
 *
 * 页面里只出现**一个**来自外部的值：`canonicalUrl`。它是我们自己按可信
 * 来源拼出来的，不是请求头反射。即便如此，仍然用 `escapeHtml` 处理一遍 ——
 * "这个值一定是安全的" 这种假设，正是 XSS 通常的成因。
 */
function canonicalAddressGuidance(canonicalUrl: string): NextResponse {
  const href = escapeHtml(canonicalUrl);
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>请改用规范地址打开</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
  main { max-width: 34rem; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; }
  a { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
</style>
</head>
<body>
<main>
  <h1>请改用规范地址打开本应用</h1>
  <p>本应用只接受从<strong>一个</strong>确定的本地地址发起的操作。本机浏览器会把
     <code>localhost</code> 与 <code>127.0.0.1</code> 当作两个不同来源，
     因此用另一个名字打开时，保存类操作不会被接受。</p>
  <p><a href="${href}">${href}</a></p>
  <p>点这个链接即可在规范地址上继续使用；你的数据没有受到任何影响。
     它不是自动跳转 —— 本应用不会替你把请求转发到另一个地址。</p>
</main>
</body>
</html>
`;

  return new NextResponse(body, {
    status: 421,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** 最小 HTML 转义（只覆盖文本与属性上下文里会产生歧义的字符）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const config = {
  /*
   * 匹配全部路径，只排除 Next 内部资源与静态文件。
   *
   * 刻意**不**排除 `/api/*`：敏感 POST 有自己的守卫，但让它也过一遍
   * 这道边界是纵深防御 —— 且成本为零。
   */
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes) —— **故意不排除**，见上方说明
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, icons, manifest (static assets)
     */
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js).*)",
  ],
};

/** 供测试与文档引用：本文件的判据来自哪个函数。 */
export const PROXY_TRUSTED_ORIGIN_NOTE = `可信来源：${trustedLocalOrigin()}`;
