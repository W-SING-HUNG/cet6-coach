import { join } from "node:path";
import {
  E2E_PORT,
  E2E_BASE_URL,
  E2E_DB_PATH,
  E2E_EMPTY_PORT,
  E2E_EMPTY_BASE_URL,
  E2E_EMPTY_DB_PATH,
  E2E_REAL_PORT,
  E2E_REAL_BASE_URL,
  E2E_REAL_DB_PATH,
  E2E_REVIEW_PORT,
  E2E_REVIEW_BASE_URL,
  E2E_REVIEW_DB_PATH,
  E2E_LEGACY_PORT,
  E2E_LEGACY_BASE_URL,
  E2E_LEGACY_DB_PATH,
  E2E_LEGACY_RESERVED_PORT,
  E2E_LEGACY_RESERVED_BASE_URL,
  E2E_LEGACY_RESERVED_DB_PATH,
  E2E_ANNOTATION_PORT,
  E2E_ANNOTATION_BASE_URL,
  E2E_FRESHNESS_PORT,
  E2E_FRESHNESS_BASE_URL,
  E2E_FRESHNESS_DB_PATH,
  E2E_DUPLICATE_PORT,
  E2E_DUPLICATE_BASE_URL,
  E2E_DUPLICATE_DB_PATH,
  E2E_COMPANION_PORT,
  E2E_COMPANION_BASE_URL,
  E2E_COMPANION_DB_PATH,
  E2E_A1_PORT,
  E2E_A1_BASE_URL,
  E2E_A2_PORT,
  E2E_A2_BASE_URL,
  E2E_A3_PORT,
  E2E_A3_BASE_URL,
  E2E_A3_DB_PATH,
  E2E_A3_CONTENT_ROOT,
  E2E_A3_COMPANION_PORT,
  E2E_A3_COMPANION_BASE_URL,
} from "./config";

/**
 * Playwright `webServer` 定义的**唯一来源**，按内容来源分成两组。
 *
 * ── 这个模块存在的全部理由：让"默认配置不可能读到私有内容"成为结构事实 ──
 *
 * Playwright 的 `webServer` **启动与否取决于配置，不取决于选了哪个测试文件**。
 * 因此"只跑一个合成 spec"（例如 `npx playwright test e2e/freshness.spec.ts`）
 * **不会**阻止其它已配置的 webServer 一起启动。
 *
 * 这曾经造成一个真实的隐私缺陷：默认配置里挂着会读取 `private-content/`
 * 的真实内容启动器，于是模型操作的一次普通定向测试也把它带起来了 ——
 * 私有内容被导入了本地测试库。用户没有任何方式从命令行表达"别启动那个"。
 *
 * 修法不是"记得别跑那个 spec"，而是**结构上把它移出默认配置**：
 *
 * | 分组 | 内容根 | 出现在哪个配置 |
 * | --- | --- | --- |
 * | `SYNTHETIC_WEB_SERVERS` | 合成夹具目录（`.e2e/*`） | **默认** `playwright.config.ts` |
 * | `REAL_CONTENT_WEB_SERVER` | `private-content/` | 仅 `playwright.real.config.ts`（人显式 opt-in） |
 *
 * 因此默认工作流**失败关闭**：即使有人误改了 spec 选择，
 * 默认配置里也**没有**任何能读到私有内容的进程可以启动。
 *
 * 由 `tests/e2e-privacy-config.test.ts` 在配置对象层守护（不是断言源码文本）。
 */

/**
 * 会读取 `private-content/` 的启动器脚本名。
 *
 * 单独抽出来是为了让"这条命令是否碰私有内容"成为一个可被测试调用的判据，
 * 而不是散落在注释里。新增真实内容启动器时必须同时登记在这里 ——
 * 否则隐私门禁检测不到它（门禁同时按内容根路径做第二重判定）。
 */
export const REAL_CONTENT_LAUNCHER = "scripts/e2e-server-real.ts";

/** 私有内容根目录名。任何把内容根指向它的启动器都属于真实内容组。 */
export const PRIVATE_CONTENT_ROOT_NAME = "private-content";

