import { NextResponse, type NextRequest } from "next/server";
import { isLoopbackHostHeader, trustedLocalOrigin } from "@/lib/loopback-guard";

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

  return undefined;
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
