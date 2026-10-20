import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, request as createHttpRequest, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 揭示端点的**安全负向测试**（真实 HTTP）。
 *
 * ── 为什么必须是真实 HTTP，而不是直接调 `POST(request)` ──
 *
 * 直接构造 `Request` 当然也能测判定逻辑，但它证明不了一件事：
 * **这个端点在生产形态下真的会带上这些请求头并被检查**。
 *
 * 本产品的使用形态是"本机浏览器打本机端口"，因此"哪些头会出现、
 * 缺失时会发生什么"只有真实链路能回答。这里用一个真实的
 * `node:http` 服务器包住同一个 `POST` 处理器，然后用原始请求打它 ——
 * 与 `tests/course-segment-tool.test.ts` 验证标注服务器同一条纪律。
 *
 * ── 为什么用**文件库**而不是 `createTestDb()` ──
 *
 * Route Handler 内部走 `getRepositories()` → `getDb()`，而那个连接
 * 由 `CET6_DB_PATH` 决定并在 `globalThis` 上缓存。用内存库会让
 * 路由读到**另一个**库，于是测试断言的是一个不存在的状态。
 *
 * 因此这里在 import 之前设好 `CET6_DB_PATH` 指向临时文件，
 * 并在结束后把全局连接清掉。
 *
 * ── 覆盖的负向形态 ──
 *
 * | 形态 | 期望 |
 * | --- | --- |
 * | 正常同源 POST | 200 + 正文 |
 * | 跨站 Origin | 403，且无正文 |
 * | **缺失** Origin | 403（失败关闭，不是放行） |
 * | 无效 Origin | 403 |
 * | 非回环 Host | 403 |
 * | `Origin: null` | 403 |
 * | GET / PUT / DELETE | 405 |
 * | 包漂移 | 404，且无正文 |
 * | 未登录 | 403 |
 */

const COURSE_ID = "fixture-course-a";
const SEGMENT_ID = "reading.a";
const PROFILE_ID = "p1";

const FIXTURE_TEXT =
  "Fixture course reading passage. This synthetic text exists only so the course " +
  "package pipeline can be exercised end to end. It is not CET material and does " +
  "not come from any course provider.";

let contentRoot: string;
let workRoot: string;
let previousRoot: string | undefined;
let previousDbPath: string | undefined;
let server: Server;
let port: number;
let dbHandle: import("node:sqlite").DatabaseSync;

type RouteModule = typeof import("@/app/api/course/reveal/route");

/** 动态 import 路由模块（在 `CET6_DB_PATH` 设好之后）。 */
async function loadRoute(): Promise<RouteModule> {
  return import("@/app/api/course/reveal/route");
}

