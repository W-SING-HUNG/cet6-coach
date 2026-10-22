/**
 * 本地请求守卫（local request guard）。
 *
 * ── 这个模块存在的唯一理由 ──
 *
 * 本产品是一个**单人、本机**的应用：它的全部内容是私有课程材料与私有真题包，
 * 服务只监听回环。因此"这个请求是不是来自本机浏览器"是一条真实的安全边界，
 * 而不是仪式。
 *
 * ── 为什么判据必须是「精确同一来源」，而不是「都是回环」 ──
 *
 * 上一版的守卫分别接受"任意回环 Host"与"任意回环 Origin"。
 * 那**不构成**同源：`http://127.0.0.1:3199` 与 `http://127.0.0.1:3200`
 * 是两个不同的来源，而它们的主机名都是回环。
 *
 * 一个具体的攻击面：本机同时跑着多个服务（另一个 CET6 实例、某个 devtools
 * 面板、任何监听回环的工具）。若守卫只比主机名，那么来自**另一个端口**的
 * 请求会被当成同源放行 —— 而那个服务的内容与凭据都与本应用无关。
 *
 * 因此判据是 `Origin` 与**实际服务的来源**逐项相等：协议、主机名、端口。
 *
 * ── 与标注服务器守卫的关系 ──
 *
 * `content/course-pipeline/segment-server.ts` 的守卫是**另一条独立实现**，
 * 判据不同（它允许缺失 Origin，因为 `GET /` 必须匿名可导航）。
 * 刻意不合并：合并会迫使一方接受另一方的宽松判据，而宽松判据在写端点上
 * 就是 fail-open。
 *
 * ── 为什么不能只依赖 Proxy ──
 *
 * 反代不是授权边界：一旦有人把端口直接暴露（`next start -H 0.0.0.0`、
 * 端口转发、容器网络），Host/Origin 就是仅剩的判据。因此它必须由
 * **应用自己**做，且必须在任何业务逻辑之前。
 */

/** 回环主机名集合。刻意不含 `0.0.0.0` 与任何公网地址。 */
export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/**
 * 本地服务器绑定的回环地址。
 *
 * 抽出来给启动脚本共用（`package.json` 的 dev/start、各 `e2e-server-*.ts`），
 * 于是"只绑回环"这件事只有**一个字面量**，不会在某个脚本里被写成
 * `-H 0.0.0.0` 或整个漏掉。
 */
export const LOOPBACK_HOST = "127.0.0.1" as const;

/**
 * 应用自身监听的来源（`protocol//hostname:port`）。
 *
 * ── 为什么它必须是**显式配置**，而不是从请求头推 ──
 *
 * 从请求头推会得到一个循环：用 `Host` 头定义"可信来源"，再拿 `Origin`
 * 去比它 —— 而 `Host` 本身就是可被 DNS rebinding 操纵的输入。
 * 因此可信来源只能来自**部署时确定的事实**：我们监听哪个地址与端口。
 *
 * ── 取值顺序（显式优先，绝不静默信任请求头）──
 *
 * 1. `CET6_LOCAL_ORIGIN` —— 完整来源，测试实例与非常规部署用它；
 * 2. `PORT` —— 只覆盖端口，协议与主机名仍取默认（Next 自己也读 `PORT`）；
 * 3. 默认 `http://127.0.0.1:3100` —— 与 `package.json` 的 `dev` / `start`
 *    **逐字一致**。三者不一致会让"开发能过、生产被自己的守卫挡掉"。
 *
 * `Host` 头**永不**参与：攻击者能控制它，让它定义可信来源等于没有边界。
 */
const DEFAULT_LOCAL_ORIGIN = "http://127.0.0.1:3100";

function configuredLocalOrigin(): string {
  const explicit = process.env.CET6_LOCAL_ORIGIN?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  /*
   * `PORT` 是 Next.js 自己也认识的环境变量。这里只取端口，
   * 因此 `PORT=3265 pnpm start` 的可信来源是 `http://127.0.0.1:3265`。
   *
   * 端口必须是 1–65535 的整数，否则忽略（不让畸形值定义安全边界）。
   */
  const port = process.env.PORT?.trim();
  if (port !== undefined && /^\d{1,5}$/.test(port)) {
    const parsed = Number(port);
    if (parsed >= 1 && parsed <= 65535) {
      return `http://${LOOPBACK_HOST}:${parsed}`;
    }
  }

  return DEFAULT_LOCAL_ORIGIN;
}

