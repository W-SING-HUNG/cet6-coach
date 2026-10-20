/**
 * 本地标注服务器（local-only annotation server）。
 *
 * ── 这个模块的定位 ──
 *
 * 它是**操作者工具**，不是学习者产品。它的唯一职责是让 使用者 在**本机浏览器**里
 * 看着自己已经拥有的私有材料、把结构标出来、存成一份分段计划。
 *
 * ── 安全模型（每一条都有明确理由，不是仪式）──
 *
 * | 措施 | 防的是什么 |
 * | --- | --- |
 * | 只监听 `127.0.0.1` | 私有付费材料不得出现在局域网上 |
 * | 拒绝非回环 Host / Origin | DNS rebinding 与跨站请求伪造 |
 * | **`GET /` 只回静态外壳** | 本机其他进程取到页面也拿不到私有内容与 token |
 * | **私有数据端点要求 token 请求头** | 未认证的读也拿不到课程正文 |
 * | 每次会话随机 token（写操作必需） | 本机其他进程/页面不得替你写计划 |
 * | **token 经 URL fragment 交付** | fragment 不随请求发给服务器 ⇒ 不进日志/请求目标 |
 * | `Cache-Control: no-store` | 私有内容不得留在浏览器缓存里 |
 * | `Referrer-Policy: no-referrer` | 本机 URL 不得经外链泄露给任何站点 |
 * | 零外部资源（无字体/CDN/分析/JS 库） | 打开页面不得产生任何外部网络请求 |
 * | 不打印正文、不把正文写进日志 | 终端输出会被记录进自动化上下文 |
 * | 不持久化绝对源路径 | 计划里只有课程 id 与校验和 |
 * | 原子写盘（临时文件 + rename） | 半截计划文件不得覆盖一份完好的计划 |
 * | 不打开数据库、不做 Git 操作 | 本工具在原理上不具备那些能力 |
 *
 * ── 为什么 `GET /` 必须是"对外一视同仁的静态外壳"（F4 的修复）──
 *
 * 浏览器导航无法携带自定义请求头，因此页面本身**必须**可匿名取得。
 * 既然它可匿名取得，就**绝不能**含任何随会话变化/私有的东西：
 * 旧的实现把抽取正文与 token 一起塞进这个页面，于是本机任意进程
 * 只要 `GET /` 就能同时拿到**私有材料**与**写计划的能力**。
 *
 * 现在页面是纯静态的（同样的字节对任何请求者都成立），私有数据一律
 * 走 `GET /api/bootstrap`（要求 token 请求头）。因此"未认证端点
 * 不返回私有内容与 token"是**结构性事实**，不是纪律要求。
 *
 * Host/Origin/CORS 检查**不**能替代这条：恶意本机进程可以自己发请求，
 * 因而必须靠**能力边界**（token）而不是靠来源来保护。
 *
 * ── 它**不**做什么（与产品边界一致）──
 *
 * - 不生成 `review.json`（那必须由人显式签出）；
 * - 不晋升、不导入、不建链；
 * - 不做 OCR、不调用任何远程服务/AI；
 * - 不把正文送进任何日志或错误消息（**包括本文件的所有 console 输出**）。
 *
 * ── 关于"服务端只见坐标"这条设计 ──
 *
 * 服务端确实持有抽取产物（它必须如此，否则无法校验行号与覆盖率），
 * 但它**只把正文发回本机浏览器**，且**只在带 token 的请求上**。
 * 任何**面向终端/自动化的输出**都只含计数与坐标 ——
 * 这条由 `scripts/course-segment.ts` 的源码级门禁守护。
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** 仅回环地址。**绝不**绑定 `0.0.0.0`。 */
export const LOOPBACK_HOST = "127.0.0.1";

/** 写操作所必需的请求头名。 */
export const SESSION_TOKEN_HEADER = "x-cet6-session-token";

/** 一次标注会话的不可变配置。 */
export interface AnnotationServerConfig {
  courseId: string;
  /** 源快照摘要（既有 `SourceInventory.digest`）。 */
  sourceDigest: string;
  /** 资产 → 逐页行文本。**只在内存里**，只发给本机浏览器。 */
  assets: {
    assetKey: string;
    /** 只作展示的相对路径标签。 */
    label: string;
    sha256: string;
    pages: {
      page: number;
      hasTextLayer: boolean;
      lines: string[];
    }[];
  }[];
  /** 已存在的计划（若默认位置有），用于"继续标注"。 */
  existingPlan: unknown | null;
}

