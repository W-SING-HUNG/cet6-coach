// @vitest-environment node
/**
 * 规范访问地址 · 统一边界（`src/proxy.ts` 的行为测试）。
 *
 * ── 为什么这个文件单独存在 ──
 *
 * `canonical-local-origin.test.ts` 只测 `lib/loopback-guard.ts` 的**纯函数判据**。
 * 但本轮发现的两个缺陷都**不在**判据里，而在 `proxy.ts` 如何使用判据：
 *
 * 1. 引导链接的端口取自 `Host` 头 ——— 判据代码完全正确，是拼接时用错了来源；
 * 2. 别名写请求直接放行到下游 ——— 判据存在，但只对读方法调用了它。
 *
 * 这类"判据对、接线错"的缺陷只有直接执行 `proxy()` 才能固定住，
 * 因此这里构造真实的 `NextRequest` 并断言返回值。
 *
 * 运行时（真实 Next 进程、真实 HTTP）的那一层在
 * `scripts/e2e-loopback-binding-proof.ts`，两者都要在。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const PORT = 3100;
const CANONICAL = `http://127.0.0.1:${PORT}`;
let previousOrigin: string | undefined;

beforeEach(() => {
  previousOrigin = process.env.CET6_LOCAL_ORIGIN;
  process.env.CET6_LOCAL_ORIGIN = CANONICAL;
});

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.CET6_LOCAL_ORIGIN;
  else process.env.CET6_LOCAL_ORIGIN = previousOrigin;
});

/** 构造一个带任意 `Host` 的请求（浏览器无法伪造该头，但服务器会看到它）。 */
function request(
  method: string,
  path: string,
  host: string,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${CANONICAL}${path}`, {
    method,
    headers: { host, ...extraHeaders },
  });
}

/** 从引导页 HTML 里取出唯一的链接。 */
function linkFrom(body: string): string | null {
  const match = /<a href="([^"]+)"/.exec(body);
  return match ? match[1] : null;
}

describe("统一边界 · 规范主机名放行", () => {
  it("规范 Host 的读请求不被拦截", () => {
    const result = proxy(request("GET", "/practice/courses", `127.0.0.1:${PORT}`));
    expect(result, "规范 Host 不得被拦截").toBeUndefined();
  });

  it("规范 Host 的写请求不被拦截（正常使用路径必须继续可用）", () => {
    const result = proxy(
      request("POST", "/settings", `127.0.0.1:${PORT}`, { origin: CANONICAL }),
    );
    expect(result, "规范 Host 的写请求必须继续通过统一边界").toBeUndefined();
  });
});

describe("统一边界 · 非回环 Host 失败关闭", () => {
  it("恶意 Host 的读请求 ⇒ 421，且不含页面正文", async () => {
    const result = proxy(request("GET", "/practice/courses", "evil.example"));
    expect(result?.status).toBe(421);
    const body = await result!.text();
    expect(body).not.toContain("<main>");
  });

  it("局域网 Host 的写请求 ⇒ 421（不是 403 引导）", () => {
    const result = proxy(
      request("POST", "/settings", "192.168.1.5:3100", { origin: CANONICAL }),
    );
    expect(result?.status).toBe(421);
  });
});

describe("统一边界 · 别名读请求得到可恢复的引导", () => {
  it("别名 Host ⇒ 421 引导页，链接指向规范地址", async () => {
    const result = proxy(request("GET", "/practice/courses", `localhost:${PORT}`));
    expect(result?.status).toBe(421);
    const body = await result!.text();
    expect(linkFrom(body)).toBe(`${CANONICAL}/practice/courses`);
  });

  it("引导页携带 no-store / nosniff / no-referrer", () => {
    const result = proxy(request("GET", "/", `localhost:${PORT}`));
    expect(result?.headers.get("cache-control")).toBe("no-store");
    expect(result?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("引导页保留路径与查询（否则无法一键恢复）", async () => {
    const result = proxy(
      request("GET", "/practice/courses?x=1&y=2", `localhost:${PORT}`),
    );
    const body = await result!.text();
    /*
     * 链接在 HTML 属性里，因此 `&` 必须是 `&amp;` —— 这是**正确**的输出，
     * 浏览器解析后仍是 `?x=1&y=2`。断言时按 HTML 反转义后比较，
     * 否则测的是转义形式而不是"路径与查询有没有被带过去"。
     */
    const link = linkFrom(body)!.replace(/&amp;/g, "&");
    expect(link).toBe(`${CANONICAL}/practice/courses?x=1&y=2`);
  });
});

describe("统一边界 · Host 端口伪造不能改变链接端口", () => {
  /*
   * ── 本轮 CTO 指出的缺陷 ──
   *
   * 上一版把 `Host` 头里的端口拿来拼引导链接：
   * `Host: localhost:9999` 打在本服务上 ⇒ 生成
   * `http://127.0.0.1:9999/...`，那是**另一项本地服务**。
   *
   * 修复要求：协议、主机名、端口三者全部来自 `trustedLocalOrigin()`。
   * 下面每个伪端口都必须得到**完全相同**的链接。
   */
  it("任意伪端口都生成同一个规范链接", async () => {
    const expected = `${CANONICAL}/practice/courses`;
    for (const spoofed of ["3250", "9999", "1", "65535", "8080"]) {
      const result = proxy(
        request("GET", "/practice/courses", `localhost:${spoofed}`),
      );
      const body = await result!.text();
      expect(linkFrom(body), `Host 端口 ${spoofed} 不得改变链接端口`).toBe(expected);
    }
  });

  it("Host 缺端口时链接仍带本实例端口（不落到默认 80）", async () => {
    const result = proxy(request("GET", "/practice/courses", "localhost"));
    const body = await result!.text();
    expect(linkFrom(body)).toBe(`${CANONICAL}/practice/courses`);
  });

  it("IPv6 别名同样指向规范地址", async () => {
    const result = proxy(request("GET", "/", "[::1]:4444"));
    const body = await result!.text();
    expect(linkFrom(body)).toBe(`${CANONICAL}/`);
  });

  it("多实例：链接端口跟随本实例配置，而不是写死 3100", async () => {
    /*
     * E2E 实例以 3199~3265 启动，各自通过 `PORT` / `CET6_LOCAL_ORIGIN`
     * 声明来源。引导链接必须是**该实例自己**的端口，否则点一下就跑到
     * 另一个服务上去了。
     */
    process.env.CET6_LOCAL_ORIGIN = "http://127.0.0.1:3265";
    const result = proxy(request("GET", "/practice/courses", "localhost:3265"));
    const body = await result!.text();
    expect(linkFrom(body)).toBe("http://127.0.0.1:3265/practice/courses");
  });
});