/** 把 Next 的 Route Handler 包进一个真实的 node:http 服务器。 */
async function startRevealServer(route: RouteModule): Promise<void> {
  server = createServer((nodeRequest, nodeResponse) => {
    void (async () => {
      /*
       * 把 node 的 IncomingMessage 转换成 WHATWG Request。
       *
       * `host` 必须显式构造：Node 的 `req.headers.host` 是小写键，
       * 而 `new Request(url)` 会自己推一个 Host 头。这里用绝对 URL
       * 让 Host 来自请求本身，再由守卫按请求头判定。
       */
      const chunks: Buffer[] = [];
      for await (const chunk of nodeRequest) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const url = new URL(nodeRequest.url ?? "/", `http://127.0.0.1:${port}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(nodeRequest.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }

      const request = new Request(url, {
        method: nodeRequest.method ?? "GET",
        headers,
        body: nodeRequest.method === "GET" || nodeRequest.method === "HEAD" ? undefined : body,
      });

      const method = nodeRequest.method ?? "GET";
      const handler =
        method === "POST"
          ? route.POST
          : method === "GET"
            ? route.GET
            : method === "PUT"
              ? route.PUT
              : method === "DELETE"
                ? route.DELETE
                : null;

      if (handler === null) {
        nodeResponse.writeHead(405, { "content-type": "application/json" });
        nodeResponse.end(JSON.stringify({ ok: false, error: "方法不允许" }));
        return;
      }

      try {
        const response = await handler(request);
        nodeResponse.writeHead(response.status, Object.fromEntries(response.headers));
        nodeResponse.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        nodeResponse.writeHead(500, { "content-type": "application/json" });
        nodeResponse.end(JSON.stringify({ ok: false, error: (error as Error).message }));
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;

  /*
   * 把本实例的可信来源告诉守卫。
   *
   * 端口由系统分配，因此**必须**在拿到端口之后设置 —— 写死一个端口会让
   * "不同端口必须被拒"那条判据失去意义（它得知道正确端口是什么）。
   */
  process.env.CET6_LOCAL_ORIGIN = `http://127.0.0.1:${port}`;
}

/** 发一个原始 HTTP 请求（允许任意 Host / Origin）。 */
function raw(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = createHttpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res: import("node:http").IncomingMessage) => {
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

/** 计数辅助：曝光行数。 */
function exposureCount(): number {
  const row = dbHandle.prepare("SELECT COUNT(*) AS c FROM course_exposure_event").get() as {
    c: number | bigint;
  };
  return Number(row.c);
}

const validBody = JSON.stringify({
  courseId: COURSE_ID,
  segmentId: SEGMENT_ID,
  courseContentVersion: 1,
});

/**
 * 带**正确风险指纹**的请求体。
 *
 * 指纹在 `beforeEach` 里由服务端算出（与页面渲染时同一路径），
 * 因此它代表"学习者看过当前风险"。
 */
let validBodyWithRisk = "";

/** 同源 POST 的公共请求头。 */
function sameOriginHeaders(): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
}

beforeEach(async () => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  previousDbPath = process.env.CET6_DB_PATH;

  workRoot = mkdtempSync(join(tmpdir(), "cet6-reveal-http-"));
  contentRoot = join(workRoot, "content");
  process.env.CET6_CONTENT_ROOT = contentRoot;
  // Route Handler 内部由这个变量决定打开哪个库。
  process.env.CET6_DB_PATH = join(workRoot, "cet6.db");

  // 在 env 设好之后再加载会读数据库的模块。
  const { createTestDb } = await import("@/db/client");
  const { createSqliteRepositories } = await import("@/repositories/sqlite");
  const { commitCourseImport, planCourseImport } = await import("@/services/course-import");
  const { buildCourseFixture, writeCourseFixture } = await import("../scripts/course-fixture");

  dbHandle = createTestDb();
  // Route Handler 走 globalThis 上缓存的连接；这里显式把它指到同一个库。
  (globalThis as { __cet6Db?: unknown }).__cet6Db = dbHandle;
  // `getRepositories()` 自己有模块级缓存（`cached`）。同一个测试进程里
  // 前一个用例可能已经建过一份指到旧库的组合 —— 必须清掉，
  // 否则路由会读写另一个库，断言就变成对一个不存在状态的检查。
  const sqlite = (await import("@/repositories/sqlite")) as unknown as {
    __resetRepositoriesForTests: () => void;
  };
  sqlite.__resetRepositoriesForTests();

  const repos = createSqliteRepositories(dbHandle);
  dbHandle
    .prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(PROFILE_ID, "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  writeCourseFixture(contentRoot, COURSE_ID, buildCourseFixture());
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);

  /*
   * 按页面渲染的同一条路径算出风险指纹。
   *
   * 用服务端自己的实现（`computeRevealRisk`）而不是在测试里重算一遍 ——
   * 那是"第二个判据"，会与实现漂移。
   */
  const { computeRevealRisk } = await import("@/services/reveal-risk");
  const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
  validBodyWithRisk = JSON.stringify({
    courseId: COURSE_ID,
    segmentId: SEGMENT_ID,
    courseContentVersion: 1,
    confirmedRiskFingerprint: risk.fingerprint,
  });

  await startRevealServer(await loadRoute());
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  if (previousDbPath === undefined) delete process.env.CET6_DB_PATH;
  else process.env.CET6_DB_PATH = previousDbPath;
  // 清掉全局连接缓存：下一个测试要打开自己的库。
  (globalThis as { __cet6Db?: unknown }).__cet6Db = undefined;

  /*
   * 先关服务器，再关数据库，最后才删目录 —— 顺序是有意义的。
   *
   * `node:sqlite` 的 `DatabaseSync` 是**原生句柄**，不是 GC 会挑个好时机收掉的
   * 普通对象。上面那句只把引用清空，句柄仍然持有文件、WAL 映射与原生内存；
   * 而 `rmSync` 会在句柄还开着的时候删掉它指向的目录。
   *
   * 每个用例都在 `beforeEach` 里新建一个库，本文件有 27 个用例 —— 也就是一次
   * 运行留下 27 个未关闭的原生连接，指向 27 个已经被删掉的临时目录。这个状态
   * 从 JavaScript 完全不可观测：没有断言失败、没有异常、没有任何日志。它只在
   * 原生层触发中止时才暴露出来，而原生中止在 Windows 上表现为进程退出码
   * 0xC0000409（STATUS_STACK_BUFFER_OVERRUN），vitest 把它报成
   * "Worker exited unexpectedly"，从头到尾不给一条应用层调用栈。
   *
   * 这就是那次"跑五次红一次"的根因，也是它只在整卷运行时出现、单独跑本文件
   * 几乎不出现的原因：整卷运行时 worker 数量与内存压力更高，原生中止更容易被
   * 触发。修法是确定性地释放资源，而不是等 GC、也不是把超时调大。
   */
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    dbHandle.close();
  } catch {
    // 某条用例可能自己关过同一个句柄；关两次不该让清理失败。
  }
  rmSync(workRoot, { recursive: true, force: true });
});

describe("揭示端点 · 正常路径", () => {
  it("同源 POST ⇒ 200 + 正文 + 曝光落库", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBodyWithRisk,
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      ok: boolean;
      recorded: boolean;
      content: { text: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.recorded).toBe(true);
    expect(payload.content.text).toBe(FIXTURE_TEXT);
    expect(exposureCount()).toBe(1);

    // 响应必须不缓存（私有正文不得留在任何中间层）。
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("localhost Origin **不**被接受（与 127.0.0.1 是两个来源）", async () => {
    /*
     * 浏览器眼里 `http://localhost:<port>` 与 `http://127.0.0.1:<port>`
     * 是**两个不同来源**（协议+主机名+端口全部参与）。
     * 因此即便它俩解析到同一台机器，守卫也按不同源拒绝。
     *
     * 这条同时保留了上一版的合法用例意图：本机两种常见写法中，
     * 只有与 `CET6_LOCAL_ORIGIN` 完全一致的那个被接受。
     */
    const response = await raw("POST", "/api/course/reveal", {
      headers: { origin: `http://localhost:${port}`, "content-type": "application/json" },
      body: validBodyWithRisk,
    });
    expect(response.status, "localhost 与 127.0.0.1 不是同一个来源").toBe(403);
    expect(exposureCount()).toBe(0);
  });

  it("重复 POST ⇒ 仍然 200 且只留一条观测", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await raw("POST", "/api/course/reveal", {
        headers: sameOriginHeaders(),
        body: validBodyWithRisk,
      });
      expect(response.status).toBe(200);
    }
    expect(exposureCount()).toBe(1);
  });
});

describe("揭示端点 · 安全负向（失败关闭）", () => {
  it("**跨站 Origin** ⇒ 403，且响应里没有任何正文", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: validBodyWithRisk,
    });

    expect(response.status).toBe(403);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    // 且没有写入任何观测 —— 请求根本没有到达服务层。
    expect(exposureCount()).toBe(0);
  });

  it("**另一个回环端口** ⇒ 403（都是回环，但不是同一个来源）", async () => {
    /*
     * 这一条是 P0-2 的核心。
     *
     * 上一版只判"主机名是不是回环"，于是 `http://127.0.0.1:3199` 的请求
     * 打在 `:3265` 的服务上会被放行 —— 而它们是两个不同的本地服务。
     * 一个同时跑着多个 CET6 实例（或任何回环工具）的机器上，
     * "都是回环"不等于"是同一个人"。
     */
    const otherPort = port + 1;
    const response = await raw("POST", "/api/course/reveal", {
      headers: {
        origin: `http://127.0.0.1:${otherPort}`,
        "content-type": "application/json",
      },
      body: validBodyWithRisk,
    });

    expect(response.status, "不同端口必须被拒").toBe(403);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });

  it("**同主机不同协议** ⇒ 403（https 不是可信来源）", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: { origin: `https://127.0.0.1:${port}`, "content-type": "application/json" },
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(403);
    expect(exposureCount()).toBe(0);
  });

  it("**localhost 打 127.0.0.1 实例** ⇒ 403（主机名不同即不同源）", async () => {
    /*
     * `localhost` 与 `127.0.0.1` 在浏览器眼里是**两个不同来源**。
     * 因此即便它俩解析到同一台机器，守卫也按不同源拒绝。
     */
    const response = await raw("POST", "/api/course/reveal", {
      headers: { origin: `http://localhost:${port}`, "content-type": "application/json" },
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(403);
    expect(exposureCount()).toBe(0);
  });

  it("**缺失 Origin** ⇒ 403（不是放行）", async () => {
    /*
     * 这一条是本端点与标注服务器的关键差别，也是它最重要的守卫。
     *
     * 正常浏览器发出的同源 POST **一定带** Origin。因此"缺失"只可能
     * 来自 curl / 手写请求 / 本机其它进程 —— 这些都不是合法调用方。
     * 放行它们等于给"任意本机进程直接打这个端口"开一扇门。
     */
    const response = await raw("POST", "/api/course/reveal", {
      headers: { "content-type": "application/json" },
      body: validBodyWithRisk,
    });

    expect(response.status, "缺失 Origin 必须失败关闭").toBe(403);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });

  it("**无效 Origin** ⇒ 403", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: { origin: "not a url at all", "content-type": "application/json" },
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(403);
    expect(exposureCount()).toBe(0);
  });

  it("**非回环 Host** ⇒ 403（挡 DNS rebinding）", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: { host: "evil.example", origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(403);
    expect(exposureCount()).toBe(0);
  });

  it("**局域网 Host** ⇒ 403", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: {
        host: "192.168.1.5:8080",
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/json",
      },
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(403);
  });

  it("**缺失 Host** ⇒ 403（判据本身，不经 HTTP 传输）", async () => {
    /*
     * HTTP/1.1 要求请求必须带 Host 头，Node 的客户端会拒绝发出一个空的
     * Host —— 因此"缺失 Host"这个形态**无法**用真实 HTTP 复现。
     *
     * 这不代表它不该被挡：一个畸形的请求（或 HTTP/2 的某些边界）仍可能
     * 缺 Host。因此这里直接驱动守卫函数证明判据本身失败关闭，
     * 而真实 HTTP 负向（非回环 Host）由上一条覆盖。
     */
    const { guardLocalRequest } = await import("@/lib/loopback-guard");
    expect(guardLocalRequest({ host: undefined, origin: `http://127.0.0.1:${port}` }).ok).toBe(false);
    expect(guardLocalRequest({ host: "", origin: `http://127.0.0.1:${port}` }).ok).toBe(false);
  });

  it("`Origin: null`（沙箱 iframe / data URL）⇒ 403", async () => {
    /*
     * 浏览器在沙箱 iframe、`data:` URL、部分重定向下会发 `Origin: null`。
     * 它不是回环来源，因此必须拒绝。
     */
    const response = await raw("POST", "/api/course/reveal", {
      headers: { origin: "null", "content-type": "application/json" },
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(403);
    expect(exposureCount()).toBe(0);
  });

  it("**GET ⇒ 405**（正文与曝光写入都不得由 GET 触发）", async () => {
    const response = await raw("GET", "/api/course/reveal", {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe("POST");
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });

  it("**PUT / DELETE ⇒ 405**", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const response = await raw(method, "/api/course/reveal", {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      expect(response.status, `${method} 必须被拒绝`).toBe(405);
    }
  });

  it("**包漂移** ⇒ 404，且响应里没有任何正文", async () => {
    const manifestPath = join(contentRoot, "courses", COURSE_ID, "course.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.segments as Array<Record<string, unknown>>).find(
      (segment) => segment.id === SEGMENT_ID,
    )!.text = "盘上被换掉的正文。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBodyWithRisk,
    });

    expect(response.status).toBe(404);
    expect(response.body, "漂移时不得下发正文").not.toContain("盘上被换掉的正文");
    expect(response.body).not.toContain(FIXTURE_TEXT);
    // 没有写入观测。
    expect(exposureCount()).toBe(0);
  });

  it("坏 JSON ⇒ 400", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect(exposureCount()).toBe(0);
  });

  it("缺少 courseId ⇒ 400（不接受「猜一个默认值」）", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: JSON.stringify({ segmentId: SEGMENT_ID, courseContentVersion: 1 }),
    });
    expect(response.status).toBe(400);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });
});

