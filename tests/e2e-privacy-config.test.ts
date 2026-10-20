import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  E2E_REAL_ONLY_SPECS,
  E2E_REAL_PORT,
  E2E_FRESHNESS_CONTENT_ROOT,
  E2E_CONTENT_ROOT,
  E2E_REVIEW_CONTENT_ROOT,
  E2E_EMPTY_CONTENT_ROOT,
  E2E_LEGACY_CONTENT_ROOT,
  E2E_LEGACY_RESERVED_CONTENT_ROOT,
  E2E_DUPLICATE_CONTENT_ROOT,
  E2E_COMPANION_CONTENT_ROOT,
} from "../e2e/config";
import {
  PRIVATE_CONTENT_ROOT_NAME,
  REAL_CONTENT_LAUNCHER,
  REAL_CONTENT_WEB_SERVER,
  SYNTHETIC_WEB_SERVERS,
  findPrivateContentServers,
  launcherScriptOf,
  type WebServerLike,
} from "../e2e/web-servers";
/*
 * 直接导入**真实的配置对象** —— 本门禁最强的一层判据（见下方说明）。
 *
 * Playwright 的 `defineConfig` 是**恒等函数**，导入配置模块只会得到那个
 * 普通对象；webServer 只有在 `playwright test` 运行时才会被启动。
 * 因此对配置对象求值是安全的，不会拉起任何进程。
 */
import defaultConfig from "../playwright.config";
import realConfig from "../playwright.real.config";
import { auditSharedRmSync, collectRmSyncCalls, isGuardedBy } from "./support/source-structure";

/**
 * E2E **隐私配置门禁** —— 默认 Playwright 工作流不得触碰私有内容。
 *
 * ── 它守的那个实测缺陷 ──
 *
 * 默认 `playwright.config.ts` 里曾经挂着 `scripts/e2e-server-real.ts`
 * （内容根 = `private-content/`）。Playwright 的 webServer **启动与否取决于
 * 配置，不取决于选了哪个测试文件**，因此模型操作的一次定向命令
 * `npx playwright test e2e/freshness.spec.ts` 也把它一并启动 ——
 * 真实试卷包被导入了本地测试库 `.e2e/cet6-real.db`。
 *
 * 用户没有任何命令行方式表达"别启动那个"。因此修法是把它**移出默认配置**。
 *
 * ── 判据分三层，因为单靠源码文本拦不住（实测踩到过两种绕过）──
 *
 * 1. **配置对象层**（最强）：对 `defaultConfig.webServer` 的实际取值判定。
 *    - 把真实启动器混进合成清单：`webServer` 数组里就会出现它；
 *    - 把 `testIgnore` 改成 `[]`：键还在、字符串断言照样过，
 *      但"排除"这件事已经不成立 —— 只有看**取值**才发现得了。
 * 2. **共享清单层**：合成清单本身必须干净。
 * 3. **源码层**：防止有人写回真实启动器或自动探测分支。
 *
 * 三层都由 `tests/e2e-privacy-config.test.ts` 与
 * `scripts/e2e-privacy-mutation.ts` 的红/绿变异证明覆盖。
 */

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

/**
 * 剥掉注释后的源码。
 *
 * 必要的理由：默认配置的**文档注释**里会写明"不要把真实启动器加回来"
 * 以及那个缺陷的名称 —— 那是正确的说明，不是违规。朴素子串检查会把
 * 讲解这条规则本身的文字判成违规（同 paper-pool-policy 的先例）。
 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 把 Playwright 的 `testMatch` / `testIgnore` 条目统一成**可判定的匹配函数**。
 *
 * ── 为什么不能直接 `new RegExp(String(item))` ──
 *
 * 这些条目是 **glob**（`**` + `/` 前缀是 glob 语法），不是正则。
 * 直接当正则构造会抛 `Nothing to repeat`（实测踩到：
 * `/**\/real-paper.local.spec.ts/`）。Playwright 对字符串条目按 glob 处理，
 * 对 `RegExp` 条目才按正则处理 —— 因此必须分开对待。
 *
 * glob 的翻译刻意保持最小：只需支持 `**`（任意层级）与 `*`（段内任意），
 * 这正是本仓库实际用到的两种形态。多写的翻译逻辑只会成为新的出错点。
 */
/**
 * 把 Playwright 的 `testMatch` / `testIgnore` 条目统一成**可判定的匹配函数**。
 *
 * ── 为什么不能直接 `new RegExp(String(item))` ──
 *
 * 这些条目是 **glob**（`**` + `/` 前缀是 glob 语法），不是正则。
 * 直接当正则构造会抛 `Nothing to repeat`（实测踩到：
 * `/**\/real-paper.local.spec.ts/`）。Playwright 对字符串条目按 glob 处理，
 * 对 `RegExp` 条目才按正则处理 —— 因此必须分开对待。
 *
 * glob 的翻译刻意保持最小：只需支持 `**`（任意层级）与 `*`（段内任意），
 * 这正是本仓库实际用到的两种形态。多写的翻译逻辑只会成为新的出错点。
 */