/** 本应用的可信来源（协议 + 主机名 + 端口）。 */
export function trustedLocalOrigin(): string {
  const url = new URL(configuredLocalOrigin());
  // 归一化：默认端口不写出来（`http://127.0.0.1:80` 与 `http://127.0.0.1` 同源）
  return `${url.protocol}//${url.host}`;
}

/** 可信来源的主机名（用于 Host 头判定）。 */
export function trustedHostname(): string {
  return new URL(configuredLocalOrigin()).hostname;
}

/**
 * 判定 Host 头是否属于**本应用自己**。
 *
 * 上一版接受任意回环主机名；现在要求与可信来源的主机名一致。
 * 缺失 Host 一律拒绝 —— HTTP/1.1 请求不带 Host 本身就是畸形输入。
 */
export function isTrustedHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== "string" || raw === "") return false;

  // Host 头形如 `127.0.0.1:3100`（IPv6 为 `[::1]:3100`）。
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  return hostname === trustedHostname();
}

/** Host 头是否至少是回环（宽松判据，仅用于诊断与测试对照）。 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== "string" || raw === "") return false;
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(hostname);
}

/**
 * Host 头是否指向**规范访问地址**（即可信来源的那个主机名）。
 *
 * ── 它与 `isTrustedHostHeader` 的分工 ──
 *
 * `isTrustedHostHeader` 是**写请求**（敏感 POST）的判据：Host 与 Origin 都
 * 必须精确等于可信来源。本函数不参与那条判定，它只用于**读请求的引导**。
 *
 * ── 为什么单列一个函数而不是放宽上面那个 ──
 *
 * `localhost` 与 `127.0.0.1` 在浏览器眼里是**两个来源**。上个版本 README
 * 让人打开 `localhost:3100`，而服务监听并信任 `127.0.0.1:3100`，
 * 于是课程揭示的 POST 被自己的同源守卫挡掉 —— 实测复现为
 * 403「来源不是同一个本地服务」，界面上表现为"看不到正文"，且没有恢复路径。
 *
 * 修法**不是**同时信任两个主机名（那会放松敏感 POST 的同源边界），
 * 而是让非规范主机名的读请求被**重定向到规范地址**：浏览器随后从
 * 规范来源发起，同源判定依然精确到单一来源。判据本身没有变宽。
 */
export function isCanonicalHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== "string" || raw === "") return false;
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  return hostname === trustedHostname();
}

/** Origin 失败的具体形态（分开是为了让响应体说清"缺"与"错"）。 */
export type OriginRejection =
  | "origin_missing"
  | "origin_invalid"
  | "origin_not_loopback"
  | "origin_loopback_alias"
  | "origin_not_same_origin";

/**
 * 判定 Origin 头是否**精确等于**本应用的可信来源。
 *
 * ── 拒绝形态，逐种都有真实 HTTP 负向测试 ──
 *
 * | 形态 | 判据 |
 * | --- | --- |
 * | `origin_missing` | 头缺失或空 |
 * | `origin_invalid` | 不是合法绝对 URL |
 * | `origin_not_loopback` | 主机名不是回环 |
 * | `origin_loopback_alias` | 回环的**另一个主机名**，协议与端口都相同 |
 * | `origin_not_same_origin` | 协议/主机名/端口中任一项与可信来源不同 |
 *
 * `origin_not_same_origin` 是上一版完全没挡住的那一类：
 * `http://127.0.0.1:3200` 打在 `:3100` 的服务上 —— 都是回环，
 * 但不是同一个来源。
 *
 * ── 为什么单独分出 `origin_loopback_alias` ──
 *
 * 它和"跨站写"不是同一件事：`http://localhost:3100` 与
 * `http://127.0.0.1:3100` 都是**本机用户自己**打开的地址，只是浏览器
 * 把它们算作两个来源。把这种情况混进 `origin_not_same_origin` 的
 * 后果是实测过的：学习者按 README 打开 localhost，点「确认阅读」
 * 得到一句"来源不是同一个本地服务"，界面既没说该换成哪个地址，
 * 也没有任何恢复路径 —— 功能看起来就是坏的。
 *
 * 判据没有放宽：它**仍然被拒绝**，只是拒绝的理由更准确，因而能给出
 * 一条可执行的自救指引（改用规范地址）。真正的跨站/跨端口/跨协议
 * 仍然落在 `origin_not_same_origin` 与 `origin_not_loopback` 里。
 */