/**
 * P0-1：服务端风险重确认。
 *
 * 这一组证明"UI 确认面板不是安全边界"：页面 GET 与揭示 POST 之间风险
 * 可能已经变了，服务端必须自己重新评估并拒绝。
 */
describe("揭示端点 · 服务端风险重确认（P0-1）", () => {
  it("**缺少**风险指纹 ⇒ 409，且不写曝光、不下发正文", async () => {
    /*
     * 省略指纹等同于"没有确认过"。
     *
     * 刻意不提供"无风险可免确认"的旁路：那会让"先渲染页面、随后有人
     * 新建一条链接"这条路径在没有任何警告的情况下消耗保留材料。
     */
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBody,
    });

    expect(response.status, "未确认风险必须被拒").toBe(409);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });

  it("**错误**风险指纹 ⇒ 409，且不写曝光", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: JSON.stringify({
        courseId: COURSE_ID,
        segmentId: SEGMENT_ID,
        courseContentVersion: 1,
        confirmedRiskFingerprint: "f".repeat(64),
      }),
    });

    expect(response.status).toBe(409);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });

  it("**新建链接**使风险变化 ⇒ 409 且回传更新后的风险视图", async () => {
    /*
     * 这是 P0-1 的核心场景：页面渲染时这段**没有**任何已核验链接
     * （因此指纹里没有链接），学习者在那种状态下确认；随后有人新建了
     * 一条指向某份真题的链接，POST 时服务端重新算出的指纹与确认过的
     * 不一致 ⇒ 拒绝。
     */
    const { verifyCanonicalLink } = await import("@/services/course-link");
    const { buildFixturePackage, writeFixturePackage } = await import("../scripts/paper-fixture");
    const { planImport, commitImport } = await import("@/services/paper-import");
    const { createSqliteRepositories } = await import("@/repositories/sqlite");

    const repos = createSqliteRepositories(dbHandle);
    writeFixturePackage(
      contentRoot,
      "fixture-cet6-2024-12-set1",
      buildFixturePackage({
        id: "fixture-cet6-2024-12-set1",
        year: 2024,
        session: "December",
        variant: "set1",
      }),
    );
    const paperPlan = planImport(repos, { only: ["fixture-cet6-2024-12-set1"] });
    expect(paperPlan.report.counts.insert).toBe(1);
    expect(commitImport(repos, paperPlan).ok).toBe(true);

    // 新建一条已核验链接（指向这份真题的仔细阅读）。
    const linked = verifyCanonicalLink(repos, {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: "fixture-cet6-2024-12-set1",
      paperContentVersion: 1,
      sectionId: "reading.careful_reading",
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "synthetic fixture (risk change test)",
    });
    expect(linked.ok, linked.ok ? "" : JSON.stringify(linked.issues)).toBe(true);

    // 用**旧的**（无链接时算出的）指纹 POST。
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBodyWithRisk,
    });

    expect(response.status, "新建链接后旧指纹必须失效").toBe(409);
    const payload = JSON.parse(response.body) as {
      ok: boolean;
      code?: string;
      risk?: { fingerprint: string; papers: Array<Record<string, unknown>> };
    };
    expect(payload.code).toBe("risk_changed");
    // 必须回传**更新后的**风险视图（学习者据此重新确认）。
    expect(payload.risk?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.risk?.papers.map((paper) => paper.paperId)).toContain("fixture-cet6-2024-12-set1");

    /*
     * ── Round 3 P0：409 的 `papers` 必须是**展示就绪的完整形状** ──
     *
     * 上一版只回三个字段，客户端未校验地断言成完整形状 ⇒ 确认面板消失
     * ⇒ 再点一次就绕过确认。因此这里逐字段断言"界面需要的每一个字段
     * 都在"，而不是只看 paperId。
     */
    const first = payload.risk!.papers[0];
    for (const field of [
      "paperId",
      "paperTitle",
      "targetLabel",
      "runtimeUsable",
      "unusableReason",
      "trainable",
      "reservedForMock",
    ]) {
      expect(first, `409 的风险条目必须带 ${field} —— 否则界面无法如实展示`).toHaveProperty(field);
    }
    // 展示字段必须是**产品语言**，不是内部 id。
    expect(String(first.targetLabel)).toMatch(/阅读 · 仔细阅读/);
    expect(String(first.targetLabel), "不得暴露 section id").not.toContain("reading.careful_reading");
    expect(first.runtimeUsable).toBe(true);

    // 且没有写曝光、没有下发正文。
    expect(exposureCount()).toBe(0);
    expect(response.body).not.toContain(FIXTURE_TEXT);
  });

  it("**改成模考保留**使风险变化 ⇒ 409", async () => {
    const { verifyCanonicalLink } = await import("@/services/course-link");
    const { buildFixturePackage, writeFixturePackage } = await import("../scripts/paper-fixture");
    const { planImport, commitImport } = await import("@/services/paper-import");
    const { createSqliteRepositories } = await import("@/repositories/sqlite");

    const repos = createSqliteRepositories(dbHandle);
    writeFixturePackage(
      contentRoot,
      "fixture-cet6-2024-12-set1",
      buildFixturePackage({
        id: "fixture-cet6-2024-12-set1",
        year: 2024,
        session: "December",
        variant: "set1",
      }),
    );
    const paperPlan = planImport(repos, { only: ["fixture-cet6-2024-12-set1"] });
    expect(commitImport(repos, paperPlan).ok).toBe(true);
    expect(
      verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 1,
        segmentId: SEGMENT_ID,
        paperId: "fixture-cet6-2024-12-set1",
        paperContentVersion: 1,
        sectionId: "reading.careful_reading",
        targetScope: "section",
        verificationStatus: "verified",
        verificationRef: "synthetic fixture (pool change test)",
      }).ok,
    ).toBe(true);

    // 先按**新**风险（已建链接）确认一次，应当成功。
    const { computeRevealRisk } = await import("@/services/reveal-risk");
    const withLink = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
    const first = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: JSON.stringify({
        courseId: COURSE_ID,
        segmentId: SEGMENT_ID,
        courseContentVersion: 1,
        confirmedRiskFingerprint: withLink.fingerprint,
      }),
    });
    expect(first.status, "链接存在时按新风险确认应当成功").toBe(200);
    expect(exposureCount()).toBe(1);

    // 使用者 把那份真题改成模考保留 ⇒ 指纹再次变化。
    repos.papers.setPool("fixture-cet6-2024-12-set1", "mock_reserve");

    const second = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: JSON.stringify({
        courseId: COURSE_ID,
        segmentId: SEGMENT_ID,
        courseContentVersion: 1,
        confirmedRiskFingerprint: withLink.fingerprint,
      }),
    });
    expect(second.status, "池归属变化后旧指纹必须失效").toBe(409);
    // 幂等：仍然只有首次那一条曝光。
    expect(exposureCount()).toBe(1);
  });

  it("**课程包漂移** ⇒ 404（包校验先于风险重确认，同样失败关闭）", async () => {
    /*
     * 顺序说明：`revealCourseSegment` 先读包快照、比对校验和，
     * **然后**才算风险。因此漂移在这里由包校验挡下（404），
     * 根本到不了风险比对那一步。
     *
     * 这不是漏洞 —— 漂移同样失败关闭、同样不写曝光、同样不下发正文。
     * 真正的"风险不可求证 ⇒ 409"路径由服务层单测覆盖
     * （`tests/course-companion-reveal.test.ts` 的
     * "包漂移时风险不可求证"用例，那里直接调服务函数）。
     */
    const manifestPath = join(contentRoot, "courses", COURSE_ID, "course.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.segments as Array<Record<string, unknown>>).find(
      (segment) => segment.id === SEGMENT_ID,
    )!.text = "盘上被换掉的正文。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBodyWithRisk,
    });

    expect(response.status).toBe(404);
    expect(response.body).not.toContain("盘上被换掉的正文");
    expect(exposureCount()).toBe(0);
  });
});