function toMatcher(entry: unknown): (path: string) => boolean {
  if (entry instanceof RegExp) return (path) => entry.test(path);

  const glob = String(entry);
  if (glob === "") return () => false;

  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // 转义正则元字符（先处理，避免影响下面的替换）
    .replace(/\*\*\//g, "(?:.*/)?") // `**/` ⇒ 任意层级（含零层）
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");

  const regex = new RegExp(`^${pattern}$`);
  return (path) => regex.test(path) || regex.test(`e2e/${path}`);
}

/** 判定一组 webServer 是否安全（空数组 = 不碰私有内容）。 */
function assertSyntheticOnly(servers: readonly WebServerLike[], label: string): void {
  const hits = findPrivateContentServers(servers);
  expect(hits, `${label} 不得包含读取私有内容的 webServer：\n${hits.join("\n")}`).toEqual([]);
}

/**
 * **从磁盘枚举**已登记的合成启动器（不是手写清单）。
 *
 * ── 为什么不能手写 ──
 *
 * 手写清单的缺陷是具体的：新增一个默认合成启动器时，那份清单不会自动
 * 多出一项 —— 于是新启动器**逃过**源码检查，而门禁仍然全绿。
 * 这正是任务书要求的"未登记的新默认启动器不能逃过检查"。
 *
 * 从 `scripts/` 实际枚举时，"新增一个 `e2e-server-*.ts`"这件事本身
 * 就会让它进入检查范围。因此这里返回磁盘上的**全部**形态匹配文件，
 * 而实际注册的实例必须全部落在这个集合里（下面两条用例判的正是这个）。
 *
 * ── 唯一的例外是**真实内容**启动器 ──
 *
 * `REAL_CONTENT_LAUNCHER` 刻意**不**在默认配置里（那正是隐私门禁的要点），
 * 因此它不会出现在"实际注册的实例"集合里，反向判据必须放它过去。
 * 排除它用的是同一个常量，不是再写一遍路径字符串。
 */
function readDeclaredLaunchers(): string[] {
  return readdirSync(join(process.cwd(), "scripts"))
    .filter((name) => /^e2e-server.*\.ts$/.test(name))
    .map((name) => `scripts/${name}`)
    .filter((path) => path !== REAL_CONTENT_LAUNCHER)
    .sort();
}

describe("E2E 隐私门禁 · 默认配置对象本身（最强一层判据）", () => {
  /** 把配置对象里的 webServer 规范化成数组。 */
  function servers(config: { webServer?: unknown }): WebServerLike[] {
    const value = config.webServer;
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]) as WebServerLike[];
  }

  it("`playwright.config.ts` 的实际 webServer 取值里没有私有内容启动器", () => {
    /*
     * 这一条判的是**默认配置导出的真实取值**。
     *
     * 与"合成清单干净"是两件事：有人可能不在清单里加，而是直接在
     * `webServer: [...SYNTHETIC_WEB_SERVERS, REAL_CONTENT_WEB_SERVER]` 里拼进去。
     * 那样清单仍然是干净的，但默认配置**实际会启动**那个进程。
     */
    const hits = findPrivateContentServers(servers(defaultConfig));
    expect(
      hits,
      `默认配置会启动读取私有内容的 webServer：\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  it("默认配置的 webServer 非空（否则上一条是空断言）", () => {
    expect(servers(defaultConfig).length).toBeGreaterThan(0);
  });

  it("默认配置的 testIgnore **实际生效**地排除了全部真实专用 spec", () => {
    /*
     * ── 这一条补上一个实测漏掉的缺口 ──
     *
     * 早先只断言"配置里有 testIgnore 这个键"。把它的值改成 `[]` 时，
     * 键还在、字符串断言照样通过 —— 但"排除"已经不成立，
     * 于是真实专用 spec 会回到默认套件里，去连一个默认配置**不会启动**的服务。
     *
     * 因此这里检查**取值**：每个 E2E_REAL_ONLY_SPECS 都必须被某个 pattern 命中。
     */
    const ignore = defaultConfig.testIgnore;
    expect(ignore, "默认配置必须设置 testIgnore").toBeDefined();

    const patterns = (Array.isArray(ignore) ? ignore : [ignore]).map(toMatcher);

    expect(patterns.length, "testIgnore 不得为空 —— 那等于不排除").toBeGreaterThan(0);

    for (const name of E2E_REAL_ONLY_SPECS) {
      expect(
        patterns.some((matches) => matches(name)),
        `默认配置的 testIgnore 未排除真实专用 spec「${name}」—— 它会在默认套件里运行`,
      ).toBe(true);
    }
  });

  it("显式配置只挂真实内容启动器，且 testMatch 覆盖全部真实专用 spec", () => {
    const realServers = servers(realConfig);

    // 它**必须**包含真实内容启动器（否则这个配置没有存在意义）。
    expect(
      findPrivateContentServers(realServers).length,
      "显式配置必须包含真实内容启动器",
    ).toBeGreaterThan(0);

    // 它**只**挂真实实例：让"这条命令碰了私有内容"成为唯一差异，一眼可辨。
    expect(realServers.length, "显式配置应只启动真实实例").toBe(1);

    // testMatch 必须覆盖全部真实专用 spec。
    const match = realConfig.testMatch;
    expect(match, "显式配置必须设置 testMatch").toBeDefined();
    const patterns = (Array.isArray(match) ? match : [match]).map(toMatcher);
    for (const name of E2E_REAL_ONLY_SPECS) {
      expect(
        patterns.some((matches) => matches(name)),
        `显式配置的 testMatch 未覆盖「${name}」`,
      ).toBe(true);
    }
  });

  it("两个配置的匹配集合**互补且不重叠**（同一 spec 不会两边都跑）", () => {
    /*
     * 若某个真实专用 spec 同时落在默认配置的选中集合与显式配置里，
     * 它就会在默认工作流中运行 —— 那正是要避免的。
     *
     * 由于默认配置的 testIgnore 已覆盖全部真实专用 spec（上一条），
     * 而显式配置的 testMatch 正好是它们，因此两者天然互补。
     * 这里再显式断言一次，防止将来有人"顺手"把某个合成 spec 加进
     * E2E_REAL_ONLY_SPECS（那会把它从默认套件里悄悄拿掉）。
     */
    for (const name of E2E_REAL_ONLY_SPECS) {
      // 真实专用 spec 必须在 e2e/ 下真实存在，且**不**是普通合成 spec。
      const source = read(`e2e/${name}`);
      expect(source.length, `${name} 必须存在`).toBeGreaterThan(200);
      /*
       * 它们必须指向真实内容实例 —— 否则把它们排除在默认套件之外就没有理由，
       * 而"清单里混进合成 spec"会静默减少默认覆盖。
       */
      expect(
        source.includes("E2E_REAL_BASE_URL") || source.includes("E2E_REAL_PORT"),
        `${name} 必须使用真实内容实例（否则不应出现在 E2E_REAL_ONLY_SPECS 里）`,
      ).toBe(true);
    }
  });
});

describe("E2E 隐私门禁 · 默认配置只使用合成内容", () => {
  it("默认 webServer 集合中**没有**任何读取 private-content 的启动器", () => {
    assertSyntheticOnly(SYNTHETIC_WEB_SERVERS, "默认（合成）webServer 集合");
  });

  it("默认 webServer 集合非空（否则这条门禁是空断言）", () => {
    // 一个空的 webServer 列表会让上面那条"没有真实启动器"恒真。
    // 因此显式要求它确实挂着合成实例。
    expect(SYNTHETIC_WEB_SERVERS.length).toBeGreaterThan(0);
  });

  it("**因果证明**：把真实启动器混进默认集合，门禁立刻失败", () => {
    /*
     * ── 这是本组测试的核心 ──
     *
     * 只断言"当前默认集合是干净的"是**静态**的：它不能证明门禁真的会拦住
     * 回归。因此这里做一次红/绿对照 —— 把真实启动器加进一个副本，
     * 证明同一个判据会报出来。
     *
     * 关键：全程**只操作内存中的对象**，不启动任何进程、不读任何私有内容、
     * 不碰任何配置文件的磁盘状态。红/绿证明因此是安全的。
     */
    const contaminated = [...SYNTHETIC_WEB_SERVERS, REAL_CONTENT_WEB_SERVER];

    // 绿：原集合通过。
    expect(findPrivateContentServers(SYNTHETIC_WEB_SERVERS)).toEqual([]);

    // 红：混入后必须被抓住，且原因可读。
    const hits = findPrivateContentServers(contaminated);
    expect(hits.length, "混入真实启动器后门禁必须报错").toBeGreaterThan(0);
    expect(hits.join("\n")).toContain(REAL_CONTENT_LAUNCHER);
    expect(hits.join("\n")).toContain(PRIVATE_CONTENT_ROOT_NAME);
  });

  it("判据对**两种**回归形态都有效（只改命令 / 只改内容根）", () => {
    /*
     * 有人可能只把某个合成启动器的命令换成真实启动器（内容根没动），
     * 也可能只把某个合成实例的内容根指向 private-content（命令没动）。
     * 两种都会真的读到私有内容，因此两种都必须被抓住。
     */
    const byCommandOnly: WebServerLike[] = [
      { command: `node scripts/${REAL_CONTENT_LAUNCHER}`, env: { CET6_CONTENT_ROOT: "/tmp/synthetic" } },
    ];
    const byContentRootOnly: WebServerLike[] = [
      { command: "node scripts/e2e-server.ts", env: { CET6_CONTENT_ROOT: join(process.cwd(), "private-content") } },
    ];

    expect(findPrivateContentServers(byCommandOnly).length, "只改命令必须被抓住").toBe(1);
    expect(findPrivateContentServers(byContentRootOnly).length, "只改内容根必须被抓住").toBe(1);

    // 而一个正常的合成条目不得被误报（避免"宁枉勿纵"变成噪声）。
    expect(
      findPrivateContentServers([
        { command: "node scripts/e2e-server.ts", env: { CET6_CONTENT_ROOT: E2E_CONTENT_ROOT } },
      ]),
    ).toEqual([]);
  });

  it("判据本身是**唯一实现**，两个配置文件都消费它", () => {
    // 若默认配置自己内联一份判断，两者会漂移。
    // 局部变量带 `Source` 后缀，避免遮蔽 import 进来的配置对象。
    const defaultSource = readCode("playwright.config.ts");
    expect(defaultSource).toContain("SYNTHETIC_WEB_SERVERS");
    expect(defaultSource, "默认配置的**代码**不应内联真实启动器命令").not.toContain(
      REAL_CONTENT_LAUNCHER,
    );

    const realSource = readCode("playwright.real.config.ts");
    expect(realSource).toContain("REAL_CONTENT_WEB_SERVER");
    // 真实配置必须**只**启动真实实例，让"碰了私有内容"成为唯一差异。
    expect(realSource).toContain("webServer: [REAL_CONTENT_WEB_SERVER]");
  });

  it("真实内容启动器**只**出现在显式 opt-in 配置里", () => {
    // 默认配置（及其引用的合成模块）的**代码**不得引用它。
    for (const file of ["playwright.config.ts", "e2e/config.ts"]) {
      expect(
        readCode(file).includes(REAL_CONTENT_LAUNCHER),
        `${file} 的代码不得引用真实内容启动器（那会把私有内容带进默认工作流）`,
      ).toBe(false);
    }

    // 唯一允许引用它的是这两处：启动器登记 + 显式 opt-in 配置。
    expect(readCode("playwright.real.config.ts")).toContain("REAL_CONTENT_WEB_SERVER");

    const webServers = readCode("e2e/web-servers.ts");
    expect(webServers).toContain("REAL_CONTENT_LAUNCHER");
  });

  it("默认配置把真实专用 spec 排除在外，且与显式配置**消费同一份清单**", () => {
    /*
     * 注意命名：这里**不能**用 `config` / `realConfig` 作为局部变量名 ——
     * 那会遮蔽文件顶部 import 进来的**配置对象**（实测踩到：
     * 局部 `const realConfig = read(...)` 让 `realConfig.testMatch`
     * 读到的是文件文本的某个字符，断言于是报出一个完全误导的数字）。
     * 因此局部变量一律带 `Source` 后缀。
     */
    const defaultSource = read("playwright.config.ts");
    const realSource = read("playwright.real.config.ts");

    // 两者都必须引用同一份清单 —— 各写一份必然漂移。
    for (const [label, source] of [
      ["playwright.config.ts", defaultSource],
      ["playwright.real.config.ts", realSource],
    ] as const) {
      expect(source, `${label} 必须消费 E2E_REAL_ONLY_SPECS`).toContain("E2E_REAL_ONLY_SPECS");
    }

    /*
     * ── 关键：必须断言**取值来自共享清单**，而不只是"配置里出现了这个标识符" ──
     *
     * 把 `testIgnore` 改成写死的列表（只列其中一个文件名）时，
     * 文件里仍然可能出现 `E2E_REAL_ONLY_SPECS`（例如别处引用过），
     * 源码字符串断言照样通过 —— 但"消费同一份清单"已经不成立，
     * 于是新增一个真实 spec 时只会加到一个配置里。
     *
     * 因此这里检查**实际取值**是否与共享清单一一对应。
     */
    const ignorePatterns = (
      Array.isArray(defaultConfig.testIgnore) ? defaultConfig.testIgnore : [defaultConfig.testIgnore]
    ).map(String);
    const matchPatterns = (
      Array.isArray(realConfig.testMatch) ? realConfig.testMatch : [realConfig.testMatch]
    ).map(String);

    /*
     * 每个配置各自的清单长度都必须与共享清单一致 —— 否则说明它是
     * 一份**独立写死**的清单（少列一项就是漏掉一个 spec）。
     */
    expect(ignorePatterns.length, "默认配置 testIgnore 长度须与共享清单一致").toBe(
      E2E_REAL_ONLY_SPECS.length,
    );
    expect(matchPatterns.length, "显式配置 testMatch 长度须与共享清单一致").toBe(
      E2E_REAL_ONLY_SPECS.length,
    );

    // 每一项都必须对应共享清单里的某个文件名（即确实由它导出）。
    for (const patterns of [ignorePatterns, matchPatterns]) {
      for (const name of E2E_REAL_ONLY_SPECS) {
        expect(
          patterns.some((pattern) => pattern.includes(name)),
          `匹配清单缺少「${name}」—— 它没有来自共享清单（可能被写死了）`,
        ).toBe(true);
      }
    }
  });
});

describe("E2E 隐私门禁 · 合成实例的内容根确实隔离", () => {
  it("每个合成实例的内容根都在 .e2e/ 下，且不是 private-content", async () => {
    /*
     * 这一条守的是"默认配置不碰私有内容"的另一半：即使命令都是合成启动器，
     * 只要某个启动器内部把内容根指向 private-content，默认工作流照样会读到
     * 私有内容。因此逐个检查合成根常量。
     *
     * 这些常量就是各启动器实际赋给 `CET6_CONTENT_ROOT` 的值。
     */
    const syntheticRoots = [
      ["E2E_CONTENT_ROOT", E2E_CONTENT_ROOT],
      ["E2E_EMPTY_CONTENT_ROOT", E2E_EMPTY_CONTENT_ROOT],
      ["E2E_REVIEW_CONTENT_ROOT", E2E_REVIEW_CONTENT_ROOT],
      ["E2E_FRESHNESS_CONTENT_ROOT", E2E_FRESHNESS_CONTENT_ROOT],
      ["E2E_LEGACY_CONTENT_ROOT", E2E_LEGACY_CONTENT_ROOT],
      ["E2E_LEGACY_RESERVED_CONTENT_ROOT", E2E_LEGACY_RESERVED_CONTENT_ROOT],
      ["E2E_DUPLICATE_CONTENT_ROOT", E2E_DUPLICATE_CONTENT_ROOT],
      ["E2E_COMPANION_CONTENT_ROOT", E2E_COMPANION_CONTENT_ROOT],
    ] as const;

    for (const [name, root] of syntheticRoots) {
      const normalized = root.replace(/\\/g, "/");
      expect(normalized.split("/").includes(".e2e"), `${name} 必须位于 .e2e/ 下：${root}`).toBe(true);
      expect(
        normalized.split("/").includes(PRIVATE_CONTENT_ROOT_NAME),
        `${name} 不得指向 private-content：${root}`,
      ).toBe(false);
    }

    /*
     * ── 上面那份清单本身必须与**实际启动器消费的常量**对齐 ──
     *
     * 否则会出现一种具体的漏网：新增一个合成实例、也给了它一个
     * `.e2e/` 内容根常量，但没把常量加进上面这个数组 ——
     * 于是那个根从未被隔离判据检查过，而门禁全绿。
     *
     * 判据（必须是**取值**级，不能是名字级）：
     * 从 `e2e/config.ts` 里取出每个被启动器消费的 `E2E_*_CONTENT_ROOT`
     * 常量的**实际路径值**，要求它出现在上面的隔离清单里。
     * "加了一个根常量但忘了登记"因此会立刻失败 —— 它的值不在清单中。
     */
    const declaredRoots = new Set(
      syntheticRoots.map(([, root]) => root.replace(/\\/g, "/")),
    );

    // 从每个启动器源码里找出它消费的内容根常量名。
    const consumedConstants = new Set<string>();
    for (const script of [
      "scripts/e2e-server.ts",
      "scripts/e2e-server-empty.ts",
      "scripts/e2e-server-review.ts",
      "scripts/e2e-server-legacy.ts",
      "scripts/e2e-server-freshness.ts",
      "scripts/e2e-server-duplicate.ts",
      "scripts/e2e-server-companion.ts",
    ]) {
      for (const match of read(script).matchAll(/E2E_[A-Z_]*CONTENT_ROOT/g)) {
        consumedConstants.add(match[0]);
      }
    }
    expect(
      consumedConstants.size,
      "没有从启动器源码里解析出任何内容根常量 —— 这条判据退化为空断言",
    ).toBeGreaterThan(0);

    // 取每个常量的**实际值**（从 e2e/config.ts 的真实导出求值）。
    const config = (await import("../e2e/config")) as unknown as Record<string, string>;
    for (const constant of consumedConstants) {
      const value = config[constant];
      expect(
        typeof value === "string" && value.length > 0,
        `e2e/config.ts 未导出字符串常量 ${constant}`,
      ).toBe(true);
      expect(
        declaredRoots.has(value.replace(/\\/g, "/")),
        `启动器消费的内容根 ${constant}（值：${value}）未在隔离判据清单里登记 —— ` +
          `它逃过了 .e2e/ 检查。请把它加进 syntheticRoots。`,
      ).toBe(true);
    }
  });

  it("每个合成启动器脚本都不把内容根指向私有内容（源码级第二重防线）", () => {
    /*
     * 配置层的检查看不到启动器**内部**的赋值。若某个合成启动器自己把
     * `CET6_CONTENT_ROOT` 改成 private-content，配置层仍然是"干净"的。
     * 因此这里补一层源码级判定。
     *
     * ── 为什么启动器不在 env 里声明内容根 ──
     *
     * 本仓库的合成启动器**刻意不在 webServer 的 env 里**声明
     * `CET6_CONTENT_ROOT`：它们各自 import `e2e/config.ts` 的常量
     * （单一事实来源），在脚本内部赋值。因此"配置对象的 env 干净"
     * **不能**证明"内容根安全"—— 判据必须落在**脚本源码**上。
     *
     * 这也是下面那条实例推导判据存在的理由。
     */
    const scripts = readDeclaredLaunchers();

    for (const script of scripts) {
      const source = read(script);
      /*
       * 只检查**赋值**行，不看注释：这些文件的注释里会说明
       * "不是 private-content/"，那是正确的说明而不是违规。
       */
      const assignments = source
        .split(/\r?\n/)
        .filter((line) => /CET6_CONTENT_ROOT\s*=/.test(line))
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));

      for (const line of assignments) {
        expect(
          line.includes(PRIVATE_CONTENT_ROOT_NAME),
          `${script} 的内容根赋值不得指向私有内容：${line.trim()}`,
        ).toBe(false);
      }
    }
  });

  /*
   * ── 覆盖范围从**实际注册的实例**推导（不写死清单）──
   *
   * 上面那条源码级判据依赖一份手写的脚本清单。它的缺陷是具体的：
   * 有人新增一个默认合成启动器（比如一个新的 E2E 实例）时，
   * 那份清单不会自动多出一项 —— 于是新启动器**逃过**了源码检查，
   * 而门禁仍然全绿。这正是任务书里"未登记的新默认启动器不能逃过检查"。
   *
   * 实测：本轮加上这条判据后，它**立刻**抓到一个既有的真实漏网 ——
   * `scripts/e2e-server-duplicate.ts`（重复逾期别名实例）此前从未被
   * 上面那份清单覆盖。若不从实例推导，这个缺口会一直存在。
   *
   * 因此这里反过来做：从 `SYNTHETIC_WEB_SERVERS` 的**实际取值**抽出
   * 每个实例的启动器脚本，要求它们**全部**出现在上面那份源码清单里。
   * 新增启动器而忘了登记 ⇒ 这里立刻失败。
   */
  it("源码级检查的清单覆盖**全部**实际注册的合成启动器（未登记的新启动器会失败）", () => {
    const registeredScripts = SYNTHETIC_WEB_SERVERS.map((server) => ({
      server,
      script: launcherScriptOf(server),
    }));

    for (const { server, script } of registeredScripts) {
      expect(
        script,
        `无法从 webServer 命令解析出启动器脚本：${server.command ?? "(空)"}` +
          `—— 隐私门禁因此无法为它做源码级检查`,
      ).not.toBeNull();
    }

    const declaredInSource = readDeclaredLaunchers();

    for (const { script } of registeredScripts) {
      expect(
        script !== null && declaredInSource.includes(script),
        `默认注册的启动器 ${script} 未出现在源码级检查清单里 —— ` +
          `它逃过了「启动器内部不得把内容根指向私有内容」这条判据。` +
          `请把它加进 tests/e2e-privacy-config.test.ts 的清单。`,
      ).toBe(true);
    }

    // 反向：清单里不应有已不存在的启动器（否则检查在对着空气断言）。
    const registered = new Set(registeredScripts.map((item) => item.script));
    for (const script of declaredInSource) {
      expect(
        registered.has(script),
        `源码检查清单里的 ${script} 已不在默认配置中 —— ` +
          `请从清单里删掉它，否则这份清单会与真实配置漂移`,
      ).toBe(true);
    }
  });

  it("**独占性**：并发启动的合成实例不得删除彼此正在读取的目录", () => {
    /*
     * ── 这条守的是一个真实竞态 ──
     *
     * Playwright 官方文档允许 `webServer` **同时启动**多个实例（它并不承诺
     * 串行）。若两个实例共享同一个内容根，而其中一个在启动时 `rmSync` 掉它，
     * 另一个就可能读到"目录刚被删掉"的状态 —— 表现为某一批用例时而失败
     * 时而通过，且失败位置与真实原因无关。
     *
     * 本轮的实例：`e2e-server-a3.ts`（3285）与 `e2e-server-a3-companion.ts`（3286）
     * 共享 `.e2e/a3-content` 与 `.e2e/cet6-a3.db`（这是**刻意**的：要证明
     * "工作台写下的东西产品界面读得到"）。因此 3285 **不得**在启动时
     * 无条件删除那个共享内容根。
     *
     * ── 判据为什么必须按**语法结构**看，而不是按文本行看 ──
     *
     * "文件里出现过 E2E_RESET_DB"是**无效判据**：那样一行在 if 内的删除
     * 和一行在 if 外的删除会同时被判为合法。
     *
     * 早先的实现试图用文本扫描补救（切行 → 累加偏移 → 正则向前回溯最近条件块），
     * 但那条实现有三个**可复现**的缺陷：
     *
     * 1. `length + 1` 假定换行是单字符。本仓库在 Windows 上检出为 CRLF，
     *    每行漂移一个字符；实测第 87 行已漂移 86 个字符，于是回溯起点
     *    落到上一条语句上 —— **受保护的真删除被判成"不在条件内"**（误报）。
     * 2. `/if\s*\(([\s\S]*)\)\s*$/` 的贪婪匹配会跨过相邻 `if`，把无关条件
     *    吞进来 —— **真正未受保护的删除可能被错误放行**（漏报）。
     * 3. 只认"最近的 `{`"，无法区分 `if` / `else` / 函数体 / `try`，也无法
     *    处理没有花括号的单语句 `if (x) rmSync(...)`。
     *
     * 因此现在改用 TypeScript Compiler API 的 AST（仓库已有依赖，零新增包）：
     * 直接问语法树"这条 `rmSync` 被哪些 `if` 语句包住"。它天然免疫换行风格、
     * 字符串里的括号、注释与贪婪匹配。
     *
     * 判据的红/绿证明见下方「结构判据自身的因果证明」一组用例。
     */
    /*
     * 共享路径的**两种引用形态**都要覆盖：
     * - 常量名（`E2E_A3_CONTENT_ROOT` / `E2E_A3_DB_PATH`）—— 启动器里的实际写法；
     * - 目录名片段（`a3-content` / `cet6-a3.db`）—— 直写字面量时的写法。
     *
     * 早先只匹配后者，于是用常量名写的 `rmSync(E2E_A3_CONTENT_ROOT, ...)`
     * 完全逃过判据 —— 那正是"判据的作用域小于它声称的范围"。
     *
     * 注意 `cet6-a3.db` 在启动器里是**经模板字符串**再传进来的：
     *     const file = `${E2E_A3_DB_PATH}${suffix}`;
     *     rmSync(file, { force: true });
     * 因此辅助模块做了一层常量展开，否则这条最关键的数据库删除会漏判。
     */
    const sharedMarkers = ["a3-content", "cet6-a3.db", "E2E_A3_CONTENT_ROOT", "E2E_A3_DB_PATH"];
    const launchers = readDeclaredLaunchers();

    let auditedSharedCalls = 0;

    for (const script of launchers) {
      const source = readFileSync(join(process.cwd(), script), "utf8");
      const audit = auditSharedRmSync(source, sharedMarkers, "E2E_RESET_DB", script);
      auditedSharedCalls += audit.calls.length;

      for (const violation of audit.violations) {
        const enclosing =
          violation.enclosingIfConditions.length === 0
            ? "无（顶层，完全不受保护）"
            : violation.enclosingIfConditions.map((item) => item.trim()).join(" ⇒ ");
        expect.fail(
          `${script}:${violation.line} 对共享路径（${violation.firstArgument.trim()}）的 rmSync ` +
            `不在 E2E_RESET_DB 条件内（实际 enclosing 条件：${enclosing}）。` +
            `并发启动时会删掉另一个实例正在读的目录 —— 这是真实竞态，不是风格问题。`,
        );
      }
    }

    /*
     * ── 非空断言：防止判据退化成"什么都没检查" ──
     *
     * 若标记或 AST 解析失效，`auditedSharedCalls` 会是 0，上面的循环一条
     * 违规都找不到，于是门禁**静默全绿**。那比误报更危险。因此要求至少
     * 命中一条真实的共享路径删除。
     */
    expect(
      auditedSharedCalls,
      "没有从任何启动器里识别出「共享路径删除」—— 判据退化为空断言，" +
        "请检查 sharedMarkers 与源文件形态是否仍然匹配",
    ).toBeGreaterThan(0);
  });

  it("每个注册的合成启动器都能被解析出脚本，且脚本真实存在", () => {
    /*
     * 这一条守护 `launcherScriptOf` 本身：它返回 null 时上面的判据会失败，
     * 但失败信息是"无法解析"。这里补一条直接的因果证明 ——
     * 判据必须能从"实际注册的实例"走到"磁盘上的脚本文件"。
     */
    for (const server of SYNTHETIC_WEB_SERVERS) {
      const script = launcherScriptOf(server);
      expect(script, `无法解析启动器：${server.command}`).not.toBeNull();
      expect(existsSync(script!), `${script} 不存在 —— 默认配置引用了一个不存在的启动器`).toBe(true);
      // 它绝不允许是真实内容启动器。
      expect(script).not.toBe(REAL_CONTENT_LAUNCHER);
    }
  });

  it("**因果证明**：未登记的新启动器会被实例推导判据抓住（不启动任何进程）", () => {
    /*
     * 与其它门禁同一条纪律：只断言"当前清单对齐"是静态的。
     * 这里做一次红/绿对照 —— 造一个"新增了启动器但没登记"的副本，
     * 证明同一个判据会报出来。全程只操作内存对象。
     *
     * 判据刻意从**当前注册的实例**反推"已登记"集合，而不是在这里
     * 手写第二份清单 —— 手写清单会与实际配置漂移，于是这条因果证明
     * 会变成"对着一个过期的期望值断言"。
     */
    const unregisteredLauncher = "scripts/e2e-server-brand-new.ts";
    const contaminated: WebServerLike[] = [
      ...SYNTHETIC_WEB_SERVERS,
      { command: `node --experimental-transform-types --import ./scripts/alias-loader.mjs ${unregisteredLauncher}` },
    ];

    const registered = contaminated.map((server) => launcherScriptOf(server));
    expect(registered).toContain(unregisteredLauncher);

    const declared = readDeclaredLaunchers();
    const missing = registered.filter(
      (script) => script !== null && !declared.includes(script),
    );
    expect(missing, "未登记的启动器必须被识别出来").toContain(unregisteredLauncher);

    // 绿：当前实际配置下没有漏网。
    const actualMissing = SYNTHETIC_WEB_SERVERS.map((server) => launcherScriptOf(server)).filter(
      (script) => script !== null && !declared.includes(script),
    );
    expect(actualMissing, "当前默认配置存在未登记的启动器").toEqual([]);
  });

  it("唯一会读私有内容的启动器**不在**默认合成启动器清单里", () => {
    const commands = SYNTHETIC_WEB_SERVERS.map((server) => server.command).join("\n");
    expect(commands).not.toContain(REAL_CONTENT_LAUNCHER);
    // 而它确实是独立存在的一个启动器脚本（没有被删除）。
    expect(read(REAL_CONTENT_LAUNCHER).length).toBeGreaterThan(0);
  });
});

/**
 * 「共享路径删除必须受开关保护」这条判据的**因果证明**。
 *
 * ── 为什么必须有这一组 ──
 *
 * 只断言"当前源码通过"是静态的：它无法区分"判据真的能发现问题"与
 * "判据永远返回 true"。上面那条 `auditedSharedCalls > 0` 只证明"看到了东西"，
 * 不证明"看得对"。
 *
 * 因此这里用**内存里构造的合成源码**做红/绿对照，不写任何文件、不启动
 * 任何进程。每个用例都同时验证：
 * - 安全形态 ⇒ 0 违规（绿）；
 * - 故意不安全的形态 ⇒ 恰好命中那条违规（红）。
 *
 * 覆盖全部已知的失衡形态：CRLF、相邻 if、嵌套 if、else 分支、
 * 单语句无花括号 if、以及完全无保护的删除。
 */
describe("E2E 隐私门禁 · 结构判据自身的因果证明（内存源码，不落盘）", () => {
  const SHARED = ["E2E_A3_CONTENT_ROOT", "a3-content"];

  /** 一段"CRLF 编码、共享路径、受 E2E_RESET_DB 保护"的启动器片段。 */
  function guardedCrLfSource(): string {
    const lines = [
      'import { rmSync } from "node:fs";',
      "const E2E_A3_CONTENT_ROOT = '.e2e/a3-content';",
      'if (process.env.E2E_RESET_DB === "1") {',
      "  rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });",
      "}",
      "rmSync('.e2e/a3-source', { recursive: true, force: true });",
    ];
    // 刻意用 CRLF：这正是本仓库在 Windows 上检出的形态。
    return lines.join("\r\n");
  }

  it("**绿**：CRLF 编码下，受保护的共享删除被正确识别为安全", () => {
    const source = guardedCrLfSource();
    expect(source.includes("\r\n"), "本用例必须真的使用 CRLF，否则证明不成立").toBe(true);

    const audit = auditSharedRmSync(source, SHARED, "E2E_RESET_DB", "guarded.ts");
    /*
     * `calls` 是**全部**删除（含独占）。这里关注的是分类是否准确：
     * 只有一条共享、一条独占，且共享那条受保护。
     */
    expect(audit.calls.length, "两处 rmSync 都应被收集").toBe(2);
    expect(audit.sharedCalls.length, "只有一条是共享路径").toBe(1);
    expect(audit.exclusiveCalls.length, "独占源目录应被单独归类").toBe(1);
    expect(audit.sharedCalls[0].firstArgument).toContain("E2E_A3_CONTENT_ROOT");
    expect(audit.violations, "受保护的删除不得被判为违规（旧实现会在此误报）").toEqual([]);
  });

  it("**红**：同一段 CRLF 源码，把删除移出 if 之后必须被抓到", () => {
    /*
     * 这是"判据不是恒绿"的核心证明。变异只做一件事：把 rmSync 行
     * 挪到 if 块之外 —— 语义上它变成了无条件删除共享路径。
     */
    const mutated = guardedCrLfSource()
      .replace(
        'if (process.env.E2E_RESET_DB === "1") {\r\n  rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });\r\n}',
        'if (process.env.E2E_RESET_DB === "1") {\r\n  // 原本的删除被移走了\r\n}\r\nrmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });',
      );

    expect(mutated, "变异必须真的改动了源码，否则证明不成立").not.toBe(guardedCrLfSource());

    const audit = auditSharedRmSync(mutated, SHARED, "E2E_RESET_DB", "mutated.ts");
    expect(audit.violations.length, "未受保护的共享删除必须被抓到").toBe(1);
    expect(audit.violations[0].enclosingIfConditions).toEqual([]);
  });

  it("**红**：相邻 if 不得让未受保护的删除被错误放行（旧贪婪正则的漏报形态）", () => {
    /*
     * 形态刻意做成"前一个 if 含 E2E_RESET_DB、后一个删除在它闭合之后"。
     * 旧实现用 `/if\s*\(([\s\S]*)\)\s*$/` 向前回溯，`[\s\S]*` 会跨过
     * 相邻的 if 把那个开关吞进来 —— 于是这条删除被错误放行。
     * AST 判据只看真实的 enclosing 语句，因此必须报违规。
     */
    const source = [
      'if (process.env.E2E_RESET_DB === "1") {',
      // 用一条**已登记的独占**路径做对照：它本就不需要授权，
      // 因此不会引入额外违规，让本用例只测"相邻 if 的越界"这一件事。
      "  rmSync(E2E_A3_SOURCE_ROOT, { recursive: true, force: true });",
      "}",
      "rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });",
    ].join("\n"); // 顺带用 LF，证明判据对换行风格不敏感

    const audit = auditSharedRmSync(source, SHARED, "E2E_RESET_DB", "adjacent.ts");
    expect(audit.violations.length, "相邻 if 之后的共享删除必须判为未受保护").toBe(1);
    expect(audit.violations[0].firstArgument).toContain("E2E_A3_CONTENT_ROOT");
  });

  it("**绿**：外层正向授权严格保护内层语句（内层无关条件不影响结论）", () => {
    /*
     * ── 这条判据的语义 ──
     *
     * 外层 `if (GUARD === "1")` 对内部是**严格施加**的：只要进入了这个
     * 分支，开关就等于 "1"，内层的任何条件都无法让开关变成别的值。
     *
     * 因此内层的无关条件（这里是 `target.length > 0`）应判 `neutral`，
     * 而不应因为"内层条件里没有开关"就错误拒绝一个真正受保护的调用。
     *
     * 说明：这里刻意用可解析的 const（而不是 for-of 循环变量），
     * 因为共享路径的识别依赖**一层**常量展开。
     */
    const source = [
      'if (process.env.E2E_RESET_DB === "1") {',
      "  const target = '.e2e/a3-content';",
      "  if (target.length > 0) {",
      "    rmSync(target, { recursive: true, force: true });",
      "  }",
      "}",
    ].join("\r\n");

    const audit = auditSharedRmSync(source, ["a3-content"], "E2E_RESET_DB", "nested.ts");
    expect(audit.calls.length).toBe(1);
    expect(audit.violations, "外层已证明授权，内层无关条件不应导致拒绝").toEqual([]);
    // 两层都应在 enclosers 里（证明遍历有效，而不是碰巧没命中）。
    expect(audit.calls[0].enclosers.length).toBe(2);
    expect(audit.calls[0].enclosers.map((item) => item.verdict)).toEqual(["proved", "neutral"]);
  });

  it("**红**：else 分支里的删除必须被判为未受保护", () => {
    /*
     * ── 这是本轮修复的核心用例之一 ──
     *
     * `else` 的语句虽然在语法上"长在 if 语句里"，但它的执行前提恰恰是
     * 条件**不成立**。也就是说：开关不是 "1" 时才会执行这条删除。
     *
     * 旧实现只问"祖先 if 的条件文本里有没有 E2E_RESET_DB"，于是这条
     * 危险写法被错误放行。现在按 then/else 的真控制流方向判：
     * else 侧一律 `destroys`。
     */
    const source = [
      'if (process.env.E2E_RESET_DB === "1") {',
      "  mkdirSync('.e2e/a3-content', { recursive: true });",
      "} else {",
      "  rmSync('.e2e/a3-content', { recursive: true, force: true });",
      "}",
    ].join("\n");

    const audit = auditSharedRmSync(source, ["a3-content"], "E2E_RESET_DB", "else.ts");
    expect(audit.calls.length).toBe(1);
    expect(audit.violations.length, "else 分支的删除必须被判为未受保护").toBe(1);
    // 并且原因必须明确指向"else 分支"，而不是笼统的"没有授权"。
    expect(audit.calls[0].enclosers[0].branch).toBe("else");
    expect(audit.calls[0].enclosers[0].verdict).toBe("destroys");
  });

  /*
   * ── 五类"提到开关但并未授权"的危险写法 ──
   *
   * 通过独立变异确认：旧实现只检查条件文本是否**包含**
   * `E2E_RESET_DB`，于是下面每一条都被错误放行。它们全部必须变红。
   *
   * 这组用例的存在理由不是"覆盖更多写法"，而是锁住一条判据语义：
   *   **提到开关 ≠ 证明开关成立。**
   */
  const DANGEROUS_CASES: Array<{ id: string; title: string; condition: string }> = [
    {
      id: "negated-equality",
      title: "否定比较 `!== \"1\"`：恰好在未授权时执行",
      condition: 'process.env.E2E_RESET_DB !== "1"',
    },
    {
      id: "or-shortcut",
      title: "OR 可绕过授权：另一侧成立即无需授权",
      condition: 'process.env.E2E_RESET_DB === "1" || process.env.FORCE_CLEAN === "1"',
    },
    {
      id: "boolean-call",
      title: "`Boolean(...)` 真值判断：无法证明精确等于 \"1\"",
      condition: "Boolean(process.env.E2E_RESET_DB)",
    },
    {
      id: "logical-negation",
      title: "逻辑取反 `!(...)`：成立即意味着未授权",
      condition: '!(process.env.E2E_RESET_DB === "1")',
    },
    {
      id: "bare-truthiness",
      title: "裸变量真值判断：任何非空字符串都为真",
      condition: "process.env.E2E_RESET_DB",
    },
  ];

  for (const item of DANGEROUS_CASES) {
    it(`**红**（${item.id}）：${item.title}`, () => {
      const source = [`if (${item.condition}) {`, "  rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });", "}"].join("\n");

      const audit = auditSharedRmSync(source, SHARED, "E2E_RESET_DB", `${item.id}.ts`);
      expect(audit.calls.length, `${item.id}：必须识别出这条删除`).toBe(1);
      expect(
        audit.violations.length,
        `${item.id}：\`${item.condition}\` 提到了开关但无法证明它成立，必须判为未受保护`,
      ).toBe(1);
    });
  }

  it("**红**：外层授权 + 内层 else 仍然必须变红（嵌套不能掩盖未授权）", () => {
    /*
     * 外层证明了授权，但内层的 else 分支是"内层条件不成立"才执行 ——
     * 它并不违反外层授权，因此这条断言严格说不该被拒绝……
     *
     * 但本判据刻意采取**失败关闭**：任一层出现 destroys 就整体拒绝。
     * 理由是这种写法在实践中几乎总是"我以为自己在保护什么"的迹象，
     * 而误报的代价（一次人工复核）远低于漏报（删掉另一实例正在读的目录）。
     *
     * 本用例把这个取舍**显式固定**下来，避免它成为未记录的隐含行为。
     */
    const source = [
      'if (process.env.E2E_RESET_DB === "1") {',
      "  if (someOtherCondition) {",
      "    mkdirSync('.e2e/a3-content', { recursive: true });",
      "  } else {",
      "    rmSync('.e2e/a3-content', { recursive: true, force: true });",
      "  }",
      "}",
    ].join("\n");

    const audit = auditSharedRmSync(source, ["a3-content"], "E2E_RESET_DB", "nested-else.ts");
    expect(audit.calls.length).toBe(1);
    expect(
      audit.violations.length,
      "任一层出现 else 分支即整体拒绝（失败关闭，代价远低于漏报）",
    ).toBe(1);
  });

  it("**红**：延迟执行边界内的删除不得被视为已授权", () => {
    /*
     * `setTimeout(() => rmSync(shared))` 位于授权条件内部，但回调的
     * **执行时机与当前控制流无关** —— 它可能在条件早已离开之后才运行。
     *
     * 因此"写在 if 里面"不等于"执行时受保护"。
     */
    const source = [
      'if (process.env.E2E_RESET_DB === "1") {',
      "  setTimeout(() => {",
      "    rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });",
      "  }, 0);",
      "}",
    ].join("\n");

    const audit = auditSharedRmSync(source, SHARED, "E2E_RESET_DB", "deferred.ts");
    expect(audit.calls.length).toBe(1);
    expect(audit.violations.length, "延迟执行回调内的删除必须判为未受保护").toBe(1);
    expect(
      audit.calls[0].enclosers.some((item) => item.deferred === true),
      "必须指出它跨过了一个延迟执行边界",
    ).toBe(true);
  });

  it("**红**：单语句无花括号的 if 也能被正确判定", () => {
    const guarded = 'if (process.env.E2E_RESET_DB === "1") rmSync(E2E_A3_CONTENT_ROOT, { recursive: true });';
    const unguarded = 'if (someOtherFlag) rmSync(E2E_A3_CONTENT_ROOT, { recursive: true });';

    expect(auditSharedRmSync(guarded, SHARED, "E2E_RESET_DB", "bare-guarded.ts").violations).toEqual([]);
    expect(auditSharedRmSync(unguarded, SHARED, "E2E_RESET_DB", "bare-unguarded.ts").violations.length).toBe(1);
  });

  it("**红**：完全无保护的顶层删除必须被抓到", () => {
    const source = 'rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });';
    const audit = auditSharedRmSync(source, SHARED, "E2E_RESET_DB", "top-level.ts");
    expect(audit.violations.length).toBe(1);
    expect(isGuardedBy(audit.calls[0], "E2E_RESET_DB")).toBe(false);
  });

  it("注释与字符串里的 rmSync 文本不产生误报（AST 只看真实调用）", () => {
    const source = [
      "// rmSync(E2E_A3_CONTENT_ROOT) 这行只是注释，不是真实删除",
      "const note = 'rmSync(E2E_A3_CONTENT_ROOT) 也只是字符串';",
      "void note;",
    ].join("\r\n");

    expect(collectRmSyncCalls(source, "comments.ts"), "注释与字符串不得被当成调用").toEqual([]);
  });

  it("真实启动器：受保护的那条通过，且判据确实看到了它（非空断言）", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-server-a3.ts"), "utf8");
    const audit = auditSharedRmSync(
      source,
      ["a3-content", "cet6-a3.db", "E2E_A3_CONTENT_ROOT", "E2E_A3_DB_PATH"],
      "E2E_RESET_DB",
      "scripts/e2e-server-a3.ts",
    );

    // 至少覆盖内容根与数据库两条 —— 后者经模板字符串间接引用。
    expect(audit.calls.length, "真实启动器里应至少识别出 2 条共享路径删除").toBeGreaterThanOrEqual(2);
    expect(audit.violations, "当前真实启动器必须是安全的").toEqual([]);
  });
});

