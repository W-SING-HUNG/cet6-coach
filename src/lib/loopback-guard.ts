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
 * 协议 → 默认端口（WHATWG URL 规范里"可省略"的那些端口）。
 *
 * ── 为什么需要这张表 ──
 *
 * `URL#port` 会把默认端口**规范化为空串**：`new URL("http://h:80").port === ""`。
 * 因此可信来源侧拿到的是 `""`，而请求侧 `Host: h:80` 解析出的是 `"80"`。
 * 直接比字符串就会把同一个来源判成不同来源 —— 独立审查在真实 80 实例上
 * 实测到合法请求被拒（403）。
 *
 * 反方向同样危险：`Host: h`（无端口）在 http 下等价于 80。若不做等效
 * 规范化，就会把"省略默认端口"当成"任意端口"而放行非默认端口的请求。
 *
 * 因此两侧都必须归一到**生效端口**再比较，而默认端口的依据是
 * **可信来源的协议**（来自配置），不是请求头。
 */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
};

/**
 * 可信来源的**权威 authority**（主机名 + **生效**端口），用于 Host 头精确比对。
 *
 * ── 关键：`port` 是"生效端口"，不是 `URL#port` ──
 *
 * 上一版直接返回 `url.port`，于是 http 默认端口得到 `""`。请求侧显式写
 * `:80` 时得到 `"80"`，两者不等 ⇒ **合法请求被拒**。
 *
 * 现在：配置显式给了端口就用它；没给就按协议取默认端口（80 / 443）。
 * 这样 `""`（省略）与 `"80"`（显式）都归到同一个 `"80"`。
 *
 * 方向仍然不变：归一化的**基准来自配置**（`configuredLocalOrigin()`），
 * 请求头只被拿来比较，永远不参与定义可信来源。
 */
function trustedAuthority(): { hostname: string; port: string; protocol: string } {
  const url = new URL(configuredLocalOrigin());
  return {
    // IPv6 字面量在 `URL#hostname` 里带方括号，与 Host 头形态一致。
    hostname: url.hostname,
    // 显式端口优先；否则取该协议的默认端口（`URL` 已把默认端口归一化为空串）。
    port: url.port !== "" ? url.port : (DEFAULT_PORTS[url.protocol] ?? ""),
    protocol: url.protocol,
  };
}


/**
 * 把 `Host` 头解析成 `{ hostname, port }`，解析失败返回 `null`。
 *
 * ── `port` 是**原样**的端口串，不是生效端口 ──
 *
 * 本函数只做**语法解析**：`""` 表示"Host 里没有端口"，`"80"` 表示显式写了 80。
 * 两者的等效关系由 `isTrustedHostHeader` 结合**可信协议**去判 —— 因为
 * "省略端口等于 80"这条规则的依据是协议，而协议来自配置，不来自 Host。
 *
 * ── 逐类畸形输入的处理 ──
 *
 * | 形态 | 结果 |
 * | --- | --- |
 * | `127.0.0.1:3100` | `{ hostname: "127.0.0.1", port: "3100" }` |
 * | `127.0.0.1` | `{ hostname: "127.0.0.1", port: "" }`（无端口） |
 * | `[::1]:3100` | `{ hostname: "[::1]", port: "3100" }`（IPv6 保方括号） |
 * | `[::1]` | `{ hostname: "[::1]", port: "" }` |
 * | `evil.example` | hostname 不匹配，由调用方拒绝 |
 * | `a:b:3100` | `null`（裸 IPv6 缺方括号 ⇒ 畸形） |
 * | `127.0.0.1:abc` | `null`（端口非数字 ⇒ 畸形） |
 * | `127.0.0.1:` | `null`（**尾随冒号无端口数字** ⇒ 畸形） |
 * | `127.0.0.1:99999` | `null`（端口越界 ⇒ 畸形） |
 * | `""` / `undefined` | `null` |
 */
export function parseHostHeader(
  hostHeader: string | undefined,
): { hostname: string; port: string } | null {
  if (hostHeader === undefined || hostHeader === "") return null;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== "string") return null;

  // 首尾空白是畸形输入的一部分（HTTP 头不应含），拒绝而不是"顺手 trim"。
  if (raw !== raw.trim() || raw === "") return null;

  // 控制字符直接拒绝。
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  let hostname: string;
  let rest: string;

  if (raw.startsWith("[")) {
    // IPv6 字面量：必须以 `]` 结束主机部分。
    const close = raw.indexOf("]");
    if (close === -1) return null;
    hostname = raw.slice(0, close + 1);
    rest = raw.slice(close + 1);
    // `]` 之后只允许 `""` 或 `":<port>"`。
    if (rest !== "" && !rest.startsWith(":")) return null;
  } else {
    /*
     * 裸冒号多于一个 ⇒ 未加方括号的 IPv6 或走私形态。两种都必须拒绝：
     * 前者是畸形 Host，后者是拆分歧义（不同解析器会得出不同结论）。
     */
    const colons = raw.split(":").length - 1;
    if (colons > 1) return null;
    const idx = raw.indexOf(":");
    hostname = idx === -1 ? raw : raw.slice(0, idx);
    rest = idx === -1 ? "" : raw.slice(idx);
  }

  if (hostname === "") return null;

  /*
   * ── 尾随冒号（`host:`）必须拒绝，不能当成"无端口" ──
   *
   * 上一版把 `"127.0.0.1:"` 解析成 `port: ""`，于是它与"无端口"完全等价，
   * 在默认端口的配置下会被**放行**。那是一条真实的不严格输入：
   * `Host:` 后什么都没有，不同解析器对它的解释并不一致，安全边界只能取
   * "拒绝"这一侧。因此这里要求：有冒号就必须有非空端口串。
   */
  const hasPortSyntax = rest !== "";
  const port = hasPortSyntax ? rest.slice(1) : "";

  if (hasPortSyntax) {
    // 冒号之后必须是非空数字串（否则就是尾随冒号/空端口）。
    if (port === "") return null;
    // 端口必须是纯数字且落在 1–65535。
    if (!/^\d{1,5}$/.test(port)) return null;
    const numeric = Number(port);
    if (numeric < 1 || numeric > 65535) return null;
  }

  return { hostname, port };
}

