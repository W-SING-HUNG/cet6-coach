#!/usr/bin/env node
/**
 * 本地回环绑定与**同源一致性**的运行时证明（P0-1 / P0-2）。
 *
 * ── 它证明什么 ──
 *
 * 1. **回环绑定**：源码里写 `-H 127.0.0.1` 不等于服务真的只监听回环。
 *    因此这里起**真实**的 Next 服务器，然后从操作系统问它是否真的在
 *    回环上接受连接、并拒绝非回环 Host。
 * 2. **`pnpm dev` 与 `pnpm start` 都可用**：上一轮发现 `start` 没写端口，
 *    于是它默认监听 3000，而 `CET6_LOCAL_ORIGIN` 默认 3100 ——
 *    生产实例会被自己的守卫挡掉。这里对**两条命令**各起一次真实服务，
 *    验证 GET 导航与授权揭示都能工作、跨来源请求失败。
 *
 * 判据是 `server.address()` / 真实 HTTP 响应的**实际取值**，不是回显常量 ——
 * 回显的写法在绑定被改成 `0.0.0.0` 之后仍然显示 `127.0.0.1`，
 * 因此证明不了任何事（同标注服务器 F7 的理由）。
 *
 * ── 它用的是什么数据 ──
 *
 * **只用合成夹具**：内容根与数据库都在 `.e2e/` 下。
 * 它**不碰** `private-content/`，也不碰日常开发库，更**不运行** `e2e:real`。
 */

import { createConnection, createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  E2E_LOOPBACK_PROOF_PORT,
  E2E_LOOPBACK_PROOF_DEV_PORT,
  E2E_LOOPBACK_PROOF_DB_PATH,
  E2E_LOOPBACK_PROOF_CONTENT_ROOT,
} from "../e2e/config";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { telemetryOffEnv } from "./next.mjs";

let passed = 0;
let failed = 0;
/** 跳过数：仅在环境确实做不到时使用（例如无法绑定特权的默认端口）。 */
let skipped = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === "" ? "" : `（${detail}）`}`);
  }
}

/** 从本机连一下某个地址，判断它是否在接受连接。 */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * 发一个**原始 HTTP** 请求（允许任意 Host）。
 *
 * `Host` 与 `Origin` 都是 Fetch 规范的禁止修改请求头：Node 的 `fetch`
 * 与浏览器都会静默丢弃脚本设的值。因此这条判据必须用底层 `node:http`
 * （同标注服务器的非回环 Host 判据）。
 */
function rawGet(
  port: number,
  path: string,
  hostHeader: string,
): Promise<{ status: number; cacheControl: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: LOOPBACK_HOST, port, path, method: "GET", headers: { host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            cacheControl: (res.headers["cache-control"] as string | undefined) ?? null,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 发一个**原始 HTTP** POST 请求（允许任意 `Host` 与 `Origin`）。
 *
 * 同 `rawGet` 的理由：这两个头都是禁止修改的请求头，只有底层
 * `node:http` 能真的把它们带上去。
 *
 * `extraHeaders` 用于 Server Action 形态的请求（需要 `next-action`）。
 * 它排在默认头之后合并，因此调用方可以覆盖 `content-type`。
 */
function rawPost(
  port: number,
  path: string,
  options: {
    hostHeader: string;
    originHeader?: string;
    body: string;
    extraHeaders?: Record<string, string>;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(options.body, "utf8");
    const headers: Record<string, string> = {
      host: options.hostHeader,
      "content-type": "application/json",
      ...options.extraHeaders,
      "content-length": String(payload.byteLength),
    };
    if (options.originHeader !== undefined) headers.origin = options.originHeader;

    const req = httpRequest(
      { host: LOOPBACK_HOST, port, path, method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** 等某个端口就绪（最多 90 秒，dev 首次编译可能较慢）。 */
async function waitForPort(port: number, timeoutSeconds = 90): Promise<boolean> {
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await canConnect(LOOPBACK_HOST, port)) return true;
  }
  return false;
}

/**
 * 读回页面 HTML（回环 Host），用于核对页面上的风险指纹。
 *
 * 判据是 `data-risk-fingerprint` 属性的**实际取值** —— 那是服务端渲染
 * 出来的，而不是在证明里重算的常量。
 */
function fetchPageHtml(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: LOOPBACK_HOST,
        port,
        path,
        method: "GET",
        headers: { host: `${LOOPBACK_HOST}:${port}` },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 从页面 HTML 里读出风险指纹（读不到返回 null）。 */
function fingerprintFromHtml(html: string): string | null {
  const match = /data-risk-fingerprint="([0-9a-f]{64})"/.exec(html);
  return match ? match[1] : null;
}

/** 起一个真实服务器并返回其子进程。 */
function startServer(command: "dev" | "start", port: number): ChildProcess {
  /*
   * 走仓库的 Next 入口（`scripts/next.mjs`）而不是裸 `pnpm exec next`：
   * 那样才会带上 `NEXT_TELEMETRY_DISABLED`（本轮 P1-T）。
   *
   * 这一条同时被架构门禁守着：任何启动器若绕过统一入口，
   * 就构成一个遥测旁路 —— 而这正是独立审查要求审计的东西。
   */
  return spawn(
    process.execPath,
    ["scripts/next.mjs", command, "-H", LOOPBACK_HOST, "-p", String(port)],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        ...telemetryOffEnv(),
        CET6_DB_PATH: E2E_LOOPBACK_PROOF_DB_PATH,
        /*
         * 只覆盖端口：`CET6_LOCAL_ORIGIN` 的协议与主机名仍走默认值。
         * 这同时验证了 `PORT` 环境变量这条取值路径（P0-2 第 2 条）。
         */
        PORT: String(port),
      },
    },
  );
}

/** 结束一个服务器：先杀外壳，再按端口找进程，最后硬超时兜底。 */
async function stopServer(child: ChildProcess, port: number): Promise<void> {
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`,
      { stdio: "ignore" },
    );
  } catch {
    /* 端口上已经没有进程了 */
  }
}

