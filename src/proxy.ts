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
   * ── 规范访问地址引导（读请求）──
   *
   * 回环的主机名不止一个：`127.0.0.1`、`localhost`、`[::1]`。它们都能连到
   * 本服务，但在浏览器眼里是**不同来源**。敏感 POST 的同源守卫必须精确到
   * 单一来源（见 `lib/loopback-guard.ts`），因此只有一个主机名能完成写操作。
   *
   * 上个版本的缺陷正在这里：README 让人打开 `localhost:3100`，而服务监听
   * 并信任 `127.0.0.1:3100`。页面照常显示，点「确认阅读」时 POST 被 403
   * 拒掉，界面只说"来源不是同一个本地服务" —— 既没说该换成哪个地址，
   * 也没有任何恢复路径。功能看起来就是坏的。
   *
   * ── 为什么这里**不**用重定向 ──
   *
   * 实测：Next 16 的 proxy 会用它自己的 `NextURL(Location, {headers})` 重建
   * 目标地址，而那个构造器**用请求的 `Host` 头覆盖 URL 的主机名**；随后
   * `adapter.js` 只在 `redirectURL.host === requestURL.host` 时才把 Location
   * 相对化，于是我们想指定的规范主机名被丢掉，Location 变成相对路径
   * （`/practice/courses`），浏览器解析回**同一个非规范主机名** ——
   * 无限重定向（实测 ERR_TOO_MANY_REDIRECTS），页面彻底打不开。
   * 也就是说：从 proxy 发起的跨主机名重定向在这版 Next 里做不到。
   *
   * ── 因此改成：一份**独立、无正文、可恢复**的引导页 ──
   *
   * 它满足三个要求，且都不依赖浏览器对非标准行为的容忍：
   *   1. **清楚**：直说发生了什么、该用哪个地址；
   *   2. **安全**：页面不读数据库、不含任何课程内容，也不反射 Host 头
   *      （只回显可信来源，那是部署事实，不是用户输入）；
   *   3. **可恢复**：给出指向规范地址的链接，路径与查询原样带过去，
   *      点一下就回到正常界面。
   *
   * 用 421（Misdirected Request）：本服务确实无法为这个主机名服务，
   * 语义准确，且浏览器会渲染响应体（也就是这份引导）。
   *
   * 只对读方法这样做。写方法**不**重定向、也不引导 —— 它们直接失败关闭，
   * 由端点自己的守卫给出原因（用 307/308 转发写请求会把请求体一并送到，
   * 等于替调用方完成了它本不该通过的来源判定）。
   */
  const method = request.method.toUpperCase();
  const isReadMethod = method === "GET" || method === "HEAD";
  if (isReadMethod && !isCanonicalHostHeader(host ?? undefined)) {
    const canonical = new URL(trustedLocalOrigin());

    /*
     * 端口取自 Host 头，因此引导链接不会跨实例 —— 本产品会以多个端口启动
     * （开发 3100、E2E 3199~3265），写死端口会把人送到另一个服务上。
     */
    const portInHost = (() => {
      const raw = host ?? "";
      const separator = raw.lastIndexOf(":");
      const bracket = raw.lastIndexOf("]");
      // 只有 "]" 之后、且确实存在冒号时才是端口（IPv6 字面量里也有冒号）。
      if (separator === -1 || (bracket !== -1 && separator < bracket)) return "";
      const candidate = raw.slice(separator + 1);
      return /^\d{1,5}$/.test(candidate) ? candidate : "";
    })();

    // 默认端口不写出来（`http://127.0.0.1:80` 与 `http://127.0.0.1` 同源）。
    const isDefaultPort =
      (canonical.protocol === "http:" && portInHost === "80") ||
      (canonical.protocol === "https:" && portInHost === "443") ||
      portInHost === "";
    const authority = isDefaultPort ? canonical.hostname : `${canonical.hostname}:${portInHost}`;

    // `request.nextUrl` 携带已解析的路径与查询，且不依赖 `request.url` 是绝对 URL。
    const nextUrl = request.nextUrl;
    const canonicalUrl = `${canonical.protocol}//${authority}${nextUrl.pathname}${nextUrl.search}`;

    return canonicalAddressGuidance(canonicalUrl);
  }

  return undefined;
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
     因此用另一个名字打开时，"确认阅读"这类写操作会被安全地拒绝。</p>
  <p><a href="${href}">${href}</a></p>
  <p>这个链接会带你到同一页面。此后请一直使用这个地址；你的数据没有受到任何影响。</p>
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
