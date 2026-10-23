// @vitest-environment node
/**
 * 默认端口兼容 · authority 规范化（HTTP 80 / HTTPS 443）。
 *
 * ── 它守的那个实测缺陷（本轮）──
 *
 * 上一版 `trustedAuthority()` 直接返回 `URL#port`，而 WHATWG URL 会把
 * **默认端口规范化为空串**：`new URL("http://h:80").port === ""`。
 * 请求侧 `Host: h:80` 却被解析成 `"80"`。于是：
 *
 * - 合法请求 `Host: h:80` 与 `Host: h` 被判成**不同** authority ⇒ 403；
 * - 反方向同样危险：若不做等效，省略端口可能被当成"任意端口"。
 *
 * 独立审查在真实 HTTP 80 实例上复现了合法请求被拒。
 *
 * ── 修法与判据 ──
 *
 * 两侧都归一到**生效端口**：显式端口优先，否则取**可信协议的**默认端口。
 * 「省略端口等于多少」的依据是配置里的协议，永远不是请求头。
 *
 * 这里逐项固定：
 * 1. HTTP 80：无端口与显式 `:80` 都合法；
 * 2. HTTPS 443：无端口与显式 `:443` 在 HTTPS 配置下等效；
 * 3. 非默认端口（3100/3250/3265）必须显式精确匹配；
 * 4. 尾随冒号（`host:`）明确拒绝，不当成"无端口"；
 * 5. 非数字/越界/多冒号/空白/控制字符/畸形 IPv6 一律拒绝。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyOrigin,
  isTrustedHostHeader,
  parseHostHeader,
  trustedHostname,
} from "@/lib/loopback-guard";

const HOST = "127.0.0.1";
let previousOrigin: string | undefined;

beforeEach(() => {
  previousOrigin = process.env.CET6_LOCAL_ORIGIN;
});

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.CET6_LOCAL_ORIGIN;
  else process.env.CET6_LOCAL_ORIGIN = previousOrigin;
});

/** 配置 HTTP 默认端口（`:80` 或省略）。 */
function configureHttpDefault(withExplicitPort: boolean): void {
  process.env.CET6_LOCAL_ORIGIN = withExplicitPort
    ? `http://${HOST}:80`
    : `http://${HOST}`;
}

describe("默认端口 · HTTP 80", () => {
  it("无端口 Host 合法", () => {
    configureHttpDefault(false);
    expect(
      isTrustedHostHeader(HOST),
      "http 配置下无端口 Host 就是 80 端口，必须放行",
    ).toBe(true);
  });

  it("显式 :80 合法（本轮修复的核心）", () => {
    configureHttpDefault(true);
    expect(
      isTrustedHostHeader(`${HOST}:80`),
      "显式 :80 与省略端口是同一个来源，必须放行",
    ).toBe(true);
  });

  it("配置省略端口时，显式 :80 同样合法", () => {
    configureHttpDefault(false);
    expect(
      isTrustedHostHeader(`${HOST}:80`),
      "URL 把配置里的 :80 规范化为空串，两种写法必须等价",
    ).toBe(true);
  });

  it("配置显式 :80 时，省略端口同样合法", () => {
    configureHttpDefault(true);
    expect(
      isTrustedHostHeader(HOST),
      "省略端口在 http 下就是 80，必须与显式 :80 等价",
    ).toBe(true);
  });

  it("非 80 的端口仍然拒绝", () => {
    configureHttpDefault(false);
    for (const port of ["3100", "3250", "3265", "8080", "81"]) {
      expect(
        isTrustedHostHeader(`${HOST}:${port}`),
        `http 默认端口配置下 ${port} 不是同一来源`,
      ).toBe(false);
    }
  });
});

describe("默认端口 · HTTPS 443", () => {
  it("无端口与显式 :443 在 HTTPS 配置下等效", () => {
    process.env.CET6_LOCAL_ORIGIN = `https://${HOST}`;
    expect(isTrustedHostHeader(HOST), "https 无端口即 443").toBe(true);
    expect(isTrustedHostHeader(`${HOST}:443`), "显式 :443 等价").toBe(true);

    process.env.CET6_LOCAL_ORIGIN = `https://${HOST}:443`;
    expect(isTrustedHostHeader(HOST), "配置写 :443 也归一化为 443").toBe(true);
    expect(isTrustedHostHeader(`${HOST}:443`)).toBe(true);
  });

  it("HTTPS 配置下 :80 **不**是同一来源（协议决定默认端口）", () => {
    process.env.CET6_LOCAL_ORIGIN = `https://${HOST}`;
    expect(
      isTrustedHostHeader(`${HOST}:80`),
      "https 的默认端口是 443，:80 是另一个来源",
    ).toBe(false);
  });

  it("HTTP 配置下 :443 **不**是同一来源", () => {
    configureHttpDefault(false);
    expect(
      isTrustedHostHeader(`${HOST}:443`),
      "http 的默认端口是 80，:443 是另一个来源",
    ).toBe(false);
  });
});