/** 对一个实例跑完整的安全判据。 */
async function verifyInstance(label: string, port: number, probe: RevealProbe): Promise<void> {
  console.log(`\n── ${label}（端口 ${port}）──`);

  // ① 回环可连（否则后面几条没有意义）。
  check("127.0.0.1 可连", await canConnect(LOOPBACK_HOST, port));

  /*
   * ② 集中边界：非回环 Host 的 HTTP 请求必须被拒。
   *
   * 这是"没有绑到 0.0.0.0 / 局域网地址"的运行时判据 ——
   * 若服务绑在 `0.0.0.0`，那么带任意 Host 的请求都会被受理。
   */
  const foreignHost = await rawGet(port, "/practice/courses", "evil.example");
  check(
    "非回环 Host ⇒ 被集中边界拒绝",
    foreignHost.status === 421 || foreignHost.status === 403,
    `状态 ${foreignHost.status}`,
  );

  // ②b 局域网 Host 同样被拒。
  const lanHost = await rawGet(port, "/practice/courses", "192.168.1.5:8080");
  check(
    "局域网 Host ⇒ 被集中边界拒绝",
    lanHost.status === 421 || lanHost.status === 403,
    `状态 ${lanHost.status}`,
  );

  // ②c 敏感 POST 端点也要过这道边界（纵深防御）。
  const foreignApi = await rawGet(port, "/api/course/reveal", "evil.example");
  check(
    "非回环 Host 打敏感端点 ⇒ 被拒",
    foreignApi.status === 421 || foreignApi.status === 403,
    `状态 ${foreignApi.status}`,
  );

  // ③ 回环 Host 的正常请求可以到达（否则守卫过严会让产品不可用）。
  const loopback = await rawGet(port, "/practice/courses", `${LOOPBACK_HOST}:${port}`);
  check(
    "回环 Host ⇒ GET 导航正常放行",
    loopback.status < 500,
    `状态 ${loopback.status}`,
  );

  // ④ 被拒的响应不得带缓存（拒绝信息也不该被中间层留住）。
  check(
    "拒绝响应的 cache-control 是 no-store",
    foreignHost.cacheControl === "no-store",
    foreignHost.cacheControl ?? "无",
  );

  /*
   * ── ④b 回环别名的引导（规范访问地址）──
   *
   * 缺陷回顾：README 让人打开 `localhost:<port>`，而服务监听并信任
   * `127.0.0.1:<port>`。页面照常显示，点「确认阅读」时 POST 被 403 ——
   * 没有任何恢复路径。这里对**真实的 Next 服务器**验证修复后的四件事，
   * 且都用原始 `Host` 头（浏览器无法伪造该头）：
   *
   * 1. 别名读请求得到**清楚的结果**（不是一张看似正常的页面）；
   * 2. 该结果里给出**规范地址**的链接，且链接指向同一个端口（不跨实例）；
   * 3. 该结果**不含任何课程正文** —— 引导页不是内容出口；
   * 4. **Host 头里的端口不能改变链接端口** —— 见 ④c。
   */
  if (LOOPBACK_HOST === "127.0.0.1") {
    const aliasHost = `localhost:${port}`;
    const aliasPage = await rawGet(port, `/practice/courses/${probe.courseId}`, aliasHost);

    check(
      "回环别名（localhost）读请求 ⇒ 得到明确的引导，而不是看似正常的页面",
      aliasPage.status === 421,
      `状态 ${aliasPage.status}`,
    );

    check(
      "引导页指向规范地址",
      aliasPage.body.includes(`http://${LOOPBACK_HOST}:${port}/`),
      "响应体里没有规范地址链接",
    );

    check(
      "引导页不携带任何课程正文",
      !aliasPage.body.includes(probe.expectedText),
      "引导页出现了正文，说明它成了内容出口",
    );

    /*
     * ── ④c Host 头端口伪造（本轮修复的核心负向控制）──
     *
     * 历史缺陷：引导链接的端口取自 `Host` 头，于是
     * `Host: localhost:9999` 打在本服务上会生成指向 `http://127.0.0.1:9999/...`
     * 的链接 —— 那是**另一项本地服务**。这既违背"可信来源不来自请求头"
     * 的原则，也会把使用者引导到别的进程上（且看起来像成功了）。
     *
     * 判据：换任意伪端口，链接的 authority 必须**始终**等于本实例的
     * 可信来源，一个字都不变。
     */
    const expectedOrigin = `http://${LOOPBACK_HOST}:${port}`;
    const spoofedPorts = ["3250", "9999", "1", "65535"];
    const spoofFailures: string[] = [];

    for (const spoofed of spoofedPorts) {
      const spoofedPage = await rawGet(port, "/practice/courses", `localhost:${spoofed}`);
      const linkMatch = /<a href="([^"]+)"/.exec(spoofedPage.body);
      const link = linkMatch ? linkMatch[1] : "";
      const usesTrustedOrigin = link.startsWith(`${expectedOrigin}/`);
      const leaksSpoofedPort = link.includes(`:${spoofed}/`) && spoofed !== String(port);
      if (!usesTrustedOrigin || leaksSpoofedPort) {
        spoofFailures.push(`Host 端口 ${spoofed} ⇒ ${link || "(无链接)"}`);
      }
    }

    check(
      "Host 头里的伪端口**不能**改变引导链接的端口",
      spoofFailures.length === 0,
      spoofFailures.join(" ; "),
    );

    /*
     * 缺端口的 Host（`localhost` 不带端口）同样不得让链接丢掉端口 ——
     * 那会让链接指向默认端口 80，又是一个"另一项服务"。
     */
    const noPortPage = await rawGet(port, "/practice/courses", "localhost");
    const noPortLink = (/<a href="([^"]+)"/.exec(noPortPage.body) ?? [])[1] ?? "";
    check(
      "Host 头缺端口时引导链接仍带本实例端口",
      noPortLink.startsWith(`${expectedOrigin}/`),
      noPortLink || "(无链接)",
    );

    /*
     * 路径/查询必须仍然被带过去（可恢复性），但**只能**是路径与查询 ——
     * 协议相对形态（`//host`）不得把链接变成开放重定向。
     */
    const withQuery = await rawGet(port, "/practice/courses?x=1&y=2", `localhost:${port}`);
    check(
      "引导链接保留路径与查询",
      withQuery.body.includes(`${expectedOrigin}/practice/courses?x=1`),
      "路径或查询丢失",
    );

    check(
      "引导链接不是协议相对 URL（不改主机名）",
      !/<a href="\/\//.test(withQuery.body),
      "出现了以 // 开头的链接，可被解释为协议相对 URL",
    );

    /*
     * 别名 Host 的写请求必须被拒 —— 且现在是在**统一 Proxy 层**就拒，
     * 不依赖下游端点自己校验。这条用敏感端点验证（它的下游守卫最严），
     * Server Actions 那一类在 ④d 单独验证。
     */
    const aliasWrite = await rawPost(port, "/api/course/reveal", {
      hostHeader: aliasHost,
      originHeader: `http://${LOOPBACK_HOST}:${port}`,
      body: JSON.stringify({
        courseId: probe.courseId,
        segmentId: probe.segmentId,
        courseContentVersion: 1,
        confirmedRiskFingerprint: "0".repeat(64),
      }),
    });
    check(
      "回环别名 Host 的写请求 ⇒ 仍被拒（引导不放宽同源边界）",
      aliasWrite.status === 403,
      `状态 ${aliasWrite.status}`,
    );

    /*
     * ── ④d Server Action 写通路（本轮实测发现）──
     *
     * Next 16.4.2 的 Server Actions CSRF 门禁把 `Origin` 与 **`Host` 头**
     * 相比，且 `Origin` 缺失时只记警告就放行（见
     * `action-handler.js` 的 `parseHostHeader`/`handleAction`）。
     * 于是"别名 Host + 别名 Origin"能**通过**那道门禁 ——
     * 实测曾真的写进数据库。因此必须由统一 Proxy 层拒绝。
     *
     * 这里用 POST 打一个 action 路径（不带合法 action id 也无所谓：
     * 判据是"在到达 action 分发之前就被拒"，状态码 403 而非 500/400）。
     */
    const aliasActionWrite = await rawPost(port, "/settings", {
      hostHeader: aliasHost,
      originHeader: `http://${aliasHost}`,
      body: "[]",
      extraHeaders: {
        "next-action": "0".repeat(40),
        "content-type": "text/plain;charset=UTF-8",
      },
    });
    check(
      "回环别名 Host 的 Server Action 写请求 ⇒ 统一边界拒绝（403）",
      aliasActionWrite.status === 403,
      `状态 ${aliasActionWrite.status}（若是 200/400/500 说明请求进了 action 层）`,
    );
    check(
      "被拒的 Server Action 写请求不含任何页面正文",
      !aliasActionWrite.body.includes(probe.expectedText),
      "响应体里出现了课程正文",
    );

    /* 规范来源下的同一路径必须是"能进到 action 层"（证明拦截是精确的）。 */
    const canonicalActionWrite = await rawPost(port, "/settings", {
      hostHeader: `${LOOPBACK_HOST}:${port}`,
      originHeader: `http://${LOOPBACK_HOST}:${port}`,
      body: "[]",
      extraHeaders: {
        "next-action": "0".repeat(40),
        "content-type": "text/plain;charset=UTF-8",
      },
    });
    check(
      "规范来源的同一写请求未被统一边界拦截（拦截只针对别名）",
      canonicalActionWrite.status !== 403,
      `状态 ${canonicalActionWrite.status}`,
    );
  }

  /*
   * ── ⑤ 同源一致性（P0-2 的核心）──
   *
   * 这几条一起证明"可信来源与实例实际监听的端口一致"：
   * 上一轮 `start` 没写端口（默认 3000），而默认可信来源是 3100 ——
   * 于是生产实例会把自己的合法请求全部拒掉。判据必须同时覆盖
   * **放行**与**拒绝**两个方向，否则"全部拒绝"也会被误判为通过。
   *
   * 指纹从**真实渲染出来的页面**读回，而不是在证明里重算 ——
   * 那才能证明"页面给出的指纹"与"服务端接受的指纹"是同一个。
   */
  const html = await fetchPageHtml(
    port,
    `/practice/courses/${probe.courseId}`,
  );
  const servedFingerprint = fingerprintFromHtml(html);
  check(
    "课程页渲染出风险指纹（页面与端点共用同一份事实）",
    servedFingerprint !== null,
  );

  if (servedFingerprint !== null) {
    const sameOrigin = await rawPost(port, "/api/course/reveal", {
      hostHeader: `${LOOPBACK_HOST}:${port}`,
      originHeader: `http://${LOOPBACK_HOST}:${port}`,
      body: JSON.stringify({
        courseId: probe.courseId,
        segmentId: probe.segmentId,
        courseContentVersion: 1,
        confirmedRiskFingerprint: servedFingerprint,
      }),
    });
    check(
      "同源 POST ⇒ 授权揭示成功（200 + 正文）",
      sameOrigin.status === 200 && sameOrigin.body.includes(probe.expectedText),
      `状态 ${sameOrigin.status}`,
    );

    /*
     * 用页面指纹走通之后，同一个指纹再打一次必须是幂等成功
     * （不是第二次被拒）—— 证明风险重确认不会把重试变成错误。
     */
    const retry = await rawPost(port, "/api/course/reveal", {
      hostHeader: `${LOOPBACK_HOST}:${port}`,
      originHeader: `http://${LOOPBACK_HOST}:${port}`,
      body: JSON.stringify({
        courseId: probe.courseId,
        segmentId: probe.segmentId,
        courseContentVersion: 1,
        confirmedRiskFingerprint: servedFingerprint,
      }),
    });
    check(
      "同源重复 POST ⇒ 200 且幂等（不因重确认而失败）",
      retry.status === 200,
      `状态 ${retry.status}`,
    );

    // ⑤b 跨来源（同主机不同端口）必须失败 —— 证明"都是回环"不等于同源。
    const otherPort = port === E2E_LOOPBACK_PROOF_PORT ? E2E_LOOPBACK_PROOF_DEV_PORT : E2E_LOOPBACK_PROOF_PORT;
    const crossPort = await rawPost(port, "/api/course/reveal", {
      hostHeader: `${LOOPBACK_HOST}:${port}`,
      originHeader: `http://${LOOPBACK_HOST}:${otherPort}`,
      body: JSON.stringify({
        courseId: probe.courseId,
        segmentId: probe.segmentId,
        courseContentVersion: 1,
        confirmedRiskFingerprint: servedFingerprint,
      }),
    });
    check(
      "不同回环端口 Origin ⇒ 403（回环 ≠ 同源）",
      crossPort.status === 403,
      `状态 ${crossPort.status}`,
    );
    check("跨来源响应不含正文", !crossPort.body.includes(probe.expectedText));

    // ⑤c 跨站 Origin 必须失败。
    const crossSite = await rawPost(port, "/api/course/reveal", {
      hostHeader: `${LOOPBACK_HOST}:${port}`,
      originHeader: "https://evil.example",
      body: JSON.stringify({
        courseId: probe.courseId,
        segmentId: probe.segmentId,
        courseContentVersion: 1,
        confirmedRiskFingerprint: servedFingerprint,
      }),
    });
    check("跨站 Origin ⇒ 403", crossSite.status === 403, `状态 ${crossSite.status}`);
    check("跨站响应不含正文", !crossSite.body.includes(probe.expectedText));
  }
}