/**
 * 判定 Host 头是否属于**本应用自己**。
 *
 * ── 它守的那两个实测缺陷 ──
 *
 * **其一（上一轮）**：上一版只比 `hostname`，**完全忽略端口**。独立审查用
 * 真实 Server Action ID 与合成 SQLite 实测：
 *
 *   `Host: 127.0.0.1:9999` + `Origin: http://127.0.0.1:9999`
 *   ⇒ HTTP 200，且数据库被真的改动。
 *
 * 因此"精确到端口"必须由**本项目**判定，不能外包给框架的 Host/Origin 比较。
 *
 * **其二（本轮）**：只比端口字符串又走向另一个极端 —— `trustedAuthority().port`
 * 来自 `URL#port`，而它把默认端口规范化为 `""`；请求侧 `Host: h:80` 却解析出
 * `"80"`。两者不等 ⇒ **合法请求被拒**（独立审查在真实 80 实例上复现）。
 *
 * ── 现在的判据：按**生效端口**比较 ──
 *
 * 两侧都归一化成"实际监听的端口"：
 *
 * - 可信侧：配置显式给了端口就用它，否则取该协议的默认端口（80 / 443）；
 * - 请求侧：显式给了端口就用它，否则取**可信协议的**默认端口。
 *
 * 于是 `h` 与 `h:80` 在 http 配置下都被判为同一来源（正确），
 * 而非默认端口必须显式精确匹配（`h:3100` 不能用一个裸 `h` 蒙混过关）。
 *
 * ── 方向不变 ──
 *
 * "省略端口等于多少"这条规则的依据是**可信协议的默认端口**，来自配置；
 * 请求头只被拿来比较，永远不参与定义可信来源。
 */
export function isTrustedHostHeader(hostHeader: string | undefined): boolean {
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null) return false;
  const trusted = trustedAuthority();
  if (parsed.hostname !== trusted.hostname) return false;

  /*
   * 请求侧省略端口时，按**可信协议的**默认端口补齐，再与可信侧比较。
   * `trusted.port` 已经是生效端口（配置值或协议默认值），因此这里是一次
   * 纯字符串等价判定 —— 两侧的"生效端口"都已确定。
   */
  const requestPort = parsed.port !== "" ? parsed.port : (DEFAULT_PORTS[trusted.protocol] ?? "");
  return requestPort === trusted.port;
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
 * Host 头是否指向**规范访问地址**（可信来源的完整 authority：主机名 + 端口）。
 *
 * ── 它与 `isTrustedHostHeader` 的分工 ──
 *
 * 两者现在是**同一条判据**（都可直接用于放行判定），区别只在语义与调用点：
 *
 * - `isTrustedHostHeader`：守卫入口 `guardLocalRequest` 用它，
 *   名字直白表达"这是不是可信主机"；
 * - `isCanonicalHostHeader`：`proxy.ts` 用它区分"规范地址"与"需要引导的地址"。
 *
 * ── 本轮修正（缺陷 A）──
 *
 * 上一版这里**只比 hostname**，于是 `127.0.0.1:9999` 被当成规范地址。
 * 独立审查实测：规范主机名 + 伪造端口 Host + 匹配该伪端口的 Origin
 * ⇒ HTTP 200 且数据库被改。现在要求主机名与端口**同时**等于可信来源。
 *
 * ── 为什么它仍然不是"放宽" ──
 *
 * `localhost` 与 `127.0.0.1` 在浏览器眼里是**两个来源**。上个版本 README
 * 让人打开 `localhost:3100`，而服务监听并信任 `127.0.0.1:3100`，
 * 于是课程揭示的 POST 被自己的同源守卫挡掉 —— 实测复现为
 * 403「来源不是同一个本地服务」，界面上表现为"看不到正文"，且没有恢复路径。
 *
 * 修法**不是**同时信任两个主机名（那会放松写操作的同源边界），而是：
 *
 * - 读请求：返回一份**不自动跳转**的引导页，页面上的链接指向规范地址，
 *   由使用者点一下（`proxy.ts` 的 `canonicalAddressGuidance`）；
 * - 写请求：在统一边界直接 403，不转发、不执行、无数据库副作用。
 *
 * 判据没有变宽：别名、错误端口在两个方向上都**不被信任**。
 */
export function isCanonicalHostHeader(hostHeader: string | undefined): boolean {
  /*
   * 委托给 `isTrustedHostHeader`：**同一条判据，只有一份实现**。
   * 两处各写一份比较逻辑，迟早会出现"读路径比写路径宽松"的缺口 ——
   * 本轮缺陷 A 正是这一类。
   */
  return isTrustedHostHeader(hostHeader);
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