/**
 * 默认（合成）配置使用的全部 webServer。
 *
 * **每一个都必须把内容根指向合成目录**，且**没有一个**引用私有内容。
 * 这就是"默认模型操作的浏览器测试只用合成根"这条规则的载体。
 */
export const SYNTHETIC_WEB_SERVERS = [
  {
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server.ts`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_DB_PATH,
      PORT: String(E2E_PORT),
      // 每次运行从干净状态开始，保证"首次进入"断言真实成立
      E2E_RESET_DB: "1",
    },
  },
  {
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-empty.ts`,
    url: E2E_EMPTY_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_EMPTY_DB_PATH,
      PORT: String(E2E_EMPTY_PORT),
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * 视觉评审实例：**长文本合成夹具**，用于产出可安全提交的评审截图。
     * 主实例的篇章只有一句话（拍不出布局结论），而真实实例的截图含真题正文。
     * 它自带 onboarding + 诊断构造，因此 /today 等页面不会重定向。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-review.ts`,
    url: E2E_REVIEW_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_REVIEW_DB_PATH,
      PORT: String(E2E_REVIEW_PORT),
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * 使用者 历史状态实例 · eligible（3230）。
     *
     * 验收对象是"库里有一条引用合成篇章的**历史** pending 阅读任务"这一状态，
     * 而主实例由 planner 生成任务、产出的全是 `reading_target` ——
     * 它上面根本没有这个对象。本实例在启动时把那一行历史数据写死，
     * 因此与其它 spec 之间零共享状态。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-legacy.ts`,
    url: E2E_LEGACY_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_LEGACY_DB_PATH,
      PORT: String(E2E_LEGACY_PORT),
      LEGACY_MODE: "eligible",
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * 使用者 历史状态实例 · reserved_only（3231）：同一形态的历史任务，
     * 但库里的卷子全部设为模考保留 —— 用于验证"没有可训练材料时给出
     * 具体原因（模考保留），且绝不消耗保留材料"。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-legacy.ts`,
    url: E2E_LEGACY_RESERVED_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_LEGACY_RESERVED_DB_PATH,
      PORT: String(E2E_LEGACY_RESERVED_PORT),
      LEGACY_MODE: "reserved_only",
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * 本地标注页面实例（3240）。被验收的对象是 `GET /` 真实响应字节里那段
     * 内联脚本，因此必须有一个真实的回环服务在监听。
     * 可标注正文是写死的合成字符串，带显眼的「合成夹具」标识；
     * 计划写到 `.e2e/`，不碰 private-content/，也不打开数据库。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-annotation.ts`,
    url: E2E_ANNOTATION_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      PORT: String(E2E_ANNOTATION_PORT),
    },
  },
  {
    /*
     * 模考新鲜度实例（3250）。需要已核验的 canonical 链接、早于链接的同版本
     * 课程曝光、以及一条因课程升版而失效的链接 —— 三样都不能在主实例上临时造。
     * 全部内容为合成夹具（试卷 sourceKind 恒为 test_fixture，
     * 课程 provider 恒为 test_fixture_provider）。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-freshness.ts`,
    url: E2E_FRESHNESS_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_FRESHNESS_DB_PATH,
      PORT: String(E2E_FRESHNESS_PORT),
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * 重复逾期别名实例（3260）。
     *
     * 症状本身是用户可见的：多条指向同一份真实材料的逾期历史条目会让
     * 系统把当天预算算成不够用，于是 Today 显示一个被压空（或几乎压空）的计划。
     * 复现它需要"同一目标有多条别名"这一精确状态，而主实例（planner 只产
     * `reading_target`）与 legacy 实例（只写一条别名）都不具备。
     *
     * 全部内容为合成夹具，独立库 / 内容根 / 端口，零共享。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-duplicate.ts`,
    url: E2E_DUPLICATE_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_DUPLICATE_DB_PATH,
      PORT: String(E2E_DUPLICATE_PORT),
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * 课程伴随界面实例（3265）。
     *
     * 验收对象是 Course Companion 的完整链路：课程列表 → 显式揭示某一段 →
     * 正文经 POST 下发，以及它的安全负向（跨站 / 缺失 Origin 必须 403，
     * 且响应里没有任何正文）。
     *
     * 复现它需要"已导入的合成课程包 + 一段已揭示过的材料 + 一份已漂移的包"
     * 这一精确状态，而主实例的库里根本没有课程包（它只导试卷）。
     *
     * 全部内容为合成夹具，独立库 / 内容根 / 端口，零共享。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-companion.ts`,
    url: E2E_COMPANION_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_COMPANION_DB_PATH,
      PORT: String(E2E_COMPANION_PORT),
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * A1 只读检查工作台实例（3270）。
     *
     * 验收对象是**真实浏览器**里的完整 A1 流程：目录树 → 勾选范围 →
     * 「检查所选材料」→ 四步结果，以及键盘可达性、状态播报、窄视口、
     * 加载 / 错误 / 禁用态。
     *
     * 它需要一份**真实的合成源目录**（含四类形态、嵌套目录、PDF+DOCX
     * 同材料），而主实例只有试卷。因此给它独立源根 / 真题库 / 端口，
     * 零共享状态。全部内容为合成夹具。
     *
     * 选取窗口本身**不弹**（自动化里无人可关模态窗口）：源根是预置的。
     * 那三条失败路径由单元测试与 `pnpm course:a1-proof` 在进程层覆盖。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-a1.ts`,
    url: E2E_A1_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      PORT: String(E2E_A1_PORT),
    },
  },
  {
    /*
     * A2 人工审核与保存工作台实例（3280）。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-a2.ts`,
    url: E2E_A2_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      PORT: String(E2E_A2_PORT),
    },
  },
  {
    /*
     * A3 受控课程接入工作台实例（3285）。
     *
     * 验收对象是**真实浏览器**里的完整 A3 用户路径：
     * 生成候选 → 人工裁决 → 保存 → 只读预演 → 晋升 → 导入 → 建链，
     * 以及三个写动作确实需要三次独立授权、并发写入保护、中断后状态恢复。
     *
     * 它需要一份**真实的合成源目录 + 合成 canonical 真题库**，而主实例
     * 只有试卷。因此给它独立内容根 / 数据库 / 端口，零共享状态。
     * 全部内容为合成夹具；源根是**预置**的（自动化里不弹原生窗口）。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-a3.ts`,
    url: E2E_A3_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_A3_DB_PATH,
      CET6_CONTENT_ROOT: E2E_A3_CONTENT_ROOT,
      PORT: String(E2E_A3_PORT),
      E2E_RESET_DB: "1",
    },
  },
  {
    /*
     * **课程伴随界面**实例（3286，Next.js 应用）。
     *
     * ── 为什么 A3 需要它 ──
     *
     * 任务书要求"真实使用路径必须到达 /practice/courses，并能打开新课程的
     * Course Companion"，且"不能只验证数据库里有一条记录"。
     *
     * A3 工作台是一个回环 Node 服务，它不是产品界面。因此必须有一个真实的
     * Next.js 实例读**同一份**数据库与内容根 —— 于是"工作台写下的东西，
     * 产品界面真的看得到"是一条跨进程被检验的性质。
     *
     * 它由**独立的启动器** `scripts/e2e-server-a3-companion.ts` 提供
     * （而不是这里写一行 `next start`）：那样才会走 `spawnNext`
     * （统一遥测设置与回环绑定），也才会被隐私门禁的启动器清单覆盖。
     *
     * 此时库里还没有课程（课程由 A3 工作台在 spec 中写入）。
     * 这恰好是真实顺序：先有产品，再有接入。
     */
    command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-a3-companion.ts`,
    url: E2E_A3_COMPANION_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      CET6_DB_PATH: E2E_A3_DB_PATH,
      CET6_CONTENT_ROOT: E2E_A3_CONTENT_ROOT,
      PORT: String(E2E_A3_COMPANION_PORT),
    },
  },
] as const;

/**
 * **真实内容**启动器（会读 `private-content/`）。
 *
 * 它**只**被 `playwright.real.config.ts` 引用。默认配置引用它是缺陷，
 * 由 `tests/e2e-privacy-config.test.ts` 判定为失败。
 */
export const REAL_CONTENT_WEB_SERVER = {
  command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs ${REAL_CONTENT_LAUNCHER}`,
  url: E2E_REAL_BASE_URL,
  reuseExistingServer: false,
  timeout: 180_000,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
  env: {
    CET6_DB_PATH: E2E_REAL_DB_PATH,
    // 真实内容根：刻意**不**用 .e2e/content（那里只有夹具包）
    CET6_CONTENT_ROOT: join(process.cwd(), PRIVATE_CONTENT_ROOT_NAME),
    PORT: String(E2E_REAL_PORT),
    E2E_RESET_DB: "1",
  },
} as const;