interface RevealProbe {
  courseId: string;
  segmentId: string;
  /** 从页面 HTML 上读出的风险指纹；读不到时为 null。 */
  fingerprint: string | null;
  /** 该段的合成正文（用于断言"确实下发了正文"）。 */
  expectedText: string;
}

/**
 * 用合成夹具准备一个**独立**实例的数据，并读出页面上的风险指纹。
 *
 * ── 为什么需要这一步 ──
 *
 * 只验证"GET 返回 200"证明不了"授权揭示能工作"：真正的授权路径要带
 * 一个服务端认可的风险指纹。而那个指纹是服务端算的，只能在真实页面里
 * 读出来 —— 这正是"用真实 HTTP 证明"而不是"照抄常量"的意义。
 *
 * 全部数据都在 `.e2e/loopback-proof-*` 下：不碰 `private-content/`，
 * 不碰 `data/cet6.db`。
 */
async function seedProbeData(): Promise<RevealProbe> {
  const courseId = "fixture-course-loopback-proof";
  const segmentId = "reading.a";
  const expectedText = "Fixture course reading passage.";

  // 每次清空重来：证明必须可重复。
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_LOOPBACK_PROOF_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(E2E_LOOPBACK_PROOF_CONTENT_ROOT, { recursive: true, force: true });
  mkdirSync(E2E_LOOPBACK_PROOF_CONTENT_ROOT, { recursive: true });

  process.env.CET6_CONTENT_ROOT = E2E_LOOPBACK_PROOF_CONTENT_ROOT;
  process.env.CET6_DB_PATH = E2E_LOOPBACK_PROOF_DB_PATH;

  const { getRepositories } = await import("@/repositories/sqlite");
  const { commitCourseImport, planCourseImport } = await import("@/services/course-import");
  const { buildCourseFixture, writeCourseFixture } = await import("./course-fixture");

  writeCourseFixture(
    E2E_LOOPBACK_PROOF_CONTENT_ROOT,
    courseId,
    buildCourseFixture({ id: courseId }),
  );

  /*
   * 先 seed profile：曝光行有 `profile_id` 外键，而揭示端点在未登录时
   * 会失败关闭（403）。因此"授权揭示能工作"这条判据必须先有一个学习者。
   *
   * 复用仓库既有的 `seed-onboard.ts`（与其它合成启动器同一条路径），
   * 而不是在证明里自己拼一份 profile 写入逻辑。
   */
  execSync(
    `"${process.execPath}" --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/seed-onboard.ts`,
    { stdio: "ignore", env: process.env },
  );

  const repos = getRepositories();
  if (!repos.learner.getProfile()) {
    throw new Error("回环证明：seed 之后仍读不到 profile");
  }

  const plan = planCourseImport(repos);
  if (plan.report.counts.rejected > 0) {
    throw new Error("回环证明的课程夹具被导入器拒绝");
  }
  const committed = commitCourseImport(repos, plan);
  if (!committed.ok) throw new Error(`回环证明的课程夹具导入失败：${committed.error}`);

  const { computeRevealRisk } = await import("@/services/reveal-risk");
  const risk = computeRevealRisk(repos, courseId, segmentId);

  return { courseId, segmentId, fingerprint: risk.fingerprint, expectedText };
}