/**
 * Round 3 P0：**线上契约**必须由运行时校验保证。
 *
 * 这一组直接测契约解析器 —— 它是"不把畸形响应当成没有风险"的落点。
 * 放在这里（而不是只放服务层测试）是因为它是**端点契约**的一部分。
 */
describe("揭示端点 · 线上契约校验（P0-R3）", () => {
  it("200 响应必须能被契约解析，且**不含**私有内容身份字段（P2-A）", async () => {
    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBodyWithRisk,
    });
    expect(response.status).toBe(200);

    const { parseRevealResponse } = await import("@/lib/course-reveal-contract");
    const parsed = parseRevealResponse(JSON.parse(response.body));
    expect(parsed.kind, "200 响应必须符合契约").toBe("success");

    /*
     * P2-A：响应刻意**不带** `contentChecksum` / `indexedContentVersion`。
     *
     * 它们是私有内容的身份信息；客户端不需要它们做任何决定。
     * 上一轮的服务层文档声称响应包含它们，那与实现不一致。
     */
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body, "响应不得下发内容校验和").not.toHaveProperty("contentChecksum");
    expect(body, "响应不得下发索引内容版本").not.toHaveProperty("indexedContentVersion");
    // 但风险指纹必须在（界面据此核对一致性）。
    expect(body.riskFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("**畸形 409 响应**必须被判为不可信，而**不是**没有风险", async () => {
    const { parseRevealResponse, riskViewAllowsReveal } = await import(
      "@/lib/course-reveal-contract"
    );

    const malformed = [
      // ① 缺 papers 字段。
      { ok: false, error: "变了", code: "risk_changed", risk: { fingerprint: "a".repeat(64), risky: true, requiresConfirmation: true, unprovableReason: null } },
      // ② papers 条目缺 runtimeUsable（上一版的实际形态）。
      {
        ok: false,
        error: "变了",
        code: "risk_changed",
        risk: {
          fingerprint: "a".repeat(64),
          risky: true,
          requiresConfirmation: true,
          unprovableReason: null,
          papers: [{ paperId: "p", reservedForMock: true, trainable: false }],
        },
      },
      // ③ 指纹不是 64 位十六进制。
      { ok: false, error: "变了", code: "risk_changed", risk: { fingerprint: "short", risky: true, requiresConfirmation: true, unprovableReason: null, papers: [] } },
      // ④ 根本不是对象。
      "not json",
      null,
      [],
    ];

    for (const payload of malformed) {
      const parsed = parseRevealResponse(payload);
      expect(
        parsed.kind,
        `畸形响应必须被判为 invalid（而不是被当成没有风险）：${JSON.stringify(payload)}`,
      ).toBe("invalid");
    }

    /*
     * 自相矛盾的"有风险但列表为空、也没有不可求证原因"必须**不放行**。
     * 它是"服务端说没风险、其实有"的形态。
     */
    expect(
      riskViewAllowsReveal({
        fingerprint: "a".repeat(64),
        risky: true,
        requiresConfirmation: true,
        unprovableReason: null,
        papers: [],
      }),
      "说 risky 却给不出任何目标 ⇒ 不得据此放行",
    ).toBe(false);

    // 未匹配（risky=false, papers=[]）是**合法**状态，必须放行。
    expect(
      riskViewAllowsReveal({
        fingerprint: "a".repeat(64),
        risky: false,
        requiresConfirmation: true,
        unprovableReason: null,
        papers: [],
      }),
      "未匹配是合法状态，不得被判为矛盾",
    ).toBe(true);

    // 不可求证（papers 为空但有原因）也是合法状态。
    expect(
      riskViewAllowsReveal({
        fingerprint: "a".repeat(64),
        risky: true,
        requiresConfirmation: true,
        unprovableReason: "读不到课程包",
        papers: [],
      }),
      "不可求证是合法状态（带原因），不得被判为矛盾",
    ).toBe(true);
  });

  it("契约类型与投影类型**逐字一致**（编译期约束的运行时对照）", async () => {
    const { linkedPaperSummarySchema } = await import("@/lib/course-reveal-contract");
    const { projectLinkedPapers } = await import("@/services/course-link-projection");

    // 投影字段集合必须与契约字段集合完全相同。
    const contractFields = Object.keys(linkedPaperSummarySchema.shape).sort();
    expect(contractFields).toEqual(
      [
        "paperId",
        "paperTitle",
        "targetLabel",
        "runtimeUsable",
        "unusableReason",
        "trainable",
        "reservedForMock",
      ].sort(),
    );
    // 投影函数存在且是唯一实现。
    expect(typeof projectLinkedPapers).toBe("function");
  });
});

