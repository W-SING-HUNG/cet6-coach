import { NextResponse, type NextRequest } from "next/server";
import {
  classifyOrigin,
  isCanonicalHostHeader,
  isLoopbackHostHeader,
  trustedLocalOrigin,
  type OriginRejection,
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
 * ── 三层判据，各管一件事 ──
 *
 * | 层 | 判据 | 挡住 |
 * | --- | --- | --- |
 * | 本文件（全部请求） | Host 是**回环** | LAN 访问、DNS rebinding |
 * | 本文件（写请求） | Host **精确等于**可信 authority（主机名 + 端口）， | 跨端口伪造、别名写 |
 * | | 且 Origin **精确等于**可信来源（必填） | 跨站写、缺失/null Origin |
 * | 敏感端点自身（`/api/course/reveal`） | 同一套精确判据（纵深防御） | 端点级复核 |
 *
 * ── 为什么写请求的判据必须在本文件里完成 ──
 *
 * 实测（Next 16.4.2，真实 Server Action ID + 隔离合成 SQLite）：
 *
 * 1. **伪造端口**：`Host: 127.0.0.1:9999` + `Origin: http://127.0.0.1:9999`
 *    打在 `:3265` 的实例上 ⇒ **200，数据库被改**。
 * 2. **缺失 Origin**：`Host: 127.0.0.1:3265`（规范）+ 无 `Origin`
 *    ⇒ **200，数据库被改**。
 *
 * 两种都能穿过 Next 内置的 action CSRF 门禁 —— 因为它把 `Origin` 与
 * **`Host` 头**相比（`action-handler.js` 的 `parseHostHeader(req.headers)`
 * 不传 `originDomain`），两者都由客户端给；且 `Origin` 缺失时代码注释
 * 明写"let this through but log a warning"。
 *
 * 因此框架的检查**不能**替代本项目的边界：这里自己判，且在 action
 * 分发之前就拒，故不会有任何 action 被执行、不会产生数据库副作用。
 *
 * ── 为什么读请求给引导页、写请求给纯文本 ──
 *
 * 读请求的失败是"人走错了地址"，给一份可点的引导是安全且有用的。
 * 写请求的失败**不应该**被渲染成页面（它不来自人肉导航），
 * 因此返回简短纯文本 + 状态码，调用方从状态码即可判断。
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
   * ── 非规范回环主机名：读给引导页、写直接拒 ──
   *
   * 回环的主机名不止一个：`127.0.0.1`、`localhost`、`[::1]`。它们都能连到
   * 本服务，但在浏览器眼里是**不同来源**。只有规范 authority 能完成写操作。
   *
   * 详细的实测依据见文件头注释（伪造端口、缺失 Origin 两条真实写入缺口）。
   */

  /** 规范来源（协议 + 主机名 + 端口）——**完全由部署配置决定**。 */
  const canonical = new URL(trustedLocalOrigin());

  const method = request.method.toUpperCase();
  const isReadMethod = method === "GET" || method === "HEAD";

  /*
   * ── 读方法：只要求 Host 是规范 authority ──
   *
   * 写方法走下面更严格的路径（Host 精确 + Origin 必填），因此这里
   * 先用"是不是读方法"分流，而不是先判 Host 再判方法 —— 顺序反了
   * 就会出现"Host 不匹配的写请求先拿到 421 引导页"这种错配。
   */
  if (isReadMethod) {
    if (isCanonicalHostHeader(host ?? undefined)) {
      /* 规范地址的读请求：放行。 */
      return undefined;
    }

    /*
     * ── 规范链接：**只**从 `trustedLocalOrigin()` 拼出 ──
     *
     * 历史缺陷：更早一版把 Host 头里的端口拿来拼引导链接，于是
     * `Host: localhost:9999` 打在本服务上会生成
     * `http://127.0.0.1:9999/...` —— 一个指向**另一项本地服务**的链接。
     *
     * 因此现在：协议、主机名、端口**三者全部**取自 `trustedLocalOrigin()`。
     * 请求只能贡献经过处理的**路径与查询**。
     *
     * 多实例（开发 3100、E2E 3199~3265）仍然正确：每个实例都通过
     * `PORT` 或 `CET6_LOCAL_ORIGIN` 声明自己的来源，`trustedLocalOrigin()`
     * 因此返回**该实例自己**的端口，不是全局写死的 3100。
     *
     * 注意：能够走到这里的只有"回环但不是规范 authority"的情形
     * （非回环 Host 已在上面 421 掉了）。给引导页是有用的，因为那是
     * 人走错了地址。
     */
    const canonicalUrl = `${canonical.origin}${safePathAndQuery(request)}`;
    return canonicalAddressGuidance(canonicalUrl);
  }

  /*
   * ── 写方法：Host 精确匹配 + Origin 必填且精确匹配 ──
   *
   * 两条都必须过，顺序是 Host 先（Host 不过说明请求没打到本服务上，
   * 此时谈 Origin 没有意义）。任一不过 ⇒ 失败关闭，不转发、不执行。
   */

  /* ① Host 必须是可信 authority（主机名 **与端口** 都精确相等）。 */
  if (!isCanonicalHostHeader(host ?? undefined)) {
    return writeRejected("host");
  }

  /*
   * ② Origin 必须存在且精确等于可信来源。
   *
   * `classifyOrigin` 会对 missing / invalid / null / 非回环 / 别名 /
   * 跨端口 / 跨协议 分别给出拒绝理由，全部拒绝。这里**不**使用任何
   * allowedOrigins 白名单 —— 只接受唯一一个可信来源。
   */
  const origin = classifyOrigin(request.headers.get("origin") ?? undefined);
  if (!origin.ok) {
    return writeRejected(origin.reason);
  }

  return undefined;
}

/**
 * 写请求的拒绝响应（唯一实现）。
 *
 * ── 为什么不区分理由给不同文案 ──
 *
 * 写请求不应由人肉导航触发，因此它的响应不是给人读的引导页；而
 * **把具体拒绝理由回给调用方**会让探测变得容易（例如"缺 Origin"与
 * "Origin 不对"分开回答，就能二分出可信来源的形态）。
 * 因此对外统一一句，理由只留在服务端日志/测试断言里。
 *
 * `reason` 参与签名是为了让调用点显式记录**为什么**拒，
 * 并在测试中可断言；它不出现在响应体里。
 */
function writeRejected(reason: "host" | OriginRejection): NextResponse {
  void reason;
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