/* ─────────────────────────── Server Action 写入矩阵 ─────────────────────────── */

/**
 * 从构建产物里读出 `/settings` 页面的**真实** Server Action ID。
 *
 * ── 为什么必须真实，不能随便编一个 ──
 *
 * 用一个伪造的 action id 去打端点，得到 400/500 也"看起来像被拒绝了" ——
 * 但那时的拒绝来自"action 不存在"，**不是**来自来源判据。
 * 那种测试会让真正的缺口通过：缺口正是"action 能被执行并写库"。
 * 因此这里取真实的 id（`server-reference-manifest.json`），
 * 保证请求确实能走到 action 分发。
 *
 * ── 为什么要在两处找，并且先"预热" ──
 *
 * 实测：
 * - `next start`（生产构建）把清单写在 `.next/server/...`；
 * - `next dev` 写在 `.next/dev/server/...`，且**懒编译** ——
 *   不先访问一次 `/settings`，清单根本不存在。
 *
 * 因此 dev 模式必须先把这个路径请求一次，再读清单；否则会得到
 * "没有 action id"，进而让整组写入矩阵被跳过 —— 那是"看起来通过"。
 */
async function readSettingsActionIds(port: number, mode: "start" | "dev"): Promise<string[]> {
  /*
   * ── 路径必须按模式选，不能"两个都试，先命中先用" ──
   *
   * 实测踩到：`next dev` 与生产构建会同时存在于同一个 `.next/` 下
   * （`.next/server/...` 是上次 build 的，`.next/dev/server/...` 是本 dev 进程的）。
   * 若按"先生产后 dev"的顺序读，dev 实例会拿到**生产构建的 action id** ——
   * 那对 dev 进程无效，于是每次调用都返回 409 "Server Action unavailable"，
   * 找 action 的循环判定"没有 action 改变 profile"，整组矩阵被跳过。
   *
   * 那是一次**假绿**：矩阵没跑，却只报了一条"找不到 action"。
   * 因此这里按模式只读对应那一份。
   */
  const primary =
    mode === "dev"
      ? join(process.cwd(), ".next", "dev", "server", "app", "settings", "page", "server-reference-manifest.json")
      : join(process.cwd(), ".next", "server", "app", "settings", "page", "server-reference-manifest.json");

  const read = (): string[] => {
    if (!existsSync(primary)) return [];
    try {
      const manifest = JSON.parse(readFileSync(primary, "utf8")) as {
        node?: Record<string, unknown>;
      };
      return Object.keys(manifest.node ?? {});
    } catch {
      return [];
    }
  };

  let ids = read();
  if (ids.length > 0) return ids;

  /*
   * 开发模式：请求该页面以触发懒编译，然后再读。
   * 请求失败不视为致命 —— 交给调用方报"读不到 action id"。
   */
  try {
    await rawGet(port, "/settings", `${LOOPBACK_HOST}:${port}`);
  } catch {
    /* 忽略：下面统一判空 */
  }
  for (let attempt = 0; attempt < 10 && ids.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ids = read();
  }
  return ids;
}

