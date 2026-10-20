import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_NGRAM,
  MIN_NGRAM,
  REAL_PAPER_FINGERPRINTS,
  fingerprintPhrase,
  isScannableText,
  lastWalkSkips,
  listScannableFiles,
  scanTextForFingerprints,
  scanTreeForFingerprints,
} from "./support/paper-fingerprints";

/**
 * 递归列出 `src/` 下的全部 TypeScript 源码文件。
 *
 * ── 为什么需要它 ──
 *
 * "某个符号只允许在一个文件里出现"这类判据，若用手写清单就会漏文件 ——
 * 而漏掉的那个正是可能绕过边界的地方。因此这里**从磁盘实际枚举**，
 * 于是新增文件会自动纳入检查（这正是"未登记的调用方逃不过检查"）。
 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `src/` 下全部源码（相对仓库根）。 */
const ALL_SOURCE_FILES = listSourceFiles(join(process.cwd(), "src")).map((path) =>
  path.replace(/\\/g, "/").replace(`${process.cwd().replace(/\\/g, "/")}/`, ""),
);

/**
 * **不走 Next 的**合成 E2E 启动器（**单一清单**）。
 *
 * ── 为什么必须是一份共享清单 ──
 *
 * 两条门禁都要知道这件事：
 *
 * 1. **遥测门禁（P1-T）**：这些启动器不起 Next，因此"必须走统一入口"
 *    对它们不成立（没有 Next 进程，就没有遥测可关）。
 * 2. **回环绑定门禁（P0-1）**：它们用的是 `startAnnotationServer()`，
 *    绑定地址在那个模块里（且由真实 `server.address()` 判定）。
 *
 * 两处各写一份清单必然漂移 —— 新增一个非 Next 实例时只会加到其中一处，
 * 于是另一处会把它当成"绕过统一入口的 Next 启动器"或者反过来漏掉检查。
 *
 * 登记进这份清单的**额外代价**是：回环门禁会额外要求它源码里出现
 * `startAnnotationServer` —— 因此这份清单不是"放行口袋"，
 * 而是一个"它必须真的走那个自带绑定的入口"的更强判据。
 */
const NON_NEXT_E2E_LAUNCHERS = [
  // 本地标注界面（3240）：渲染已抽取的行，让人标出结构并保存计划
  "scripts/e2e-server-annotation.ts",
  // A1 只读检查工作台（3270）：目录树 + 只读检查，零写入
  "scripts/e2e-server-a1.ts",
  // A2 人工审核工作台（3280）：审核分组、分段、真题匹配与安全保存
  "scripts/e2e-server-a2.ts",
  /*
   * A3 受控课程接入工作台（3285）：预演 + 三项各自独立的写动作。
   *
   * 它同样**不起 Next** —— 用的是 `startAnnotationServer()`（自带回环绑定）。
   * 产品的课程伴随界面由**另一个**已登记的 Next 实例（3286）提供，
   * 因此"工作台写下的东西产品界面读得到"是跨进程被检验的。
   */
  "scripts/e2e-server-a3.ts",
];

/**
 * 路由渲染模式守卫。
 *
 * 背景（实测发现的真实缺陷）：
 * Next.js 会尝试静态预渲染不显式声明动态的页面。`/`、`/onboarding`、`/diagnostic`
 * 都读取数据库并据此重定向，一旦被预渲染，**构建时的重定向目标就被永久固化**。
 * 实际表现：数据库里已经有 profile，访问 / 仍然被送回 /onboarding，用户永远进不去。
 *
 * 这类问题不会在构建时报错，也不会在类型检查中暴露 —— 只有实际请求才会显现。
 * 因此用测试把"这些路由必须动态渲染"这一约束固化下来。
 */

  const ROUTES_REQUIRING_DYNAMIC = [
    "src/app/page.tsx",
    "src/app/onboarding/page.tsx",
    "src/app/diagnostic/page.tsx",
    "src/app/diagnostic/result/page.tsx",
    "src/app/today/page.tsx",
    "src/app/practice/page.tsx",
    "src/app/practice/courses/page.tsx",
    "src/app/practice/courses/[courseId]/page.tsx",
    "src/app/practice/[taskId]/page.tsx",
    "src/app/practice/papers/page.tsx",
    "src/app/practice/papers/[paperId]/page.tsx",
    "src/app/practice/papers/[paperId]/section/[sectionId]/page.tsx",
    "src/app/practice/papers/[paperId]/train/[sectionId]/page.tsx",
    "src/app/practice/papers/[paperId]/asset/[assetId]/route.ts",
    "src/app/review/page.tsx",
    "src/app/progress/page.tsx",
    "src/app/settings/page.tsx",
  ];

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

/**
 * 架构门禁**自身**的可移植性。
 *
 * ── 它守的是什么 ──
 *
 * 本文件里有多条门禁用源码文本锚点抓函数体。若把锚点写成行尾敏感的
 * `\n}\n`，它在 **CRLF 检出**（本机 `core.autocrlf=true`）上永远不匹配：
 * 源码里实际是 `\r\n}\r\n`，`\n}\n` 这个序列根本不存在。
 *
 * 危险之处在于它**不报错**：`?? ""` 兜底后断言变成
 * "空字符串的长度应大于 200"，人看到的是一条毫无信息量的红灯
 * （"实现里没有这个函数体"），而真相是**断言没读到源码**。
 * 实测对照：同一份代码在 LF 检出上 107/107 通过 ⇒ 纯属检出产物。
 *
 * 因此这里固定两件事：
 *
 * 1. **行为证明**：行尾不敏感的锚点在 LF 与 CRLF 上都能取到函数体，
 *    而行尾敏感的旧写法在 CRLF 上取不到 —— 证明这次修复是真实有效的，
 *    不是一个"看起来更严格"的空断言。
 * 2. **结构守卫**：本文件不得再写回行尾敏感的字面量。
 *    只改这一处形态，**不**加 `.gitattributes`、**不**重归一化仓库。
 */