describe("默认端口 · 尾随冒号明确拒绝", () => {
  /*
   * ── 上一版的另一处不严格 ──
   *
   * `"127.0.0.1:"` 被解析成 `port: ""`，与"无端口"完全等价，于是在默认端口
   * 配置下被**放行**。`Host:` 后什么都没有，不同解析器解释不一致，
   * 安全边界只能取"拒绝"这一侧。
   */
  it("`host:` 在默认端口配置下仍被拒绝", () => {
    for (const explicit of [false, true]) {
      configureHttpDefault(explicit);
      expect(
        isTrustedHostHeader(`${HOST}:`),
        `配置 explicit=${explicit} 时尾随冒号必须拒绝`,
      ).toBe(false);
    }
  });

  it("`[::1]:` 同样被拒绝", () => {
    configureHttpDefault(false);
    expect(isTrustedHostHeader("[::1]:")).toBe(false);
  });

  it("parseHostHeader 对尾随冒号返回 null", () => {
    expect(parseHostHeader(`${HOST}:`)).toBeNull();
    expect(parseHostHeader("[::1]:")).toBeNull();
  });
});

describe("非默认端口必须显式精确匹配", () => {
  it("配置 :3100 时，省略端口被拒绝", () => {
    process.env.CET6_LOCAL_ORIGIN = `http://${HOST}:3100`;
    expect(
      isTrustedHostHeader(HOST),
      "省略端口是 80，不是 3100；不得蒙混过关",
    ).toBe(false);
    expect(isTrustedHostHeader(`${HOST}:3100`)).toBe(true);
  });

  it("配置 :3100 时，:80 被拒绝（两个不同端口）", () => {
    process.env.CET6_LOCAL_ORIGIN = `http://${HOST}:3100`;
    expect(isTrustedHostHeader(`${HOST}:80`)).toBe(false);
  });

  it("非默认端口之间互不等价", () => {
    process.env.CET6_LOCAL_ORIGIN = `http://${HOST}:3265`;
    expect(isTrustedHostHeader(`${HOST}:3265`)).toBe(true);
    for (const other of ["3100", "3250", "3266", "80"]) {
      expect(isTrustedHostHeader(`${HOST}:${other}`), `${other} 不得等价于 3265`).toBe(false);
    }
  });
});

describe("严格输入规则不因本次修复而放松", () => {
  it("畸形 Host 仍全部拒绝", () => {
    configureHttpDefault(false);
    const malformed = [
      `${HOST}:abc`,
      `${HOST}:99999`,
      `${HOST}:0`,
      `${HOST}:080`, // 前导零：保持严格，不做数值等价
      `${HOST}::80`,
      `::1:80`,
      ` ${HOST}`,
      `${HOST} `,
      "[::1",
      "",
    ];
    for (const host of malformed) {
      expect(
        isTrustedHostHeader(host),
        `${JSON.stringify(host)} 必须被拒绝`,
      ).toBe(false);
    }
  });

  it("`:080` 不被当成 80（不做数值归一化）", () => {
    /*
     * 刻意不做"前导零等价"：`080` 与 `80` 在不同解析器里可能给出不同结果，
     * 而安全边界只接受规范写法。这是**收紧**，不是放松。
     */
    configureHttpDefault(false);
    expect(isTrustedHostHeader(`${HOST}:080`)).toBe(false);
  });
});

describe("Origin 侧默认端口一致性（不得放宽同源规则）", () => {
  it("HTTP 80 配置下，无端口与 :80 的 Origin 都被接受", () => {
    configureHttpDefault(false);
    expect(classifyOrigin(`http://${HOST}`).ok).toBe(true);
    expect(classifyOrigin(`http://${HOST}:80`).ok).toBe(true);
  });

  it("HTTPS 443 配置下，无端口与 :443 的 Origin 都被接受", () => {
    process.env.CET6_LOCAL_ORIGIN = `https://${HOST}:443`;
    expect(classifyOrigin(`https://${HOST}`).ok).toBe(true);
    expect(classifyOrigin(`https://${HOST}:443`).ok).toBe(true);
  });

  it("跨协议 Origin 仍被拒绝（协议仍参与判定）", () => {
    configureHttpDefault(false);
    const result = classifyOrigin(`https://${HOST}:80`);
    expect(result.ok, "https 的 Origin 打 http 服务必须拒绝").toBe(false);
  });

  it("别名主机名在默认端口下仍被拒绝", () => {
    configureHttpDefault(false);
    const result = classifyOrigin(`http://localhost`);
    expect(result.ok, "localhost 与 127.0.0.1 在 80 端口下仍是两个来源").toBe(false);
  });

  it("非默认端口 Origin 仍需精确匹配", () => {
    process.env.CET6_LOCAL_ORIGIN = `http://${HOST}:3100`;
    expect(classifyOrigin(`http://${HOST}:3100`).ok).toBe(true);
    expect(classifyOrigin(`http://${HOST}`).ok, "省略端口是 80，不是 3100").toBe(false);
    expect(classifyOrigin(`http://${HOST}:3101`).ok).toBe(false);
  });
});

describe("配置来源仍是唯一权威（Host 不参与定义）", () => {
  it("trustedHostname 只反映配置", () => {
    configureHttpDefault(false);
    /*
     * 判据永远读配置，而不是读某个请求 —— 这条断言的意义在于：
     * 无论请求头写什么，`trustedHostname()` 都不会变。
     */
    expect(trustedHostname()).toBe(HOST);
    expect(isTrustedHostHeader("evil.example")).toBe(false);
    expect(trustedHostname()).toBe(HOST);
  });
});