/** 读 profile 的可用分钟数（写入矩阵的前后对比基准）。 */
async function readProfileMinutes(): Promise<{ weekday: number; weekend: number } | null> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(E2E_LOOPBACK_PROOF_DB_PATH, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT weekday_minutes, weekend_minutes FROM learner_profile LIMIT 1")
      .get() as { weekday_minutes: number; weekend_minutes: number } | undefined;
    if (!row) return null;
    return { weekday: row.weekday_minutes, weekend: row.weekend_minutes };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** 复位 profile 的分钟数，保证每个用例从同一基准出发。 */
async function resetProfileMinutes(): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(E2E_LOOPBACK_PROOF_DB_PATH);
  try {
    db.prepare("UPDATE learner_profile SET weekday_minutes = 60, weekend_minutes = 120").run();
  } finally {
    db.close();
  }
}

/**
 * Server Action 写入矩阵（缺陷 A / B 的运行时回归）。
 *
 * ── 判据是"数据库有没有变"，不是"状态码是多少" ──
 *
 * 这正是本轮两个缺陷的教训：状态码 200 且**库被改**才是缺口；
 * 而 403 但库仍被改同样是缺口。因此每个用例都对比前后两行。
 *
 * ── 为什么每个用例都复位 ──
 *
 * 否则 A 用例写入的 137/211 会让后续"拒绝"用例的"库未变"断言
 * 变成同义反复（本来就是 137，变了也看不出来）。复位保证每次对比有效。
 */