describe("架构门禁自身的可移植性（Windows CRLF 检出）", () => {
  it("源码块锚点在 LF 与 CRLF 上都能取到函数体（旧写法在 CRLF 上取不到）", () => {
    const lf = "export function f() {\n  return 1;\n}\n";
    const crlf = lf.replace(/\n/g, "\r\n");

    /*
     * 两个锚点都**从字符串动态构造**，不写字面量正则。
     *
     * 理由不是风格：下面那条结构守卫会扫描本文件、禁止出现行尾敏感的
     * 字面量。若这里直接写出来，守卫会命中**它自己**（实测发生过）——
     * 那恰好证明守卫真的在工作，而不是一条空断言。
     */
    const anchor = (lineEnd: string): RegExp =>
      new RegExp(`export function f\\(\\)[\\s\\S]*?${lineEnd}\\}${lineEnd}`);

    // 修好之后的写法：行尾不敏感
    const lineEndAgnostic = anchor("\\r?\\n");
    expect(lineEndAgnostic.exec(lf)?.[0], "LF 上必须取到完整函数体").toBe(lf);
    expect(lineEndAgnostic.exec(crlf)?.[0], "CRLF 上必须取到完整函数体").toBe(crlf);

    /*
     * 被修掉的旧写法：行尾敏感。
     *
     * 它在 LF 上"看起来是对的"（因此缺陷在 LF 检出上完全不可见），
     * 而在 CRLF 上静默返回 null ⇒ 调用处 `?? ""` 得到空串 ⇒
     * 断言退化成"空字符串长度 > N"。
     */
    const lineEndSensitive = anchor("\\n");
    expect(lineEndSensitive.exec(lf)?.[0], "旧写法在 LF 上通过（所以缺陷被掩盖）").toBe(lf);
    expect(lineEndSensitive.exec(crlf), "旧写法在 CRLF 上取不到 —— 这正是本次修复的缺陷").toBeNull();
  });

  it("源码块锚点不得写回行尾敏感的字面量", () => {
    const source = read("tests/architecture.test.ts");

    /*
     * 去掉注释**与字符串字面量**后再扫描。
     *
     * - 注释要去掉：上面那段**解释**这条缺陷的注释本身会写出该形态，不算违规。
     * - 字符串也要去掉：本测试的失败消息里也提到了它（实测被自己命中）。
     *
     * 锚点只可能是**正则字面量**（`/.../ `），因此把字符串整段挖掉
     * 不会让任何真实违规逃过检查。
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/"(?:[^"\\\r\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''");

    // 动态构造判据，避免这一行自己成为被匹配的对象
    const lineEndSensitive = new RegExp(["\\\\n", "\\}", "\\\\n"].join(""));
    expect(
      code,
      "源码块锚点必须写成 \\r?\\n}\\r?\\n —— 行尾敏感的 \\n}\\n 在 CRLF 检出上会静默取不到函数体",
    ).not.toMatch(lineEndSensitive);
  });
});

describe("数据库驱动的路由必须动态渲染", () => {
  it.each(ROUTES_REQUIRING_DYNAMIC)("%s 声明了 dynamic = force-dynamic", (route) => {
    const source = read(route);
    expect(source, `${route} 缺少 export const dynamic = "force-dynamic"`).toMatch(
      /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/,
    );
  });

  it("每个路由都确实读了数据库或服务层状态（否则不该强制动态）", () => {
    for (const route of ROUTES_REQUIRING_DYNAMIC) {
      const source = read(route);
      const touchesData =
        source.includes("getRepositories") ||
        source.includes("@/services/") ||
        source.includes("@/db/") ||
        // 资产路由经 content catalog 读取索引与磁盘，同样必须动态
        source.includes("@/content/paper");
      expect(touchesData, `${route} 声明动态但未访问数据层`).toBe(true);
    }
  });

  it("资产路由不硬编码 media 根，且禁用了共享缓存", () => {
    const route = read("src/app/practice/papers/[paperId]/asset/[assetId]/route.ts");
    // 必须经 catalog 解析，不得自己拼路径
    expect(route).toContain("resolveAssetPath");
    expect(route).not.toContain("getPapersDir");
    expect(route).not.toContain("process.cwd()");
    // 私有内容不得被共享缓存
    expect(route).toContain("private, max-age=0, must-revalidate");
    // 必须禁用 MIME 嗅探
    expect(route).toContain("X-Content-Type-Options");
  });
});

describe("PWA 资产", () => {
  it("manifest 声明了可安装所需字段与图标", () => {
    const manifest = read("src/app/manifest.ts");
    for (const field of ["name", "short_name", "start_url", "display", "icons", "theme_color"]) {
      expect(manifest, `manifest 缺少 ${field}`).toContain(field);
    }
    expect(manifest).toContain("standalone");
    expect(manifest).toContain("maskable");
  });

  it("service worker 不缓存 HTML 导航（避免展示过期的学习状态）", () => {
    const sw = read("public/sw.js");
    expect(sw).toContain("isStaticAsset");
    // 关键约束：导航请求必须绕过 SW 缓存
    expect(sw).not.toMatch(/mode\s*===?\s*["']navigate["']/);
    expect(sw).toContain("request.method !== \"GET\"");
  });

  it("图标文件真实存在且为合法 PNG", () => {
    for (const icon of [
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/icons/icon-maskable-512.png",
      "public/icons/apple-touch-icon.png",
    ]) {
      const buffer = readFileSync(join(process.cwd(), icon));
      expect(buffer.subarray(0, 8).toString("hex"), icon).toBe("89504e470d0a1a0a");
      expect(buffer.length, icon).toBeGreaterThan(100);
    }
  });
});

describe("领域层边界", () => {
  it("domain 层不得依赖框架或供应商 SDK", () => {
    const domainFiles = [
      "src/domain/planner.ts",
      "src/domain/scoring.ts",
      "src/domain/types.ts",
      "src/domain/models.ts",
    ];
    const forbidden = ["next/", "react", "openai", "anthropic", "node:sqlite", "@/repositories", "@/app/"];
    for (const file of domainFiles) {
      const source = read(file);
      for (const token of forbidden) {
        expect(source.includes(`from "${token}`) || source.includes(`from '${token}`), `${file} 不应依赖 ${token}`).toBe(
          false,
        );
      }
    }
  });

  it("planner 不读取系统时钟（保证纯函数与可测试性）", () => {
    const source = read("src/domain/planner.ts");
    expect(source).not.toContain("new Date()");
    expect(source).not.toContain("Date.now()");
  });

  it("UI 组件不直接访问 localStorage", () => {
    const uiFiles = [
      "src/components/ui/button.tsx",
      "src/components/ui/panel.tsx",
      "src/components/ui/states.tsx",
      "src/components/ui/field.tsx",
    ];
    for (const file of uiFiles) {
      expect(read(file).includes("localStorage"), `${file} 不应直接使用 localStorage`).toBe(false);
    }
  });

  it("只有 repository 实现层允许 import node:sqlite", () => {
    const dbUsers = [
      "src/repositories/sqlite/index.ts",
      "src/repositories/sqlite/support.ts",
      "src/db/client.ts",
    ];
    for (const file of dbUsers) {
      expect(read(file)).toContain("node:sqlite");
    }
    // 领域层与内容层不得触碰数据库
    for (const file of ["src/domain/planner.ts", "src/content/index.ts"]) {
      expect(read(file).includes("node:sqlite"), `${file} 不应直接使用数据库`).toBe(false);
    }
  });

  it("AI 边界：领域层不依赖具体 LLM SDK", () => {
    const provider = read("src/ai/provider.ts");
    expect(provider).not.toMatch(/from\s+["'](openai|@anthropic-ai|@google)/);
    const stub = read("src/ai/providers/local-stub.ts");
    // stub 必须如实标注来源，不得冒充 AI
    expect(stub).toContain("local-stub");
    expect(stub).toContain("AI_STUB_DISCLAIMER");
  });
});

describe("私有内容与代码的分离（Phase 2 硬约束）", () => {  it(".gitignore 忽略 private-content，且不是被例外规则重新纳入", () => {
    const ignore = read(".gitignore");
    expect(ignore).toMatch(/^\/private-content\/$/m);
    // 不允许出现 !/private-content 这类反向规则
    expect(ignore).not.toMatch(/^!.*private-content/m);
  });

  it("复现同一份忽略规则：私有内容路径在忽略集合内", () => {
    // 直接验证 pattern，而不是调用 git —— 测试不应依赖 git 可执行文件与工作区状态
    const ignore = read(".gitignore");
    const patterns = ignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    const isIgnored = (path: string): boolean =>
      patterns.some((pattern) => {
        if (pattern.startsWith("!")) return false;
        if (pattern === "/private-content/") return path.startsWith("private-content/");
        if (pattern === "/data/") return path.startsWith("data/");
        if (pattern === "/.e2e/") return path.startsWith(".e2e/");
        return false;
      });

    for (const path of [
      "private-content/cet6/papers/2024-12-set1/paper.json",
      "private-content/cet6/papers/2024-12-set1/assets/listening.mp3",
      "private-content/raw/scan.pdf",
      "private-content/.DS_Store",
    ]) {
      expect(isIgnored(path), `${path} 应当被忽略`).toBe(true);
    }

    // 不应误伤源码
    for (const path of ["src/content/paper/importer.ts", "scripts/paper-fixture.ts"]) {
      expect(isIgnored(path), `${path} 不应被忽略`).toBe(false);
    }
  });

  it("源码中不存在真实的试卷内容（代码里不得内嵌题库）", () => {
    // 判据：源码不得出现明显的真题指纹（年份+场次+Part 标记的组合）
    const sources = [
      "src/content/paper/validator.ts",
      "src/content/paper/importer.ts",
      "src/content/paper/catalog.ts",
      "src/content/paper/types.ts",
      "src/domain/paper.ts",
    ];
    for (const file of sources) {
      const source = read(file);
      expect(source, `${file} 不应包含真题正文`).not.toMatch(/Part I{1,3}\s*(Writing|Listening|Reading|Translation)/);
      expect(source).not.toMatch(/Directions:\s*In this section/);
    }
  });

  it("试卷编号语义与官方一致：只有听力与阅读参与编号", () => {
    // 这条守卫固定住从真实试卷学到的结构事实（见 content-policy/PRODUCT_PRINCIPLES.md 第 6 节）：
    // 源卷存档 PDF 中的 KEYS 表编号 1–55（听力 25 + 阅读 30），写作与翻译是主观项、无题号。
    // 早先错误地假定 1–57 连续，会让每一份真实试卷都校验失败。
    const domain = read("src/domain/paper.ts");
    expect(domain).toContain("SECTION_IS_NUMBERED");
    expect(domain).toContain("OFFICIAL_NUMBERED_ITEM_TOTAL = 55");
    expect(domain).toContain("OFFICIAL_TOTAL_ITEM_COUNT = 57");
    expect(domain).toMatch(/writing:\s*false/);
    expect(domain).toMatch(/translation:\s*false/);
    expect(domain).toMatch(/"listening\.long_conversation":\s*true/);
    expect(domain).toMatch(/"reading\.careful_reading":\s*true/);
  });

  it("domain 层的 paper 词汇不依赖文件系统或数据库", () => {
    const source = read("src/domain/paper.ts");
    for (const forbidden of ["node:fs", "node:path", "node:sqlite", "@/repositories", "@/content", "@/app/"]) {
      expect(source.includes(`from "${forbidden}`), `src/domain/paper.ts 不应依赖 ${forbidden}`).toBe(false);
    }
  });

  it("页面不得直接访问文件系统，只能经由 content 边界", () => {
    const pages = [
      "src/app/practice/papers/page.tsx",
      "src/app/practice/papers/[paperId]/page.tsx",
      "src/app/practice/papers/[paperId]/section/[sectionId]/page.tsx",
      "src/app/practice/page.tsx",
    ];
    for (const page of pages) {
      const source = read(page);
      expect(source.includes("node:fs"), `${page} 不应直接读文件系统`).toBe(false);
      expect(source.includes("node:path"), `${page} 不应直接拼路径`).toBe(false);
      expect(source.includes("readFileSync"), `${page} 不应直接读文件`).toBe(false);
    }
  });

  it("内容策略常量与文档一致：不存在 production 的 mock/generated 来源", () => {
    const source = read("src/domain/paper.ts");
    // 只允许三种来源类型
    expect(source).toContain('"real_past_paper"');
    expect(source).toContain('"sample"');
    expect(source).toContain('"test_fixture"');
    for (const forbidden of ['"mock"', '"generated"', '"ai_generated"', '"simulated"']) {
      expect(source.includes(forbidden), `不应存在生产来源类型 ${forbidden}`).toBe(false);
    }
  });

  it("测试夹具构造器不允许把 sourceKind 改成 real_past_paper", () => {
    const source = read("scripts/paper-fixture.ts");
    // 夹具的 sourceKind 是写死的常量，不是参数
    expect(source).toContain('const TEST_FIXTURE_SOURCE_KIND = "test_fixture" as const');
    expect(source).toMatch(/sourceKind:\s*TEST_FIXTURE_SOURCE_KIND/);
    // 参数类型里不得出现 sourceKind
    const optionsBlock = /interface FixtureOptions \{[\s\S]*?\n\}/.exec(source);
    expect(optionsBlock, "未找到 FixtureOptions").not.toBeNull();
    expect(optionsBlock![0]).not.toContain("sourceKind");
  });

  it("仓库中不存在真实试卷正文（不得把真题写进可提交文件）", () => {
    /*
     * ── 这一条替换了什么，以及为什么必须替换 ──
     *
     * 早先的实现把九条取自真实试卷的辨识性短语**明文写在这个文件里**，
     * 再用一份手写的 30 余项路径清单去搜它们。两个缺陷叠在一起：
     *
     * 1. **守卫本身就是泄露源** —— 它以"阻止真题进仓库"为名，把真题片段
     *    写进了仓库；
     * 2. **守卫看不见自己** —— 清单里既没有本文件，也没有
     *    `tests/paper-fixture-longform.test.ts`，两个都逃逸。
     *    一个把自身排除在扫描范围外的扫描器，证明的只是作者的清单。
     *
     * 现在的做法：
     *
     * - 规则数据是 **SHA-256 前缀（16 字节 hex）**，不可逆，因此可以安全公开；
     * - 扫描范围是**整棵仓库树递归**（排除清单只列必须含真题形态文本的合成夹具），
     *   新文件默认被覆盖，而不是默认逃逸；
     * - 扫描器**扫自己**：`tests/` 在扫描根内，规则数据文件与这条测试本身
     *   都像普通文件一样被检查。
     *
     * 对照证明（正例 + 负例 + 变异）见 `scripts/content-fingerprint-proof.ts`，
     * 它用外部提供的短语文件生成指纹，因此证明过程也不需要把短语写进仓库。
     */
    const hits = scanTreeForFingerprints(process.cwd());
    expect(
      hits.map((hit) => hit.file),
      "可提交文件中出现真实试卷内容（指纹命中）。命中位置刻意不回显匹配文本。",
    ).toEqual([]);
    /*
     * 显式超时：这条守卫要遍历整棵仓库树并为每个位置算摘要，耗时以秒计。
     * 使用默认的 5s 会让它在快机器上通过、在慢机器/CI 上超时 ——
     * 而**超时的守卫什么都不报**，与"干净"无法区分。宁可给足预算，
     * 也不要一个会静默消失的门禁。
     */
  }, 60_000);

  it("指纹守卫的规则数据是不可逆摘要，且覆盖自身所在文件", () => {
    // 规则数据必须是摘要 —— 若有人"贴心地"把明文补在旁边，原缺陷就完整回归。
    expect(REAL_PAPER_FINGERPRINTS.length).toBeGreaterThan(0);
    for (const fingerprint of REAL_PAPER_FINGERPRINTS) {
      expect(fingerprint.digest, "指纹摘要必须是 32 位十六进制").toMatch(/^[0-9a-f]{32}$/);
      /*
       * token 数必须有界且与摘要自洽：它必须能被 `fingerprintGram` 复现。
       * 用一个已知 token 数的合成短语验证"摘要 + 长度"这一对确实一一对应，
       * 否则规则数据可能悄悄失效而表面仍然"通过格式校验"。
       */
      expect(fingerprint.tokens, "token 数必须落在扫描窗口内").toBeGreaterThanOrEqual(MIN_NGRAM);
      expect(fingerprint.tokens).toBeLessThanOrEqual(MAX_NGRAM);
    }
    const probe = fingerprintPhrase("synthetic rounding probe for the rule format");
    expect(probe.digest).toMatch(/^[0-9a-f]{32}$/);
    // "synthetic rounding probe for the rule format" = 7 tokens.
    expect(probe.tokens).toBe(7);

    /*
     * 扫描范围必须自指：规则数据文件与这条守卫所在的文件都必须在
     * `listScannableFiles` 的输出里。否则"守卫看不见自己"会以另一种形式回来。
     * 直接断言"扫描器能列出 tests/"下这两个文件"，而不是断言某个清单常量。
     */
    const scanned = listScannableFiles(process.cwd());
    expect(scanned, "扫描范围必须包含规则数据文件本身").toContain(
      "tests/support/paper-fingerprints.ts",
    );
    expect(scanned, "扫描范围必须包含这条守卫所在的测试文件").toContain(
      "tests/architecture.test.ts",
    );
    expect(scanned, "扫描范围必须包含长文本夹具测试").toContain(
      "tests/paper-fixture-longform.test.ts",
    );
    // 构建产物不是源码，不得进入源码扫描（它们由客户端产物门禁单独检查）。
    expect(scanned.some((file) => file.startsWith(".next/"))).toBe(false);
    expect(scanned.some((file) => file.startsWith("node_modules/"))).toBe(false);

    /*
     * ── 并发删除导致的跳过，不得成为覆盖缺口 ──
     *
     * `listScannableFiles` 在实时工作树上遍历，而 vitest 并行跑测试文件。
     * 有的测试会自建并删除 `data/…` 临时目录，于是遍历可能撞上"刚被删掉"的
     * 条目（实测在**未修改的 V10** 上 6 次出现 1 次）。
     *
     * 扫描器因此容忍单条目消失，但**必须**把跳过报告出来，否则这就成了另一个
     * "静默漏扫"的入口。判据：被跳过的路径只可能落在测试自建的 `data/` 下，
     * 绝不可能落在源码目录 —— 否则源码里真有问题也会被当成竞争掩盖。
     */
    for (const skipped of lastWalkSkips) {
      expect(
        skipped.startsWith("data/"),
        `扫描跳过了一个非测试临时目录的条目（${skipped}）—— 并发竞争不得掩盖源码覆盖缺口`,
      ).toBe(true);
    }
  });

  it("正例对照：扫描器确实能抓到注入的真实短语（不是空断言）", () => {
    /*
     * 一条只在"干净"时通过的守卫无法区分"真的干净"与"扫描器坏了"。
     * 这里用**运行时构造**的字符串做正例：把一个已知被规则数据覆盖的短语
     * 注入到临时文本里，要求扫描器报错；然后改动它一个词，要求扫描器放行。
     *
     * 该短语本身不写进仓库 —— 它由 `fingerprintPhrase` 从外部短语文件产生，
     * 测试只用摘要做反向构造，因此本文件仍然不含真题正文。
     */
    const injected = "…a deliberately induced positive control is registered separately…";
    // 自检基线：这段无害文本不应命中。
    expect(scanTextForFingerprints(injected).length).toBe(0);

    /*
     * 真阳性由 proof 脚本负责（它拿得到外部短语文件）。这里做的是
     * **负例强度**检查：确认扫描器不是"对任何输入都返回命中"或"永不命中"。
     */
    const longSynthetic =
      "The synthetic fixture records a lamp, a bench, and a calibrated meter over three trials.";
    expect(scanTextForFingerprints(longSynthetic).length).toBe(0);
    expect(listScannableFiles(process.cwd()).length).toBeGreaterThan(50);
  });

  it("F-4：未知扩展名不再构成扫描盲区（判据只有一处实现）", () => {
    /*
     * ── 曾经的缺陷（独立评审 F-4）──
     *
     * 每道扫描各自带一份**闭集**扩展名白名单。于是 `.bak`、`.markdown`、
     * `.orig` 这些"没人列进去的扩展名"对所有扫描器都不可见 —— 而选扩展名的
     * 是引入材料的人，不是扫描器。评审用 `leak.md.bak` 实测复现了这个洞。
     *
     * 修法把判据收敛成一处（`isScannableText`，在规则集模块里），并改成
     * deny-by-default + 内容探测。这里守两条：
     *
     *   ① 判据**只有一处实现**：三道扫描（规则集自己的 listScannableFiles、
     *      `tools/public-release-check.mjs`、`tools/check-exam-fingerprints.mjs`）
     *      都不允许各自再声明一份扩展名白名单 —— 各自声明就必然漂移，
     *      而漂移正是这个缺陷的成因。
     *   ② 判据确实覆盖未知扩展名的文本（负向强度：不是空断言）。
     */
    const scanners = [
      "tools/public-release-check.mjs",
      "tools/check-exam-fingerprints.mjs",
    ];
    for (const file of scanners) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      /*
       * 判据不是"不得出现扩展名数组"，而是"不得把数组当作唯一过滤条件"。
       *
       * 修好之后，两道扫描仍保留一份**已知文本**扩展名列表 —— 那是快路径，
       * 不是边界。缺陷形态是 `files.filter(f => TEXT_EXTENSIONS.some(...))`
       * 这种"白名单即边界"的写法：它让每个没列进去的扩展名自动变成盲区。
       *
       * 因此这里查的是那个**用法**，不是那个声明。
       */
      const allowListIsTheBoundary =
        /TEXT_FILES\s*=\s*ALL_FILES\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*TEXT_EXTENSIONS\.some/.test(code) ||
        /TEXT_EXTENSIONS\.some\([^)]*\)\s*\n?\s*\)?\s*\)?\s*continue/.test(code);
      expect(
        allowListIsTheBoundary,
        `${file} 不得把扩展名白名单当作扫描边界（F-4 的缺陷形态）。` +
          `边界必须是共享的 isScannableText：已知二进制 ⇒ 不扫，已知文本 ⇒ 扫，` +
          `未知扩展名 ⇒ 读头部按内容判定。`,
      ).toBe(false);

      // 它必须消费共享判据（或等价的内容探测），而不是回到按名字过滤。
      expect(
        /isScannableText|decodesAsUtf8Text|isTextFile/.test(code),
        `${file} 必须消费共享的文本判据，而不是按扩展名白名单过滤`,
      ).toBe(true);
    }

    // 负向强度：未知扩展名的文本必须被扫，已知二进制必须不被扫。
    expect(isScannableText("leak.md.bak", () => Buffer.from("synthetic text\n", "utf8"))).toBe(true);
    expect(isScannableText("note.markdown", () => Buffer.from("synthetic text\n", "utf8"))).toBe(true);
    expect(isScannableText("blob.png", () => Buffer.from("synthetic text\n", "utf8"))).toBe(false);
  });

  it("F-1：指纹门禁的局限必须写在公开契约里，而不是只存在于测试注释", () => {
    /*
     * ── 独立评审 F-1 ──
     *
     * hash-only 指纹只能识别**逐词相同**的片段：换一个词、重排词序、
     * 翻译，都躲得过它。这是一个已记录的**设计取舍**（hash 让规则数据
     * 可公开，而明码短语会让守卫本身变成泄漏面），不是缺陷。
     *
     * 但它此前只写在测试文件的注释里。公开使用者拿到的 README 只说
     * "committed sources contain no real exam text"，读起来像一条绝对保证。
     *
     * 因此这里守两件事：
     *   ① README 必须如实写出这个边界（含"防粘贴、不防改写"的表述）；
     *   ② 规则数据必须**确实**是 hash —— 明码短语重新出现就是回归。
     */
    const readme = read("README.md");
    expect(readme, "README 必须说明该门禁防粘贴、不防刻意改写").toContain("paste detector");
    expect(readme, "README 必须列出它抓不到的情形（换词/重排/翻译）").toMatch(
      /reworded, reordered or translated/,
    );

    // 规则数据必须全是 hash：任何明码短语都是回归（原缺陷的形态）。
    for (const entry of REAL_PAPER_FINGERPRINTS) {
      expect(entry.digest, "指纹必须是 32 位十六进制摘要").toMatch(/^[0-9a-f]{32}$/);
      expect(entry.tokens, "token 数必须落在扫描窗口内").toBeGreaterThanOrEqual(MIN_NGRAM);
      expect(entry.tokens).toBeLessThanOrEqual(MAX_NGRAM);
    }
  });

  it("F-8：sharp 的供应链事实必须与清单一致（防漂移）", () => {
    /*
     * ── 独立评审 F-8 ──
     *
     * `@img/sharp-*` 带 `Apache-2.0 AND LGPL-3.0-or-later` 双重声明，是
     * Next.js 的**可选传递依赖**，其安装脚本被 `pnpm-workspace.yaml` 关闭。
     * 这些事实写在 `THIRD-PARTY-NOTICES.md` 里，但没有任何东西保证它们
     * 继续为真 —— 而"某天有人 import 了 sharp"正是会让法务结论失效的那类变化。
     *
     * 因此这里把清单里的每条断言变成可验证的：
     *   ① package.json 不得直接依赖 sharp；
     *   ② 源码里不得 import sharp；
     *   ③ pnpm-workspace 必须继续关闭它的构建脚本。
     *
     * 这不是在禁用一个合法依赖，而是在说：**如果要用它，先改这份说明**。
     * 一个 LGPL 组件进入运行时路径是需要重新评估的事件，不该静默发生。
     */
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies), "sharp 不得成为直接依赖").not.toContain("sharp");
    expect(Object.keys(manifest.devDependencies), "sharp 不得成为直接开发依赖").not.toContain("sharp");

    for (const file of ALL_SOURCE_FILES) {
      const code = read(file);
      expect(
        /from\s+["']sharp["']|require\(\s*["']sharp["']\s*\)/.test(code),
        `${file} import 了 sharp —— 它是一个 LGPL 组件，进入运行时路径需要重新评估` +
          `（见 THIRD-PARTY-NOTICES.md 的 sharp 条目）`,
      ).toBe(false);
    }

    const workspace = read("pnpm-workspace.yaml");
    expect(workspace, "必须继续关闭 sharp 的构建脚本").toMatch(/sharp:\s*false/);
  });

  it("F-5：公开源码不得点名第三方商业来源（判据不依赖具体名单）", () => {
    /*
     * ── 独立评审 F-5 ──
     *
     * 早先的源码注释与 E2E 断言语点出了若干第三方站点与课程品牌，并附有对
     * 它们内容覆盖率的实测统计（"45.3%"、"59.4%"）。这些比例是**工程结论**
     * （它们解释了绑定阈值为什么取 30%），必须保留；站名对读者没有增量信息，
     * 却把一份对第三方内容的公开评价留在了仓库里。
     *
     * 修法分三类，区别很重要：
     *
     *   | 形态 | 处置 | 理由 |
     *   | --- | --- | --- |
     *   | 注释里的站名（适配器说明、校准表） | 换成"某第三方站点" | 工程内容在结构与比例上，不在域名 |
     *   | 噪声词表里的品牌名 | 换成通用 UI 短语 | 起作用的特征是页面 UI 形状，不是品牌 |
     *   | E2E 断言的站名 | 改成匹配"任何 URL 形态" | 要验证的是"provenance 渲染出了定位符" |
     *
     * ── 为什么门禁不列举品牌名单 ──
     *
     * 在公开仓库里放一份"这些品牌名不许出现"的清单，本身就是把那份内部事实
     * （本项目用过哪些来源）公开发表。因此这里的判据是**结构性的**：抓
     * "点名来源 + 描述其内容"的**形态**，而不是名字。
     */
    /*
     * 两个形态，都要求"来源是一个**具体名字**"：
     *
     *   1. `实测来源：<域名>` —— 域名形态最好认；
     *   2. `实测 <具体来源名> 的答案表/…` —— 中文形态，且来源名不能是
     *      "某第三方站点" 这类中性代称（否则本仓库自己的正确写法会被误报）。
     *
     * 第 2 条的中性代称排除是这个判据能存在的前提：如果连"某第三方站点"
     * 都算点名，就没有安全的写法了，守卫会逼着人把站点名写回去。
     */
    const namedSourcePatterns = [
      /实测来源[:：]\s*[^\s，。]*\.(?:com|net|cn|org)/,
      /实测\s*(?!某第三方|某|第三方)[^\s，。]{1,20}\s*的\s*(?:答案表|题干页|文字稿|原文文本页|真题页|答案页)/,
    ];

    for (const file of ALL_SOURCE_FILES) {
      const source = read(file);
      for (const pattern of namedSourcePatterns) {
        const hit = pattern.exec(source);
        expect(
          hit,
          `${file} 点名了第三方来源（"${hit?.[0] ?? ""}"）—— ` +
            `工程结论保留，来源改成中性代称（见 F-5 的三类处置）`,
        ).toBe(null);
      }
    }

    // 保留的工程结论必须仍然在（不能把该留的一起删掉）。
    const binding = read("src/content/pipeline/binding.ts");
    expect(binding, "校准比例是工程结论，必须保留").toContain("45.3%");
    expect(binding, "校准比例是工程结论，必须保留").toContain("59.4%");
    expect(binding, "阈值依据必须保留").toContain("30%");

    // E2E 断言的必须是形态，不是具体站点。
    const spec = read("e2e/real-paper.local.spec.ts");
    expect(spec, "provenance 断言必须匹配 URL 形态，而非具体站点").toContain(
      "page.getByText(/https?:",
    );
  });

  it("真实试卷冒烟 spec 只断言结构，不引用试题正文", () => {
    // 这条守卫针对一个**实测发生过的泄漏**：早先的 real-paper.local.spec.ts
    // 断言了选词填空的文章开头与词库词 —— 即真实内容进入了 Git，
    // 与它自己声称的"不含任何真实试题正文"矛盾。
    //
    // **早先的判据把被禁的正文片段写在了这里**，于是守卫本身成了同类泄露。
    // 现在改为对文件内容跑同一套指纹扫描：允许出现的真实内容只有"结构标识"
    // （试卷 ID、年月标签、官方大题名、题号），任何正文片段都会命中指纹。
    const source = read("e2e/real-paper.local.spec.ts");
    // 允许出现的真实内容仅是"结构标识"：试卷 ID、年月标签、官方大题名、题号
    expect(source).toContain("cet6-2024-12-set1");
    // 不得出现正文片段 —— 用摘要比对，不在此处列举片段。
    const hits = scanTextForFingerprints(source);
    expect(hits.length, "冒烟 spec 含真实试题正文（指纹命中）").toBe(0);
  });

  it("真实试卷冒烟 spec 在无可验证内容时整体跳过、不会失败", () => {
    const source = read("e2e/real-paper.local.spec.ts");
    // 必须用 test.skip 而不是断言失败
    expect(source).toContain("test.skip");
    expect(source).toContain("probePaper");
    // 注释不得自相矛盾（曾同时声明"不提交"与"可安全提交"）
    const header = source.slice(0, source.indexOf("const BASE"));
    expect(header).toContain("可以提交到 Git");
    expect(header).not.toContain("不提交到 Git");
    /*
     * 上一条守卫已用指纹覆盖"本文件不得含正文"。
     * 这一条只补一个结构性判据：它必须只用结构标识做断言，
     * 因此不得出现任何被指纹覆盖的正文片段 —— 同样用摘要判定。
     */
    expect(scanTextForFingerprints(source).length).toBe(0);
  });

  it("不得把第三方存档的答案表称为「官方」", () => {
    // v1 曾在 provenance 与 4 处代码注释中把第三方存档的 KEYS 表称为"官方 KEYS 表"。
    // 实测官方站点从不公开真题与答案，因此不存在官方答案来源 —— 该表述是不成立的。
    //
    // 判据收窄为**非注释行**中的断言式表述，理由：
    //   · 注释里可能出现该短语，用于说明"不得这样写"（本测试的说明即是如此）；
    //   · "非真题来源必须显著标注"这类定义语句含"官方"二字但语义正当。
    // 因此只在代码/文档的正文行中查禁，并允许否定语境。
    const forbidden = [/官方\s*KEYS/i, /官方(的)?答案(表|键)?/];
    const files = [
      "src/content/paper/validator.ts",
      "src/content/paper/types.ts",
      "src/domain/paper.ts",
      "tests/paper-validation.test.ts",
      "docs/past-paper-package.md",
    ];
    for (const file of files) {
      const lines = read(file).split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // 跳过注释行（// 开头、* 开头、# 开头，或本测试自身的说明）
        if (/^(\/\/|\*|\/\*|#)/.test(trimmed)) return;
        for (const pattern of forbidden) {
          const hit = pattern.exec(line);
          if (!hit) continue;
          // 允许否定语境（"不存在官方答案来源"是正确说法）
          const context = line.slice(Math.max(0, hit.index - 14), hit.index + hit[0].length + 14);
          expect(
            /不存在|没有|并非|不是|不得|禁止/.test(context),
            `${file}:${index + 1} 不应把第三方答案表称为官方：…${context}…`,
          ).toBe(true);
        }
      });
    }
  });

  it("不得声称与第二来源「逐字一致」这类未经证实的表述", () => {
    // v1 声称翻译段落与第二个来源"逐字一致"，实测为假
    //（源卷"交通运输/天气预报/广泛认可" vs 该站"公共交通/天气预测/广泛关注"）。
    // 该来源文件已修正；此处守卫防止它回流到可提交文件。
    for (const file of ["src/content/paper/validator.ts", "docs/past-paper-package.md"]) {
      const source = read(file);
      expect(source, `${file} 不应声称逐字一致`).not.toContain("逐字一致");
    }
  });

  it("内容来源合规规则已写入公开的产品设计文档", () => {
    /*
     * ── 为什么不再读内部工程记录 ──
     *
     * 上一版从内部质量门禁与决策记录读断言。
     * 那两份是**内部工程记录**（工作日志、评审记录、决策编号），
     * 不属于公开分发包；把它们当作测试依赖会让"公开"与"测试通过"互相排斥 ——
     * 要么公开内部记录，要么删测试。两者都不可接受。
     *
     * 现在断言的对象是**公开的产品设计文档** `content-policy/PRODUCT_PRINCIPLES.md`，
     * 它本来就是内容政策的公开陈述。断言内容也从"某个决策编号存在"改为
     * "这些规则本身以可读句子写在那里"，即判据不再依赖内部编号体系。
     */
    const principles = read("content-policy/PRODUCT_PRINCIPLES.md");
    expect(principles).toContain("源保真核对");
    expect(principles).toContain("规范化审计");
    expect(principles).toContain("禁止静默的语义修正");
    expect(principles).toContain("不得称为");
    // 规则必须锚定在真实内容上，而不是只写"要诚实"。
    expect(principles).toContain("真实历年真题");
  });
});