describe("E2E 隐私门禁 · 真实内容路径必须是人显式的", () => {
  it("真实内容实例有独立的端口与独立数据库，不与合成实例共用", () => {
    // 独立端口：真实实例不能与任何合成实例抢占同一端口。
    const syntheticPorts = SYNTHETIC_WEB_SERVERS.map((server) => server.env?.PORT).filter(Boolean);
    expect(syntheticPorts).not.toContain(String(E2E_REAL_PORT));

    /*
     * 独立数据库：真实内容不写进任何合成库。
     *
     * 注意标注服务的 `env` 里**没有** `CET6_DB_PATH`（它不打开数据库）——
     * 因此这里必须容忍缺失，只比较"确实声明了库路径"的那些实例。
     */
    const realDb = REAL_CONTENT_WEB_SERVER.env.CET6_DB_PATH;
    const syntheticDbs = SYNTHETIC_WEB_SERVERS.map(
      (server) => (server.env as Record<string, string | undefined> | undefined)?.CET6_DB_PATH,
    ).filter((value): value is string => typeof value === "string");

    expect(syntheticDbs.length, "合成实例里应有多份独立库").toBeGreaterThan(0);
    expect(syntheticDbs).not.toContain(realDb);
  });

  it("真实内容路径**不靠自动探测**启用（不存在「私有内容在就自动跑」的分支）", () => {
    /*
     * 若用 `existsSync(private-content)` 之类来决定是否启用，那么"本机恰好
     * 有私有材料"就变成了静默放行 —— 默认工作流会在一台机器上安全、
     * 在另一台上读私有内容，而用户看不出差别。启用只能是人的显式动作。
     *
     * 判据必须**剥掉注释**：默认配置的注释里会解释这条规则本身
     * （"不要读取 private-content/"），那是正确的说明而不是违规。
     * 同 paper-pool-policy 的先例。
     */
    const code = read("playwright.config.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const detector of ["existsSync", PRIVATE_CONTENT_ROOT_NAME, "CET6_CONTENT_ROOT"]) {
      expect(
        code.includes(detector),
        `默认配置的**代码**不得用 ${detector} 做自动探测（启用必须是人的显式动作）`,
      ).toBe(false);
    }
  });

  it("显式 opt-in 有具名 npm 脚本，且**不**被默认脚本引用", () => {    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    // 具名脚本存在（不是"藏在一个未文档化的环境变量后面"）。
    expect(pkg.scripts["e2e:real"]).toBeDefined();
    expect(pkg.scripts["e2e:real"]).toContain("playwright.real.config.ts");

    // 默认 e2e 脚本**不得**指向真实配置。
    expect(pkg.scripts["e2e"]).not.toContain("playwright.real.config.ts");
    // 而全量验证脚本不得包含真实内容路径。
    expect(pkg.scripts["verify"]).not.toContain("playwright.real.config.ts");
    expect(pkg.scripts["verify"]).not.toContain("e2e:real");
  });

  it("真实专用 spec 文件被保留（不为了通过率删除）", () => {
    for (const name of E2E_REAL_ONLY_SPECS) {
      const source = read(`e2e/${name}`);
      expect(source.length, `${name} 必须仍然存在`).toBeGreaterThan(500);
      // 它们必须继续用 skip 表达"前提不满足"而不是失败。
      expect(source, `${name} 应当用 test.skip 表达前提不满足`).toContain("test.skip");
    }
  });
});