async function verifyActionWriteMatrix(label: string, port: number, mode: "start" | "dev"): Promise<void> {
  const actionIds = await readSettingsActionIds(port, mode);
  if (actionIds.length === 0) {
    check(`${label}：能读到真实 Server Action ID`, false, "server-reference-manifest.json 缺失");
    return;
  }
  check(`${label}：能读到真实 Server Action ID`, true);

  /*
   * 逐个 action id 试一次，找出真正接受 { weekdayMinutes, weekendMinutes }
   * 的那一个 —— 不硬编码 id（它会随构建变化）。
   *
   * ── 基准必须是**复位之后**的那一行 ──
   *
   * 这里踩过一次：若在循环前读 `baseline`，而它恰好已经是 137/211
   * （上一轮遗留），那么"写成功"也会被判成"没变化"，于是找不到 action、
   * 整组矩阵被跳过 —— 一个因为测试自身缺陷而"看起来通过"的假绿。
   * 因此每一轮都在复位后重新读基准。
   */
  let preferenceActionId: string | null = null;

  for (const id of actionIds) {
    await resetProfileMinutes();
    const before = await readProfileMinutes();
    if (before === null) {
      check(`${label}：profile 行存在（写入矩阵的前提）`, false);
      return;
    }
    await rawActionWrite(port, `${LOOPBACK_HOST}:${port}`, `http://${LOOPBACK_HOST}:${port}`, id);
    const after = await readProfileMinutes();
    const changed =
      after !== null && (after.weekday !== before.weekday || after.weekend !== before.weekend);
    if (changed) {
      preferenceActionId = id;
      break;
    }
  }

  if (preferenceActionId === null) {
    check(`${label}：找到一个会真正写库的 Server Action`, false, "没有 action 改变了 profile");
    return;
  }
  check(`${label}：找到一个会真正写库的 Server Action`, true);

  /* ── 每个用例：复位 → 读前 → 发请求 → 读后 ── */
  const cases: Array<{
    name: string;
    host: string;
    origin: string | null;
    expectStatus: number;
    expectDbChange: boolean;
  }> = [
    // A. 规范 Host + 规范 Origin ⇒ 必须成功且真的写库
    { name: "A 规范 Host + 规范 Origin", host: `${LOOPBACK_HOST}:${port}`, origin: `http://${LOOPBACK_HOST}:${port}`, expectStatus: 200, expectDbChange: true },
    // B. 别名 Host + 别名 Origin ⇒ 拒绝
    { name: "B localhost Host + localhost Origin", host: `localhost:${port}`, origin: `http://localhost:${port}`, expectStatus: 403, expectDbChange: false },
    // C. 规范主机名 + 伪造端口（缺陷 A 的原始形态）
    { name: "C 规范主机名 + 伪造端口 9999", host: `${LOOPBACK_HOST}:9999`, origin: `http://${LOOPBACK_HOST}:9999`, expectStatus: 403, expectDbChange: false },
    // D. 规范 Host + 缺失 Origin（缺陷 B 的原始形态）
    { name: "D 规范 Host + 缺失 Origin", host: `${LOOPBACK_HOST}:${port}`, origin: null, expectStatus: 403, expectDbChange: false },
    // E. 规范 Host + null Origin
    { name: "E 规范 Host + null Origin", host: `${LOOPBACK_HOST}:${port}`, origin: "null", expectStatus: 403, expectDbChange: false },
    // F. 规范 Host + 跨端口 Origin
    { name: "F 规范 Host + 跨端口 Origin", host: `${LOOPBACK_HOST}:${port}`, origin: `http://${LOOPBACK_HOST}:${port + 1}`, expectStatus: 403, expectDbChange: false },
    // G. 规范 Host + 外部 Origin
    { name: "G 规范 Host + 外部 Origin", host: `${LOOPBACK_HOST}:${port}`, origin: "https://evil.example", expectStatus: 403, expectDbChange: false },
    // H. 非规范 Host + 缺失 Origin
    { name: "H 非规范 Host + 缺失 Origin", host: `localhost:${port}`, origin: null, expectStatus: 403, expectDbChange: false },
  ];

  for (const testCase of cases) {
    await resetProfileMinutes();
    const before = await readProfileMinutes();
    const response = await rawActionWrite(port, testCase.host, testCase.origin, preferenceActionId);
    const after = await readProfileMinutes();
    const changed =
      before !== null && after !== null && (before.weekday !== after.weekday || before.weekend !== after.weekend);

    check(
      `${label} · ${testCase.name} ⇒ ${testCase.expectStatus}`,
      response.status === testCase.expectStatus,
      `状态 ${response.status}`,
    );
    check(
      `${label} · ${testCase.name} ⇒ 数据库${testCase.expectDbChange ? "已更新" : "不变"}`,
      changed === testCase.expectDbChange,
      `前 ${before?.weekday}/${before?.weekend} → 后 ${after?.weekday}/${after?.weekend}`,
    );
  }
}