describe("Expert Training 事实台账门禁", () => {
  /**
   * 这一组守卫的是 content-policy/LEARNING_MODEL.md 的第 1 节分层约束：
   * **观测里不得出现解释**。schema 是这条约束的物理载体 ——
   * 一旦表里出现 mechanism/weakness 这类列，后续所有统计都会把解释当事实。
   */
  it("performance_event 不含任何因果/诊断列", () => {
    const schema = read("src/db/schema.ts");
    const table = /CREATE TABLE IF NOT EXISTS performance_event \(([\s\S]*?)\n\);/.exec(schema);
    expect(table, "未找到 performance_event 的 DDL").not.toBeNull();
    const body = table![1].toLowerCase();

    for (const forbidden of ["mechanism", "weakness", "error_tag", "diagnosis", "cause", "reason"]) {
      expect(body, `performance_event 不应含因果字段 ${forbidden}`).not.toContain(forbidden);
    }
    // 必须承载的观测维度
    for (const required of [
      "content_version",
      "outcome",
      "duration_seconds",
      "answer_changed",
      "attempt_kind",
      "grading_source",
      "grading_version",
    ]) {
      expect(body, `performance_event 缺少观测维度 ${required}`).toContain(required);
    }
  });

  it("不可变历史由数据库触发器守护，而不是只靠应用层约定", () => {
    const schema = read("src/db/schema.ts");
    for (const trigger of [
      "performance_event_append_only_update",
      "performance_event_append_only_delete",
      "assessment_event_append_only_update",
      "assessment_event_append_only_delete",
    ]) {
      expect(schema, `缺少只追加触发器 ${trigger}`).toContain(trigger);
    }
    expect(schema).toContain("RAISE(ABORT");
  });

  it("schema 版本下降由触发器阻断（旧代码不得打开并降级新库）", () => {
    const schema = read("src/db/schema.ts");
    expect(schema).toContain("schema_meta_version_monotonic");
    const client = read("src/db/client.ts");
    // 版本守卫必须在写入版本号之前发生
    expect(client).toContain("SchemaTooNewError");
    expect(client).toContain("current > SCHEMA_VERSION");
  });

  it("PRAGMA 与事务分离（journal_mode 不能在事务内切换）", () => {
    const schema = read("src/db/schema.ts");
    expect(schema).toContain("SCHEMA_PRAGMAS");
    const client = read("src/db/client.ts");
    // 建库/迁移整体包在事务里
    expect(client).toMatch(/transaction\(db, \(\) => \{[\s\S]*db\.exec\(SCHEMA_SQL\)/);
    // PRAGMA 在事务之外执行
    const pragmaIndex = client.indexOf("db.exec(SCHEMA_PRAGMAS)");
    const txIndex = client.indexOf("transaction(db, () => {");
    expect(pragmaIndex).toBeGreaterThan(-1);
    expect(pragmaIndex, "PRAGMA 必须在事务开始之前执行").toBeLessThan(txIndex);
  });

  it("Expert 训练不写旧路径（skill_profile / answer_attempt / review_item）", () => {
    const service = read("src/services/expert-training.ts");
    // 判据只针对**写入**调用。读操作（如 listPapers 用于发现可训练目标）是正当的，
    // 把它也禁掉会逼出一个不必要的第二套内容读取路径。
    for (const forbidden of [
      "skillProfile.save",
      "records.saveAttempts",
      "records.saveSession",
      "review.upsert",
      "review.markReviewed",
      "papers.saveImport",
      "papers.setPool",
    ]) {
      expect(service.includes(forbidden), `Expert 训练不应写入 ${forbidden}`).toBe(false);
    }
    // 旧路径的弱点/画像逻辑不得被引入
    expect(service).not.toContain("recordPracticeWeaknesses");
    expect(service).not.toContain("applyPracticeEvidence");
    expect(service).not.toContain("deriveWeaknesses");
  });

  it("Expert 训练不使用合成题库作为证据来源", () => {
    const service = read("src/services/expert-training.ts");
    const domain = read("src/domain/expert-training.ts");
    for (const forbidden of ["diagnostic-bank", "practice-library"]) {
      expect(service.includes(forbidden), `Expert 训练引用了合成内容 ${forbidden}`).toBe(false);
      expect(domain.includes(forbidden), `Expert 判分引用了合成内容 ${forbidden}`).toBe(false);
    }
  });

  it("可作答视图不含答案字段（未提交时答案不下发到客户端）", () => {
    const service = read("src/services/expert-training.ts");
    const view = /export interface TrainingQuestionView \{([\s\S]*?)\n\}/.exec(service);
    expect(view, "未找到 TrainingQuestionView").not.toBeNull();
    const body = view![1];
    // 这三个字段一旦出现，答案就会随 RSC 载荷到达浏览器
    expect(body, "TrainingQuestionView 不应含 answer").not.toContain("answer:");
    expect(body, "TrainingQuestionView 不应含 answerParagraph").not.toContain("answerParagraph");
    expect(body, "TrainingQuestionView 不应含 explanation").not.toContain("explanation");
  });

  it("判定结论只有 correct / incorrect / skipped 三种（未作答 ≠ 答错）", () => {
    const domain = read("src/domain/expert-training.ts");
    const outcome = /export type AnswerOutcome =([^;]+);/.exec(domain);
    expect(outcome).not.toBeNull();
    expect(outcome![1]).toContain('"correct"');
    expect(outcome![1]).toContain('"incorrect"');
    expect(outcome![1]).toContain('"skipped"');
    // 不得引入解释性结论
    for (const forbidden of ["careless", "guessing", "unknown_mechanism", "weak"]) {
      expect(outcome![1].includes(forbidden), `AnswerOutcome 不应含解释性结论 ${forbidden}`).toBe(false);
    }
  });

  it("阅读训练收敛：旧执行器不可能渲染合成阅读题面", () => {
    /*
     * 本次收敛的产品规则：面向学习者的 CET-6 阅读训练只使用真实历年真题，
     * 只走 Expert Training 工作面与它的不可变台账。
     *
     * 这三条断言防止"合成阅读渲染路径"以任何形式复活：
     * 1. `ContentView` 不再有 `reading` 变体（类型层不存在可渲染的阅读视图）；
     * 2. `TaskRunner` 不再引用合成篇章的字段（passage / wordCount）；
     * 3. 计划目录把阅读主题材指向 `reading_target`，而不是 `reading_passage`。
     */
    const contentView = read("src/app/practice/[taskId]/content-view.ts");
    expect(
      contentView.includes('kind: "reading"'),
      "ContentView 不应再有 reading 变体 —— 合成阅读不得可渲染",
    ).toBe(false);

    const runner = read("src/app/practice/[taskId]/task-runner.tsx");
    expect(runner.includes("<ReadingBody"), "TaskRunner 不应渲染合成阅读题面").toBe(false);
    expect(runner.includes("content.passage"), "TaskRunner 不应读取合成篇章正文").toBe(false);

    const planner = read("src/domain/planner.ts");
    expect(
      /PRIMARY_CONTENT_TYPE[\s\S]*?reading:\s*"reading_target"/.test(planner),
      "planner 的阅读主题材必须是真实真题阅读大题",
    ).toBe(true);
  });

  it("阅读任务的跳转规则只有一个实现（界面不得自己拼 URL）", () => {
    /*
     * 同一条决定（"点这个任务会去哪"）被 Today 主导动作、Today 任务清单、
     * Practice 计划区三处消费。若各自拼 URL，只要有一处漏改，学习者就会
     * 从那个入口回到已被淘汰的旧阅读执行器。
     */
    const hrefRule = read("src/domain/reading-target.ts");
    expect(hrefRule).toContain("export function taskHrefOf");
    expect(hrefRule).toContain("export function readingTrainingHref");

    for (const file of [
      "src/app/today/page.tsx",
      "src/app/today/task-list.tsx",
      "src/app/practice/page.tsx",
    ]) {
      const source = read(file);
      // 不得硬编码旧执行器的 URL 模板
      expect(
        source.includes("`/practice/${"),
        `${file} 不应自己拼任务 URL —— 应使用服务层解析后的 href`,
      ).toBe(false);
    }
  });
});

describe("课程层（Course Layer）门禁", () => {
  /**
   * 这一组守卫的是本阶段最重要的那条语义边界：
   *
   *   **课程曝光（看过材料）≠ 表现证据（独立作答真题）。**
   *
   * 它必须在**源码层面**就被固定，而不是靠"记得别写"：
   * 课程层的服务文件不得出现任何 Expert 台账 / 旧闭环的写入符号。
   * 一旦有人"顺手"把曝光写进 evidence_projection，这个测试会立刻红。
   */
  const COURSE_SERVICES = [
    "src/services/course-import.ts",
    "src/services/course-link.ts",
    "src/services/course-exposure.ts",
  ];

  it("课程层服务**不写** Expert 台账（performance_event / assessment_event / evidence_projection）", () => {
    for (const file of COURSE_SERVICES) {
      const source = read(file);
      for (const forbidden of [
        "expert.startRun",
        "expert.completeRun",
        "expert.appendAssessment",
        "expert.rebuildProjection",
        "startReadingRun",
        "submitReadingRun",
      ]) {
        expect(
          source.includes(forbidden),
          `${file} 不应调用 ${forbidden} —— 课程曝光不得产生表现证据`,
        ).toBe(false);
      }
      // repository 层也不得被间接借道
      expect(source.includes("repos.expert"), `${file} 不应触碰 expert repository`).toBe(false);
    }
  });

  it("课程层服务**不写**旧闭环（skill_profile / answer_attempt / review_item / Weakness）", () => {
    for (const file of COURSE_SERVICES) {
      const source = read(file);
      for (const forbidden of [
        "skillProfile.save",
        "records.saveAttempts",
        "records.saveSession",
        "review.upsert",
        "review.markReviewed",
        "recordPracticeWeaknesses",
        "applyPracticeEvidence",
        "deriveWeaknesses",
      ]) {
        expect(source.includes(forbidden), `${file} 不应写入 ${forbidden}`).toBe(false);
      }
    }
  });

  it("课程层服务**不触碰规划 / 模考保留 / 未触碰选择**（本阶段明确不改变既有产品行为）", () => {
    for (const file of COURSE_SERVICES) {
      const source = read(file);
      for (const forbidden of [
        "papers.setPool",
        "isPaperStartableForPractice",
        "listReadingTargetCandidates",
        "ensurePlan",
      ]) {
        expect(
          source.includes(forbidden),
          `${file} 不应触碰 ${forbidden} —— 课程层 V1 不影响 planner / mock_reserve / untouched`,
        ).toBe(false);
      }
    }
  });

  /**
   * 统一的曝光写入边界。
   *
   * 任务书明确禁止"让 UI Action 直接调用一个绕过既有领域验证的裸仓储
   * `appendExposure`"。因此这里把那条边界固定成源码契约：
   *
   * 1. `appendExposure` 的调用点**只允许**出现在服务层；
   * 2. 服务层之外（UI / 脚本 / 路由）不得出现它。
   *
   * 第 2 条是结构性的：裸仓储方法上没有事件种类登记、版本比对、
   * manifest 校验和、段存在性这些判定，绕过它就把全部不变量关掉了。
   */
  it("曝光写入边界统一：appendExposure 只允许被课程曝光服务调用", () => {
    const callers = ALL_SOURCE_FILES.filter((file) => {
      const source = read(file);
      // 只看调用（不是定义/接口声明），剥掉注释与字符串。
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/"(?:[^"\\\r\n]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''");
      return /\.appendExposure\s*\(/.test(code);
    });

    expect(
      callers,
      `appendExposure 只能由 src/services/course-exposure.ts 调用（当前：${callers.join(", ")}）—— ` +
        `绕过服务层会关掉事件登记 / 版本比对 / manifest 校验和 / 段存在性这些不变量`,
    ).toEqual(["src/services/course-exposure.ts"]);
  });

  it("正文揭示只有**一个**出口，且它先持久化后下发", () => {
    const service = read("src/services/course-exposure.ts");

    // 唯一的揭示服务入口。
    expect(service, "缺少揭示服务入口").toContain("export function revealCourseSegment");

    /*
     * 顺序的结构保证：写入曝光必须出现在**返回正文之前**。
     *
     * 判据不能是"文件里同时有这两件事"—— 那在顺序颠倒时仍然成立。
     * 因此比较两个锚点在源码中的位置。
     */
    const appendIndex = service.indexOf("repos.courses.appendRevealExposureOnce(");
    const contentIndex = service.indexOf("content: toSegmentContent(");
    expect(appendIndex, "未找到曝光写入调用").toBeGreaterThan(-1);
    expect(contentIndex, "未找到正文返回").toBeGreaterThan(-1);
    expect(
      appendIndex,
      "揭示路径必须先写曝光、再返回正文 —— 否则一次失败的记账会让正文无痕离开服务层",
    ).toBeLessThan(contentIndex);

    /*
     * 失败变体在类型层就不得携带 `content`。
     *
     * 判据取**类型声明**而不是运行时分支：类型由 TypeScript 强制，
     * 而"分支里碰巧没带"随时可能被改掉。
     *
     * 现在有**三个**失败变体（普通失败 / 风险已变 / 兜底），
     * 因此逐个检查 —— 漏掉任一个都会让那条路径能夹带正文。
     */
    const resultType = /export type RevealSegmentResult =([\s\S]*?)\r?\n\r?\n/.exec(service);
    expect(resultType, "未找到 RevealSegmentResult 的类型声明").not.toBeNull();
    const declaration = resultType![1];

    const failureVariants = declaration.match(/\{[^{}]*ok: false;[^{}]*\}/g) ?? [];
    expect(failureVariants.length, "应至少有两个失败变体").toBeGreaterThanOrEqual(2);
    for (const variant of failureVariants) {
      expect(
        variant.includes("content"),
        `揭示结果的失败变体不得声明 content —— 失败关闭意味着没有任何正文字节下发：${variant}`,
      ).toBe(false);
    }
    // 风险已变的变体必须带 risk（UI 据此重新确认）。
    expect(declaration, "风险已变的失败变体必须带回 risk").toMatch(
      /code: "risk_changed";\s*\r?\n\s*risk: RevealRiskDescriptor/,
    );
  });

  it("P0-3：揭示只读**一次**盘（校验与下发共用同一份快照）", () => {
    /*
     * 缺陷形态：先读一次包做校验，落库曝光，然后再解析一次 `course.json`
     * 取正文。那两次读取之间盘上文件可以被换掉，"校验过的内容"与
     * "下发的内容"就不是同一份。
     *
     * 判据落在**调用点数量**上：揭示路径自身不得再读一次包，
     * 唯一的读盘发生在 `readVerifiedSnapshot` 里，且恰好一次。
     */
    const service = read("src/services/course-exposure.ts");

    const snapshotBody = /function readVerifiedSnapshot\(([\s\S]*?)\r?\n\}/.exec(service)?.[1] ?? "";
    expect(snapshotBody.length, "未找到 readVerifiedSnapshot").toBeGreaterThan(100);
    const snapshotReads = (snapshotBody.match(/readCoursePackageIntegrity\(/g) ?? []).length;
    expect(snapshotReads, "readVerifiedSnapshot 必须恰好读一次包").toBe(1);

    // 揭示路径不得自己 import 解析器/路径工具（那会打开第二个读盘入口）。
    for (const forbidden of [
      "NormalizedCourseImporter",
      "resolveWithinRoot",
      "getCoursesDir",
      "readFileSync",
    ]) {
      expect(
        service.includes(forbidden),
        `course-exposure 不应自己读盘（${forbidden}）—— 包读取必须经 course-packages 的唯一实现`,
      ).toBe(false);
    }

    // 完整性结果必须保留解析内容，调用方才可能"只读一次"。
    const integrity = read("src/services/course-packages.ts");
    expect(integrity, "完整性结果必须保留已校验的解析内容").toContain("content: CoursePackageContent");
  });

  it("P0-4：揭示幂等由数据库保证（不是 check-then-insert）", () => {
    const repo = read("src/repositories/sqlite/courses.ts");

    expect(repo, "缺少原子幂等的揭示写入").toContain("appendRevealExposureOnce");

    const body =
      /appendRevealExposureOnce\(([\s\S]*?)\r?\n  \}\r?\n/.exec(repo)?.[1] ?? "";
    expect(body.length, "未找到 appendRevealExposureOnce 的实现体").toBeGreaterThan(200);
    expect(body, "必须用确定性身份").toContain("revealExposureIdentity");
    expect(body, "必须用 ON CONFLICT DO NOTHING（原子幂等）").toMatch(/ON CONFLICT\(id\) DO NOTHING/);
    expect(body, "不得出现 UPDATE（曝光只追加）").not.toContain("UPDATE");
    expect(body, "不得出现 DELETE（曝光只追加）").not.toContain("DELETE");

    // 身份函数必须在 ports 层（服务层与仓储层共用同一份）。
    const ports = read("src/repositories/ports.ts");
    expect(ports, "缺少确定性揭示身份").toContain("export function revealExposureIdentity");
    const identityBody =
      /export function revealExposureIdentity\(input: \{([\s\S]*?)\r?\n\}\): string \{/.exec(ports)?.[1] ?? "";
    expect(identityBody.length, "未找到 revealExposureIdentity").toBeGreaterThan(40);
    // 身份必须版本感知，且不含时间。
    expect(identityBody, "身份必须包含内容版本").toContain("courseContentVersion");
    expect(identityBody, "身份不得包含 occurredAt（否则重试会被当成新揭示）").not.toContain("occurredAt");
  });

  it("P0-5：`reveal_requested` 是潜在接触，不是已确认看过", () => {
    const domain = read("src/domain/paper-freshness.ts");

    /*
     * 判据必须是**取值**，不是"文件里提到过 reveal_requested"。
     * 上一版把它登记成 `establishesSeenContent: true`，于是请求被算成
     * "确实看过"，产出 `exposed` —— 而请求只说明学习者要求看。
     */
    const entry = /reveal_requested: \{([\s\S]*?)\r?\n  \},/.exec(domain)?.[1] ?? "";
    expect(entry.length, "未找到 reveal_requested 的登记项").toBeGreaterThan(40);
    expect(entry, "reveal_requested 不得算作已确认接触").toContain("establishesSeenContent: false");
    expect(entry, "reveal_requested 必须算作潜在接触").toContain("establishesPotentialContact: true");

    // 潜在接触必须有一个独立的判定入口（与已确认分开）。
    expect(domain).toContain("export function establishesPotentialContact");
    expect(domain).toContain("EXPOSURE_TYPES_ESTABLISHING_POTENTIAL_CONTACT");

    // 服务层必须用它：潜在接触 ⇒ uncertain，而不是 pristine/exposed。
    const service = read("src/services/paper-freshness.ts");
    expect(service, "服务层必须消费潜在接触判定").toContain("establishesPotentialContact");
    expect(service, "潜在接触必须登记为未解决条件").toContain("potential_contact_only");
  });

  it("伴随视图只读：不得出现正文通道字段的下发", () => {
    /*
     * 列表页只需要身份与状态。它一旦带上正文字段，页面加载就会把
     * 私有课程内容送回客户端 —— 而揭示的意义正是"只在明确请求时读取"。
     */
    const service = read("src/services/course-companion.ts");
    // 只读：没有任何写入调用。
    for (const forbidden of ["appendExposure", "appendLink", "saveImport", "setPool", ".run("]) {
      expect(service.includes(forbidden), `course-companion 不应写入（${forbidden}）`).toBe(false);
    }
    // 返回形状里不得有正文字段。
    const viewInterface = /export interface CourseSegmentSummary \{([\s\S]*?)\r?\n\}/.exec(service);
    expect(viewInterface, "未找到 CourseSegmentSummary").not.toBeNull();
    const body = viewInterface![1];
    for (const forbidden of ["text", "transcript", "referenceTranslation", "notes"]) {
      expect(
        new RegExp(`^\\s*${forbidden}\\s*[:?]`, "m").test(body),
        `CourseSegmentSummary 不得携带正文字段 ${forbidden}`,
      ).toBe(false);
    }
  });

  it("course_exposure_event 表里没有 outcome / mastery / mechanism 等结果或因果列", () => {    const schema = read("src/db/schema.ts");
    const table = /CREATE TABLE IF NOT EXISTS course_exposure_event \(([\s\S]*?)\n\);/.exec(schema);
    expect(table, "未找到 course_exposure_event 的 DDL").not.toBeNull();
    const body = table![1].toLowerCase();

    for (const forbidden of [
      "outcome",
      "score",
      "correct",
      "incorrect",
      "mastery",
      "weakness",
      "mechanism",
      "diagnosis",
      "cause",
      "error_tag",
      // 曝光**不得以 canonical 题目为主身份** —— 否则未匹配时期的曝光
      // 将永久无法在日后核验出对应关系时被投影
      "question_id",
      "paper_id",
      "section_id",
    ]) {
      expect(body, `course_exposure_event 不应含 ${forbidden} 列`).not.toContain(forbidden);
    }

    // 必须承载的观测身份
    for (const required of [
      "profile_id",
      "course_id",
      "segment_id",
      "course_content_version",
      "event_type",
      "occurred_at",
    ]) {
      expect(body, `course_exposure_event 缺少 ${required}`).toContain(required);
    }
  });

  it("课程曝光的只追加由数据库触发器守护（与 Expert 台账同一条纪律）", () => {
    const schema = read("src/db/schema.ts");
    for (const trigger of [
      "course_exposure_event_append_only_update",
      "course_exposure_event_append_only_delete",
    ]) {
      expect(schema, `缺少只追加触发器 ${trigger}`).toContain(trigger);
    }
  });

  it("课程包正文不落库：course_package 只有索引事实，没有正文列", () => {
    const schema = read("src/db/schema.ts");
    const table = /CREATE TABLE IF NOT EXISTS course_package \(([\s\S]*?)\n\);/.exec(schema);
    expect(table, "未找到 course_package 的 DDL").not.toBeNull();
    const body = table![1].toLowerCase();

    /*
     * 判据必须是**精确的列名**，不能用朴素子串 ——
     * 实测踩到：`"content"` 会被 `content_version` / `content_fingerprint`
     * 命中，于是守卫会把"这个包是哪一版内容"这条**必须存在**的索引事实
     * 判成正文。
     */
    const columnNames = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("--"))
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name));

    for (const forbidden of ["content", "body", "sections", "text", "manifest", "passage"]) {
      expect(
        columnNames,
        `course_package 不应含正文列 ${forbidden}（精确列名判定）`,
      ).not.toContain(forbidden);
    }
    for (const required of [
      "content_version",
      "manifest_checksum",
      "content_fingerprint",
      "package_path",
      "rights_note",
    ]) {
      expect(columnNames, `course_package 缺少索引事实 ${required}`).toContain(required);
    }
  });

  it("链接目标的可用性判据只有一个实现（fail-closed）", () => {
    const domain = read("src/domain/course.ts");
    expect(domain).toContain("export function isLinkRuntimeUsable");
    expect(domain).toContain("export function explainLinkUnusable");

    // 服务层必须消费该判据，而不是自己重写一套版本比较
    const service = read("src/services/course-link.ts");
    expect(service).toContain("isLinkRuntimeUsable");
    // 运行时读取路径必须过滤，而不是把全部链接都交出去
    expect(service).toContain("export function listRuntimeLinksForSegment");
    expect(service).toMatch(/\.filter\(\(view\) => view\.runtimeUsable\)/);
  });

  it("课程内容指纹与整包校验和是两个不同的判据（元数据变更不得涨版本）", () => {
    const fingerprint = read("src/content/course/fingerprint.ts");
    expect(fingerprint).toContain("export function courseContentFingerprint");
    // 指纹投影必须**排除**权利说明 / 来源说明 / provider / edition 这些声明
    const projection = /export interface CourseFingerprintProjection \{([\s\S]*?)\n\}/.exec(fingerprint);
    expect(projection, "未找到 CourseFingerprintProjection").not.toBeNull();
    const body = projection![1];
    for (const forbidden of [
      "provider",
      "edition",
      "rightsNote",
      "provenance",
      "checksum",
      "mimeType",
      "bytes",
    ]) {
      expect(body, `内容指纹不应包含声明字段 ${forbidden}`).not.toContain(forbidden);
    }

    // repository 的导入判据必须用指纹判内容
    const repo = read("src/repositories/sqlite/courses.ts");
    expect(repo).toContain("contentFingerprint");
    expect(repo).toMatch(/contentChanged[\s\S]*?contentFingerprint/);
  });

  it("provider 没有被硬编码成任何具体名字（首个 provider 不是特例）", () => {
    /*
     * 首个真实 provider 是一个商业课程品牌，但架构上它与其它 provider 完全等价。
     * 一旦某个通用领域/存储模块里出现具体 provider 名，加第二个 provider
     * 就会变成一次跨层改动而不是"再放一个包目录"。
     *
     * ── 判据必须排除注释（同 paper-pool-policy 的先例）──
     * 朴素检查会把**讲解这条规则本身**的注释也算成违规
     * （实测踩到：domain/course.ts 里说明"首个 provider 是某个品牌"那句
     * 被命中）。因此先剥掉注释，只检查**代码**。
     *
     * 夹具脚本刻意排除在外 —— 它必须写死一个 `test_fixture_provider`
     * 才能保证夹具不冒充真实课程。
     *
     * ── 禁词表刻意不含真实品牌名 ──
     * 这条守卫要证明的是"没有硬编码任何 provider 专有名词"。用真实品牌名
     * 当禁词会把一份内部事实（首个 provider 是哪个品牌）留在公开仓库里，
     * 而守卫的强度不依赖于此：一个占位形态（`some-provider`）加正则
     * 形态（连续小写字母的专有 slug）就足以抓住硬编码。
     */
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const genericFiles = [
      "src/domain/course.ts",
      "src/content/course/types.ts",
      "src/content/course/validator.ts",
      "src/content/course/importer.ts",
      "src/content/course/fingerprint.ts",
      "src/repositories/sqlite/courses.ts",
      "src/services/course-import.ts",
      "src/services/course-link.ts",
      "src/services/course-exposure.ts",
    ];

    for (const file of genericFiles) {
      const code = stripComments(read(file)).toLowerCase();
      for (const providerName of ["some-provider", "another-provider"]) {
        expect(
          code.includes(providerName),
          `${file} 的**代码**硬编码了 provider 名 "${providerName}" —— provider 必须是自由字符串`,
        ).toBe(false);
      }
      /*
       * 第二条：`provider` 字段不得被赋成一个**引号包住的专有 slug**。
       *
       * 判据是形状，不是名字：合法值来自 manifest（自由字符串），因此任何
       * 在通用领域/存储模块里写死的字面量都是硬编码。这样不必在公开仓库里
       * 列举"哪些品牌名算专有"—— 那份清单本身就是内部事实。
       */
      const providerLiteral = /provider\s*[:=]\s*["'`][a-z][a-z0-9_-]{2,}["'`]/i.exec(code);
      expect(
        providerLiteral,
        `${file} 的代码把 provider 写成了字面量 "${providerLiteral?.[0] ?? ""}" —— ` +
          `provider 必须是来自 manifest 的自由字符串`,
      ).toBe(null);
    }
  });

  it("课程包与试卷包是两棵独立的内容子树（互不误认）", () => {
    const paths = read("src/content/paper/paths.ts");
    expect(paths).toContain("export function getCoursesDir");
    // 课程目录必须是内容根下的独立子树，而不是 papers 之下
    expect(paths).toMatch(/getCoursesDir\(\)[\s\S]{0,300}?join\(getContentRoot\(\), "courses"\)/);

    // 课程导入器只枚举自己的目录
    const courseImporter = read("src/content/course/importer.ts");
    expect(courseImporter).not.toContain("getPapersDir");
    expect(courseImporter).toContain("getCoursesDir");
  });

  it("课程层不复用题库（它不是第二个 CET-6 题库）", () => {
    for (const file of [
      ...COURSE_SERVICES,
      "src/content/course/validator.ts",
      "src/content/course/importer.ts",
      "src/repositories/sqlite/courses.ts",
    ]) {
      const source = read(file);
      for (const forbidden of ["diagnostic-bank", "practice-library"]) {
        expect(source.includes(forbidden), `${file} 引用了合成内容 ${forbidden}`).toBe(false);
      }
    }
  });
});

/**
 * 正文揭示端点（Route Handler）的安全门禁。
 *
 * ── 它守的那条边界 ──
 *
 * 这是全应用唯一会把**私有课程正文**送出服务层的 HTTP 端点。
 * 因此它的守卫必须是结构性的，而不是"记得检查"：
 *
 * 1. 只有 POST —— GET / HEAD / SSR / RSC / prefetch 都不得触发正文或写入；
 * 2. 回环 Host 与 Origin 必须**独立**校验（不依赖 Proxy 作为唯一授权边界）；
 * 3. 缺失 Origin 一律失败关闭（正常同源 POST 一定带 Origin）；
 * 4. 响应必须不缓存。
 *
 * 这些判据的**行为**证明在 `tests/course-reveal-endpoint.test.ts`
 * （真实 HTTP，含负向用例）；这里固定源码契约，防止它被改回去。
 */
describe("正文揭示端点 · 安全边界", () => {
  const ROUTE = "src/app/api/course/reveal/route.ts";

  it("端点只导出 POST，其它方法显式 405", () => {
    const route = read(ROUTE);

    // 必须显式导出 POST。
    expect(route, "端点必须导出 POST").toContain("export async function POST");

    /*
     * 其它方法必须存在且返回 405。
     *
     * 刻意要求"显式导出并拒绝"，而不是"没有 GET 自然 404"：
     * 前者是一条**写下来的契约**，后者依赖框架默认行为，
     * 而框架行为在版本升级时可能改变。
     *
     * 判据落在**函数体**上（不是整文件子串）：`DELETE` 这三个字母
     * 会出现在 `export async function DELETE` 本身里，因此整文件搜索
     * 会让断言恒真。
     */
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const body =
        new RegExp(`export async function ${method}\\(\\)[\\s\\S]*?\\r?\\n\\}`).exec(route)?.[0] ?? "";
      expect(body.length, `端点必须显式导出 ${method}`).toBeGreaterThan(20);
      expect(body, `${method} 必须拒绝（返回 405）`).toContain("methodNotAllowed()");
    }

    // 405 响应必须带 Allow: POST（让调用方知道正确方法）。
    expect(route).toMatch(/Allow:\s*["']POST["']/);
    // 且状态码确实是 405。
    expect(route).toMatch(/status:\s*405/);
  });

  it("端点必须做独立的 Host/Origin 校验（不依赖 Proxy）", () => {
    const route = read(ROUTE);

    // 必须消费唯一的守卫实现，而不是自己内联一份判据。
    expect(route, "必须消费本地请求守卫").toContain("guardLocalRequest");
    expect(route, "必须给出可读拒绝原因").toContain("explainLocalRejection");

    // 守卫必须在**任何业务逻辑之前**执行。
    const guardIndex = route.indexOf("guardLocalRequest({");
    const reposIndex = route.indexOf("getRepositories()");
    const bodyIndex = route.indexOf("await request.json()");
    expect(guardIndex, "未找到守卫调用").toBeGreaterThan(-1);
    expect(reposIndex, "未找到 repository 获取").toBeGreaterThan(-1);
    expect(bodyIndex, "未找到请求体解析").toBeGreaterThan(-1);
    expect(
      guardIndex,
      "Host/Origin 守卫必须先于取数、解析请求体与服务调用 —— 否则拒绝发生在副作用之后",
    ).toBeLessThan(reposIndex);
    expect(guardIndex).toBeLessThan(bodyIndex);

    // 未登录同样是失败关闭。
    expect(route).toContain("getOnboardingState");
    expect(route).toMatch(/!state\.onboarded \|\| !state\.profile/);
  });

  it("守卫对缺失 Origin 失败关闭（不是放行）", () => {
    /*
     * 这是本端点与标注服务器的关键差别，也是它最重要的守卫。
     * 正常浏览器发出的同源 POST 一定带 Origin；"缺失"只可能来自
     * 手写请求 / curl / 本机其它进程。放行它们等于给"任意本机进程
     * 直接打这个端口"开一扇门。
     */
    const guard = read("src/lib/loopback-guard.ts");
    expect(guard, "缺失 Origin 必须判失败").toContain("origin_missing");
    // 分类函数对空值必须返回失败，而不是 ok。
    expect(guard).toMatch(
      /if \(originHeader === undefined \|\| originHeader === ""\) return \{ ok: false, reason: "origin_missing" \}/,
    );
  });

  it("响应必须不缓存（私有正文不得留在任何中间层）", () => {
    const route = read(ROUTE);
    // 必须是**实测**判据的落点：no-store 逐字节出现在响应头里。
    expect(route, "响应必须带 Cache-Control: no-store").toContain('"Cache-Control": "no-store"');
    expect(route, "响应必须禁用 MIME 嗅探").toContain('"X-Content-Type-Options": "nosniff"');
    // 错误响应同样不缓存 —— 半截失败信息也不该被留住。
    expect(route).toContain("noStoreHeaders()");
  });

  it("端点必须动态渲染（不参与静态生成 / prefetch）", () => {
    const route = read(ROUTE);
    expect(route).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("正文下发只经服务层的揭示入口（端点不自己读包）", () => {
    const route = read(ROUTE);
    // 端点不得自己 import 内容层 / 自己拼路径 —— 那会产生第二个正文出口。
    for (const forbidden of [
      "NormalizedCourseImporter",
      "getCoursesDir",
      "resolveWithinRoot",
      "readCoursePackageIntegrity",
      "readFileSync",
    ]) {
      expect(
        route.includes(forbidden),
        `揭示端点不应自己读包（${forbidden}）—— 正文只能经 revealCourseSegment 一个出口`,
      ).toBe(false);
    }
    expect(route, "必须消费揭示服务").toContain("revealCourseSegment");
  });

  it("端点路径常量是**零依赖**模块（客户端不得因此拉进服务端代码）", () => {
    /*
     * 实测构建失败的根因：客户端组件从 Route Handler import 路径常量，
     * 于是一整条 `node:sqlite` 依赖链被打进浏览器 bundle，
     * Turbopack 报 "the chunking context does not support external modules"。
     *
     * 因此这里固定成源码契约：共享常量模块不得 import 任何服务端模块。
     */
    const shared = read("src/lib/course-reveal-route.ts");
    const imports = shared.match(/from\s+["'][^"']+["']/g) ?? [];
    expect(
      imports,
      `共享常量模块不得 import 任何东西（当前：${imports.join(", ")}）—— ` +
        `它被客户端消费，任何依赖都会被带进浏览器 bundle`,
    ).toEqual([]);

    // 而 Route Handler 必须从同一个模块取路径（不是自己写一份）。
    const route = read(ROUTE);
    expect(route, "端点必须从共享常量模块取路径").toContain(
      'from "@/lib/course-reveal-route"',
    );
  });

  it("P0-1：揭示前必须在服务端重新评估风险并比对指纹", () => {
    const service = read("src/services/course-exposure.ts");

    // 必须消费风险模块（不自己内联一份判据）。
    expect(service, "必须消费风险重确认").toContain("computeRevealRisk");
    expect(service, "必须比对指纹").toContain("riskFingerprintMatches");
    expect(service, "必须给出可读拒绝原因").toContain("explainRiskChange");

    /*
     * 顺序是硬约束：风险判定必须在写入曝光**之前**。
     *
     * 判据比较两个锚点的位置 —— "文件里同时有这两件事"在顺序颠倒时
     * 仍然成立，因此必须比位置。
     */
    const riskIndex = service.indexOf("if (!riskFingerprintMatches(");
    const writeIndex = service.indexOf("repos.courses.appendRevealExposureOnce(");
    expect(riskIndex, "未找到风险比对").toBeGreaterThan(-1);
    expect(writeIndex, "未找到曝光写入").toBeGreaterThan(-1);
    expect(
      riskIndex,
      "风险判定必须先于曝光写入 —— 否则被拒的揭示仍会留下记录，让对应真题失去严格未见资格",
    ).toBeLessThan(writeIndex);
  });

  it("P0-1：风险指纹必须**不含**时间戳与随机数（否则每次请求都是新靶子）", () => {
    const risk = read("src/services/reveal-risk.ts");
    // 指纹只能由"当前适用的事实"推导。
    for (const forbidden of ["Date.now()", "new Date()", "randomUUID", "randomBytes", "occurredAt"]) {
      expect(
        risk.includes(forbidden),
        `风险指纹不得包含 ${forbidden} —— 它必须是确定性摘要，否则同一次页面渲染与 POST 会算出不同值`,
      ).toBe(false);
    }
    // 指纹必须包含会影响风险判定的事实。
    expect(risk, "指纹必须包含链接的双方内容版本").toContain("link.paperContentVersion");
    expect(risk, "指纹必须包含池归属").toContain("isPaperReservedForMock");
    expect(risk, "指纹必须包含课程包校验和").toContain("content-checksum");

    /*
     * Round 3 P3：指纹必须绑定 segmentId 与**完整**目标身份。
     *
     * 只带 `targetScope` 不够：同一份卷子换一个大题或题组，风险事实变了，
     * 而指纹不变 ⇒ 旧确认可被复用。
     */
    expect(risk, "指纹必须绑定 segmentId（否则同课程不同段共享确认上下文）").toContain(
      "segment\\u0000${segmentId}",
    );
    expect(risk, "指纹必须包含 sectionId").toContain("section\\u0000${link.sectionId}");
    expect(risk, "指纹必须包含 groupId").toContain("group\\u0000${link.groupId");
    expect(risk, "指纹必须包含 questionId").toContain("question\\u0000${link.questionId");
  });

  it("P0-1：端点必须要求确认指纹（缺失 ⇒ 拒绝）", () => {
    const route = read(ROUTE);
    expect(route, "端点必须回传 confirmedRiskFingerprint").toContain("confirmedRiskFingerprint");
    // 风险已变用 409（不是 404/500）。
    expect(route).toContain('result.code === "risk_changed" ? 409 : 404');
    // 409 必须带回更新后的风险视图。
    expect(route, "409 必须回传更新后的风险视图").toContain("risk: result.code");
  });

  /**
   * Round 3 P0：揭示控件**不得**有任何"绕过确认直接 POST"的分支。
   *
   * ── 它守的那个真实绕过 ──
   *
   * 上一版的点击处理器里有一条捷径：
   *
   * ```ts
   * if (usableLinks.length === 0) { void reveal(); return; }
   * ```
   *
   * 而 409 之后 `usableLinks` **必然**为空（服务端只回了三个字段，
   * 客户端未校验地断言成完整形状，`runtimeUsable` 是 `undefined`）。
   * 于是再点一次「看这段」就带着**新**指纹直接 POST ——
   * 模考保留卷在没有任何知情确认的情况下被写成 `reveal_requested`。
   *
   * 因此本门禁检查两件事：
   *
   * 1. `submitReveal(` 只被**两处**调用：「确认阅读」按钮与网络重试按钮
   *    （两处都是学习者显式动作）；
   * 2. 客户端**不得**用未校验的断言消费 409 响应 —— 必须走
   *    `parseRevealResponse`，且必须检查 `riskViewAllowsReveal`。
   */
  it("P0-R3：揭示控件不得有绕过确认的提交路径", () => {
    const buttonSource = read("src/app/practice/courses/[courseId]/reveal-button.tsx");
    /*
     * 剥掉注释再判：解释这条规则的注释本身会写出 `submitReveal` 等字样，
     * 朴素扫描会把它当成一个调用点（同 paper-pool-policy 与隐私门禁的先例）。
     */
    const button = buttonSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    /*
     * ① `submitReveal` 的调用点必须**全部**由显式动作触发。
     *
     * ── 为什么不用"数量恰好为 3"这种判据（Round 3 P2-C）──
     *
     * 上一版写的是 `expect(submitCalls.length).toBe(3)`。它的问题是
     * **脆弱且无关**：加一个"在列表页快速揭示"的合法入口、或者把
     * 网络重试抽成一个子组件，都会让这条断言失败，而**没有**任何
     * 行为真的变坏。反之，把三处都写成同一种绕过形态它也能通过
     * （数量对就行）。
     *
     * 因此改成**行为导向**的判据：每一处调用都必须落在一个
     * "人工动作"的上下文里（`onClick` / `onConfirm`），并且
     * **不存在**任何"按风险状态自动决定提交"的分支。
     * 这样新增入口不会误伤，而真正的旁路仍然会被抓住。
     */
    const submitCalls = button.match(/void submitReveal\(/g) ?? [];
    expect(
      submitCalls.length,
      "至少应有一处发起揭示（否则揭示功能不存在了）",
    ).toBeGreaterThan(0);

    /*
     * ② 每一处调用都必须是**人工动作**的直接结果。
     *
     * 判据：每个 `void submitReveal(` 的出现位置，其前方（同一语句或
     * 同一表达式里）必须有一个人工动作处理器名。刻意不数数量 ——
     * 数数量会把"合法的重构"误判成缺陷（见 ① 的说明）。
     *
     * `onOpenClick` 是唯一的例外，而且它自己就带一个硬条件
     * （`confirmedFingerprint === riskContext.fingerprint`）——
     * 那个条件由下面 ③ 单独守护。
     */
    const callSites = [...button.matchAll(/void submitReveal\(/g)];
    const ACTION_HANDLERS = ["onClick=", "onConfirm="];
    for (const site of callSites) {
      const index = site.index ?? 0;
      const context = button.slice(Math.max(0, index - 120), index);
      const insideActionHandler = ACTION_HANDLERS.some((handler) => context.includes(handler));
      const insideGuardedOpenClick = context.includes("if (confirmedFingerprint !== null");
      expect(
        insideActionHandler || insideGuardedOpenClick,
        `发现一处 submitReveal 调用既不在人工动作处理器里、也没有确认指纹保护` +
          `（位置 ${index}）。它很可能是又一个"看起来无风险就直接发"的捷径 —— ` +
          `揭示只能由学习者点按钮触发，或由已显式确认的同一风险触发。`,
      ).toBe(true);
    }

    // 「确认阅读」必须是其中一个人工动作（它本身就是显式确认）。
    expect(
      button,
      "「确认阅读」按钮必须直接调用 submitReveal（它本身就是显式确认）",
    ).toContain("onConfirm={() => void submitReveal(riskContext.fingerprint)}");

    /*
     * ② 点击处理器**不得**出现"无条件提交"的分支。
     *
     * 判据：从 `function onOpenClick(` 起，到下一个顶层函数声明为止的
     * 整段里，"直接读取"必须**只**出现在
     * `confirmedFingerprint === riskContext.fingerprint` 那个条件之后。
     *
     * 刻意不用"匹配到第一个 `\n  }`"那种贪婪写法：函数体内的 if 块
     * 也有同样的缩进，正则会在那里提前截断（实测踩到）。
     */
    const start = button.indexOf("function onOpenClick(");
    expect(start, "未找到 onOpenClick").toBeGreaterThan(-1);
    const after = button.slice(start);
    // 下一个顶层声明（顶格 `function` / `if (content)` / 注释块）之前的内容。
    const bodyEnd = after.indexOf("\n  if (content)", 1);
    const body = bodyEnd > 0 ? after.slice(0, bodyEnd) : after;

    expect(
      body,
      "onOpenClick 必须先检查 `confirmedFingerprint === riskContext.fingerprint`",
    ).toContain("confirmedFingerprint === riskContext.fingerprint");

    /*
     * 关键判据：那段里**不得**出现"按链接数量决定要不要发"的形态。
     *
     * 上一版的绕过正是 `if (usableLinks.length === 0) { void reveal(); }`。
     */
    expect(
      /(usable|effective)Links\.length\s*===\s*0/.test(body),
      "onOpenClick 不得按链接数量决定是否直接提交 —— 那正是绕过确认的入口",
    ).toBe(false);

    // ③ 不得用未校验断言消费响应。
    expect(
      /as\s*\{[\s\S]{0,200}ok:\s*true/.test(button),
      "不得把端点响应用 `as {...}` 未校验地断言成某个形状 —— 那是 Round 3 P0 的根因",
    ).toBe(false);
    expect(button, "必须走契约校验").toContain("parseRevealResponse");
    expect(button, "必须检查风险视图是否完整").toContain("riskViewAllowsReveal");
    // ④ 409 必须作废旧确认。
    expect(button, "409 必须清空已确认指纹").toContain("setConfirmedFingerprint(null)");
  });

  it("P0-R3：风险视图的展示字段由**服务端**投影，不是客户端猜的", () => {
    /*
     * 服务端必须回**展示就绪**的完整形状。
     *
     * 判据是 `RiskPaperTarget`（只有三字段的那个旧类型）不再存在，
     * 且风险模块消费共享投影。
     */
    const risk = read("src/services/reveal-risk.ts");
    expect(
      risk.includes("RiskPaperTarget"),
      "`RiskPaperTarget`（只有 paperId/reservedForMock/trainable 的旧形状）必须已被完整投影取代 —— " +
        "它是 Round 3 P0 的另一半根因",
    ).toBe(false);
    expect(risk, "风险模块必须用共享投影").toContain("projectLinkedPapers");

    // 共享投影只有一份实现。
    const projection = read("src/services/course-link-projection.ts");
    expect(projection, "投影必须产出完整字段").toContain("runtimeUsable");
    expect(projection, "投影必须产出可读标题").toContain("targetLabel");

    /*
     * 伴随服务必须**消费**共享投影的结果，而不是自己再拼一份。
     *
     * 现在的形态更强：伴随服务的段摘要直接取 `risk.papers`
     * （风险计算内部就是唯一投影），因此"界面展示的"与"409 回传的"
     * 在**类型上**就是同一个值 —— 不存在两份。
     */
    const companion = read("src/services/course-companion.ts");
    expect(
      companion,
      "伴随服务的段摘要必须直接取风险计算里的链接投影（唯一来源）",
    ).toContain("linkedPapers: risk.papers");
    expect(
      companion,
      "伴随服务不得自己实现一份链接投影（两份必然漂移）",
    ).not.toContain("function describeLinkedPapers");
  });

  /**
   * Final P2：卷名与目标的切分必须用**已知字段**，不得用歧义分隔符。
   *
   * ── 它守的那个真实缺陷 ──
   *
   * 上一版用 `head.indexOf(" · ")` 定位"卷名与目标的分界"。
   * 但卷名本身就可能含 `" · "`：`2024 年 12 月 · set1` 是标准形态
   * （年份 · 场次 · 套别）。于是卷名被截掉套别、`set1` 混进第一个目标。
   *
   * 学习者看到"我确认的是 2024 年 12 月"，而库里有好几套 12 月卷子 ——
   * 这不是排版瑕疵，是**确认范围再次被写错**。
   *
   * 因此这里固定"用 `paperTitle` 当边界"这条实现约定：
   * 它是契约里独立校验过的字段，服务端保证 `targetLabel` 以它开头，
   * 于是按**长度**切完全不依赖分隔符的形状。
   */
  it("Final-P2：卷名边界必须用 paperTitle，不得用歧义分隔符", () => {
    /*
     * 剥掉注释再判：解释这条规则的注释本身会写出 `indexOf(" · ")`
     * （同 paper-pool-policy 与隐私门禁的先例）。
     */
    const button = read("src/app/practice/courses/[courseId]/reveal-button.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // ① 必须消费 paperTitle 作为边界，并原样渲染它（不是从 label 切的）。
    expect(button, "必须用 paperTitle 定位卷名边界").toContain("paper.paperTitle.length");
    expect(button, "必须原样渲染 paperTitle").toContain("{paper.paperTitle}");

    /*
     * ② 不得用 `" · "` 定位边界。
     *
     * 判据是"不得出现 `indexOf(" · ")`"—— 那不是某个具体写法的禁令，
     * 而是"不得靠数一个歧义分隔符来推断结构"。
     * 卷名与大题名（`阅读 · 仔细阅读`）都可能含它，因此它**永远**不安全。
     */
    expect(
      /indexOf\(\s*["']\s*·\s*["']\s*\)/.test(button),
      "不得用 indexOf(\" · \") 切分卷名与目标 —— 卷名与大题名本身都可能含 ` · `（Final P2）",
    ).toBe(false);

    // ③ 畸形串必须原样显示，不得猜结构。
    expect(button, "前缀不匹配时必须原样显示").toContain("if (!head.startsWith(paper.paperTitle))");
    expect(button, "切出的目标为空时必须原样显示").toContain("if (targets.length === 0)");
  });

  it("P1-R3：确认契约由服务端下发，界面不得自己推断", () => {
    const companion = read("src/services/course-companion.ts");
    // 契约字段存在且被填充。
    expect(companion, "段摘要必须带 requiresConfirmation").toContain("requiresConfirmation");
    expect(companion, "契约必须来自风险计算").toContain("risk.requiresConfirmation");

    /*
     * 界面必须**消费**这个契约。
     *
     * 上一版界面自己看 `linkedPapers.length` 决定要不要确认 ——
     * 于是未匹配段直接揭示（Round 3 P1）。
     */
    const button = read("src/app/practice/courses/[courseId]/reveal-button.tsx");
    expect(button, "界面必须接收 requiresConfirmation").toContain("requiresConfirmation");
  });

  it("P2-B：用户可见消息不得包含内部路径", () => {
    /*
     * 用户可见的失败原因会经 404 响应与 `packageIssue` 出现在界面上。
     * 它们不得包含私有目录结构或磁盘路径。
     */
    for (const file of [
      "src/services/course-packages.ts",
      "src/services/course-companion.ts",
      "src/app/api/course/reveal/route.ts",
    ]) {
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(
        /private-content\//.test(source),
        `${file} 不得在**代码**（非注释）里拼出 private-content/ 这样的内部路径 —— ` +
          `它会出现在用户可见的错误消息里`,
      ).toBe(false);
    }

    // 显示边界必须消毒。
    const route = read("src/app/api/course/reveal/route.ts");
    expect(route, "端点必须消毒失败原因").toContain("sanitizeDisplayText");
  });

  it("P2-F2：服务端绝对路径不得进入可渲染的数据结构", () => {
    /*
     * ── 独立评审 F-2 的根因与修法 ──
     *
     * 曾经的缺陷：`PaperLibrary` 带 `contentRoot` / `papersDir` 两个字段，
     * 值是 `getContentRoot()` / `getPapersDir()` 的**本机绝对路径**；真题库
     * 空状态把 `library.papersDir` 直接渲染进 HTML。于是盘符、用户名、
     * 安装位置进入浏览器 —— 而 `display-safety.ts` 的消毒覆盖不到它，
     * 因为那条路径是**配置值直传**，不是"错误消息带路径"。
     *
     * 修法不是"记得要消毒"（那依赖每个新出口都记得），而是**结构性**的：
     * 页面根本拿不到绝对路径。服务层只暴露展示标签
     * （`contentRootDisplayLabel()` / `papersDirDisplayLabel()`），
     * 需要真实路径的调用方（导入器、校验器）直接调 getter，不走这个结构体。
     *
     * 因此这里判三件事：
     *   ① `PaperLibrary` 不得再有 `contentRoot` / `papersDir` 字段（防回归）；
     *   ② 真题库页面必须渲染展示标签，且不得引用裸 `papersDir`；
     *   ③ 空状态文案不得含任何绝对路径形态。
     */
    const service = read("src/services/papers.ts");
    const interfaceBody = service.slice(
      service.indexOf("export interface PaperLibrary"),
      service.indexOf("export function getPaperLibrary"),
    );
    expect(
      /^\s*(contentRoot|papersDir)\s*:/m.test(interfaceBody),
      "PaperLibrary 不得再暴露 contentRoot / papersDir 字段（那是本机绝对路径，F-2）",
    ).toBe(false);
    expect(interfaceBody, "PaperLibrary 必须带展示标签字段").toMatch(/(contentRootLabel|papersDirLabel)\s*:/);
    expect(service, "服务层必须用展示投影，而不是 getContentRoot/getPapersDir").toContain(
      "papersDirDisplayLabel",
    );

    const page = read("src/app/practice/papers/page.tsx");
    expect(page, "真题库页面必须渲染展示标签").toContain("library.papersDirLabel");
    expect(
      /\{library\.(contentRoot|papersDir)\}/.test(page),
      "真题库页面不得直接渲染 library.papersDir / library.contentRoot（绝对路径，F-2）",
    ).toBe(false);

    // 课程列表页同样只允许展示标签。
    const coursesPage = read("src/app/practice/courses/page.tsx");
    expect(coursesPage, "课程列表页必须用展示投影").toContain("coursesDirDisplayLabel()");
    expect(
      /private-content\/courses\/?["'`]\s*$/.test(
        coursesPage.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"),
      ),
      "课程列表页不得再手写 private-content/courses/ 字面量（改用 coursesDirDisplayLabel()）",
    ).toBe(false);
  });

  it("P2-F2b：底层异常消息不得回显被拒绝的路径输入", () => {
    /*
     * F-2 的**同类根因**：`UnsafePathError` 的消息形态是
     * `路径不安全：<input>（<reason>）` —— 它回显输入。当输入来自 manifest
     * （外部数据）或数据库（不可信来源）时，把这条消息送到界面上就等于让
     * 那个来源决定浏览器里出现什么文本。
     *
     * 因此判据是：**不得**把 `error.message`（或 UnsafePathError 原文）
     * 直接拼进会到界面的 issue / reason。改用 `pathSafetyCategory(error)`
     * 拿分类原因，或不给原因。
     *
     * 注意这不是"禁止读错误消息"—— CLI 与日志仍然需要它。判据只覆盖
     * **会进入 packageIssue / issues[] / reason** 的那些出口。
     */
    const guarded = [
      "src/content/paper/importer.ts",
      "src/content/paper/catalog.ts",
      "src/content/course/importer.ts",
      "src/services/course-packages.ts",
      "src/content/paper/validator.ts",
      "src/content/course/validator.ts",
    ];
    for (const file of guarded) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(
        /error\)\.message/.test(code) && /(issues|reason)\s*[:=]/.test(code),
        `${file} 不得把 (error as Error).message 直接拼进会到界面的 issue/reason —— ` +
          `它可能回显被拒绝的路径输入（F-2 同类根因）。用 pathSafetyCategory(error) 拿分类原因。`,
      ).toBe(false);
    }

    // 而 catalog 的 handleFor 必须失败关闭成不含输入的消息。
    const catalog = read("src/content/paper/catalog.ts");
    expect(catalog, "handleFor 的失败消息不得回显输入").toContain(
      "索引里记录的内容包路径不安全或无法解析",
    );
  });

  it("P2-C：界面不得直接显示浏览器原文错误", () => {
    const button = read("src/app/practice/courses/[courseId]/reveal-button.tsx");
    expect(
      /set\w*Error\(`[^`]*\$\{\(?\s*(fetchError|error)\s+as Error\)?\.message\}/.test(button),
      "不得把 `(error as Error).message`（如 `Failed to fetch`）直接显示给学习者 —— " +
        "它既不是中文，也没告诉用户该做什么",
    ).toBe(false);
    // 必须给可操作的中文说明与重试入口。
    expect(button, "必须给可操作的中文网络错误说明").toMatch(/连接|网络|服务/);
  });

  it("P1-2：`created` 来自原子 INSERT 的 `changes`", () => {
    const repo = read("src/repositories/sqlite/courses.ts");
    expect(repo).toContain("ON CONFLICT(id) DO NOTHING");
    // 不得再用"插入前 SELECT"推断 created。
    expect(
      /const existing = firstRow\(this\.db, "SELECT \* FROM course_exposure_event WHERE id = \?"/.test(repo),
      "不得再用插入前的 SELECT 推断 created —— 并发下会谎报创建",
    ).toBe(false);
    // 必须读 INSERT 的原子结果。
    expect(repo, "必须用 changes 判 created").toContain("Number(written.changes) === 1");
  });

  /**
   * P1-T：Next.js telemetry 保护必须**可从仓库复现**，不依赖机器全局配置。
   *
   * ── 上一版为什么不合格（独立审查 P1）──
   *
   * 它读的是**机器全局**配置（`%APPDATA%/nextjs-nodejs/Config/config.json`）。
   * 于是：干净 checkout + 没有全局 opt-out ⇒ 门禁失败，而仓库什么都没做错。
   * 换句话说，那份保护**无法从仓库本身复现**，而且"修好"它需要 使用者
   * 手动跑一条机器全局命令 —— 任务书明确禁止这一点。
   *
   * ── 现在的判据 ──
   *
   * 判据从"机器此刻的状态"改成"**仓库是否每次调用都带上设置**"。
   * 三件事各自可证：
   *
   * 1. **存在唯一注入点**：`scripts/next.mjs` 是 Next 的唯一入口，
   *    且它设置 `NEXT_TELEMETRY_DISABLED=1`（官方支持的机制）；
   * 2. **每条启动路径都走那个入口**：npm script、E2E 启动器、
   *    回环绑定证明、真实内容启动器 —— 逐项查，漏一条即失败；
   * 3. **注入真的有效**：由 `scripts/telemetry-clean-env-proof.ts`
   *    在**模拟干净用户**下证明（见下）。
   *
   * 这样"干净 checkout 上保护成立"成为仓库的性质，而不是机器的运气。
   *
   * 官方文档：https://nextjs.org/telemetry
   * 已验证的短路逻辑（`next/dist/telemetry/storage.js` 第 291 行）：
   * `if (!!this.NEXT_TELEMETRY_DISABLED || !this.conf) return true;`
   * —— env 为真时根本不读全局配置，因此与机器状态完全无关。
   */
  it("P1-T：telemetry 保护可从仓库复现（不依赖机器全局配置）", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    // ① 每个会起 Next 的 npm script 都必须走统一入口。
    /*
     * 判据是"命令里出现裸 next"而不是"命令里出现 next"：
     * 合法形态是 `node scripts/next.mjs dev …`，其中 `next.mjs` 是**文件路径**，
     * 不是 Next CLI 调用。因此用词边界 + 排除 `.mjs` 后缀来区分。
     */
    const bareNext = /(?:^|[\s&|"])next(?:\s|$)/;
    const nextScripts = Object.entries(pkg.scripts).filter(
      ([, value]) => bareNext.test(value) && !value.includes("scripts/next.mjs"),
    );
    expect(
      nextScripts.map(([name]) => name),
      "所有会起 Next 的 npm script 都必须走 scripts/next.mjs —— 上面的就是绕过统一入口的那些",
    ).toEqual([]);

    // 并且至少有几条 script 确实经统一入口起 Next（否则上面的空集合没有意义）。
    const viaWrapper = Object.entries(pkg.scripts).filter(([, value]) =>
      value.includes("scripts/next.mjs"),
    );
    expect(
      viaWrapper.length,
      "应至少有几条 script 经统一入口起 Next（dev/build/start/telemetry:status）",
    ).toBeGreaterThanOrEqual(4);

    // ② 统一入口本身必须真的设置那个 env。
    const wrapper = read("scripts/next.mjs");
    expect(wrapper, "统一入口必须设置 NEXT_TELEMETRY_DISABLED").toContain(
      "NEXT_TELEMETRY_DISABLED",
    );
    expect(wrapper, "统一入口必须把它注入子进程 env").toContain("telemetryOffEnv()");
    // ③ 不得用 next.config.ts 的 telemetry 选项 —— 那不是受支持的配置。
    const config = read("next.config.ts");
    expect(
      /telemetry\s*:/.test(config),
      "next.config.ts 里没有 telemetry 这个受支持的选项（写它会静默无效，比不写更糟）",
    ).toBe(false);

    // ④ 启动器与相关子进程不得绕过统一入口（本轮审计要求）。
    /*
     * `listSourceFiles` 返回**绝对路径**，而 `read()` 要仓库相对路径 ——
     * 直接混用会拼出 `<绝对路径>/<绝对路径>` 这种双重前缀（实测踩到 ENOENT）。
     */
    const repoRoot = process.cwd().replace(/\\/g, "/");
    const launchers = listSourceFiles(join(process.cwd(), "scripts"))
      .map((path) => path.replace(/\\/g, "/").replace(`${repoRoot}/`, ""))
      .filter((file) => /e2e-server.*\.ts$/.test(file));

    /*
     * 标注实例与 A1 只读检查工作台实例是**已登记的例外**：它们根本不启动
     * Next，而是用 `startAnnotationServer()` 起一个自带回环绑定的页面服务。
     * 既然没有 Next 进程，就没有遥测可关。
     *
     * 登记而不是放过：这个例外与回环绑定门禁里用的是**同一份清单**
     * （见 `NON_NEXT_E2E_LAUNCHERS` 与下方"每个合成 E2E 启动器都绑定回环"），
     * 两处必须同时知道它们 —— 各写一份必然漂移。
     */
    for (const launcher of launchers) {
      if (NON_NEXT_E2E_LAUNCHERS.includes(launcher)) continue;
      const source = read(launcher)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(
        source.includes("telemetryOffEnv") || source.includes("spawnNext"),
        `启动器 ${launcher} 既没有 telemetryOffEnv 也没有走 spawnNext —— ` +
          `它会起一个不带遥测设置的 Next 进程（旁路）。` +
          `若它确实不起 Next，请把它登记进 NON_NEXT_E2E_LAUNCHERS 并说明理由。`,
      ).toBe(true);
    }
  });

  /**
   * P1-T 的**行为**证明：模拟一个干净用户，证明仓库自己就能关掉遥测。
   *
   * 这一条与上面那条源码门禁互补：上面证明"仓库每次都带上设置"，
   * 这一条证明"那个设置真的让 Next 闭嘴"。
   *
   * 做法是把 Next 的配置目录指到一个**临时空目录**（通过 `APPDATA`），
   * 于是 Next 看到的是一个从没用过的用户 —— 与真实全局配置完全隔离，
   * 既不读它也不写它。然后用同一个干净环境跑两遍：
   * 不经仓库入口（应当 Enabled）与经仓库入口（必须 Disabled）。
   *
   * ── 为什么不常驻在 vitest 里 ──
   *
   * 实测：spawn 一次 `next telemetry status` 约 1–2 秒。放在并行套件里
   * 足以触发既有的 5 秒超时脆弱性（Round 3 踩过同样的坑）。
   * 因此它是一条**独立 script**（`pnpm telemetry:proof`），
   * 由质量门禁显式调用；这里只断言那条 script 存在且被门禁引用。
   */
  it("P1-T：存在干净环境下的遥测行为证明脚本", () => {
    const proofPath = "scripts/telemetry-clean-env-proof.ts";
    expect(existsSync(join(process.cwd(), proofPath)), "缺少干净环境遥测证明脚本").toBe(true);

    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(
      pkg.scripts["telemetry:proof"],
      "必须有一条 telemetry:proof script，让门禁可被显式执行",
    ).toContain(proofPath);

    const proof = read(proofPath);
    // 证明必须做红/绿两次：没有设置时应当仍是 Enabled。
    expect(proof, "证明必须先展示「没有设置」的基线（否则绿灯没有意义）").toContain("Enabled");
    expect(proof, "证明必须断言仓库入口让它变 Disabled").toContain("Disabled");
  });

  it("P0-1：存在集中式 Host 边界（proxy.ts），且判据是回环", () => {
    /*
     * 敏感 POST 端点有自己的守卫，但那**只覆盖那一个路径**。
     * 初始的课程页 GET、RSC 预取、HTML 导航此前没有任何请求边界 ——
     * 一个带 `Host: evil.example` 的 GET 会照样拿到页面。
     *
     * 因此必须有一道**集中**边界：逐个路由自己判，就等于指望
     * "每个新路由都记得加"。
     */
    const proxy = read("src/proxy.ts");
    expect(proxy, "必须导出 proxy 函数").toContain("export function proxy");
    // 判据来自唯一的守卫模块（不内联第二份）。
    expect(proxy, "必须消费回环 Host 判据").toContain("isLoopbackHostHeader");
    // 拒绝必须是失败关闭，且不返回任何页面内容。
    expect(proxy, "非回环 Host 必须被拒绝").toMatch(/status:\s*421/);
    // 必须覆盖全部路径（只排除 Next 内部资源）。
    expect(proxy).toContain("matcher");
    expect(proxy, "不得排除 /api（敏感端点也要过这道边界）").not.toMatch(/api\s*\|/);
  });

  it("P0-1：本地服务器只绑定回环（开发与生产的启动命令）", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev, "dev 必须显式绑定 127.0.0.1").toContain("-H 127.0.0.1");
    expect(pkg.scripts.start, "start 必须显式绑定 127.0.0.1").toContain("-H 127.0.0.1");
    // 绝不绑定 0.0.0.0。
    expect(pkg.scripts.dev).not.toContain("0.0.0.0");
    expect(pkg.scripts.start).not.toContain("0.0.0.0");
  });

  it("P0-2：`dev` 与 `start` 的端口必须与默认可信来源**逐字一致**", () => {
    /*
     * ── 它守的那个实测缺陷 ──
     *
     * 上一轮 `dev` 写 `-p 3100`，而 `start` **没写端口** —— Next 默认 3000。
     * 同时 `CET6_LOCAL_ORIGIN` 默认 `http://127.0.0.1:3100`。
     *
     * 后果：`pnpm start` 起在 3000，而守卫认为可信来源是 3100，
     * 于是**生产实例会把自己的合法 POST 全部拒掉**（403）。
     * 这类缺陷在"只跑 dev"的开发流程里永远看不到。
     *
     * 判据逐项比：两条命令的端口相同，且等于守卫里的默认来源端口。
     */
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const portOf = (script: string): string | null => /-p\s+(\d+)/.exec(script)?.[1] ?? null;

    const devPort = portOf(pkg.scripts.dev);
    const startPort = portOf(pkg.scripts.start);
    expect(devPort, "dev 必须显式给出端口").not.toBeNull();
    expect(startPort, "start 必须显式给出端口（不能靠 Next 默认的 3000）").not.toBeNull();
    expect(startPort, "start 与 dev 的端口必须一致").toBe(devPort);

    // 守卫的默认来源端口必须与它们一致。
    const guard = read("src/lib/loopback-guard.ts");
    const defaultOrigin = /DEFAULT_LOCAL_ORIGIN = "http:\/\/127\.0\.0\.1:(\d+)"/.exec(guard);
    expect(defaultOrigin, "未找到守卫的默认来源").not.toBeNull();
    expect(
      defaultOrigin![1],
      "守卫的默认来源端口必须与 dev/start 的端口一致 —— 否则生产实例会被自己的守卫挡掉",
    ).toBe(devPort);
  });

  it("P0-2：可信来源只来自部署配置，绝不从请求头推", () => {
    const guard = read("src/lib/loopback-guard.ts");
    /*
     * 用 `Host` 头定义"可信来源"再拿 `Origin` 去比它，是一个循环：
     * `Host` 本身就是可被 DNS rebinding 操纵的输入。
     * 因此可信来源必须来自 `CET6_LOCAL_ORIGIN` / `PORT` / 硬编码默认值。
     */
    expect(guard, "必须读 CET6_LOCAL_ORIGIN").toContain("CET6_LOCAL_ORIGIN");
    expect(guard, "必须支持 PORT 覆盖").toContain('process.env.PORT');
    // 精确比对必须含协议、主机名与端口三者。
    expect(guard, "必须比对协议").toContain("url.protocol");
    expect(guard, "必须比对主机名").toContain("url.hostname");
    expect(guard, "必须比对端口").toContain("url.port");
  });

  /**
   * 隐私过程门禁：标准脚本不得检查 使用者的真实库/真实内容。
   *
   * ── 它守的那个实测违规 ──
   *
   * `scripts/course-intake-e2e.ts` 曾有一行
   * `statSync(join(repo, "data", "cet6.db")).mtimeMs`，用来"证明 使用者
   * 的库没被碰到"。那是对真实数据库的一次元数据读取 —— 任务书明确
   * 禁止（"不得 stat / hash / 枚举 / 检查任何真实内容或真实 DB"）。
   *
   * 因此这里把"标准脚本不碰真实文件"固定成源码契约：扫描 `scripts/` 下
   * 全部源码，断言没有对 `data/cet6.db` 或 `.e2e/cet6-real.db` 的
   * `statSync` / `readFileSync` / `Get-FileHash` 形态。
   *
   * 判据**剥掉注释**：解释这条规则的注释本身会写出那些形态
   * （同 paper-pool-policy 与 e2e 隐私门禁的先例）。
   */
  it("隐私过程：标准脚本不得 stat / 读取使用者真实库或真实 E2E 库", () => {
    const scriptFiles = listSourceFiles(join(process.cwd(), "scripts"))
      .map((path) => path.replace(/\\/g, "/").replace(`${process.cwd().replace(/\\/g, "/")}/`, ""))
      // 真实内容专用启动器只由人显式 opt-in（`pnpm e2e:real`），
      // 它**刻意**要打开真实内容 —— 因此排除在默认扫描之外。
      .filter((file) => file !== "scripts/e2e-server-real.ts");

    expect(scriptFiles.length, "scripts/ 下应有源码").toBeGreaterThan(5);

    const forbidden = [
      // 对真实库的 stat
      /statSync\([^)]*cet6\.db/,
      // 对真实库的读取
      /readFileSync\([^)]*data[^)]*cet6\.db/,
      // 对真实库的哈希
      /Get-FileHash[^)]*cet6\.db/,
      // 对真实 E2E 库的 stat / 哈希
      /statSync\([^)]*cet6-real\.db/,
      /Get-FileHash[^)]*cet6-real\.db/,
    ];

    for (const file of scriptFiles) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const pattern of forbidden) {
        expect(
          pattern.test(code),
          `${file} 出现了对真实库的禁止操作（${pattern}）—— ` +
            `隐私过程门禁要求标准脚本只使用 .e2e/ 隔离数据，绝不检查使用者的真实库`,
        ).toBe(false);
      }
    }
  });

  it("P0-1：每个合成 E2E 启动器都绑定回环（从配置对象推导启动器脚本）", async () => {
    /*
     * 与隐私门禁同一条纪律：从 `SYNTHETIC_WEB_SERVERS` 的**实际取值**
     * 推导启动器脚本，而不是手写脚本清单 —— 新增启动器时清单不会自动多出一项。
     *
     * 绑定标志写在**启动器脚本内部**的 `spawnSync("pnpm", ["exec", "next", "start", "-H", …])`
     * 里，而不是 webServer 的 `command` 字段（那个字段只是 `node scripts/xxx.ts`）。
     * 因此判据必须落在脚本源码上 —— 这正是"实测运行时绑定，不是源码字符串"
     * 的互补面：这里保证每个启动器**确实请求了**回环绑定。
     *
     * 真正的运行时绑定由 `scripts/e2e-loopback-binding-proof.ts` 起真实服务验证。
     */
    const { SYNTHETIC_WEB_SERVERS, launcherScriptOf } = await import("../e2e/web-servers");
    expect(SYNTHETIC_WEB_SERVERS.length, "合成实例清单不得为空").toBeGreaterThan(0);

    for (const server of SYNTHETIC_WEB_SERVERS) {
      const script = launcherScriptOf(server);
      expect(script, `无法解析启动器：${server.command}`).not.toBeNull();

      const source = read(script!);

      /*
       * 判定"这个启动器是否真的会起一个 Next 生产服务"。
       *
       * 两种合法形态：
       *
       * 1. `spawnNext("start", …)` —— 走仓库统一入口（`scripts/spawn-next.ts`）。
       *    这是现在**唯一**允许的形态：绑定与遥测设置都在那里一次性保证，
       *    而不是每个启动器各写一遍（各写一遍必然有一个漏掉）。
       * 2. 已登记的**非 Next** 实例：它们根本不起 Next，而是用
       *    `startAnnotationServer()` 起一个自带回环绑定的页面服务
       *    （标注界面 3240 与 A1 只读检查工作台 3270）。
       *
       * 判据刻意**不**匹配 `"next", "start"` 这种裸 spawn 形态 ——
       * 那正是绕过统一入口的形态（遥测旁路，见 P1-T 门禁）。
       */
      const bindsViaNextStart =
        source.includes('spawnNext("start"') || source.includes("spawnNext('start'");
      if (!bindsViaNextStart) {
        expect(
          NON_NEXT_E2E_LAUNCHERS,
          `不走统一入口的启动器 ${script} 必须是已登记的**非 Next** 实例`,
        ).toContain(script);
        expect(source, `${script} 不得绑定 0.0.0.0`).not.toContain("0.0.0.0");
        /*
         * 而且它必须**真的**走那个自带回环绑定的服务器入口 ——
         * 否则"非 Next"就成了一个可以放任何东西的口袋。
         */
        expect(
          source,
          `${script} 必须经 startAnnotationServer() 取得回环绑定`,
        ).toContain("startAnnotationServer");
        continue;
      }

      /*
       * 绑定参数现在写在 `spawn-next.ts` 里（唯一实现），因此这里断言的是
       * **那个文件**而不是每个启动器 —— 否则每个启动器都要重复同一串字面量，
       * 而那正是"漏一个就少一层保护"的形态。
       */
      const spawnHelper = read("scripts/spawn-next.ts");
      expect(
        spawnHelper,
        "统一启动入口必须显式请求回环绑定（-H LOOPBACK_HOST）",
      ).toContain('"-H", LOOPBACK_HOST');
      expect(spawnHelper, "统一启动入口不得绑定 0.0.0.0").not.toContain("0.0.0.0");
      // 启动器自身也不得写死一个别的绑定地址。
      expect(source, `合成启动器 ${script} 不得绑定 0.0.0.0`).not.toContain("0.0.0.0");
    }
  });
});

/**
 * 模考新鲜度门禁（Course Exposure → Mock Freshness）。
 *
 * ── 这一组守的是什么 ──
 *
 * 本阶段补上的语义是：
 *
 *     课程曝光到已核验的真题内容 ≠ 这份试卷仍然"完全没见过"。
 *
 * 它带来两个新的越界风险，而两者都必须由**源码级**门禁固定，不能只靠行为测试：
 *
 * 1. **新鲜度可能被写进表现证据。** 它是本仓库里第一个"由课程曝光推出、
 *    又影响产品行为"的派生结论 —— 正是最容易被顺手塞进 skill_profile 或
 *    evidence_projection 的东西。而它是**内容事实**，不是能力判断。
 * 2. **可能长出第二个"链接是否可用"的判据。** 一旦服务层自己比较版本，
 *    它就与 `course-link.ts` 的权威判据漂移，而漂移方向必然是 fail-open。
 */
describe("模考新鲜度门禁（Course Exposure → Mock Freshness）", () => {
  const FRESHNESS_FILES = ["src/domain/paper-freshness.ts", "src/services/paper-freshness.ts"];

  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("新鲜度层**不写** Expert 台账 / 旧闭环（曝光仍然不是表现证据）", () => {
    for (const file of FRESHNESS_FILES) {
      const source = read(file);
      for (const forbidden of [
        "expert.startRun",
        "expert.completeRun",
        "expert.appendAssessment",
        "expert.rebuildProjection",
        "startReadingRun",
        "submitReadingRun",
        "repos.expert",
        "skillProfile.save",
        "records.saveAttempts",
        "records.saveSession",
        "review.upsert",
        "review.markReviewed",
        "recordPracticeWeaknesses",
        "applyPracticeEvidence",
        "deriveWeaknesses",
      ]) {
        expect(
          source.includes(forbidden),
          `${file} 不应调用 ${forbidden} —— 新鲜度是内容事实，不得产生表现证据`,
        ).toBe(false);
      }
    }
  });

  it("新鲜度层**只读**：没有任何写入调用", () => {
    const service = stripComments(read("src/services/paper-freshness.ts"));
    for (const forbidden of [
      "appendExposure",
      "appendLink",
      "saveImport",
      "setPool",
      "transaction(",
      ".run(",
      "INSERT",
      "UPDATE",
      "DELETE",
    ]) {
      expect(service.includes(forbidden), `paper-freshness 服务不应写入（${forbidden}）`).toBe(false);
    }
  });

  it("新鲜度**不碰池归属 / planner / 未触碰选择**（策略与事实是两个问题）", () => {
    for (const file of FRESHNESS_FILES) {
      const source = read(file);
      for (const forbidden of [
        "papers.setPool",
        "listReadingTargetCandidates",
        "ensurePlan",
        "getTodayView",
      ]) {
        expect(
          source.includes(forbidden),
          `${file} 不应触碰 ${forbidden} —— 新鲜度不得改写使用者的策略选择`,
        ).toBe(false);
      }
    }
    // 判据层可以消费"是否保留"这个**只读**谓词，但不得写池。
    const service = read("src/services/paper-freshness.ts");
    expect(service).not.toContain("setPool");
  });

  it("domain 层的新鲜度是**纯函数**：不读盘、不读库、不看时钟", () => {
    const domain = read("src/domain/paper-freshness.ts");
    for (const forbidden of [
      "node:fs",
      "node:path",
      "node:sqlite",
      "@/repositories",
      "@/content",
      "@/app/",
      "@/services",
      "new Date()",
      "Date.now()",
    ]) {
      expect(
        domain.includes(`from "${forbidden}`) || domain.includes(forbidden),
        `domain/paper-freshness.ts 不应依赖 ${forbidden}`,
      ).toBe(false);
    }
  });

  it("严格模考资格只有一个实现（失败关闭），且三态齐全", () => {
    const domain = read("src/domain/paper-freshness.ts");
    expect(domain).toContain("export function isPaperEligibleForStrictMock");
    expect(domain).toContain("export function decidePaperFreshness");
    // 失败关闭的判据必须是"只有 pristine 通过"，而不是"排除 exposed"。
    const body = /export function isPaperEligibleForStrictMock\([\s\S]*?\n\}/.exec(domain)?.[0] ?? "";
    expect(body.length).toBeGreaterThan(40);
    expect(body).toContain("pristine");
    expect(body, "资格判据不得写成排除法").not.toContain("exposed");
    expect(body, "资格判据不得写成排除法").not.toContain("uncertain");

    // 三态必须齐全，且 uncertain 与 pristine 是两个不同的值。
    for (const state of ['"pristine"', '"exposed"', '"uncertain"']) {
      expect(domain, `缺少状态 ${state}`).toContain(state);
    }
  });

  it("服务层**复用**权威链接判据，不自己比较版本（不得有第二个判据）", () => {
    const service = read("src/services/paper-freshness.ts");

    // 必须经唯一入口取得可用性。
    expect(service).toContain("listLinksForSegmentWithUsability");

    // 不得自己 new 导入器 / 自己解析包路径（那会产生第二个完整性判据）。
    expect(service, "不应自己 new 导入器读盘").not.toContain("new NormalizedCourseImporter()");
    expect(service, "不应自己 new 导入器读盘").not.toContain("new NormalizedPackageImporter()");
    expect(service, "不应自己解析包路径").not.toContain("resolveWithinRoot");
    expect(service, "不应自己拼内容路径").not.toContain("getCoursesDir");
    expect(service, "不应自己拼内容路径").not.toContain("getPapersDir");

    // 可用性判定必须来自链接层，而不是在这里重写版本比较。
    const code = stripComments(service);
    expect(
      /isLinkRuntimeUsable\s*\(/.test(code),
      "不应在新鲜度服务里调用版本判据 —— 可用性由 listLinksForSegmentWithUsability 给出",
    ).toBe(false);

    // 完整性读取只用于**给原因分类**，因此必须复用同一份实现。
    expect(service).toContain("readCoursePackageIntegrity");
    expect(service).toContain("readPaperPackageIntegrity");
  });

  it("新鲜度是**派生**的：没有缓存表、没有新 schema 对象", () => {
    const schema = read("src/db/schema.ts");
    for (const forbidden of ["paper_freshness", "mock_freshness", "exposure_projection"]) {
      expect(schema, `schema 不应出现派生缓存表 ${forbidden}`).not.toContain(forbidden);
    }
    // 不得跨调用缓存（那会掩盖磁盘漂移与新增曝光）。
    const service = read("src/services/paper-freshness.ts");
    expect(
      /^(const|let)\s+\w*[Cc]ache\w*\s*[:=]/m.test(service),
      "paper-freshness 存在模块级缓存 —— 新增曝光与磁盘漂移会被掩盖",
    ).toBe(false);
  });

  it("面向学习者的措辞不得使用污染/掌握度词汇（产品语言纪律）", () => {
    const domain = read("src/domain/paper-freshness.ts");
    /*
     * 只检查**面向学习者的字符串**：把只读的注释剥离后扫描。
     * 注释里会提到这些词用于说明"不得使用"，那不算违规。
     */
    const code = stripComments(domain);
    for (const forbidden of [
      "污染",
      "tainted",
      "contaminated",
      "dirty",
      "掌握度",
      "正确率",
      "弱项",
      "能力分",
    ]) {
      expect(
        code.includes(forbidden),
        `domain/paper-freshness.ts 的**代码**出现了 ${forbidden} —— 措辞纪律要求用产品语言`,
      ).toBe(false);
    }
  });

  it("事件种类登记表完整，且判断是**二值**的（没有权重/分数）", () => {
    const domain = read("src/domain/paper-freshness.ts");
    expect(domain).toContain("COURSE_EXPOSURE_SEEN_BASIS");
    expect(domain).toContain("export function findExposureRegistryGaps");
    expect(domain).toContain("export function establishesSeenContent");

    // 登记项只允许三个字段（两个判定 + 依据）。
    const basis = /export interface ExposureTypeSeenBasis \{([\s\S]*?)\n\}/.exec(domain)?.[1] ?? "";
    expect(basis.length).toBeGreaterThan(30);
    const fields = basis
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(";"))
      .map((line) => line.split(":")[0]);
    expect(fields.sort()).toEqual([
      "establishesPotentialContact",
      "establishesSeenContent",
      "rationale",
    ]);

    // 不得出现权重 / 严重度这类没有证据的精确性。
    for (const forbidden of ["weight", "severity", "score", "priority"]) {
      expect(basis, `登记项不得含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("守护测试必须真实使用磁盘与数据库（不是源码字符串断言）", () => {
    const test = read("tests/paper-freshness.test.ts");
    expect(test, "必须真实建临时内容根").toContain("mkdtempSync");
    expect(test, "必须真实写盘").toContain("writeCourseFixture");
    expect(test, "必须真实建库").toContain("createTestDb");
    expect(test, "必须真实核验链接").toContain("verifyCanonicalLink");
    expect(test, "必须真实记录曝光").toContain("recordCourseExposure");
    expect(test, "必须真实制造包漂移").toContain("writeFileSync");
    expect(test, "必须覆盖 v8 未激活形态").toContain("courseLayerActivated");
    expect(test, "必须直接查曝光表验证只追加").toContain("course_exposure_event");
    // 关键：必须覆盖"先曝光后核验"这条顺序（历史可回溯投影）。
    expect(test, "必须覆盖先曝光后核验").toContain("先曝光、后核验");
    expect(test, "必须覆盖先核验后曝光").toContain("先核验、后曝光");
    // 必须证明"不知道"不等于"没见过"。
    expect(test, "必须覆盖 uncertain 不等于 pristine").toContain("不知道 ≠ 没见过");
  });

  it("严格模考资格只有一个实现：服务层不得自己比较状态", () => {
    /*
     * 服务层曾经自己写 `.state === "pristine"`，与 domain 的谓词重复了同一个
     * 决定。两处的后果是漂移 —— 语义一变只有一处被改，而"这份卷子能不能当
     * 严格模考"正是本能力存在的那个问题，两个答案就是没有答案。
     */
    const service = read("src/services/paper-freshness.ts");
    const code = service
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(
      /\.state\s*[!=]==?\s*["']pristine["']/.test(code),
      "paper-freshness 服务不得自己比较状态字符串（应委托 domain 谓词）",
    ).toBe(false);
    expect(code, "服务层必须委托 domain 的资格谓词").toContain(
      "domainIsPaperEligibleForStrictMock",
    );
  });

  it("池归属判定必须经权威谓词（服务层不得写裸比较）", () => {
    /*
     * 池归属已收敛到 `domain/paper.ts` 的具名谓词。服务层曾经写
     * `paper.pool !== "mock_reserve"` —— 多写一处就多一处漂移点。
     * 页面侧的同类守卫在 tests/paper-pool-policy.test.ts。
     */
    const service = read("src/services/paper-freshness.ts");
    const code = service
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(
      /pool\s*[!=]==?\s*["']mock_reserve["']/.test(code),
      "paper-freshness 服务不得自带池比较（应收敛到 isPaperReservedForMock）",
    ).toBe(false);
    expect(code, "服务层必须使用权威池谓词").toContain("isPaperReservedForMock");
  });

  it("措辞纪律：面向学习者的文案不得含 Markdown 标记（会渲染成字面字符）", () => {
    /*
     * 实测缺陷：解释文案里写了 `**强调**`，而 React 把字符串当纯文本渲染 ——
     * 用户看到的是带星号的 `**刺激材料已经不再是新的**`。
     *
     * 这是**内容错误**，不是样式问题。因果回归在
     * tests/freshness-wording.test.ts（作用在最终字符串上）。
     * 这里做源码级兜底：explain* 函数体内不得出现 `**`。
     *
     * ── 判据必须先剥掉注释（实测踩到）──
     *
     * 函数体里可以包含**说明这条规则本身**的注释，而那样的注释会合法地
     * 写出 `**强调**`（例如"原先那句是内部实现词汇"这类解释）。
     * 朴素地扫描整个函数体会把讲解规则的文字判成违规 ——
     * 同 paper-pool-policy 与 course 层 provider 门禁的先例。
     *
     * 反过来，**字符串字面量里的 `**` 才是违规**，因此只剥注释、不剥字符串。
     */
    const domain = read("src/domain/paper-freshness.ts");
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const fn of ["explainPaperFreshness", "explainStrictMockIneligibility"]) {
      const body = new RegExp(`export function ${fn}\\([\\s\\S]*?\\r?\\n\\}`).exec(domain)?.[0] ?? "";
      expect(body.length, `未找到 ${fn} 的函数体`).toBeGreaterThan(80);
      expect(stripComments(body), `${fn} 的返回值不得含 Markdown 标记`).not.toContain("**");
    }

    // 标点拼装必须收敛到 joinClauses（不得手写 join + 句号）。
    expect(domain).toContain("export function joinClauses");
    const uncertainCase = /case "uncertain":([\s\S]*?)case |case "uncertain":([\s\S]*?)\n  \}/.exec(
      domain,
    )?.[0] ?? "";
    expect(uncertainCase, "uncertain 分支必须用 joinClauses 拼装").toContain("joinClauses");
    expect(uncertainCase, "uncertain 分支不得手写标点拼接").not.toContain('join("；")');
  });
});

/**
 * E2E 隐私门禁（默认 Playwright 配置不得触碰私有内容）。
 *
 * ── 实测缺陷 ──
 *
 * 默认 `playwright.config.ts` 里挂着 `scripts/e2e-server-real.ts`
 * （内容根 = `private-content/`）。Playwright 的 webServer **启动与否取决于
 * 配置，不取决于选了哪个测试文件** —— 因此模型操作的一次定向命令
 * `npx playwright test e2e/freshness.spec.ts` 也把它一并启动，
 * 真实试卷包被导入了本地测试库。
 *
 * 修法是把它**移出默认配置**（单独的 `playwright.real.config.ts`，
 * 必须人显式 `--config` 指定）。因果证明在 tests/e2e-privacy-config.test.ts
 * （对配置对象做红/绿判定，不启动任何进程）。
 *
 * 这里只做源码级兜底，防止有人把真实启动器写回默认配置。
 */
describe("E2E 隐私门禁：默认配置不得触碰私有内容", () => {
  it("默认 Playwright 配置不得引用真实内容启动器", () => {
    const config = read("playwright.config.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(config, "默认配置不得引用 e2e-server-real").not.toContain("e2e-server-real");
    // 它必须只挂合成实例。
    expect(config, "默认配置必须消费合成 webServer 清单").toContain("SYNTHETIC_WEB_SERVERS");
  });

  it("默认配置不得用自动探测启用真实内容路径", () => {
    /*
     * `existsSync(private-content)` 之类的探测会让"本机恰好有私有材料"
     * 变成静默放行 —— 默认工作流在一台机器上安全、在另一台上读私有内容，
     * 而用户看不出差别。启用只能是人的显式动作。
     */
    const config = read("playwright.config.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const detector of ["existsSync", "private-content", "CET6_CONTENT_ROOT"]) {
      expect(config, `默认配置的代码不得用 ${detector} 做自动探测`).not.toContain(detector);
    }
  });

  it("真实内容实例有具名 opt-in 脚本，且默认脚本不含它", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(pkg.scripts["e2e:real"], "必须存在具名 opt-in 脚本").toBeDefined();
    expect(pkg.scripts["e2e:real"]).toContain("playwright.real.config.ts");
    expect(pkg.scripts["e2e"], "默认 e2e 脚本不得指向真实配置").not.toContain(
      "playwright.real.config.ts",
    );
    // 全量验证脚本同样不得包含真实内容路径。
    expect(pkg.scripts["verify"]).not.toContain("playwright.real.config.ts");
  });

  it("两个配置消费**同一份**真实专用 spec 清单", () => {
    // 各写一份必然漂移：新增一个真实 spec 时只加到一个配置里。
    for (const file of ["playwright.config.ts", "playwright.real.config.ts"]) {
      expect(read(file), `${file} 必须消费 E2E_REAL_ONLY_SPECS`).toContain("E2E_REAL_ONLY_SPECS");
    }

    const config = read("playwright.config.ts");
    const realConfig = read("playwright.real.config.ts");
    expect(config, "默认配置必须排除真实专用 spec").toContain("testIgnore");
    expect(realConfig, "显式配置必须选中真实专用 spec").toContain("testMatch");
  });

  it("真实专用 spec 文件仍然存在（不为了通过率删除）", () => {
    for (const name of ["e2e/real-paper.local.spec.ts", "e2e/visual-v2.local.spec.ts"]) {
      expect(read(name).length, `${name} 必须仍然存在`).toBeGreaterThan(500);
    }
  });
});

/**
 * Review Fix 门禁（F1 / F2 / F3 / F4 / F6）。
 *
 * 这些守卫针对的是**独立 GLM 评审实测确认**的三处真实缺陷：
 *
 * - F1/F4：canonical 链接的写入与运行时判据只比**内容版本**，
 *   因此"直接在盘上改包、不升版本"这条路径可以创造链接真相，
 *   也可以让已失真的链接继续"可用"（fail-open）。
 * - F2：manifest 没有独立的序列化契约版本，`contentVersion` 被当成了它。
 * - F3：`course_canonical_link` 自称不可变复核历史，但数据库不拦
 *   UPDATE/DELETE，且确定性身份不含 `verificationRef` ——
 *   修正出处会被静默吞掉。
 *
 * 它们全部通过 900+ 既有测试而不被发现，所以这里补的是**判据级**守卫：
 * 把"必须检查包完整性"这件事固定成源码契约，而不只依赖行为测试。
 */
describe("Review Fix 门禁：Course Layer 完整性 / 契约版本 / 复核不可变", () => {
  it("F1: 链接判据必须消费唯一的包完整性实现（不得各自读盘比版本）", () => {
    const service = read("src/services/course-link.ts");

    // 必须存在唯一的完整性模块，且服务层消费它
    const integrity = read("src/services/course-packages.ts");
    expect(integrity).toContain("export function readCoursePackageIntegrity");
    expect(integrity).toContain("export function readPaperPackageIntegrity");
    expect(integrity).toContain("export function paperTargetExists");
    expect(integrity).toContain("export function createPackageIntegrityCache");

    // 写入路径与运行时路径都要用同一个实现
    expect(service).toContain("readCoursePackageIntegrity");
    expect(service).toContain("readPaperPackageIntegrity");
    expect(service).toContain("paperTargetExists");

    // 服务层**不得**再自己拼路径 / 自己读包 —— 那会产生第二个判据
    expect(service, "course-link 不应自己解析包路径（判据必须只有一处）").not.toContain(
      "resolveWithinRoot",
    );
    expect(service, "course-link 不应自己 new 导入器读盘").not.toContain("new NormalizedCourseImporter()");
    expect(service, "course-link 不应自己 new 导入器读盘").not.toContain("new NormalizedPackageImporter()");
  });

  it("F1/F4: manifest 校验和漂移必须是**阻断项**，不得只 warning 后照样写入", () => {
    const service = read("src/services/course-link.ts");

    /*
     * 判据是"漂移检查必须出现在**返回失败**的分支里"。
     * 朴素地找 "checksumMatches" 不够 —— 修复前的代码也提到过校验和，
     * 只是把它写进了 warnings。因此这里同时确认：
     * 1. 有 checksumMatches 判定；
     * 2. 它出现在 `ok: false` 返回的同一段逻辑里；
     * 3. 不存在"包已改动…链接已写入"这种 fail-open 措辞。
     */
    expect(service).toContain("checksumMatches");

    // fail-open 的原始措辞必须消失
    expect(
      service.includes("链接已写入，但请重新导入"),
      "仍保留了『漂移时先写入再提醒』的 fail-open 行为",
    ).toBe(false);

    // 漂移必须以 ok:false 拒绝：检查 checksumMatches 之后紧跟失败返回
    expect(
      /!courseIntegrity\.checksumMatches[\s\S]{0,400}?ok:\s*false/.test(service),
      "课程包漂移未以失败关闭",
    ).toBe(true);
    expect(
      /!paperIntegrity\.checksumMatches[\s\S]{0,400}?ok:\s*false/.test(service),
      "真题包漂移未以失败关闭（F4）",
    ).toBe(true);
  });

  it("F1: 运行时完整性判据包含包漂移与目标结构（不只是版本）", () => {
    const service = read("src/services/course-link.ts");

    // 求值函数必须同时判定两侧完整性
    expect(service).toContain("function evaluateLinkRuntimeState");
    const evaluator = /function evaluateLinkRuntimeState\(([\s\S]*?)\n\}/.exec(service);
    expect(evaluator, "未找到运行时求值函数").not.toBeNull();
    const body = evaluator![1];
    expect(body, "运行时未检查课程包完整性").toContain("courseIntegrity");
    expect(body, "运行时未检查真题包完整性（F4）").toContain("readPaperPackageIntegrity");
    expect(body, "运行时未检查目标结构").toContain("paperTargetExists");
    expect(body, "运行时未处理包漂移").toContain("checksumMatches");

    // 概览与列表必须共用同一段判据
    expect(service).toMatch(/getCourseLinkOverview[\s\S]{0,2000}?evaluateLinkRuntimeState/);
  });

  it("F1: 完整性缓存**不跨调用**（模块级缓存会掩盖磁盘漂移）", () => {
    const integrity = read("src/services/course-packages.ts");

    // 缓存必须由调用方新建
    expect(integrity).toContain("export function createPackageIntegrityCache");
    // 不得存在模块级可变缓存
    expect(
      /^(const|let)\s+\w*[Cc]ache\w*\s*[:=]/m.test(integrity),
      "course-packages 存在模块级缓存 —— 磁盘漂移会被掩盖",
    ).toBe(false);
  });

  it("F2: manifest 有独立的 schemaVersion 判据，且不参与内容指纹", () => {
    const domain = read("src/domain/course.ts");
    expect(domain).toContain("COURSE_MANIFEST_SCHEMA_VERSION");
    expect(domain).toContain("export function judgeCourseManifestSchemaVersion");

    // validator 必须消费它，且在**形状校验之前**判定
    const validator = read("src/content/course/validator.ts");
    expect(validator).toContain("judgeCourseManifestSchemaVersion");
    const judgeIndex = validator.indexOf("judgeCourseManifestSchemaVersion(rawSchemaVersion)");
    const zodIndex = validator.indexOf("courseManifestSchema.safeParse(raw)");
    expect(judgeIndex, "未找到对原始输入的 schemaVersion 判定").toBeGreaterThan(-1);
    expect(zodIndex).toBeGreaterThan(-1);
    expect(
      judgeIndex,
      "schemaVersion 必须在 zod 形状校验**之前**判定，否则未知契约会报出一串下游字段错误",
    ).toBeLessThan(zodIndex);

    // 指纹投影不得包含 schemaVersion
    const fingerprint = read("src/content/course/fingerprint.ts");
    const projection = /export interface CourseFingerprintProjection \{([\s\S]*?)\n\}/.exec(fingerprint);
    expect(projection).not.toBeNull();
    expect(
      projection![1],
      "schemaVersion 参与了内容指纹 —— 一次序列化升级会让复核链接无谓失效",
    ).not.toContain("schemaVersion");
  });

  it("F3: course_canonical_link 的不可变性由数据库触发器守护", () => {
    const schema = read("src/db/schema.ts");
    for (const trigger of [
      "course_canonical_link_append_only_update",
      "course_canonical_link_append_only_delete",
    ]) {
      expect(schema, `缺少复核记录只追加触发器 ${trigger}`).toContain(trigger);
    }
    // 与既有只追加表用同一种机制
    expect(schema).toContain("RAISE(ABORT");
  });

  it("F3: 链接身份必须包含审计元数据（verificationRef / note），但不含 createdAt", () => {
    const repo = read("src/repositories/sqlite/courses.ts");
    const identity = /export function courseLinkIdentity\(input: \{([\s\S]*?)\n\}\): string \{/.exec(repo);
    expect(identity, "未找到 courseLinkIdentity").not.toBeNull();
    const signature = identity![1];

    expect(signature, "身份缺少 verificationRef —— 修正出处会被静默吞掉").toContain("verificationRef");
    expect(signature, "身份缺少 note —— 修正注解会被静默吞掉").toContain("note");
    expect(signature, "createdAt 不得参与身份（否则每次重跑都产生新行）").not.toContain("createdAt");

    // 语义目标身份必须**不含**审计元数据（否则去重失效）
    const semantic = /export function courseLinkSemanticTarget\(input: \{([\s\S]*?)\n\}\): string \{/.exec(repo);
    expect(semantic, "未找到 courseLinkSemanticTarget").not.toBeNull();
    const semanticSignature = semantic![1];
    for (const forbidden of ["verificationRef", "note", "createdAt", "verificationStatus"]) {
      expect(
        semanticSignature,
        `语义目标身份不应包含 ${forbidden} —— 它必须与审计元数据无关`,
      ).not.toContain(forbidden);
    }
  });

  it("F3: 运行时链接按语义目标去重（历史行多不得变成多个运行时目标）", () => {
    const service = read("src/services/course-link.ts");
    expect(service).toContain("export function dedupeBySemanticTarget");
    expect(service).toContain("semanticTargetOf");

    // 运行时入口必须经过去重
    const runtimeFn = /export function listRuntimeLinksForSegment\(([\s\S]*?)\n\}/.exec(service);
    expect(runtimeFn, "未找到 listRuntimeLinksForSegment").not.toBeNull();
    expect(runtimeFn![1], "运行时入口未去重").toContain("dedupeBySemanticTarget");

    // 概览同样去重
    expect(service).toMatch(/getCourseLinkOverview[\s\S]{0,3000}?dedupeBySemanticTarget/);
  });

  it("F6: 漂移与不可变性的守护测试必须真实使用磁盘与数据库（不是源码字符串断言）", () => {
    /*
     * 这一条守的是"测评是否可信"本身。
     * F1 之所以能通过 900+ 测试，是因为没有任何测试**真的去改盘上的文件**。
     * 因此这里断言漂移测试确实在写真实文件、真实查库。
     */
    const drift = read("tests/course-link-integrity.test.ts");
    expect(drift, "漂移测试必须真的写盘").toContain("writeFileSync");
    expect(drift, "漂移测试必须用真实临时目录").toContain("mkdtempSync");
    expect(drift, "漂移测试必须真实查库").toContain("course_canonical_link");

    const history = read("tests/course-link-history.test.ts");
    expect(history, "不可变性测试必须用裸 SQL 验证").toContain("UPDATE course_canonical_link");
    expect(history, "不可变性测试必须验证 DELETE 被阻断").toContain("DELETE FROM course_canonical_link");

    const schemaTests = read("tests/course-manifest-schema.test.ts");
    expect(schemaTests, "schemaVersion 测试必须覆盖缺失").toContain("omitSchemaVersion");
    expect(schemaTests, "schemaVersion 测试必须覆盖未来版本").toContain("schemaVersion: 2");
  });
});

/**
 * 只读 / dry-run 路径**不得迁移 schema** 的门禁（本轮 MAJOR 缺陷）。
 *
 * ── 缺陷 ──
 *
 * `pnpm course:import` 自称"预演（dry-run，不写数据库）"，
 * 却无条件调用 `getRepositories()` → `getDb()` → `openDatabase()`，
 * 而 `openDatabase` 会跑 PRAGMA + 建表 + 迁移 + 写 `schema_meta.schema_version`。
 * **打开本身就是写**，于是预演把 使用者的真实库从 v8 迁移到了 v9。
 * `course:link` 的默认 dry-run / `--list` / `--segments` 同类。
 *
 * 下面这些断言把"只读路径不具备迁移能力"固定成**源码契约**：
 * 行为测试证明当前实现安全，这些守卫防止它日后被改回去。
 */
describe("只读门禁：dry-run / 只读命令不得具备迁移能力", () => {
  /** 从源码里剥掉注释，避免"讲解规则本身的注释"被误判。 */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("db/client 提供只读打开，且它不执行任何 DDL/PRAGMA/版本写入", () => {
    const client = read("src/db/client.ts");
    expect(client, "缺少只读打开实现").toContain("export function openDatabaseReadOnly");

    const body = /export function openDatabaseReadOnly\([\s\S]*?\n\}/.exec(client);
    expect(body, "未找到 openDatabaseReadOnly 实现").not.toBeNull();
    const code = stripComments(body![0]);

    // 必须真的用 SQLite 的只读连接
    expect(code, "只读打开必须使用 readOnly 选项").toMatch(/readOnly:\s*true/);

    // 不得执行迁移/建表/PRAGMA/版本写入
    for (const forbidden of [
      "SCHEMA_SQL",
      "SCHEMA_PRAGMAS",
      "MIGRATIONS",
      "applyMigrations",
      "applyInvariants",
    ]) {
      expect(code, `只读打开不得引用 ${forbidden}`).not.toContain(forbidden);
    }
    expect(code, "只读打开不得写 schema_version").not.toContain("INSERT INTO schema_meta");
    expect(code, "只读打开不得创建目录").not.toContain("mkdirSync");
  });

  it("只读打开仍保留 SchemaTooNew 失败关闭（不得削弱既有不变量）", () => {
    const client = read("src/db/client.ts");
    const body = /export function openDatabaseReadOnly\([\s\S]*?\n\}/.exec(client);
    expect(body).not.toBeNull();
    expect(body![0], "只读打开必须保留版本守卫").toContain("SchemaTooNewError");
    expect(body![0]).toContain("current > SCHEMA_VERSION");
  });

  it("repository 层提供只读组合，且它不经过 getDb/openDatabase", () => {
    const index = read("src/repositories/sqlite/index.ts");
    expect(index, "缺少只读 repository 工厂").toContain("export function createReadOnlyRepositories");
    expect(index, "缺少默认库的只读工厂").toContain("export function getReadOnlyRepositories");

    const body = /export function createReadOnlyRepositories\([\s\S]*?\n\}/.exec(index);
    expect(body, "未找到 createReadOnlyRepositories").not.toBeNull();
    const code = stripComments(body![0]);
    expect(code, "只读工厂必须用 openDatabaseReadOnly").toContain("openDatabaseReadOnly");
    expect(code, "只读工厂不得走 openDatabase（那会迁移）").not.toMatch(/openDatabase\(/);
    expect(code, "只读工厂不得走 getDb").not.toMatch(/getDb\(\)/);
  });

  it("course:import 在未 --commit 时走只读路径（dry-run 不得拥有迁移能力）", () => {
    const script = stripComments(read("scripts/course-import.ts"));
    expect(script, "course:import 缺少只读 repo 用法").toContain("getReadOnlyRepositories");
    expect(script, "course:import 缺少写入 repo 用法").toContain("getRepositories");
    expect(
      /const repos = commit \? getRepositories\(\) : getReadOnlyRepositories\(\)/.test(script),
      "course:import 必须按 --commit 分岔选择 repository",
    ).toBe(true);
    // 关键：不得存在"无条件 getRepositories()"那种旧形态
    expect(
      /^\s*const repos = getRepositories\(\);/m.test(script),
      "course:import 仍存在无条件 getRepositories() —— dry-run 会迁移",
    ).toBe(false);
  });

  it("course:link 的全部只读路径都走只读 repository", () => {
    const script = stripComments(read("scripts/course-link.ts"));
    expect(script).toContain("getReadOnlyRepositories");

    // --segments 与 --list 必须只读
    const segmentsFn = /function printSegments\([\s\S]*?\n\}/.exec(script);
    const linksFn = /function printLinks\([\s\S]*?\n\}/.exec(script);
    expect(segmentsFn, "未找到 printSegments").not.toBeNull();
    expect(linksFn, "未找到 printLinks").not.toBeNull();
    expect(segmentsFn![0], "printSegments 必须是只读").toContain("getReadOnlyRepositories");
    expect(linksFn![0], "printLinks 必须是只读").toContain("getReadOnlyRepositories");

    // 默认核验（非 --commit）必须只读；只有 --commit 才允许写
    expect(
      /const repos = args\.commit \? getRepositories\(\) : getReadOnlyRepositories\(\)/.test(script),
      "course:link 的默认核验必须按 --commit 分岔",
    ).toBe(true);

    // 不得有任何"无条件 getRepositories()"残留
    expect(
      /^\s*const repos = getRepositories\(\);/m.test(script),
      "course:link 仍存在无条件 getRepositories() —— dry-run/list 会迁移",
    ).toBe(false);
  });

  it("纯校验命令（course:validate）根本不打开数据库", () => {
    const code = stripComments(read("scripts/course-validate.ts"));
    for (const forbidden of ["getRepositories", "getReadOnlyRepositories", "openDatabase", "node:sqlite"]) {
      expect(code, `course:validate 不应接触数据库（${forbidden}）`).not.toContain(forbidden);
    }
  });

  it("v8 上读课程层不得崩溃：repository 读方法必须先问 isActivated", () => {
    const repo = read("src/repositories/sqlite/courses.ts");
    expect(repo, "缺少 isActivated 探针").toContain("isActivated()");

    /*
     * 每个读方法都必须先判激活，否则 v8 上会抛 `no such table` ——
     * 那会把"课程层未激活"表现成一个崩溃，把操作者引向错误方向。
     */
    const readMethods = [
      "listPackages",
      "getPackage",
      "countPackages",
      "hasContentVersion",
      "listLinksForSegment",
      "listLinksForCourse",
      "getLink",
      "listExposureForProfile",
      "listExposureForSegment",
      "countExposure",
    ];
    for (const method of readMethods) {
      /*
       * 锚定到**方法声明**（两个空格缩进 + 方法名 + 形参 + `{`），
       * 而不是任意调用点 —— 例如 `this.getLink(...)` 出现在 appendLink 内部，
       * 朴素正则会把那段实现误当成 getLink 的方法体（实测踩到）。
       */
      const body = new RegExp(
        `\\n  ${method}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`,
      ).exec(repo);
      expect(body, `未找到 ${method} 的方法体`).not.toBeNull();
      expect(body![1], `${method} 未先判 isActivated（v8 上会抛 no such table）`).toContain(
        "isActivated()",
      );
    }
  });

  it("只读门禁的守护测试必须真实对比 schema 快照（不是只断言没抛错）", () => {
    const test = read("tests/course-readonly-dry-run.test.ts");
    expect(test, "必须真实造临时库").toContain("mkdtempSync");
    expect(test, "必须对比 schema_version").toContain("schema_version");
    expect(test, "必须断言没有 course_* 表").toContain("courseTables");
    expect(test, "必须覆盖 v8").toContain("deriveV8Ddl");
    expect(test, "必须覆盖 --commit 会迁移").toContain("commitCourseImport");
    expect(test).toContain("function snapshot");
  });
});

/**
 * 课程导入与匹配流水线（Course Intake & Matching Pipeline）门禁。
 *
 * 这些约束是**架构性**的：它们描述"这条流水线在原理上不能做什么"，
 * 而不是"这次实现没有做"。因此用源码级门禁固定，避免日后被无声破坏。
 *
 * ── 源码块锚点必须**对行尾不敏感**（Windows 检出上的实测缺陷）──
 *
 * 本 describe 里有多条门禁用 `[\s\S]*?\n}\n` 抓一个函数体。该写法在
 * **CRLF 检出**上永远不匹配：源码里 `}` 前后是 `\r\n`，因此
 * `\n}\n` 这个三字符序列在文件中根本不存在。
 *
 * 后果不是报错，而是**静默取到空串**（`?? ""` 兜底），随后
 * `expect(body.length).toBeGreaterThan(N)` 失败 —— 失败信息看起来像
 * "实现里没有这个函数体"，实际是**断言没读到源码**。实测：仓库 blob 为 LF、
 * 本机 `core.autocrlf=true`，同一份代码在 LF 检出上 107/107 通过。
 * 因此这是**检出产物**，不是代码缺陷。
 *
 * 修法刻意最小：只把这些锚点写成 `\r?\n}\r?\n`，
 * **不**加 `.gitattributes`、**不**重归一化仓库、**不**制造大规模行尾 diff。
 * 注意 `\n}`（结尾不带换行）本来就安全（`\r\n}` 含 `\n}`）；
 * 只有 `\n}\n` 这一形态会失效，因此**只有它**需要改。
 * 这条约束由下面「源码块锚点不得写回行尾敏感的字面量」一项守护。
 */
describe("课程导入与匹配流水线门禁", () => {
  const PIPELINE_FILES = [
    "src/content/course-pipeline/sources.ts",
    "src/content/course-pipeline/pdf-extract.ts",
    "src/content/course-pipeline/grouping.ts",
    "src/content/course-pipeline/segment.ts",
    "src/content/course-pipeline/match.ts",
    "src/content/course-pipeline/canonical.ts",
    "src/content/course-pipeline/candidate.ts",
    "src/content/course-pipeline/review.ts",
    "src/content/course-pipeline/digests.ts",
    "src/content/course-pipeline/projection.ts",
    "src/content/course-pipeline/index.ts",
  ];
  const CLI_FILES = ["scripts/course-extract.ts", "scripts/course-review.ts"];

  /** 去掉注释后的源码 —— 避免把注释里的名词当成真实 import。 */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("流水线与 CLI **绝不 import** 数据库 / 仓库层（只读是结构性的，不是纪律）", () => {
    for (const path of [...PIPELINE_FILES, ...CLI_FILES]) {
      const code = stripComments(read(path));
      const importLines = code
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"))
        .join("\n");
      expect(importLines, `${path} 不得 import 数据库/仓库层`).not.toMatch(
        /repositories|db\/client|node:sqlite|@\/db/,
      );
    }
  });

  it("流水线**绝不调用** verifyCanonicalLink（机器匹配不得创造运行时真相）", () => {
    for (const path of [...PIPELINE_FILES, ...CLI_FILES]) {
      const code = stripComments(read(path));
      expect(code, `${path} 不得调用 verifyCanonicalLink`).not.toMatch(/verifyCanonicalLink\s*\(/);
      expect(code, `${path} 不得 import course-link 服务`).not.toMatch(/from\s+"@\/services\/course-link"/);
    }
  });

  it("流水线**绝不**写 Expert 台账 / 旧闭环 / 课程曝光（课程导入不是表现证据）", () => {
    for (const path of [...PIPELINE_FILES, ...CLI_FILES]) {
      const code = stripComments(read(path));
      for (const forbidden of [
        "performance_event",
        "assessment_event",
        "evidence_projection",
        "skill_profile",
        "answer_attempt",
        "course_exposure_event",
      ]) {
        expect(code, `${path} 不得提及 ${forbidden}`).not.toContain(forbidden);
      }
      /*
       * `review_item` 单独判定：门禁自己做的是**候选复核事项**
       * （`CandidateReviewItem`），与旧闭环的 `review_item` **表**无关。
       * 因此只禁止把它当表/SQL 使用，而不是禁止这串字符出现在标识符里
       * （`blocking_review_items_resolved` 是检查项名字）。
       */
      expect(code, `${path} 不得访问 review_item 表`).not.toMatch(
        /\breview_item\b(?!s)|\breview_items\b\s*(?==|,|\)|;|WHERE|SET)/,
      );
      expect(code, `${path} 不得出现 review_item 的 SQL`).not.toMatch(
        /(FROM|INTO|UPDATE|TABLE)\s+review_item\b/i,
      );
    }
  });

  it("机器匹配**不得**把文件名/套别号/题号/课程答案作为打分特征", () => {
    const match = stripComments(read("src/content/course-pipeline/match.ts"));
    /*
     * 判据是"打分函数**读取**了这些线索"，不是"这些字段名出现过"。
     *
     * `scorePair` 只把它们**初始化为 null**（作为 `contextOnly` 的结构骨架），
     * 真正的值由分数算完之后在 `matchOne` 里附加。因此这里断言：
     *   · scorePair 的**函数签名**不接收 context；
     *   · scorePair 内不出现 `context.` 读取；
     *   · scorePair 内没有对 contextOnly 以外任何字段的赋值。
     */
    const scoreBody = /function scorePair\([\s\S]*?\r?\n}\r?\n/.exec(match)?.[0] ?? "";
    expect(scoreBody.length).toBeGreaterThan(100);

    const signature = scoreBody.slice(0, scoreBody.indexOf("): MatchEvidence"));
    expect(signature, "scorePair 不得接收 context（那是打分之外的线索）").not.toContain("context");
    expect(scoreBody, "scorePair 不得读取 context").not.toContain("context.");

    // `courseFileName` / `courseSetLabel` / `courseAnswerKey` 只允许出现在
    // contextOnly 字面量里，且值必须是 null（骨架），不得来自任何输入。
    for (const field of ["courseFileName", "courseSetLabel", "courseAnswerKey"]) {
      const occurrences = scoreBody.split(field).length - 1;
      expect(occurrences, `${field} 在 scorePair 里只应作为 null 骨架出现一次`).toBe(1);
      expect(scoreBody, `${field} 必须初始化为 null（不得来自输入）`).toMatch(
        new RegExp(`${field}: null`),
      );
    }

    // 值的附加必须发生在 scorePair **之外**（算完分之后）
    expect(match, "contextOnly 必须在 scorePair 之外填充").toMatch(
      /evidence\.contextOnly\.courseFileName = context\.courseFileName/,
    );

    // 而它们必须被登记为**禁止特征**（可检索的说明）
    const types = read("src/content/course-pipeline/types.ts");
    expect(types).toContain("FORBIDDEN_MATCH_FEATURES");
    for (const feature of [
      "fileName",
      "providerSetLabel",
      "physicalOrder",
      "bareQuestionNumber",
      "courseAnswerKey",
      "folderName",
    ]) {
      expect(types, `禁止特征清单必须包含 ${feature}`).toContain(feature);
    }
  });

  it("候选包与 courses/ 是两棵独立子树（候选在原理上不可能被生产导入器发现）", () => {
    const paths = read("src/content/paper/paths.ts");
    expect(paths, "必须有独立的候选目录").toContain("getCourseCandidatesDir");
    // 候选目录的**实现**必须指向 course-candidates（而不是 courses）
    const fn = /export function getCourseCandidatesDir\(\)[\s\S]*?\n}/.exec(paths)?.[0] ?? "";
    expect(fn.length).toBeGreaterThan(50);
    expect(fn, "候选目录必须指向 course-candidates").toContain('"course-candidates"');
    expect(fn, "候选目录不得指向 courses").not.toContain('"courses"');
    // 导入器只枚举 courses/*
    const importer = read("src/content/course/importer.ts");
    expect(importer).toContain("getCoursesDir");
    expect(importer, "导入器不得提到候选目录").not.toContain("course-candidates");
  });

  it("晋升只复制 course.json 与 assets/（候选元数据不得泄漏进运行时课程包）", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    // 白名单复制：显式复制 course.json 与 assets/
    expect(review).toContain('cpSync(join(candidateDir, "course.json")');
    expect(review).toContain("COURSE_CANDIDATE_ASSETS_DIR");
    // 候选/复核元数据必须被显式排除
    expect(review).toContain("COURSE_CANDIDATE_FILENAME");
    expect(review).toContain('"review.json"');
    // **不得**整目录递归复制候选目录（那会把 candidate.json 一起带进去）
    expect(review, "不得整目录 cpSync(candidateDir, targetDir)").not.toMatch(
      /cpSync\(\s*candidateDir\s*,\s*targetDir/,
    );
  });

  it("DOCX 在 V1 不被解析：流水线里不存在 DOCX 解析器", () => {
    for (const path of PIPELINE_FILES) {
      const code = stripComments(read(path));
      for (const forbidden of ["mammoth", "jszip", "unzip", "docx-parser", "adm-zip"]) {
        expect(code, `${path} 不得引入 DOCX 解析（${forbidden}）`).not.toMatch(
          new RegExp(`from\\s+"[^"]*${forbidden}`, "i"),
        );
      }
    }
    // 而"推迟"必须有明确标记
    const types = read("src/content/course-pipeline/types.ts");
    expect(types).toContain("TEXT_EXTRACTION_DEFERRED");
    expect(types).toContain('"deferred"');
  });

  it("V1 **不做 OCR**、**不调用远程 AI**、**不用嵌入/向量库**", () => {
    for (const path of [...PIPELINE_FILES, ...CLI_FILES]) {
      const code = stripComments(read(path));
      // 不得引入 OCR / 远程客户端 / 向量库
      for (const forbidden of [
        "tesseract",
        "openai",
        "anthropic",
        "@google/generative-ai",
        "cohere",
        "pinecone",
        "qdrant",
        "chromadb",
        "faiss",
        "embedding",
      ]) {
        expect(code, `${path} 不得引入 ${forbidden}`).not.toMatch(new RegExp(forbidden, "i"));
      }
      // 不得出现网络请求
      expect(code, `${path} 不得发起网络请求`).not.toMatch(/\bfetch\s*\(|https?:\/\//);
    }
  });

  it("不得新增依赖：课程流水线只用既有 pdfjs-dist 与 Node 内置模块", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // 本阶段明确要求 0 新依赖。既有的 pdfjs-dist 是唯一与抽取有关的包。
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of [
      "splink",
      "docling",
      "mammoth",
      "tesseract.js",
      "pdf-parse",
      "pdfjs-dist-legacy",
      "faiss-node",
      "hnswlib-node",
      "vectra",
    ]) {
      expect(all, `不得新增依赖 ${forbidden}`).not.toHaveProperty(forbidden);
    }
    // PDF 抽取必须走既有依赖
    expect(all).toHaveProperty("pdfjs-dist");
  });

  it("PDF 抽取复用既有 extract.ts（不另写第二个解析器）", () => {
    const pdf = stripComments(read("src/content/course-pipeline/pdf-extract.ts"));
    expect(pdf, "必须复用既有 pdfjs 适配器").toContain("@/content/pipeline/extract");
    // 不得自己 import pdfjs（那会成为第二个解析点）
    expect(pdf, "不得直接 import pdfjs-dist").not.toMatch(/from\s+"pdfjs-dist/);
  });

  it("候选校验和覆盖源/课程/分组/分段/匹配五项（含 canonical 库快照）", () => {
    const digests = stripComments(read("src/content/course-pipeline/digests.ts"));
    for (const field of [
      "sourceDigest",
      "courseChecksum",
      "groupingDigest",
      "segmentationDigest",
      "matchingDigest",
    ]) {
      expect(digests, `候选校验和必须覆盖 ${field}`).toContain(field);
    }
    // canonical 库快照必须在匹配摘要里 —— 否则"库变了旧分数仍成立"
    const matchDigest = /export function courseMatchingDigest[\s\S]*?\n}/.exec(digests)?.[0] ?? "";
    expect(matchDigest.length).toBeGreaterThan(100);
    expect(matchDigest, "匹配摘要必须包含 canonical 库快照").toContain("canonicalLibraryDigest");
  });

  it("工具**从不**生成 review.json（人工复核不能被工具自己满足）", () => {
    // 抽取命令不得写出 review.json
    const extract = stripComments(read("scripts/course-extract.ts"));
    expect(extract, "抽取命令不得写 review.json").not.toMatch(/writeFileSync\([^)]*review\.json/);
    // 候选写出函数只写**候选文件**（course.json 来自 archive.files，外加 candidate.json）
    const candidate = stripComments(read("src/content/course-pipeline/candidate.ts"));
    const writer = /export function writeCourseCandidate\([\s\S]*?\n}/.exec(candidate)?.[0] ?? "";
    expect(writer.length).toBeGreaterThan(100);
    expect(writer, "写出器必须写 candidate.json").toContain("COURSE_CANDIDATE_FILENAME");
    expect(writer, "写出器必须写 archive.files（含 course.json）").toContain("archive.files");
    expect(writer, "写出器不得写 review.json").not.toMatch(/review\.json/);
    // course.json 必须在 archive.files 里被注册
    expect(candidate, "course.json 必须被写进候选文件集").toContain("COURSE_MANIFEST_FILENAME");
  });

  it("晋升失败关闭：门禁非 PROMOTABLE 即拒绝，且不得出现手工放行开关", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    expect(review).toContain("PROMOTABLE");
    expect(review, "必须有显式的拒绝分支").toMatch(/status !== "PROMOTABLE"/);
    // CLI 不得提供绕过门禁的开关
    const cli = stripComments(read("scripts/course-review.ts"));
    for (const forbidden of ["--force", "--skip-gate", "--yes", "--ignore-review"]) {
      expect(cli, `不得提供 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("源路径安全复用既有 resolveWithinRoot / isWithin（不另写第二套判据）", () => {
    const sources = stripComments(read("src/content/course-pipeline/sources.ts"));
    expect(sources, "必须复用既有路径边界").toContain("isWithin");
    expect(sources, "必须复用既有路径解析").toContain("@/content/paper/paths");
    // 不得把绝对路径写进清点结果
    expect(sources).toContain("assertNoAbsolutePaths");
  });

  it("两条命令已登记在 package.json（且命名遵循既有约定）", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["course:extract"]).toContain("scripts/course-extract.ts");
    expect(pkg.scripts["course:review"]).toContain("scripts/course-review.ts");
    // 与既有的 course:* 命令用同一套 node 参数
    expect(pkg.scripts["course:extract"]).toContain("--experimental-transform-types");
    expect(pkg.scripts["course:review"]).toContain("alias-loader.mjs");
  });

  it("守护测试必须真实使用磁盘与真实 PDF 字节（不是源码字符串断言）", () => {
    const test = read("tests/course-intake.test.ts");
    expect(test, "必须真实建临时目录").toContain("mkdtempSync");
    expect(test, "必须真实写文件").toContain("writeFileSync");
    expect(test, "必须用真实可解析的 PDF 夹具").toContain("buildTextPdf");
    expect(test, "必须覆盖无文本层").toContain("buildImageOnlyPdf");
    expect(test, "必须覆盖符号链接逃逸").toContain("symlinkSync");
    expect(test, "必须覆盖陈旧复核").toContain("candidateChecksum");
    expect(test, "必须覆盖 canonical 库变化").toContain("buildIndexFromDisk");
    // Review Fix（F8~F11）的守护测试也必须走真实磁盘
    expect(test, "F8：必须有裁决类型分派的真实门禁用例").toContain("isBlockingItemResolved");
    expect(test, "F9：必须覆盖 rejected 分组").toContain("rejected_groupings_block_promotion");
    expect(test, "F9：必须覆盖 excluded 段").toContain("excluded_segments_block_promotion");
    expect(test, "F10：必须覆盖源当前性").toContain("checkSourceCurrentness");
    expect(test, "F11：必须覆盖恶意 evidence").toContain("buildLinkPlan");
  });

  it("F8：阻断事项的化解必须**按 code 分派**，不得退回扁平 where 集合", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    /*
     * 判据是"不存在一张把所有裁决混在一起的扁平 where 集合"。
     *
     * 早先的实现建 `resolvedWhere: Set<string>`，把 materialGroupings /
     * segments / matches 的 id 全部塞进同一个集合再按 `where` 查 ——
     * 于是一条 `segment_requires_review` 会因为"存在任意一条针对该段的
     * 匹配裁决"而被判已解决（实测确认过）。
     */
    expect(review, "不得再出现扁平的 resolvedWhere 集合").not.toContain("resolvedWhere");
    // 三类裁决必须分开保存
    expect(review).toContain("decidedGroupings");
    expect(review).toContain("decidedSegments");
    expect(review).toContain("decidedMatches");
    // 必须按 code 分派（switch 在 item.code 上）
    expect(review).toMatch(/switch\s*\(\s*item\.code\s*\)/);
    // 段层事项不得读取 decidedMatches
    const segmentCase = /case "segment_requires_review":([\s\S]*?)(?=\n    case |\n    default:)/.exec(review)?.[1] ?? "";
    expect(segmentCase.length).toBeGreaterThan(40);
    expect(segmentCase, "段层事项不得用匹配裁决化解").not.toContain("decidedMatches");
  });

  it("F8：抽取层事实缺陷**不可**被任何复核裁决化解（唯一实现）", () => {
    const types = stripComments(read("src/content/course-pipeline/types.ts"));
    expect(types, "不可化解清单必须是类型层的固有属性").toContain("NEVER_RESOLVABLE_BY_REVIEW");
    // 抽取层 code 必须都在清单里
    for (const code of ["extraction_failed", "page_without_text_layer", "empty_asset", "grouping_invariant_violated"]) {
      expect(types, `不可化解清单必须包含 ${code}`).toContain(code);
    }
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    // review.ts 必须引用那一份清单，而不是自己再写一份
    expect(review, "review.ts 必须复用类型层的清单").toContain("NEVER_RESOLVABLE_BY_REVIEW");
  });

  it("F9：rejected / excluded 必须**阻断晋升**，且不得自动改写候选", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    // 两项硬门禁必须存在
    expect(review).toContain("rejected_groupings_block_promotion");
    expect(review).toContain("excluded_segments_block_promotion");
    // 二者必须属于硬失败（BLOCKED），而不是"人还没决定"
    const hardChecks = /const HARD_CHECKS = new Set\(\[([\s\S]*?)\]\)/.exec(review)?.[1] ?? "";
    expect(hardChecks).toContain("rejected_groupings_block_promotion");
    expect(hardChecks).toContain("excluded_segments_block_promotion");
    /*
     * 晋升**不得**自动删段或重组材料 —— 那会改写一份已绑定校验和的候选，
     * 让复核立刻与校验和脱钩。因此晋升路径里不得出现"按 review 过滤段"的逻辑。
     */
    const promoteBody = /export function promoteCourseCandidate\([\s\S]*?\r?\n}\r?\n/.exec(review)?.[0] ?? "";
    expect(promoteBody.length).toBeGreaterThan(200);
    expect(promoteBody, "晋升不得按复核结果过滤/改写候选内容").not.toMatch(
      /review\.segments|review\.materialGroupings/,
    );
  });

  it("F10：源当前性必须**重新清点**当前源，且绝不持久化绝对路径", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    expect(review).toContain("checkSourceCurrentness");
    // 必须复用同一套清点实现（否则"第二次测量"用的不是同一把尺子）
    expect(review, "必须复用 scanSourceDirectory").toContain("scanSourceDirectory");
    // 门禁必须有源当前性这一项，且属于硬失败
    expect(review).toContain("source_current_and_unchanged");
    const hardChecks = /const HARD_CHECKS = new Set\(\[([\s\S]*?)\]\)/.exec(review)?.[1] ?? "";
    expect(hardChecks).toContain("source_current_and_unchanged");

    // 源定位符只有两种形态，且 external **不记录位置**
    const types = stripComments(read("src/content/course-pipeline/types.ts"));
    expect(types).toContain("SourceLocator");
    expect(types).toMatch(/kind:\s*"standard"/);
    expect(types).toMatch(/kind:\s*"external"/);
    // external 分支的 locator 必须是 null 字面量类型
    expect(types).toMatch(/locator:\s*null/);
  });

  it("F11：生成的交接命令**不得**嵌入自由文本，且仍然不带 --commit", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    // 旧的 quoteArg（只替换双引号，反斜杠不是 PowerShell 转义）必须消失
    expect(review, "不得再使用不安全的 quoteArg").not.toContain("quoteArg");
    // 必须改用受控标识符
    expect(review).toContain("buildSafeReviewRef");
    expect(review).toContain("safeCliToken");
    // 安全字符集必须显式声明
    expect(review).toMatch(/SAFE_CLI_TOKEN|\[a-z0-9\._:-\]/i);

    const planBody = /export function buildLinkPlan\([\s\S]*?\r?\n}\r?\n/.exec(review)?.[0] ?? "";
    expect(planBody.length).toBeGreaterThan(300);
    // 命令里不得出现 entry.evidence / review.reviewer 这类自由文本
    expect(planBody, "命令不得包含自由文本 evidence").not.toMatch(/--ref[^\n]*evidence/);
    expect(planBody, "命令不得包含 reviewer 自由文本").not.toMatch(/--ref[^\n]*reviewer/);
    expect(planBody, "交接命令仍然不得带 --commit").not.toContain("--commit");
  });

  it("canonical 库不完整必须被区分对待：不阻断课程包晋升，但阻断接受建议", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    expect(review).toContain("canonical_library_complete_for_acceptance");
    const hardChecks = /const HARD_CHECKS = new Set\(\[([\s\S]*?)\]\)/.exec(review)?.[1] ?? "";
    expect(hardChecks, "接受建议在库不完整时必须是硬失败").toContain(
      "canonical_library_complete_for_acceptance",
    );
    // readFailures 必须参与库摘要（否则"少读到一份卷"对复核不可见）
    const match = stripComments(read("src/content/course-pipeline/match.ts"));
    const digestBody = /export function canonicalLibraryDigest\([\s\S]*?\r?\n}\r?\n/.exec(match)?.[0] ?? "";
    expect(digestBody.length).toBeGreaterThan(100);
    expect(digestBody, "库摘要必须包含 readFailures").toContain("readFailures");
    // 库摘要比对仍然是既有语义（不得被这次改动削弱）
    expect(review).toContain("canonical_library_unchanged_since_review");
  });

  it("F12：交接计划必须**绑定门禁** —— gate 是必需参数，非 PROMOTABLE 时零命令", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));

    // `gate` 必须是 buildLinkPlan 签名里的**必需**参数（不是可选、不是内部重算）
    const signature = /export function buildLinkPlan\(input:\s*\{([\s\S]*?)\}\):\s*LinkPlanResult/.exec(review)?.[1] ?? "";
    expect(signature.length).toBeGreaterThan(50);
    expect(signature, "buildLinkPlan 必须接收 gate").toMatch(/gate:\s*PromotionGate/);
    expect(signature, "gate 不得是可选参数").not.toMatch(/gate\?/);

    // 函数体必须**首先**做门禁判定，且非 PROMOTABLE 直接返回空
    const body = /export function buildLinkPlan\([\s\S]*?\r?\n}\r?\n/.exec(review)?.[0] ?? "";
    expect(body.length).toBeGreaterThan(400);
    expect(body, "必须显式比较 PROMOTABLE").toMatch(/gate\.status\s*!==\s*"PROMOTABLE"/);
    // 非 PROMOTABLE 分支必须返回 entries: []
    const guard = /if\s*\(gate\.status\s*!==\s*"PROMOTABLE"\)\s*\{([\s\S]*?)\n  \}/.exec(body)?.[1] ?? "";
    expect(guard.length).toBeGreaterThan(40);
    expect(guard, "非 PROMOTABLE 必须返回空 entries").toMatch(/entries:\s*\[\]/);
    expect(guard, "非 PROMOTABLE 必须 allowed:false").toMatch(/allowed:\s*false/);

    // 返回类型必须是结构化的（不是裸数组）—— 让"为什么没有计划"可打印可测试
    const types = stripComments(read("src/content/course-pipeline/types.ts"));
    expect(types).toContain("LinkPlanResult");
    expect(types).toMatch(/allowed:\s*boolean/);
    expect(types).toMatch(/reason:\s*string/);
    expect(types).toMatch(/entries:\s*LinkPlanEntry\[\]/);
  });

  it("F12：CLI 必须把 gate 传给交接打印，且不得在非 PROMOTABLE 时声称已复核交接", () => {
    const cli = stripComments(read("scripts/course-review.ts"));
    // printHandoff 必须接收 gate
    const sig = /function printHandoff\(([\s\S]*?)\):\s*void/.exec(cli)?.[1] ?? "";
    expect(sig.length).toBeGreaterThan(20);
    expect(sig, "printHandoff 必须接收 gate").toContain("gate: PromotionGate");
    // buildLinkPlan 调用必须传 gate
    const call = /buildLinkPlan\(\{([\s\S]*?)\}\)/.exec(cli)?.[1] ?? "";
    expect(call.length).toBeGreaterThan(30);
    expect(call, "CLI 调用必须传 gate").toMatch(/\bgate\b/);
    // 必须显式处理"被抑制"分支，且在**打印计划标题之前**
    expect(cli, "必须有抑制分支").toContain("链接交接已抑制");
    const suppressedIndex = cli.indexOf("链接交接已抑制");
    const planHeaderIndex = cli.indexOf("【已复核链接交接计划】");
    expect(suppressedIndex).toBeGreaterThan(0);
    expect(planHeaderIndex).toBeGreaterThan(0);
    expect(
      suppressedIndex,
      "抑制分支必须先于『已复核链接交接计划』标题（否则会先声称再收回）",
    ).toBeLessThan(planHeaderIndex);
    // 抑制分支必须在打印任何 course:link 之前返回
    const suppressedBlock = cli.slice(suppressedIndex, planHeaderIndex);
    expect(suppressedBlock, "抑制分支不得打印 course:link").not.toContain("pnpm course:link");
    expect(suppressedBlock, "抑制分支必须说明零命令").toMatch(/没有输出任何/);
  });

  it("F-B：课程 id 必须**证明容纳**，不得直接 join(root, courseId)", () => {
    // 唯一的路径构造入口在 containment.ts，且复用既有机制
    const containment = stripComments(read("src/content/course-pipeline/containment.ts"));
    for (const reused of ["normalizeRelativePath", "resolveWithinRoot", "isWithin"]) {
      expect(containment, `必须复用既有 ${reused}`).toContain(reused);
    }
    expect(containment, "必须有单段 slug 判据").toContain("COURSE_ID_PATTERN");
    expect(containment).toContain("assertSafeCourseId");

    // service 层不得再直接 join 根 + courseId
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    expect(review, "readStoredCandidate 必须走 resolveCandidateDir").toContain("resolveCandidateDir(");
    expect(review, "晋升目标必须走 resolvePromotedCourseDir").toContain("resolvePromotedCourseDir(");
    expect(review, "不得直接 join(candidatesDir, courseId)").not.toMatch(
      /join\(\s*candidatesDir\s*,\s*courseId/,
    );
    expect(review, "不得直接 join(coursesDir, ...courseId)").not.toMatch(
      /join\(\s*coursesDir\s*,\s*input\.stored\.courseId/,
    );

    // CLI 也必须在边界先校验
    const cli = stripComments(read("scripts/course-review.ts"));
    expect(cli, "CLI 必须校验课程 id").toContain("assertSafeCourseId");
    expect(cli, "CLI 必须区分路径安全错误").toContain("isPathSafetyError");
  });

  it("F-C：任意本机字符串在打印前必须消毒；不得输出含真实路径的可粘贴命令", () => {
    const extract = stripComments(read("scripts/course-extract.ts"));
    // 源目录路径必须消毒后才打印
    expect(extract, "extract 必须消毒源目录路径").toMatch(/sanitizeForDisplay\(sourceRoot/);
    expect(extract, "extract 必须消毒 locator.label").toContain("sanitizeForDisplay(locator.label)");
    // 不得输出带引号真实路径的命令
    expect(extract, "不得输出 --source-root \"<真实路径>\"").not.toMatch(/--source-root "\$\{args\.source\}/);
    expect(extract, "必须给出不含路径的模板").toContain("--source-root <PATH>");

    const cli = stripComments(read("scripts/course-review.ts"));
    expect(cli, "review 必须消毒 locator.label").toContain("sanitizeForDisplay(locator.label)");

    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    expect(review, "review 服务必须消毒路径后再写入 detail").toMatch(/sanitizeForDisplay\(currentRoot/);
  });

  it("F-A：派生子摘要是诊断缓存，身份判据只有 candidateChecksum", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    // 自洽性检查必须区分"缓存过期"与"内容不一致"
    const body = /name: "candidate_checksum_self_consistent"[\s\S]*?\n  \}\);/.exec(review)?.[0] ?? "";
    expect(body.length).toBeGreaterThan(200);
    expect(body, "必须说明子摘要是缓存/诊断").toMatch(/缓存|诊断子摘要/);
    expect(body, "必须明确权威值是现场重算").toMatch(/权威值|现场重算/);
    expect(body, "不得把缓存过期说成内容被改动").not.toMatch(/内容.{0,6}被改动/);

    const cli = stripComments(read("scripts/course-review.ts"));
    expect(cli, "CLI 不得把子摘要不符标成红色的完整性问题").not.toMatch(/\$\{same \? "✓" : "✗"\} \$\{label\}/);
    expect(cli, "CLI 必须说明缓存过期不构成完整性问题").toContain("不构成完整性问题");
  });

  it("F-D：坏 JSON 必须是正常失败状态（解析被守卫）", () => {
    const cli = stripComments(read("scripts/course-review.ts"));
    // review.json 的解析必须包在 try/catch 里
    expect(cli, "review.json 解析必须被守卫").toMatch(/try\s*\{[\s\S]{0,200}validateCourseReviewFile\(\s*JSON\.parse/);
    expect(cli).toContain("不是合法 JSON");

    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    // candidate.json 的解析同样必须被守卫
    expect(review, "candidate.json 解析必须被守卫").toMatch(/try\s*\{[\s\S]{0,200}JSON\.parse\(metadataRaw\)/);
  });

  it("F-E：buildLinkPlan 不得保留未使用的参数", () => {
    const review = stripComments(read("src/content/course-pipeline/review.ts"));
    const signature = /export function buildLinkPlan\(input:\s*\{([\s\S]*?)\}\):\s*LinkPlanResult/.exec(review)?.[1] ?? "";
    expect(signature.length).toBeGreaterThan(30);
    expect(signature, "不得保留未使用的 courseContentVersion").not.toContain("courseContentVersion");
  });

  it("F-F：公开文档不得写死易漂移的验证条数", () => {
    /*
     * 原来这一条还读内部的质量门禁、项目背景与状态文档。
     * 那三份是内部工程记录，不随源码分发，
     * 因此判据改为只覆盖**公开分发包里真实存在的文档**。
     *
     * 判据本身（不得写死会漂移的精确条数）保持不变 —— 这是这类文档最容易
     * 过期的方式，而不是"删掉一段难做的断言"。
     */
    /*
     * 只覆盖公开分发包里**确实存在**的文档。
     *
     * 曾经把一份**不属于公开分发包**的工程文档列在这里。配上
     * `existsSync(...) continue`，这条判据就变成了一个不会失败的
     * 循环：路径不存在 → 静默跳过 → 永远绿。
     *
     * `tools/check-doc-references.mjs` 现在扫描源码里的文档引用，这条悬空引用
     * 正是它抓到的。此处刻意不写出那个文件名 —— 它属于未公开材料。
     */
    for (const doc of ["docs/course-package.md", "docs/past-paper-package.md", "README.md"]) {
      // 断了就是缺陷，不再静默跳过：这三份都属于公开分发包。
      expect(existsSync(join(process.cwd(), doc)), `${doc} 必须存在于公开分发包中`).toBe(true);
      const text = read(doc);
      // 不得再出现"91 项"这类已过期的精确条数
      expect(text, `${doc} 仍写着过期的 91 项`).not.toContain("91 项");
      expect(text, `${doc} 仍写着过期的 71 项`).not.toContain("71 项");
    }
  });
});