describe("统一边界 · 路径注入不能改写主机名", () => {
  /*
   * 路径与查询是请求方**唯一**能贡献的部分，因此必须假定它是敌意的。
   * 以 `//` 开头的形态在浏览器里是协议相对 URL：拼在规范来源后面会
   * 变成开放重定向。
   */
  it("协议相对路径（//host）被回退为 /", async () => {
    const result = proxy(
      request("GET", "/practice/courses", `localhost:${PORT}`),
    );
    const body = await result!.text();
    const link = linkFrom(body)!;
    expect(link.startsWith(`${CANONICAL}/`), `链接必须是规范来源之下的绝对路径：${link}`).toBe(true);
    // 不得出现 "127.0.0.1:3100//evil.example" 这种把主机名挤掉的形态
    expect(link.replace(CANONICAL, "")).not.toMatch(/^\/\//);
  });

  it("引导链接里不出现任何控制字符", async () => {
    const result = proxy(request("GET", "/", `localhost:${PORT}`));
    const body = await result!.text();
    const link = linkFrom(body)!;
    expect(/[\u0000-\u001f\u007f]/.test(link)).toBe(false);
  });
});

describe("统一边界 · 别名写请求在统一层拒绝", () => {
  /*
   * ── 为什么要在这里拒，而不是留给下游 ──
   *
   * 实测：Next 16.4.2 的 Server Actions CSRF 门禁把 `Origin` 与 **`Host` 头**
   * 相比，`Origin` 缺失时只记警告就放行。于是"别名 Host + 别名 Origin"
   * 能通过那道门禁，action 正常执行并**写入数据库**。
   * 下游端点并非都自己做精确 Origin 校验，因此统一边界必须自己兜住。
   */
  const writeMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;

  for (const method of writeMethods) {
    it(`${method} + 别名 Host ⇒ 403（不引导、不转发）`, async () => {
      const result = proxy(
        request(method, "/settings", `localhost:${PORT}`, {
          origin: `http://localhost:${PORT}`,
          "next-action": "0".repeat(40),
        }),
      );
      expect(result, `${method} 必须被统一边界拦截`).toBeDefined();
      expect(result!.status).toBe(403);
      const body = await result!.text();
      expect(body).not.toContain("<a href=");
      expect(body).not.toContain("<html");
    });
  }

  it("别名写请求的拒绝体不含任何内部细节", async () => {
    const result = proxy(
      request("POST", "/settings", `localhost:${PORT}`, {
        origin: `http://localhost:${PORT}`,
      }),
    );
    const body = await result!.text();
    expect(body).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(body.toLowerCase()).not.toContain("stack");
  });

  it("别名写请求的响应头禁止缓存", () => {
    const result = proxy(
      request("POST", "/settings", `localhost:${PORT}`, {
        origin: `http://localhost:${PORT}`,
      }),
    );
    expect(result?.headers.get("cache-control")).toBe("no-store");
  });
});