/** 发一个**真实 Server Action** 写请求（带真实 action id 与任意 Host/Origin）。 */
function rawActionWrite(
  port: number,
  hostHeader: string,
  originHeader: string | null,
  actionId: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(
      JSON.stringify([{ weekdayMinutes: 137, weekendMinutes: 211 }]),
      "utf8",
    );
    const headers: Record<string, string> = {
      host: hostHeader,
      "next-action": actionId,
      "content-type": "text/plain;charset=UTF-8",
      "content-length": String(payload.byteLength),
    };
    if (originHeader !== null) headers.origin = originHeader;

    const req = httpRequest(
      { host: LOOPBACK_HOST, port, path: "/settings", method: "POST", headers, timeout: 25000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main(): Promise<void> {
  console.log("本地回环绑定与同源一致性 · 运行时证明（真实 next dev / next start，合成数据）\n");

  const probe = await seedProbeData();

  /*
   * 两个端口刻意不同：证明"端口是配置出来的"，而不是写死的。
   * 若守卫把端口写死，`start`（或 `dev`）那个实例会被自己的守卫挡掉。
   */
  const startPort = E2E_LOOPBACK_PROOF_PORT;
  const devPort = E2E_LOOPBACK_PROOF_DEV_PORT;

  // ── 生产：`pnpm start` ──
  const startChild = startServer("start", startPort);
  if (!(await waitForPort(startPort))) {
    check("合成实例（start）成功启动", false, "服务未在 90 秒内就绪");
    await stopServer(startChild, startPort);
    return;
  }
  check("合成实例（start）成功启动", true);
  await verifyInstance("pnpm start", startPort, probe);
  await verifyActionWriteMatrix("pnpm start", startPort, "start");
  await stopServer(startChild, startPort);

  // ── 开发：`pnpm dev` ──
  const devChild = startServer("dev", devPort);
  if (!(await waitForPort(devPort))) {
    check("合成实例（dev）成功启动", false, "服务未在 90 秒内就绪");
    await stopServer(devChild, devPort);
    return;
  }
  check("合成实例（dev）成功启动", true);
  await verifyInstance("pnpm dev", devPort, probe);
  await verifyActionWriteMatrix("pnpm dev", devPort, "dev");
  await stopServer(devChild, devPort);

  await verifyDefaultPortAuthority();

  console.log(`\n结果：${passed} 通过 / ${skipped} 跳过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;

  // 硬超时兜底：绝不挂住（CI 上一次挂住会浪费整轮预算）。
  setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
}

/**
 * 默认端口（HTTP 80）下的 authority 规范化 · 真实进程验证。
 *
 * ── 它守的那个实测缺陷（本轮）──
 *
 * `trustedAuthority()` 曾直接返回 `URL#port`，而 WHATWG URL 把默认端口规范化
 * 为 `""`；请求侧 `Host: h:80` 解析成 `"80"`，两者不等 ⇒ **合法请求被拒**。
 * 独立审查在真实 80 实例上复现。
 *
 * ── 为什么这一段**可能跳过**，而跳过要说清楚 ──
 *
 * 绑定 1024 以下的端口在多数 CI runner 上需要特权；拿不到时**不能**
 * 悄悄当作通过（那正是本仓库反复警告的假绿）。因此这里：
 * - 端口能绑 ⇒ 真实起一个 80 实例并跑完整判据；
 * - 端口绑不了 ⇒ 记为 **SKIP** 并写明原因，不计入通过数。
 *
 * 判据本身的纯函数版本（22 项）在 `tests/default-port-authority.test.ts` 里，
 * 那个在任何环境都会执行 —— 所以"跳过"不等于"没验证"。
 */
async function verifyDefaultPortAuthority(): Promise<void> {
  const DEFAULT_PORT = 80;
  console.log(`\n── 默认端口 authority（HTTP ${DEFAULT_PORT}）──`);

  // 先确认这个端口当前可用；不可用就明确跳过。
  const canBind = await canBindPort(DEFAULT_PORT);
  if (!canBind) {
    skipped += 1;
    console.log(
      `  ○ 跳过：无法绑定 ${DEFAULT_PORT} 端口（通常需要特权）。` +
        `判据的纯函数覆盖见 tests/default-port-authority.test.ts。`,
    );
    return;
  }

  /*
   * 用**不带显式端口**的可信来源配置启动：`http://127.0.0.1`。
   * 这正是独立审查复现缺陷时的那种配置。
   */
  const child = spawn(
    process.execPath,
    ["scripts/next.mjs", "start", "-H", LOOPBACK_HOST, "-p", String(DEFAULT_PORT)],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        ...telemetryOffEnv(),
        CET6_DB_PATH: E2E_LOOPBACK_PROOF_DB_PATH,
        // 一个"默认端口"形态的配置：不写 :80。
        CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}`,
      },
    },
  );

  try {
    if (!(await waitForPort(DEFAULT_PORT))) {
      check(`默认端口实例（:${DEFAULT_PORT}）成功启动`, false, "90 秒内未就绪");
      return;
    }
    check(`默认端口实例（:${DEFAULT_PORT}）成功启动`, true);

    /* ① 无端口 Host 合法（这是省略默认端口的规范写法）。 */
    const noPort = await rawGet(DEFAULT_PORT, "/practice/courses", LOOPBACK_HOST);
    check(
      `默认端口：无端口 Host 被放行`,
      noPort.status === 200,
      `状态 ${noPort.status}`,
    );

    /* ② 显式 :80 合法（本轮修复的核心 —— 旧版这里会 421/403）。 */
    const explicit80 = await rawGet(
      DEFAULT_PORT,
      "/practice/courses",
      `${LOOPBACK_HOST}:${DEFAULT_PORT}`,
    );
    check(
      `默认端口：显式 :${DEFAULT_PORT} Host 与省略端口等效`,
      explicit80.status === 200,
      `状态 ${explicit80.status}（旧版缺陷会在此处拒绝合法请求）`,
    );

    /* ③ 尾随冒号必须拒绝（不得被当成"无端口"放行）。 */
    const trailing = await rawGet(DEFAULT_PORT, "/practice/courses", `${LOOPBACK_HOST}:`);
    check(
      `默认端口：尾随冒号 Host 被拒绝`,
      trailing.status === 421,
      `状态 ${trailing.status}`,
    );

    /* ④ 非默认端口仍被拒（80 的配置下 :3100 是另一个来源）。 */
    const otherPort = await rawGet(DEFAULT_PORT, "/practice/courses", `${LOOPBACK_HOST}:3100`);
    check(
      `默认端口：非默认端口 Host 被拒绝`,
      otherPort.status === 421,
      `状态 ${otherPort.status}`,
    );

    /* ⑤ 写请求：无 Origin 仍必须 403（默认端口不放松 Origin 必填）。 */
    const noOrigin = await rawPost(DEFAULT_PORT, "/settings", {
      hostHeader: LOOPBACK_HOST,
      body: "[]",
      extraHeaders: { "next-action": "0".repeat(40), "content-type": "text/plain;charset=UTF-8" },
    });
    check(
      `默认端口：缺失 Origin 的写请求仍 403`,
      noOrigin.status === 403,
      `状态 ${noOrigin.status}`,
    );
  } finally {
    await stopServer(child, DEFAULT_PORT);
  }
}

/** 试探某个端口当前能否绑定（不能绑定 ⇒ 调用方按 SKIP 处理，不算通过）。 */
function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, LOOPBACK_HOST);
  });
}

main().catch((error: unknown) => {
  console.error("回环绑定证明失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