export function classifyOrigin(originHeader: string | undefined): { ok: true } | { ok: false; reason: OriginRejection } {
  if (originHeader === undefined || originHeader === "") return { ok: false, reason: "origin_missing" };
  const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof raw !== "string" || raw === "") return { ok: false, reason: "origin_missing" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "origin_invalid" };
  }

  // `Origin: null`（沙箱 iframe / data: URL / 部分重定向）解析出
  // `protocol === "null:"`，主机名为空 —— 它必然不是回环来源。
  if (!(LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname)) {
    return { ok: false, reason: "origin_not_loopback" };
  }

  // 逐项比对：协议、主机名、端口。任一项不同即不同源。
  const trusted = new URL(trustedLocalOrigin());
  if (url.protocol !== trusted.protocol || url.hostname !== trusted.hostname || url.port !== trusted.port) {
    /*
     * 同协议、同端口，只有主机名不同，且该主机名也是回环 ⇒ 这是
     * "回环别名"而不是跨源写。仍拒绝，但理由更贴切（见上方说明）。
     */
    const sameProtocol = url.protocol === trusted.protocol;
    const samePort = url.port === trusted.port;
    if (sameProtocol && samePort) {
      return { ok: false, reason: "origin_loopback_alias" };
    }
    return { ok: false, reason: "origin_not_same_origin" };
  }
  return { ok: true };
}

/**
 * Origin 是否至少是回环（宽松判据，仅用于诊断与测试对照）。
 *
 * 它**不是**放行判据 —— 放行必须走 `classifyOrigin` 的精确同一来源。
 * 存在的理由是让测试能证明"精确判据比宽松判据多挡住了什么"。
 */
export function isAcceptableLoopbackOrigin(originHeader: string | undefined): boolean {
  if (originHeader === undefined || originHeader === "") return false;
  const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof raw !== "string" || raw === "") return false;
  try {
    const url = new URL(raw);
    return (LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname);
  } catch {
    return false;
  }
}

/** 守卫结果：可读原因（用于 403 响应体与测试断言）。 */
export type LocalGuard =
  | { ok: true }
  | { ok: false; reason: "host_not_trusted" | OriginRejection };

/**
 * 一次完整的请求守卫判定（**唯一入口**）。
 *
 * 顺序有意义：先 Host 后 Origin。Host 不过说明请求根本没打到本服务上，
 * 此时谈 Origin 没有意义。
 */
export function guardLocalRequest(headers: {
  host?: string | undefined;
  origin?: string | undefined;
}): LocalGuard {
  if (!isTrustedHostHeader(headers.host)) return { ok: false, reason: "host_not_trusted" };
  const origin = classifyOrigin(headers.origin);
  return origin.ok ? { ok: true } : { ok: false, reason: origin.reason };
}

/** 旧名的兼容转发（避免调用方一次性全改；判据已是精确同一来源）。 */
export const guardLoopbackRequest = guardLocalRequest;

/**
 * 失败原因 → 面向调用方的可读说明（不含任何内部细节）。
 *
 * ── `origin_loopback_alias` 这一支的原则 ──
 *
 * 它**仍然拒绝**，但它给出的必须是一条**可执行**的指引：告诉使用者
 * 换成哪个地址即可恢复。原因见 `classifyOrigin` 的说明 —— 这一支
 * 对应的情境是"本机用户自己打开了另一个回环主机名"，不是攻击。
 *
 * 说明里刻意只写**规范地址**（`trustedLocalOrigin()`），不写
 * "localhost 与 127.0.0.1 都行"之类的宽松措辞：那会让人以为两个
 * 来源等价，反过来诱导下一次同样的失败。
 */
export function explainLocalRejection(
  reason: "host_not_trusted" | OriginRejection,
): string {
  switch (reason) {
    case "host_not_trusted":
      return "只接受来自本应用监听的本地地址的请求。";
    case "origin_missing":
      return "这个操作必须由本应用的页面发起（缺少来源信息，已拒绝）。";
    case "origin_invalid":
      return "这个操作只能由本应用的页面发起（来源信息无法识别，已拒绝）。";
    case "origin_not_loopback":
      return "这个操作只能由本应用的页面发起（来源不是本机，已拒绝）。";
    case "origin_loopback_alias":
      return `这个操作只能从本应用的规范地址发起。请改用 ${trustedLocalOrigin()} 打开本应用后重试（本机回环的其它主机名不算同一个来源，已拒绝）。`;
    case "origin_not_same_origin":
      return "这个操作只能由本应用的页面发起（来源不是同一个本地服务，已拒绝）。";
  }
}

/** 旧名的兼容转发。 */
export const explainLoopbackRejection = explainLocalRejection;