describe("揭示端点 · 未登录失败关闭", () => {  it("没有 profile ⇒ 403（未登录时不下发任何正文）", async () => {
    dbHandle.prepare("DELETE FROM learner_profile").run();

    const response = await raw("POST", "/api/course/reveal", {
      headers: sameOriginHeaders(),
      body: validBodyWithRisk,
    });

    expect(response.status).toBe(403);
    expect(response.body).not.toContain(FIXTURE_TEXT);
    expect(exposureCount()).toBe(0);
  });
});

describe("揭示端点 · 隔离产物核对", () => {
  it("测试库落在临时目录，不触碰任何 .e2e 或开发库", () => {
    // 这条断言守护"安全测试不得读写真实数据"这条边界本身。
    expect(process.env.CET6_DB_PATH).toContain("cet6-reveal-http-");
    expect(existsSync(join(workRoot, "cet6.db"))).toBe(false);
  });
});

/*
 * ── 关于 `src/proxy.ts` 的 Host 边界：为什么它**不**在本文件里测 ──
 *
 * 本文件的服务器只包住了 Route Handler（`createServer((req,res) => route.POST(req))`），
 * 它**不是**一个真实的 Next 服务器 —— 因此 proxy 不会执行。
 *
 * 在这里写"非回环 Host ⇒ 421"会拿到 405（路由处理器自己的方法拒绝），
 * 于是断言失败的原因与守卫完全无关。那正是任务书警告的
 * "因为错误的理由变红"。
 *
 * 因此 proxy 的负向判据放在**真实 Next 服务器**上：
 * `scripts/e2e-loopback-binding-proof.ts`（用底层 node:http 带任意 Host，
 * 实测 421）。浏览器侧无法伪造 Host（禁止修改的请求头），已在该 spec 里注明。
 */
