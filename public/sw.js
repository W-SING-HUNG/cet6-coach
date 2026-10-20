/*
 * Service worker —— 保守方案。
 *
 * 决策背景：
 * - Next.js 16 默认使用 Turbopack，Serwist 的 Next.js 集成在 Turbopack 路径下仍有已知摩擦，
 *   而 Phase 1 的 PWA 需求只是"合法 manifest + 可安装基础 + 响应式移动体验"。
 * - 因此这是一个手写的、不参与构建管道的静态 service worker：
 *   它不拦截 API、不缓存 HTML 文档的响应，只做 app shell 资源与静态图标的缓存优先。
 *
 * 明确不做的：不做 HTML 导航缓存，因为学习数据必须反映服务器真实状态，
 * 缓存一个过期的 Today 页面比显示离线页面更有害。
 *
 * 完整离线优先能力留到 Phase 2，届时再评估引入构建期插件的收益。
 */

const CACHE = "cet6-shell-v1";

/** 只预缓存确定不会过期的静态资源。 */
const PRECACHE = [
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 单个资源失败不应导致整个安装失败
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 只处理静态资源；HTML 导航与 RSC 请求直接走网络，保证数据新鲜
  const isStaticAsset =
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/favicon.ico";

  if (!isStaticAsset) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