/** 一条 webServer 定义的形状（只取本模块需要检查的部分）。 */
export interface WebServerLike {
  command?: string;
  env?: Record<string, string>;
}

/**
 * 从 webServer 命令里抽出**启动器脚本路径**。
 *
 * ── 为什么需要它 ──
 *
 * 隐私门禁的第三条判据是"每个默认注册的合成实例都被逐一证明过内容根安全"。
 * 要做到这一点，就必须能从一个 webServer 定义回到"它跑的是哪个脚本"，
 * 否则门禁只能维护一份**写死的脚本清单** —— 而写死的清单在新增启动器时
 * 必然漏掉它，那正是"未登记的新默认启动器逃过检查"。
 *
 * 命令形态是 `node --experimental-transform-types --import ./scripts/alias-loader.mjs <script>`
 * 因此取最后一个以 `scripts/` 开头、且不是 alias-loader 的 token。
 * 解析不出来时返回 null —— 门禁据此判失败（保守方向）。
 */
export function launcherScriptOf(server: WebServerLike): string | null {
  const command = server.command ?? "";
  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  const scripts = tokens.filter(
    (token) => token.includes("scripts/") && !token.endsWith("alias-loader.mjs"),
  );
  if (scripts.length !== 1) return null;
  // 统一成仓库相对路径（去掉可能的 ./ 前缀与反斜杠）
  return scripts[0].replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 判定一组 webServer 定义里**哪些会读到私有内容**（**唯一判据**）。
 *
 * 返回"命中"的可读描述列表；空数组表示这组配置安全。
 *
 * ── 为什么用两个信号而不是一个 ──
 *
 * 只看命令名会让"新写一个别的启动器去读私有内容"漏网；
 * 只看内容根会让"启动器改了名字但根没变"看起来安全。
 * 两个都查，任一命中即判定为真实内容启动器 —— 保守方向。
 *
 * 这个函数是隐私门禁的**因果核心**：门禁对它做红/绿两次调用即可证明
 * "把真实启动器放回默认配置会让门禁失败"，而**不需要真的启动它**。
 */
export function findPrivateContentServers(servers: readonly WebServerLike[]): string[] {
  const hits: string[] = [];
  for (const [index, server] of servers.entries()) {
    const command = server.command ?? "";
    const contentRoot = server.env?.CET6_CONTENT_ROOT ?? "";

    const byCommand = command.includes(REAL_CONTENT_LAUNCHER);
    // 路径分隔符在 Windows 上可能是 `\`，因此统一后再比较。
    const normalizedRoot = contentRoot.replace(/\\/g, "/");
    const byContentRoot = normalizedRoot.split("/").includes(PRIVATE_CONTENT_ROOT_NAME);

    if (byCommand || byContentRoot) {
      const reasons = [byCommand ? `命令引用 ${REAL_CONTENT_LAUNCHER}` : null, byContentRoot ? `内容根指向 ${PRIVATE_CONTENT_ROOT_NAME}/` : null]
        .filter((item): item is string => item !== null)
        .join("、");
      hits.push(`webServer[${index}]：${reasons}`);
    }
  }
  return hits;
}