/** 服务器句柄。 */
export interface AnnotationServerHandle {
  /**
   * 形如 `http://127.0.0.1:<port>/#token=…` —— 可交给本机操作者。
   *
   * ── 为什么 token 在 **fragment** 里而不是查询串（F4）──
   *
   * URL fragment（`#` 之后）**不会**随请求发给服务器（RFC 3986 / WHATWG URL）。
   * 因此：
   *
   * - 它不出现在服务端的请求目标里 ⇒ 不进访问日志、不进任何服务端记录；
   * - 它不出现在 `Referer` 里（页面另外设了 `no-referrer` 兜底）；
   * - 它不进入浏览器发给本服务的任何请求行。
   *
   * 查询串则相反：它会随**每一个**同源请求一起发给服务器，于是
   * "把凭据放进 URL"就真的落进了服务端日志。这条差别是本次修复的要点。
   *
   * 客户端读到 fragment 后立刻 `history.replaceState` 抹掉它（见
   * `segment-client-script.ts`），因此它也不会长期留在可见地址栏里。
   */
  url: string;
  /** 实际监听端口（0 = 系统分配）。 */
  port: number;
  /** 会话 token（写操作必需）。**这是敏感操作者输出，绝不落盘。** */
  token: string;
  /** 实际传给 `listen()` 的绑定地址（供测试核对"真的只绑回环"）。 */
  boundAddress: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 请求守卫
// ---------------------------------------------------------------------------

/**
 * 判定 Host 头是否属于**本机回环**。
 *
 * ── 为什么必须检查它 ──
 *
 * "我只监听 127.0.0.1" 不足以阻止一次由浏览器发起的、指向本服务的请求：
 * 一个恶意页面可以把自己的域名解析到 127.0.0.1（DNS rebinding），
 * 于是浏览器会带着 `Host: evil.example` 访问本服务，而同源策略
 * 在这里帮不上忙。拒绝非回环 Host 直接掐断这条路。
 *
 * 接受 `localhost` 与 `127.0.0.1`（含端口），以及 IPv6 回环 `[::1]`。
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  // 去掉端口（IPv6 形如 `[::1]:8080`）
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/**
 * 判定 Origin 头是否可接受。
 *
 * 缺失 Origin 是**正常**的（同源 GET、命令行工具、`<img>` 加载）。
 * 但一旦它出现，就必须是回环来源 —— 一个来自外部页面的 POST 会带上
 * 那个页面的 Origin，必须被拒绝。
 *
 * ── 这是**宽松**判据，只用于页面导航类请求 ──
 *
 * 它接受**任意端口**的回环来源。对读取类请求（`GET /`、`GET /api/bootstrap`）
 * 这已经足够（读还需要 token）。但 A1 的敏感 POST 端点**不能**用它 ——
 * `http://127.0.0.1:3240` 与 `http://127.0.0.1:3241` 都是回环，却是两个服务。
 * 那些端点走 `isExactSameOrigin`（见下）。
 */
export function isAcceptableOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  } catch {
    // 解析不了的 Origin 一律拒绝（可疑输入不给第二次机会）
    return false;
  }
}

/**
 * 判定 Origin 是否与**本服务实际监听的来源**逐项相等（协议 + 主机名 + 端口）。
 *
 * ── 为什么 A1 的敏感写端点必须用它，而不是 `isAcceptableOrigin` ──
 *
 * 本机同时可能跑着多个回环服务（另一个标注实例、某个 devtools 面板、
 * 任何监听回环的工具）。只比"主机名是回环"会让来自**另一个端口**的
 * 请求被当成同源放行 —— 而那个服务与本次会话的 token 毫无关系，
 * 却因此获得了一个"看起来合法"的来源。
 *
 * 端口是**部署时确定的事实**（我们就是听着它），因此它不来自请求头，
 * 也就不可被操纵。缺失 Origin 一律拒绝：正常浏览器发出的同源 POST
 * 一定带 Origin，"缺失"只可能来自手写请求或本机其它进程。
 */
export function isExactSameOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === "") return false;
  try {
    const url = new URL(origin);
    // `http://127.0.0.1:3241` 打在本服务（3240）上 ⇒ 不同源
    if (url.port !== String(port)) return false;
    if (url.protocol !== "http:") return false;
    if (url.hostname !== LOOPBACK_HOST && url.hostname !== "localhost") return false;
    return true;
  } catch {
    return false;
  }
}

/** token 比较：**定长**比较，避免因长度差异泄露信息。 */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided === "") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // 长度不同直接判否；长度相同时逐字节比较（不短路）
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// 计划构造（服务端只接受**结构化输入**，绝不接受命令）
// ---------------------------------------------------------------------------

/** 浏览器提交的一条指派（服务端会重新校验一切）。 */
export interface SubmittedAssignment {
  channel: string;
  assetKey: string;
  page: number;
  lineStart: number;
  lineEnd: number;
  note: string | null;
}

/** 浏览器提交的一个单元。 */
export interface SubmittedUnit {
  title: string;
  kind: string;
  assignments: SubmittedAssignment[];
}

/**
 * 由**服务端**构造计划文件（浏览器只提供结构，不提供文件内容）。
 *
 * ── 为什么不让浏览器直接 POST 整份 JSON ──
 *
 * 因为那等于让浏览器决定 `binding`（课程 id / 源摘要 / 资产校验和）。
 * 而绑定恰恰是陈旧语义的全部依据 —— 一个陈旧的页面（打开后源被改了）
 * 若带着**旧的** binding 提交，就会写出一份"看起来有效"的陈旧计划。
 *
 * 因此 binding **一律由服务端在当前时刻重新计算**：
 * 页面刷新前后提交的计划都绑定到**当前**源快照。
 */
