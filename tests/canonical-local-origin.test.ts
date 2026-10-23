// @vitest-environment node
/**
 * 规范访问地址 · 回环别名与同源边界（单元层）。
 *
 * ── 它守的那个实测缺陷 ──
 *
 * README 让人打开 `http://localhost:3100`，而服务监听并信任
 * `http://127.0.0.1:3100`。浏览器把这两个主机名当作**两个不同来源**，
 * 于是课程揭示的 POST 被同源守卫拒掉（实测 403），界面只说"来源不是
 * 同一个本地服务" —— 没有恢复路径。功能看起来就是坏的。
 *
 * ── 修复的两条腿，各自断言 ──
 *
 * 1. **判据没有放宽。** 别名来源仍然被**拒绝**（这一条最重要：
 *    修"用户体验"最容易滑向"同时信任两个主机名"，而那会放松
 *    唯一出口来源的写操作边界）。
 * 2. **拒绝变成可恢复的。** 别名有自己的一类理由，说明里直接给出
 *    规范地址，使用者照着换一下即可。
 *
 * 运行时（真实 Next 服务器、原始 Host 头）的那一层在
 * `scripts/e2e-loopback-binding-proof.ts` 里 —— 本文件只固定纯函数判据。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyOrigin,
  explainLocalRejection,
  guardLocalRequest,
  isCanonicalHostHeader,
  isLoopbackHostHeader,
  trustedHostname,
  trustedLocalOrigin,
} from "@/lib/loopback-guard";

const PORT = 3100;
let previousOrigin: string | undefined;

beforeEach(() => {
  previousOrigin = process.env.CET6_LOCAL_ORIGIN;
  process.env.CET6_LOCAL_ORIGIN = `http://127.0.0.1:${PORT}`;
});

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.CET6_LOCAL_ORIGIN;
  else process.env.CET6_LOCAL_ORIGIN = previousOrigin;
});

describe("规范访问地址 · 回环别名仍被拒绝", () => {
  it("localhost 来源**不**被接受（与 127.0.0.1 是两个来源）", () => {
    const result = classifyOrigin(`http://localhost:${PORT}`);
    expect(result.ok, "localhost 与 127.0.0.1 不是同一个来源，必须拒绝").toBe(false);
    expect(result.ok === false && result.reason).toBe("origin_loopback_alias");
  });

  it("IPv6 回环别名同样不被接受", () => {
    const result = classifyOrigin(`http://[::1]:${PORT}`);
    expect(result.ok).toBe(false);
  });

  it("规范来源本身被接受（修复不能把正常路径一起毙掉）", () => {
    expect(classifyOrigin(`http://127.0.0.1:${PORT}`).ok).toBe(true);
    expect(guardLocalRequest({
      host: `127.0.0.1:${PORT}`,
      origin: `http://127.0.0.1:${PORT}`,
    }).ok).toBe(true);
  });

  it("别名 Host 与规范 Origin ⇒ 仍被拒（Host 判定在最前面）", () => {
    const guard = guardLocalRequest({
      host: `localhost:${PORT}`,
      origin: `http://127.0.0.1:${PORT}`,
    });
    expect(guard.ok, "回环别名 Host 不得放行写请求").toBe(false);
    expect(guard.ok === false && guard.reason).toBe("host_not_trusted");
  });

  it("别名不能因为都属于回环而通过精确判据", () => {
    /*
     * 这两条一起说明"宽松判据"与"放行判据"不是同一个东西：
     * 宽松判据说"是回环"，精确判据说"不是同一个来源"。
     * 修复绝不能把后者变成前者。
     */
    expect(isLoopbackHostHeader(`localhost:${PORT}`)).toBe(true);
    expect(classifyOrigin(`http://localhost:${PORT}`).ok).toBe(false);
  });
});

describe("规范访问地址 · 拒绝是可恢复的", () => {
  it("别名的拒绝说明直接给出规范地址", () => {
    const message = explainLocalRejection("origin_loopback_alias");
    expect(message, "说明里必须写出规范地址，否则使用者无从恢复").toContain(
      trustedLocalOrigin(),
    );
  });

  it("跨来源与跨站的拒绝说明**不**给出规范地址（那不是用户的地址错误）", () => {
    /*
     * 只有"别名"这一支是本机用户自己可以改正的笔误。
     * 跨站/跨端口来的请求不该得到"照这个地址打开"的提示 ——
     * 那会诱导把一个不受信任的调用方引到正确路径上。
     */
    for (const reason of ["origin_not_loopback", "origin_not_same_origin"] as const) {
      expect(explainLocalRejection(reason)).not.toContain(trustedLocalOrigin());
    }
  });

  it("每条拒绝理由都有非空说明（不会出现 undefined 被塞进响应体）", () => {
    const reasons = [
      "host_not_trusted",
      "origin_missing",
      "origin_invalid",
      "origin_not_loopback",
      "origin_loopback_alias",
      "origin_not_same_origin",
    ] as const;
    for (const reason of reasons) {
      const message = explainLocalRejection(reason);
      expect(typeof message, `${reason} 的说明必须是字符串`).toBe("string");
      expect(message.length, `${reason} 的说明不能是空串`).toBeGreaterThan(0);
    }
  });
});