/**
 * 隐私变异脚本的**覆盖声明**必须与实际变异一致。
 *
 * 与 `tests/freshness-wording.test.ts` 的同源守卫同一条理由：
 * 变异测试的价值完全建立在"声称覆盖了什么"与"实际施加了什么"一致之上。
 * 表一旦漂移（插入一个变异后编号整体后移），人就会以为某条守卫被覆盖了，
 * 而实际施加的是别的东西 —— 而每个变异各自仍然是绿的。
 */
describe("E2E 隐私门禁 · 变异脚本覆盖声明一致", () => {
  function mutationSource(): string {
    return readFileSync(join(process.cwd(), "scripts/e2e-privacy-mutation.ts"), "utf8");
  }

  it("表里列出的每个 P<n> 都在数组里存在", () => {
    const source = mutationSource();

    const actual = new Map<string, string>();
    const arrayRe = /id:\s*"(P\d+)",\s*\r?\n\s*guard:\s*"([^"]+)"/g;
    let hit: RegExpExecArray | null;
    while ((hit = arrayRe.exec(source)) !== null) actual.set(hit[1], hit[2]);

    expect(actual.size, "变异数组不得为空").toBeGreaterThan(0);

    const tableRows = source
      .split(/\r?\n/)
      // 覆盖表写在文件的 JSDoc 里，因此行首是 ` * `。
      .filter((line) => /^\s*\*\s*\|\s*P\d+\s*\|/.test(line))
      .map((line) => line.replace(/^\s*\*\s*/, "").replace(/^\s*\|/, ""));

    expect(tableRows.length, "覆盖表必须列出全部变异").toBe(actual.size);

    for (const row of tableRows) {
      const cells = row.split("|").map((cell) => cell.trim());
      const id = cells[0];
      const described = cells[1];
      expect(actual.has(id), `覆盖表里的 ${id} 在变异数组里不存在`).toBe(true);

      // 字符级重叠度（同 freshness 的做法：容得下摘要措辞，抓得住编号漂移）。
      const normalize = (text: string): string => text.replace(/\*\*/g, "").replace(/\s/g, "");
      const describedChars = [...new Set(normalize(described))];
      const guardNorm = normalize(actual.get(id)!);
      const overlap = describedChars.filter((char) => guardNorm.includes(char)).length;
      expect(
        overlap / describedChars.length,
        `覆盖表 ${id} 的描述「${described}」与 guard「${actual.get(id)}」重叠度过低 —— 表可能已漂移`,
      ).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("数组里每个变异都被覆盖表列出（无遗漏）", () => {
    const source = mutationSource();
    const ids: string[] = [];
    const arrayRe = /id:\s*"(P\d+)",/g;
    let hit: RegExpExecArray | null;
    while ((hit = arrayRe.exec(source)) !== null) ids.push(hit[1]);

    for (const id of ids) {
      expect(
        new RegExp(`\\|\\s*${id}\\s*\\|`).test(source),
        `变异 ${id} 未在覆盖表中列出`,
      ).toBe(true);
    }
  });

  it("变异脚本只跑 vitest，绝不启动 playwright webServer", () => {
    /*
     * 这是隐私变异测试的安全前提：施加的变异是配置对象层面的，
     * 而只有 `playwright test` 会启动 webServer。因此脚本必须只跑 vitest。
     */
    const source = mutationSource();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code, "不得调用 playwright CLI").not.toMatch(/spawnSync\(\s*["']playwright/);
    expect(code, "必须只跑 vitest 入口模块").toContain("vitest.mjs");
    expect(code, "不得使用 shell: true").not.toMatch(/shell:\s*true/);
  });
});