export function buildPlanFromSubmission(input: {
  submitted: { author: string; reason: string; units: SubmittedUnit[] };
  courseId: string;
  sourceDigest: string;
  /** assetKey → sha256（**当前**的，不是页面加载时的）。 */
  currentAssetChecksums: Map<string, string>;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    binding: {
      courseId: input.courseId,
      sourceDigest: input.sourceDigest,
      assets: [...input.currentAssetChecksums.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([assetKey, sha256]) => ({ assetKey, sha256 })),
    },
    author: input.submitted.author,
    createdAt: new Date().toISOString(),
    reason: input.submitted.reason,
    units: input.submitted.units.map((unit) => ({
      title: unit.title,
      kind: unit.kind,
      assignments: unit.assignments.map((assignment) => ({
        channel: assignment.channel,
        range: {
          assetKey: assignment.assetKey,
          page: assignment.page,
          lineStart: assignment.lineStart,
          lineEnd: assignment.lineEnd,
        },
        note: assignment.note,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 服务器
// ---------------------------------------------------------------------------

/** 一次会话的运行时状态（注入 handler 以便单元测试直接驱动）。 */
export interface AnnotationSession {
  token: string;
  courseId: string;
  sourceDigest: string;
  config: AnnotationServerConfig;
  /**
   * 计划写盘回调（由 CLI 注入，负责原子写 + 替换确认策略）。
   *
   * ── 它必须回传**权威的**计划校验和 ──
   *
   * 校验和的唯一实现在 `segmentation-plan.ts` 的 `segmentationPlanDigest`。
   * 本模块**刻意不**自己算一遍 —— 两份实现在字段清单上稍有差异
   * 就会产出两个都"看起来合理"的校验和，而页面显示的那个
   * 与实际进入候选的那个不同。那属于最糟的一类静默分歧。
   *
   * 因此：算校验和是回调的责任（CLI 手里就有权威实现），
   * 本模块只负责把它回显给页面。
   */
  savePlan(plan: Record<string, unknown>): { ok: boolean; detail: string; planDigest: string };
  /**
   * **A1 只读检查工作台**能力（由启动器注入）。
   *
   * ── 它为什么是一个**能力对象**，而不是几个函数 import ──
   *
   * 本模块（`segment-server.ts`）刻意不 import 抽取、分组、匹配、
   * 目录选择器中的任何一个 —— 它的依赖面只有 `node:http` 与 `node:crypto`。
   * 那条纪律让"标注服务器不可能读数据库 / 不可能写候选"成为**结构性**事实
   * （见 `tests/course-segmentation-plan.test.ts` 的源码级门禁）。
   *
   * 因此 A1 的检查能力经这个对象注入：服务端只做
   * HTTP 层的事（守卫、token、路径分派、JSON 形状），
   * 而"怎么检查"留在它自己的模块里。
   *
   * ── 不提供它时行为**逐字节不变** ──
   *
   * `undefined` / `null` ⇒ 本进程只有既有的标注能力：
   * `/api/intake/*` 全部 404，`/api/plan` 照常可用。
   * 这条由 `tests/course-segment-tool.test.ts` 与 A1 测试双向守护。
   */
  intake?: IntakeCapability | null;
  /**
   * 实际监听端口的读取器（由 `startAnnotationServer` 在 `listen` 之后注入）。
   *
   * ── 为什么是回调而不是一个数字 ──
   *
   * `port: 0` 时真实端口只有在 `listen` 完成后才知道。若把配置里的 `0`
   * 当成端口用，"精确同源"判据会把**每一个**合法请求都判成跨源
   * （`http://127.0.0.1:52501` 的 port 永远不等于 `"0"`）——
   * 那正是"守卫把正常用户挡在门外"这一类缺陷。
   */
  actualPort?: () => number;
}

/**
 * A1 只读检查能力（由启动器注入；**服务端只调它，不理解它的内部**）。
 *
 * ── 绝对的路径纪律 ──
 *
 * `pickFolder()` **可以**返回绝对路径 —— 那是它存在的唯一理由（Node 侧要读盘）。
 * 但它返回的路径**永远不被本模块回给浏览器**：服务端把它交给
 * `browse` / `inspect`，而那两个方法的返回值按约定只含**相对路径**。
 *
 * 本模块不校验那条约定（它无法校验）—— 它由 A1 自己的测试守护：
 * 每个端点的响应体都被断言不含绝对路径形态。
 */
export interface IntakeCapability {
  /** 打开系统原生目录选择对话框；把选中的**绝对路径**交回本进程。 */
  pickFolder(): Promise<{
    outcome: string;
    path: string | null;
    detail: string;
    newFolderButtonHidden: boolean | null;
  }>;
  /** 记下一个已选源根（**只存在于服务端内存里**）。 */
  rememberSource(sourcePath: string): void;
  /** 当前已记下的源根标签（**只有目录名**）；没有时为 null。 */
  sourceLabel(): string | null;
  /** 当前已记下的源根是否存在（**不返回路径**）。 */
  hasSource(): boolean;
  /** 只读元数据清单（不含字节内容）。 */
  browse(): Promise<unknown>;
  /** 跑一次完整只读检查。 */
  inspect(selection: { includeDirectories: string[]; excludeFiles: string[] }): Promise<unknown>;
  /** 忘掉当前源根（"换一个目录"）。 */
  forgetSource(): void;

  // ── A2 人工裁决与保存能力 ──
  /** 读取已有草稿（若存在） */
  loadDraft?(courseId: string): Promise<unknown>;
  /**
   * 只读查询"这份审核将绑定哪一份候选、哪一版真题库"。
   *
   * 返回 `{ candidateExists, rebound, reason }`；**绝不**回传占位摘要或路径。
   */
  describeBinding?(courseId: string): Promise<unknown>;
  /** 校验审核草稿是否合法及是否陈旧 */
  validateDraft?(payload: unknown): Promise<unknown>;
  /** 安全保存人工裁决并备份 */
  saveDraft?(payload: unknown): Promise<unknown>;
  /** 安全保存人工分段计划（A2 专用端点，非 `/api/plan`） */
  savePlanDraft?(payload: unknown): Promise<unknown>;

  // ── A1 → A2 断点：生成课程候选 ──
  /**
   * **预演**一次候选生成（零写入）。
   *
   * 返回段/材料/资产的预计数量与全部复核事项，让人在授权前看清后果。
   */
  previewCandidate?(payload: unknown): Promise<unknown>;
  /**
   * **生成**课程候选（写入 `course-candidates/<id>/`）。
   *
   * 只在用户显式授权后调用；服务端仍然会重新校验一切。
   */
  generateCandidate?(payload: unknown): Promise<unknown>;

  // ── A3 受控接入能力（三个独立边界） ──
  /** 只读预演：门禁逐项 + 冲突 + 每个操作将写到哪里。 */
  previewPromotion?(courseId: string): Promise<unknown>;
  /** A3-a：晋升（写 `courses/`）。**单独授权。** */
  promoteCandidate?(payload: unknown): Promise<unknown>;
  /** A3-b：导入索引（写数据库，首次触发 v8→v9 迁移）。**单独授权。** */
  importIndex?(payload: unknown): Promise<unknown>;
  /** A3-c：建立真题链接（默认预演；保存须再次明确确认）。**单独授权。** */
  linkCanonical?(payload: unknown): Promise<unknown>;
  /** 读取三项进度（中断后重新打开时恢复现场）。 */
  readProgress?(courseId: string): Promise<unknown>;
}

const MAX_BODY_BYTES = 512 * 1024;

/** 读取请求体（**有上限**：不接受任意大的 body）。 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("请求体过大（上限 512 KiB）"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // 私有内容绝不留在浏览器缓存里
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    /*
     * 与页面同一条纪律：本机 URL（含回环端口）不得出现在任何外部站点的
     * 请求里。JSON 响应同样带 no-referrer —— 判据不因响应类型而分叉。
     */
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    /*
     * ── 本机 URL 绝不外泄 ──
     *
     * 标注 URL 的 fragment 里带着会话 token。虽然 fragment 本身不会被
     * `Referer` 带上，但整条 URL（含回环端口）也不该出现在任何外部站点的
     * 请求里。`no-referrer` 把它彻底掐断（页面 `<meta name="referrer">`
     * 是同一策略的第二道，用于 `file://` 之类的边界情形）。
     */
    "referrer-policy": "no-referrer",
    /*
     * ── CSP：把"零外部资源"变成浏览器强制的事实 ──
     *
     * `default-src 'none'` 禁止一切外部加载；脚本与样式内联白名单
     * （页面是单文件、无构建步骤）。因此即使有人往页面里插了一个
     * `<link href="https://...">`，浏览器也会拒绝加载它。
     *
     * `connect-src 'self'` 只允许回环自身的 XHR/fetch（页面要读
     * `/api/bootstrap` 并写 `/api/plan`）。
     */
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(html);
}

/**
 * 启动标注服务器。
 *
 * `port: 0` 让操作系统分配一个空闲端口 —— 这是默认，因为把私有材料的
 * 标注工具固定绑在一个众所周知端口上没有任何好处。
 */
export async function startAnnotationServer(
  session: AnnotationSession,
  options: {
    port?: number;
    page: () => string;
    intakePage?: () => string;
    /**
     * A3 受控接入工作台页面。
     *
     * 与 `intakePage` 同样的纪律：**零参数**、与任何请求者字节相同、
     * 不含课程正文 / 复核记录 / token / 源路径。
     *
     * 不提供它时 `/a3` 回 404：一个只有 A1/A2 能力的进程在结构上
     * 就没有 A3 的页面可给。
     */
    a3Page?: () => string;
  },
): Promise<AnnotationServerHandle> {
  const intakePage = options.intakePage ?? (() => "");
  const a3Page = options.a3Page ?? (() => "");
  /*
   * 把**真实监听端口**接到会话上（见 `AnnotationSession.actualPort`）。
   *
   * 初值是配置里的端口；`listen` 完成后（`port: 0` 时）被换成操作系统
   * 实际分配的端口。因此请求处理时读到的永远是一个已确定的值。
   */
  let resolvedPort = options.port ?? 0;
  session.actualPort = () => resolvedPort;
  const server: Server = createServer((request, response) => {
    handleRequest(request, response, session, options.page, intakePage, a3Page).catch(() => {
      /*
       * 兜底错误处理：**绝不把正文或堆栈回给浏览器，也绝不打印正文**。
       * 只回一个泛化的失败。
       */
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "内部错误" });
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // **只监听回环** —— 绝不 0.0.0.0
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);
  // 精确同源判据据此与**真的**监听端口比对（`port: 0` 时尤其重要）
  resolvedPort = port;
  /*
   * 真实绑定地址来自 `server.address()`，**不是**回显常量。
   *
   * 差别很重要：`boundAddress` 记录的是操作系统实际接受的绑定地址。
   * 若有人把 `listen` 的目标改成 `0.0.0.0`，这里会**如实反映**出来
   * （测试据此判红）—— 而"回显 LOOPBACK_HOST 常量"那种写法
   * 在同样的改动下仍然显示 `127.0.0.1`，因此证明不了任何事。
   */
  const boundAddress = typeof address === "object" && address !== null ? address.address : LOOPBACK_HOST;

  return {
    /*
     * token 放在 **fragment** 里：本机操作者可以整条粘贴进浏览器。
     *
     * fragment **不会**随请求发给服务器，因此它不进请求目标、不进日志。
     * 写操作仍然要求同一个 token 出现在请求头里，因此一个只知道 URL 的
     * 跨站页面无法写 —— 而且它连读都做不到（读也要 token 请求头）。
     */
    url: `http://${LOOPBACK_HOST}:${port}/#token=${session.token}`,
    port,
    token: session.token,
    boundAddress,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  session: AnnotationSession,
  page: () => string,
  intakePage: () => string,
  a3Page: () => string,
): Promise<void> {
  // ── 守卫 1：Host 必须是回环（挡 DNS rebinding）──
  if (!isLoopbackHost(request.headers.host)) {
    sendJson(response, 403, { ok: false, error: "只接受回环 Host" });
    return;
  }
  // ── 守卫 2：Origin（若出现）必须是回环（挡跨站写）──
  if (!isAcceptableOrigin(request.headers.origin)) {
    sendJson(response, 403, { ok: false, error: "只接受回环 Origin" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);

  /*
   * ── 页面（`GET /`）：**静态外壳，无需凭据，且不含任何私有数据** ──
   *
   * 浏览器导航无法带自定义请求头，因此这一条必须匿名可用。
   * 正因如此，它**只**回一个与任何请求者都相同的静态文档：
   * 没有课程正文、没有计划、没有 token、没有源路径。
   *
   * 这里刻意**不**看 token —— 看了也没用（页面里没有任何东西可保护），
   * 而且会让"页面依赖 token"这种错误设计有可乘之机。
   */
  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, page());
    return;
  }

  /*
   * ── A1 工作台页面（`GET /intake`）：**同样是静态外壳** ──
   *
   * 与 `GET /` 一字不差的纪律：可匿名取得、与任何请求者字节相同、
   * 不含课程正文 / 计划 / token / 源路径。因此它也**必须**零参数渲染 ——
   * 签名本身就是那条边界的守卫（同 `renderAnnotationShell`）。
   *
   * 认证后它经 `GET /api/intake/state` 取私有引导数据。
   */
  if (request.method === "GET" && url.pathname === INTAKE_PAGE_PATH) {
    sendHtml(response, intakePage());
    return;
  }

  /*
   * ── A3 受控接入工作台页面（`GET /a3`）：**同样是静态外壳** ──
   *
   * 与 `GET /intake` 一字不差的纪律。
   *
   * ── 判据取能力而不是"页面函数返回空" ──
   *
   * `A3_PAGE_PATH` 是**接入能力**的界面。若会话没有
   * `previewPromotion`（A1 / A2 / 标注模式），就没有 A3 可做 ——
   * 因此回 404。判据落在能力上而不是"渲染结果是不是空字符串"：
   * 后者会因为一个渲染 bug 把"没有能力"变成"有一个空白页面"。
   */
  if (request.method === "GET" && url.pathname === A3_PAGE_PATH) {
    if (session.intake?.previewPromotion === undefined) {
      sendJson(response, 404, { ok: false, error: "未知路径" });
      return;
    }
    sendHtml(response, a3Page());
    return;
  }

  /*
   * ── A1 能力路由（`/api/intake/*`）──
   *
   * 没有注入 `intake` 能力时**全部 404**：本进程只有既有的标注能力，
   * 因此"标注模式不会被 A1 的路由影响"是一条结构性事实。
   */
  if (url.pathname.startsWith("/api/intake/")) {
    if (session.intake === undefined || session.intake === null) {
      sendJson(response, 404, { ok: false, error: "未知路径" });
      return;
    }
    await handleIntakeRequest(request, response, session, url);
    return;
  }

  /*
   * ── 私有引导数据（`GET /api/bootstrap`）：**必须带 token** ──
   *
   * 这是唯一下发正文的端点。未认证请求一律 403 —— 因此本机其他进程
   * 即使能访问回环端口，也拿不到任何私有内容，更拿不到写计划的能力。
   *
   * 旧实现把这份数据塞进 `GET /` 的 HTML，于是"读私有材料"与
   * "取得写能力"都无需凭据 —— 那正是被复评证明的缺陷。
   */
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      courseId: session.courseId,
      sourceDigest: session.sourceDigest,
      assets: session.config.assets,
      existingPlan: session.config.existingPlan,
    });
    return;
  }

  // ── 保存计划（写操作：**必须**带 token）──
  if (request.method === "POST" && url.pathname === "/api/plan") {
    if (!tokenMatches(session.token, headerToken(request))) {
      // 写操作绝不接受查询串里的 token —— 那会被跨站请求带上
      sendJson(response, 403, { ok: false, error: "写操作需要正确的会话 token 请求头" });
      return;
    }

    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      sendJson(response, 413, { ok: false, error: (error as Error).message });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(response, 400, { ok: false, error: "请求体不是合法 JSON" });
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      sendJson(response, 400, { ok: false, error: "请求体必须是一个对象" });
      return;
    }

    const submission = parsed as { author?: unknown; reason?: unknown; units?: unknown };
    if (
      typeof submission.author !== "string" ||
      !Array.isArray(submission.units) ||
      submission.units.length === 0
    ) {
      sendJson(response, 400, { ok: false, error: "需要 author（字符串）与至少一个 unit" });
      return;
    }

    /*
     * binding 由**服务端**按当前时刻构造 —— 绝不接受浏览器送来的 binding。
     *
     * 理由：一个打开很久的页面可能带着过期的源摘要提交。若信任它，
     * 就会写出一份**看起来有效**的陈旧计划，而它会在下一次抽取时
     * 悄悄把旧坐标套到新源上。由服务端重算 ⇒ 计划永远绑定当前源快照。
     */
    const currentChecksums = new Map(session.config.assets.map((asset) => [asset.assetKey, asset.sha256]));
    const plan = buildPlanFromSubmission({
      submitted: {
        author: submission.author,
        reason: typeof submission.reason === "string" ? submission.reason : "",
        units: submission.units as SubmittedUnit[],
      },
      courseId: session.courseId,
      sourceDigest: session.sourceDigest,
      currentAssetChecksums: currentChecksums,
    });

    const result = session.savePlan(plan);
    sendJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      detail: result.detail,
      // 计划校验和由 CLI 用**权威实现**算好回传（见 `AnnotationSession.savePlan`）
      planDigest: result.planDigest,
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "未知路径" });
}

function headerToken(request: IncomingMessage): string | undefined {
  const raw = request.headers[SESSION_TOKEN_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** 生成一次会话的随机 token（32 字节 base64url ⇒ 不可猜测）。 */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// A1 只读检查工作台 · 请求处理
// ---------------------------------------------------------------------------

/** A1 工作台页面的路径（与 `GET /` 同一个进程、同一套守卫、同一个 token）。 */
export const INTAKE_PAGE_PATH = "/intake";

/** A3 受控接入工作台页面的路径。 */
export const A3_PAGE_PATH = "/a3";

/** 端点路径常量（客户端脚本引用它们，因此集中在这里，避免两处各写一份）。 */
export const INTAKE_ENDPOINTS = {
  state: "/api/intake/state",
  browse: "/api/intake/browse",
  pick: "/api/intake/pick",
  inspect: "/api/intake/inspect",
  loadDraft: "/api/intake/draft",
  binding: "/api/intake/binding",
  validateDraft: "/api/intake/validate-draft",
  saveDraft: "/api/intake/save-draft",
  savePlan: "/api/intake/save-plan",
  previewCandidate: "/api/intake/preview-candidate",
  generateCandidate: "/api/intake/generate-candidate",
  previewPromotion: "/api/intake/preview-promotion",
  promote: "/api/intake/promote",
  importIndex: "/api/intake/import-index",
  link: "/api/intake/link",
  progress: "/api/intake/progress",
} as const;

/** A1 敏感 POST 允许的 body 上限（选择范围是一个路径数组，不该很大）。 */
const MAX_INTAKE_BODY_BYTES = 256 * 1024;

/**
 * 处理 A1 的 `/api/intake/*`。
 *
 * ── 三类请求，守卫强度**刻意不同** ──
 *
 * | 端点 | 方法 | token | 精确同源 | 理由 |
 * | --- | --- | --- | --- | --- |
 * | `state` | GET | **要** | 不要 | 只回"有没有源 + 目录名"，不含正文也不含路径 |
 * | `browse` | GET | **要** | 不要 | 只读**元数据**（不打开文件句柄），输入只有已记下的源根 |
 * | `pick` | POST | **要** | **要** | 它会让 Node 进程弹出模态窗口并读一个本机路径 |
 * | `inspect` | POST | **要** | **要** | 它会按用户给的路径范围读盘（本机 I/O 能力） |
 * | A2/A3 全部 POST | POST | **要** | **要** | 它们全部具备写盘/写库能力 |
 *
 * `pick` 与 `inspect` 是**新的敏感 POST 端点**，因此它们用
 * `isExactSameOrigin(origin, port)`（协议 + 主机名 + **端口**逐项相等），
 * 而不是读端点那条宽松的"任意回环"判据。任务书要求的正是这一条。
 *
 * `browse` 是 GET 而不是 POST：它**不接受任何用户输入**（范围来自已记下的
 * 源根），因此没有"用请求体驱动本机 I/O"这条面。它仍然要求 token ——
 * 与既有 `GET /api/bootstrap` 同一条纪律。
 *
 * ── A3 的三个写端点为什么**必须**走精确同源 ──
 *
 * 它们分别写 `courses/`、写数据库（含 schema 迁移）、写不可变复核行。
 * 一个来自另一个回环端口的请求（本机另一个服务）与本次会话的 token
 * 毫无关系，却可能获得一个"看起来合法"的来源。因此判据与 `pick` / `inspect`
 * 完全相同，不因为"功能更重要"而放宽 —— 恰好相反。
 *
 * ── 它们绝不回显绝对路径 ──
 *
 * `pick` 的响应体里**没有**路径：它只回"选好了 / 取消了 / 打不开"，
 * 外加源根**目录名**（用于让人确认选对了哪一个）。绝对路径只存在于
 * 服务端内存里（`capability.rememberSource`）。
 */
async function handleIntakeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  session: AnnotationSession,
  url: URL,
): Promise<void> {
  const capability = session.intake!;
  /*
   * **实际监听端口**（不是配置里的那个）：`port: 0` 时真实端口由操作系统分配，
   * 而"精确同源"必须与**真的**在监听的那个端口比 —— 用配置值会让
   * `port: 0` 的实例把所有合法请求判成跨源。
   */
  const port = session.actualPort?.() ?? 0;

  // ── 读端点：token 必需（与既有 bootstrap 同一条纪律）──
  if (request.method === "GET" && url.pathname === INTAKE_ENDPOINTS.state) {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      sourceLabel: capability.sourceLabel(),
      hasSource: capability.hasSource(),
      /** 只读能力声明：界面据此隐藏任何"保存 / 导入"控件。 */
      mode: "read_only",
      endpoints: INTAKE_ENDPOINTS,
    });
    return;
  }

  /*
   * ── 元数据浏览（`GET /api/intake/browse`）──
   *
   * ── 为什么它必须与检查分开（任务书明确要求）──
   *
   * 首屏"这个文件夹里有什么"若走完整检查，就会把范围内**每一个 PDF
   * 都解析一遍** —— 一个几十 MB 的讲义要几秒到几十秒，而用户此刻
   * 还没有选择任何东西。那既慢，又在无谓地做远超必要的 I/O。
   *
   * `browse` 走的是 `scanSourceTree`：**绝不打开文件句柄**，
   * 只 `readdir` + `stat`。因此它很快，且其安全性由与内容清点
   * **完全同一份**遍历实现保证（见 `sources.ts` 的 `traverseSourceTree`）。
   */
  if (request.method === "GET" && url.pathname === INTAKE_ENDPOINTS.browse) {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    if (!capability.hasSource()) {
      sendJson(response, 409, { ok: false, error: "还没有选择课程目录" });
      return;
    }
    try {
      sendJson(response, 200, { ok: true, metadata: await capability.browse() });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── A2 草稿读取端点（GET /api/intake/draft?courseId=...）──
  //
  // 能力检查**先于**参数校验：A1 会话（无该能力）一律 501。
  if (request.method === "GET" && url.pathname === INTAKE_ENDPOINTS.loadDraft) {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    if (!capability.loadDraft) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用草稿加载能力" });
      return;
    }
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      sendJson(response, 400, { ok: false, error: "缺少 courseId 参数" });
      return;
    }
    try {
      const draft = await capability.loadDraft(courseId);
      sendJson(response, 200, { ok: true, draft });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── A2 绑定身份端点（GET /api/intake/binding?courseId=...）──
  //
  // 只读：回答"这份审核将绑定哪一份候选、哪一版真题库"。
  // 候选不存在时如实报告（界面据此提示先运行 course:extract），
  // **绝不**回传占位摘要。响应只含摘要与布尔，不含任何路径。
  //
  // 能力检查**先于**参数校验：A1 会话（无该能力）一律 501，
  // 不因为"忘了带 courseId"而暴露不同的失败形态。
  if (request.method === "GET" && url.pathname === INTAKE_ENDPOINTS.binding) {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    if (!capability.describeBinding) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用绑定查询能力" });
      return;
    }
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      sendJson(response, 400, { ok: false, error: "缺少 courseId 参数" });
      return;
    }
    try {
      const binding = await capability.describeBinding(courseId);
      sendJson(response, 200, { ok: true, binding });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── A3 进度读取端点（GET /api/intake/progress?courseId=...）──
  //
  // 只读：回答"三项里哪几步成功了"。中断后重新打开工作台时，
  // 这是恢复现场的唯一依据 —— 因此它必须能在任何时候被查询，
  // 而且**不**因为"没做过任何一步"而报错。
  if (request.method === "GET" && url.pathname === INTAKE_ENDPOINTS.progress) {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    if (!capability.readProgress) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用课程接入能力" });
      return;
    }
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      sendJson(response, 400, { ok: false, error: "缺少 courseId 参数" });
      return;
    }
    try {
      sendJson(response, 200, { ok: true, progress: await capability.readProgress(courseId) });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── A3 预演端点（GET /api/intake/preview-promotion?courseId=...）──
  //
  // 只读：门禁逐项 + 冲突 + 每个操作将写到哪里。零写入、零迁移。
  if (request.method === "GET" && url.pathname === INTAKE_ENDPOINTS.previewPromotion) {
    if (!tokenMatches(session.token, headerToken(request))) {
      sendJson(response, 403, { ok: false, error: "缺少或错误的会话 token" });
      return;
    }
    if (!capability.previewPromotion) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用课程接入能力" });
      return;
    }
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      sendJson(response, 400, { ok: false, error: "缺少 courseId 参数" });
      return;
    }
    try {
      sendJson(response, 200, { ok: true, preview: await capability.previewPromotion(courseId) });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── 敏感 POST：token + **精确同源**（含端口）──
  //
  // 刻意把 A3 的三个写端点与 A2 的保存端点列在**同一处**：
  // 它们全部具备写盘/写库能力，因此判据必须完全相同。
  // 分开写会让"新增一个写端点时忘了加同源检查"成为可能 —— 而那正是
  // fail-open 的入口。
  const isSensitivePost =
    request.method === "POST" &&
    (url.pathname === INTAKE_ENDPOINTS.pick ||
      url.pathname === INTAKE_ENDPOINTS.inspect ||
      url.pathname === INTAKE_ENDPOINTS.validateDraft ||
      url.pathname === INTAKE_ENDPOINTS.saveDraft ||
      url.pathname === INTAKE_ENDPOINTS.savePlan ||
      url.pathname === INTAKE_ENDPOINTS.previewCandidate ||
      url.pathname === INTAKE_ENDPOINTS.generateCandidate ||
      url.pathname === INTAKE_ENDPOINTS.promote ||
      url.pathname === INTAKE_ENDPOINTS.importIndex ||
      url.pathname === INTAKE_ENDPOINTS.link);

  if (!isSensitivePost) {
    sendJson(response, 404, { ok: false, error: "未知路径" });
    return;
  }

  if (!tokenMatches(session.token, headerToken(request))) {
    sendJson(response, 403, { ok: false, error: "这个操作需要正确的会话 token 请求头" });
    return;
  }
  if (!isExactSameOrigin(request.headers.origin, port)) {
    sendJson(response, 403, { ok: false, error: "这个操作只能由本工作台的同一来源页面发起" });
    return;
  }

  if (url.pathname === INTAKE_ENDPOINTS.pick) {
    const picked = await capability.pickFolder();
    // **绝不回显绝对路径**；只回结局与源根目录名
    if (picked.path !== null) capability.rememberSource(picked.path);
    sendJson(response, 200, {
      ok: picked.outcome === "selected" || picked.outcome === "cancelled",
      outcome: picked.outcome,
      detail: picked.detail,
      sourceLabel: picked.outcome === "selected" ? capability.sourceLabel() : null,
      /** 运行时事实：原生对话框是否真的关掉了"新建文件夹"。 */
      newFolderButtonHidden: picked.newFolderButtonHidden,
    });
    return;
  }

  // 读取敏感 POST 请求体
  let body: string;
  try {
    body = await readIntakeBody(request);
  } catch (error) {
    sendJson(response, 413, { ok: false, error: (error as Error).message });
    return;
  }

  let parsed: unknown;
  try {
    parsed = body === "" ? {} : JSON.parse(body);
  } catch {
    sendJson(response, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    sendJson(response, 400, { ok: false, error: "请求体必须是一个对象" });
    return;
  }

  // ── A2 草稿校验端点 ──
  if (url.pathname === INTAKE_ENDPOINTS.validateDraft) {
    if (!capability.validateDraft) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用草稿校验能力" });
      return;
    }
    try {
      const res = await capability.validateDraft(parsed);
      sendJson(response, 200, { ok: true, validation: res });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── A2 保存裁决草稿端点 ──
  if (url.pathname === INTAKE_ENDPOINTS.saveDraft) {
    if (!capability.saveDraft) {
      sendJson(response, 501, { ok: false, error: "当前工作台处于只读模式，不具备保存人工审核决定的能力" });
      return;
    }
    try {
      const res = await capability.saveDraft(parsed);
      sendJson(response, (res as { ok?: boolean }).ok ? 200 : 400, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── A2 保存人工分段计划端点 ──
  if (url.pathname === INTAKE_ENDPOINTS.savePlan) {
    if (!capability.savePlanDraft) {
      sendJson(response, 501, { ok: false, error: "当前工作台处于只读模式，不具备保存分段计划的能力" });
      return;
    }
    try {
      const res = await capability.savePlanDraft(parsed);
      sendJson(response, (res as { ok?: boolean }).ok ? 200 : 400, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  /*
   * ── A1 → A2 断点：生成课程候选 ──
   *
   * `previewCandidate` 是 GET 之外的 POST，因为它要接收课程基本信息
   * （id / 标题 / 提供方）。但它是**零写入**的：只跑一遍抽取流水线，
   * 把预计产生的段/材料/资产与全部复核事项回给界面。
   *
   * `generateCandidate` 才写盘。两者分开是有意的：预演必须能在
   * "不产生任何候选目录"的前提下被反复执行。
   */
  if (url.pathname === INTAKE_ENDPOINTS.previewCandidate) {
    if (!capability.previewCandidate) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用候选生成能力" });
      return;
    }
    try {
      const res = await capability.previewCandidate(parsed);
      sendJson(response, 200, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  if (url.pathname === INTAKE_ENDPOINTS.generateCandidate) {
    if (!capability.generateCandidate) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用候选生成能力" });
      return;
    }
    try {
      const res = await capability.generateCandidate(parsed);
      sendJson(response, (res as { ok?: boolean }).ok ? 200 : 400, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  /*
   * ── A3 的三个独立写端点 ──
   *
   * 每一个都是**单独授权**：完成 A3-a 不代表批准 A3-b 或 A3-c。
   * 这里刻意**不**提供任何"全部完成"的复合端点 —— 把三个不同性质的
   * 不可逆动作压成一个按钮，会让 使用者 在一次点击里同时批准
   * "替换运行时课程包"、"迁移数据库"与"创造一条 verified 真相"。
   */
  if (url.pathname === INTAKE_ENDPOINTS.promote) {
    if (!capability.promoteCandidate) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用课程接入能力" });
      return;
    }
    try {
      const res = await capability.promoteCandidate(parsed);
      sendJson(response, (res as { ok?: boolean }).ok ? 200 : 400, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  if (url.pathname === INTAKE_ENDPOINTS.importIndex) {
    if (!capability.importIndex) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用课程接入能力" });
      return;
    }
    try {
      const res = await capability.importIndex(parsed);
      sendJson(response, (res as { ok?: boolean }).ok ? 200 : 400, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  if (url.pathname === INTAKE_ENDPOINTS.link) {
    if (!capability.linkCanonical) {
      sendJson(response, 501, { ok: false, error: "当前会话未启用课程接入能力" });
      return;
    }
    try {
      const res = await capability.linkCanonical(parsed);
      sendJson(response, (res as { ok?: boolean }).ok ? 200 : 400, res);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
    }
    return;
  }

  // ── 检查：body 是一个选择范围（相对路径数组）──

  const raw = parsed as { includeDirectories?: unknown; excludeFiles?: unknown };
  if (!Array.isArray(raw.includeDirectories) || !Array.isArray(raw.excludeFiles)) {
    sendJson(response, 400, {
      ok: false,
      error: "需要 includeDirectories（数组）与 excludeFiles（数组）—— 空数组表示不检查任何内容",
    });
    return;
  }
  /*
   * 元素必须是字符串。**不做任何路径解释**：选择范围的合法性由
   * `buildSourceSelection` 与遍历本身判定（它只做排除，不扩大读取范围）。
   * 这里只挡住非字符串，避免把类型错误带进下游。
   */
  const includeDirectories = raw.includeDirectories.filter((item): item is string => typeof item === "string");
  const excludeFiles = raw.excludeFiles.filter((item): item is string => typeof item === "string");
  if (includeDirectories.length + excludeFiles.length > 20_000) {
    sendJson(response, 400, { ok: false, error: "选择范围过大（条目数超过上限）" });
    return;
  }
  if (!capability.hasSource()) {
    sendJson(response, 409, { ok: false, error: "还没有选择课程目录" });
    return;
  }

  try {
    const result = await capability.inspect({ includeDirectories, excludeFiles });
    sendJson(response, 200, { ok: true, result });
  } catch (error) {
    /*
     * 失败**必须**被如实上报，且**绝不**带路径。
     *
     * `sanitizeIntakeError` 把任何路径形态（盘符 / UNC / POSIX / 已知私有目录）
     * 换成中性占位 —— 错误消息是最容易顺手带上一个路径的地方。
     */
    sendJson(response, 500, { ok: false, error: sanitizeIntakeError((error as Error).message) });
  }
}

/** 读取 A1 POST 的 body（**有独立上限**）。 */
function readIntakeBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_INTAKE_BODY_BYTES) {
        reject(new Error("请求体过大（上限 256 KiB）"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * 错误消息的路径消毒（**唯一边界**）。
 *
 * ── 为什么在这里，而不是在每个 throw 处 ──
 *
 * 错误消息来源会新增（任何 `catch` 都可能拼进一个路径），而出口只有一个。
 * 逐个改来源等于指望"每个新 catch 都记得消毒"。
 *
 * 判据刻意保守：只要出现盘符、UNC 前缀、POSIX 绝对路径或已知私有目录名，
 * 就把**整个片段**换成中性占位 —— 不知道路径长什么样时，
 * 多抹掉一点比漏掉一个路径安全。
 */
export function sanitizeIntakeError(message: string): string {
  const PLACEHOLDER = "（本机目录）";
  let text = message;
  text = text.replace(/[A-Za-z]:\\[^\s'"()]*/g, PLACEHOLDER);
  text = text.replace(/\\\\[^\s'"()]+/g, PLACEHOLDER);
  text = text.replace(/\/(?:[^\s/'"()]+\/)+[^\s/'"()]*/g, PLACEHOLDER);
  for (const marker of ["private-content", "course-candidates", "course-sources", "\\.e2e"]) {
    text = text.replace(new RegExp(`${marker}[^\\s，。；、）】"']*`, "g"), PLACEHOLDER);
  }
  return text.replace(/\s{2,}/g, " ").trim();
}