describe("规范访问地址 · authority 判定（主机名 + 端口）", () => {
  /*
   * ── 本轮修正的缺陷 A ──
   *
   * 旧断言写 `expect(isCanonicalHostHeader("127.0.0.1")).toBe(true)` ——
   * 那是"只比 hostname、忽略端口"的语义。独立审查用真实 Server Action
   * 实测：`Host: 127.0.0.1:9999` + 匹配伪端口的 Origin ⇒ 200 且**改了数据库**。
   *
   * 因此这里不是"改断言让它变绿"，而是把判据换成正确的、更严格的那一条：
   * 端口参与判定，缺失端口不再等价于"任意端口"。
   */
  it("可信 authority 由主机名与端口共同决定", () => {
    expect(trustedHostname()).toBe("127.0.0.1");

    // 完整的规范 authority ⇒ 通过
    expect(isCanonicalHostHeader(`127.0.0.1:${PORT}`)).toBe(true);

    /*
     * 缺端口 ⇒ **不**通过。可信来源是 `:3100`；`127.0.0.1`（无端口）
     * 在 HTTP 语义里指 80 端口 —— 那是另一个监听者。
     * 旧版把它当 true，正是缺陷 A 的一半成因。
     */
    expect(
      isCanonicalHostHeader("127.0.0.1"),
      "缺端口不等于可信端口（默认端口是 80，不是 3100）",
    ).toBe(false);

    expect(isCanonicalHostHeader(`localhost:${PORT}`)).toBe(false);
    expect(isCanonicalHostHeader("[::1]:3100")).toBe(false);
    expect(isCanonicalHostHeader("evil.example")).toBe(false);
    expect(isCanonicalHostHeader(undefined)).toBe(false);
    expect(isCanonicalHostHeader("")).toBe(false);
  });

  it("端口伪造一律拒绝（缺陷 A 的核心负向控制）", () => {
    /*
     * 这是 Reviewer 实际利用的那条路径：主机名正确、端口伪造。
     * 每一个都必须为 false —— 否则错误端口会被当成规范地址放行写入。
     */
    for (const port of ["9999", "3101", "1", "65535", "3250", "80"]) {
      expect(
        isCanonicalHostHeader(`127.0.0.1:${port}`),
        `伪造端口 ${port} 不得被判为规范地址`,
      ).toBe(false);
    }
  });

  it("畸形 Host 失败关闭（解析器不得产生歧义）", () => {
    /*
     * 这些形态的共同点是"不同解析器会得出不同结论"。安全边界只能取
     * 交集，因此一律拒绝，而不是猜一个解释。
     */
    const malformed = [
      "127.0.0.1:abc", // 端口非数字
      "127.0.0.1:99999", // 端口越界
      "127.0.0.1:0", // 端口 0
      "127.0.0.1:", // 冒号后为空
      "127.0.0.1:3100:3100", // 多个冒号（走私形态）
      "::1:3100", // 裸 IPv6 缺方括号
      " 127.0.0.1:3100", // 前导空白
      "127.0.0.1:3100 ", // 尾随空白
      "[::1", // 方括号未闭合
    ];
    for (const host of malformed) {
      expect(
        isCanonicalHostHeader(host),
        `${JSON.stringify(host)} 必须被拒绝`,
      ).toBe(false);
    }
  });

  it("规范地址判定不接受主机名相似的伪造", () => {
    for (const host of [
      "127.0.0.1.evil.com",
      "evil.com:127.0.0.1",
      "not127.0.0.1",
    ]) {
      expect(isCanonicalHostHeader(host), `${host} 不得被判为规范地址`).toBe(false);
    }
  });
});

describe("规范访问地址 · 端口仍参与同源判定", () => {
  it("同主机名、不同端口 ⇒ 不是同一来源", () => {
    const result = classifyOrigin(`http://127.0.0.1:${PORT + 1}`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("origin_not_same_origin");
  });

  it("别名的不同端口归到跨来源，而不是别名", () => {
    /*
     * `localhost:3200` 既换了主机名、又换了端口。它的性质是
     * "另一个本地服务"，不是"同一服务的另一个名字" —— 因此不该得到
     * "把地址换一下就好"的引导。
     */
    const result = classifyOrigin(`http://localhost:${PORT + 1}`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("origin_not_same_origin");
  });

  it("协议不同 ⇒ 不是同一来源", () => {
    const result = classifyOrigin(`https://127.0.0.1:${PORT}`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("origin_not_same_origin");
  });
});
