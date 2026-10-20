import { describe, expect, it } from "vitest";
import {
  ALLOWED_SHAPES,
  ALLOWED_UNC_HOSTS,
  classifyWindowsPath,
  describeFinding,
  findInternalWorkspacePaths,
} from "../tools/workspace-path-scan.mjs";

/**
 * `tools/workspace-path-scan.mjs` 的**单元级**回归。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 独立复评发现：公开源码里有 4 处**字面量**写出了构建机的暂存目录
 * （一处 build 工具注释、一处 sanitiser 夹具、一处测试注释）。
 * 原有的结构判据只认「用户主目录」形态（`<drive>:\Users\<name>\…`、
 * `/home/<name>/…`）—— 而暂存工作区**不是**用户主目录，于是这 4 处
 * 全部静默通过。
 *
 * 所以本组用例检查的不是"某个具体字符串被禁"，而是**判据的结构**：
 *
 * 1. 任意盘符、任意用户名的内部工作区路径都必须被抓到；
 * 2. 合法的公开内容（OS 路径、合成夹具、已脱敏、URL、应用路由）必须放行；
 * 3. 报告**不得**回显路径本身（CI 日志与仓库同等公开）。
 *
 * ── 为什么用运行时拼接 ──
 *
 * 这些用例要断言"某个形状会被拒绝"，而它们自己就在被扫描的树里。
 * 直接写字面量会让本文件自己成为一条泄露 —— 与它要防的缺陷同类。
 * 因此所有"真实形状"都在运行时由片段拼出。
 */

const BS = String.fromCharCode(92);
const FS = "/";
/**
 * 用分隔符拼接路径，源码中不出现完整字面量。
 *
 * 这不是风格问题：本文件**也在被扫描的树里**。若这里直接写出一个看起来像
 * 真实工作区的路径，它自己就会成为一条泄露 —— 与它要防的缺陷同类。
 * 因此所有"真实形状"都由片段在运行时拼出。
 */
const win = (...segments: string[]): string => segments.join(BS);

/** 一个在运行时才成形的"像真实工作区"的目录名。 */
const WORKSPACE = ["acme", "staging", "7"].join("-");
const SECRET_WORKSPACE = ["acme", "secret", "workspace", "9"].join("-");

describe("内部工作区路径判据 · 必须抓到", () => {
  const cases: Array<[string, string]> = [
    ["正斜杠 + 未知盘符", ["D:", WORKSPACE, "tools", "probe.ts"].join(FS)],
    ["反斜杠 + 未知盘符", win("E:", WORKSPACE, "tools", "probe.ts")],
    ["小写盘符", win("d:", "internal-thing", "src", "a.ts")],
    ["JSON 转义的双反斜杠", win("D:", "", WORKSPACE, "tools", "a.ts")],
    ["构建机检出目录", win("F:", "builds", "agent-runner-7", "checkout", "src", "a.ts")],
    ["单个像真实目录的段", win("G:", "real-workspace-name", "x")],
  ];

  for (const [label, probe] of cases) {
    it(`${label} 会被判为内部路径`, () => {
      const hits = findInternalWorkspacePaths(probe);
      expect(hits.length, `${label}: ${probe}`).toBeGreaterThan(0);
      expect(hits[0].shape).toBe("windows-internal-workspace");
    });
  }

  it("脱敏只发生在**首段**才放行（尾部的省略号不能洗白真实首段）", () => {
    /*
     * `<drive>:\<real-name>\…` 仍然点名了 `<real-name>`。
     * 若把"任意位置出现省略号"当作已脱敏，这条就会漏。
     */
    const tailRedacted = win("D:", "acme-staging-7", "…");
    expect(findInternalWorkspacePaths(tailRedacted).length, "尾部省略号不得洗白真实首段").toBe(1);

    const headRedacted = win("D:", "...", "private-content");
    expect(findInternalWorkspacePaths(headRedacted).length, "首段省略号表示已脱敏").toBe(0);
  });

  it("POSIX 家目录：账户非占位符才报", () => {
    const roots = ["/home", "/Users"];
    const real = "/" + ["home", "somebody-xyz", "projects", "a.ts"].join("/");
    const placeholder = "/" + ["home", "you", "project", "a.ts"].join("/");

    expect(findInternalWorkspacePaths(real, { posixRoots: roots }).length, "真实账户名必须被报").toBe(1);
    expect(findInternalWorkspacePaths(placeholder, { posixRoots: roots }).length, "占位账户名放行").toBe(0);
  });

  it("裸根标记（`/home/`）本身不是泄露", () => {
    /*
     * 判据要在自己的文档里写出它匹配什么，那是正确内容。
     * 没有账户段的裸标记不含任何身份。
     */
    expect(findInternalWorkspacePaths('"/' + 'home/" 与 "/' + 'Users/" 是两种约定').length).toBe(0);
  });
});

describe("内部工作区路径判据 · 合法内容必须放行", () => {
  const allowed: Array<[string, string]> = [
    ["OS 路径（每台 Windows 都有）", win("C:", "Windows", "system32", "win.ini")],
    ["合成根", win("Q:", "sample-root", "private-content", "courses", "x")],
    ["合成账户", win("C:", "Users", "synthetic", "AppData", "Local", "cet6-content")],
    ["首段省略号", win("D:", "...", "private-content")],
    ["单字母段", win("D:", "a", "b")],
    ["临时目录夹具", win("C:", "temp", "evil")],
    ["合成用户夹具", win("D:", "synthetic-user", "Documents", "secret.txt")],
    ["README 示例", win("D:", "study", "cet6-content")],
    ["裸盘符", win("D:", "")],
    ["URL", "https://example.com/path/to/thing"],
    ["形似盘符的 scheme", "s3://bucket/key"],
    ["应用路由", "/practice/courses/abc/segment/x"],
    ["POSIX 路由", "/api/courses/xyz"],
    ["包版本号", "npm install pkg@1.2.3"],
  ];

  for (const [label, probe] of allowed) {
    it(`${label} 不被误报`, () => {
      expect(findInternalWorkspacePaths(probe), `${label}: ${probe}`).toEqual([]);
    });
  }
});

describe("内部工作区路径判据 · 报告与允许表", () => {
  it("报告不回显完整路径（只保留盘符与首段）", () => {
    /*
     * CI 日志与仓库同等公开。把匹配到的**完整**路径打进日志，等于把泄露
     * 从树里搬到了日志里 —— 那不是修复。
     *
     * 报告刻意保留盘符与首段的归一化形式：足以让人定位到"哪台机器的哪类
     * 布局"，不足以还原目录结构或定位到具体文件。
     */
    const probe = win("I:", SECRET_WORKSPACE, "deep", "deeper", "a.ts");
    const [hit] = findInternalWorkspacePaths(probe);
    const rendered = describeFinding(hit);

    expect(rendered).toContain("windows-internal-workspace");
    // 末段与更深层目录不得出现 —— 那些才是还原布局所需的细节。
    expect(rendered, "报告不得包含末段文件名").not.toContain("a.ts");
    expect(rendered, "报告不得包含更深层目录").not.toContain("deep");
    expect(hit.normalised, "归一化形式只到首段").toBe(`i:${BS}${SECRET_WORKSPACE}${BS}…`);
    expect(rendered).toContain(`i:${BS}${SECRET_WORKSPACE}${BS}…`);
  });

  it("允许表每一条都给出理由（不允许无名豁免）", () => {
    expect(ALLOWED_SHAPES.size).toBeGreaterThan(0);
    for (const [shape, reason] of ALLOWED_SHAPES) {
      expect(typeof reason, `${shape} 缺少理由`).toBe("string");
      expect(reason.length, `${shape} 的理由过短`).toBeGreaterThan(10);
    }
  });

  it("允许表不得包含任何形如真实工作区的条目", () => {
    /*
     * 反向保护：允许表是唯一能静默放行一条路径的机制，因此它自身也必须
     * 受约束 —— 一条形如 `<drive>:\<像真实目录名>\…` 的条目等于开后门。
     *
     * ── 为什么"禁止名单"必须在运行时推导 ──
     *
     * 本文件自己也在被扫描的树里。若这里把真实的工作区目录名**写死**成
     * 字面量，这条断言本身就泄露了它想保护的东西 —— 与 N-V8-1 同类。
     * 因此名单来自"当前进程实际位于哪个目录"，而不是一份手抄清单：
     * 判据检查的是"允许表不得收录任何真实目录名"，而"真实"由运行环境定义。
     */
    const here = process.cwd().replace(/\\/g, "/").split("/").filter(Boolean);
    // 当前工作目录的各级父目录名，就是这台机器上真实存在的目录名。
    const realDirectoryNames = new Set(
      here.map((segment) => segment.toLowerCase()).filter((segment) => segment.length >= 2),
    );

    for (const [shape] of ALLOWED_SHAPES) {
      const first = shape.replace(/^[a-z]:[\\/]/, "").replace(/\\…$/, "").toLowerCase();
      expect(
        realDirectoryNames.has(first),
        `允许表收录了真实目录名（${shape}）—— 允许表只能收录合成/占位词`,
      ).toBe(false);
    }
  });
});

describe("Windows 路径分类", () => {
  it("纯 OS 形态归类为 non-disclosing", () => {
    const r = classifyWindowsPath(win("C:", "Windows", "system32"));
    expect(r.finding).toBe(false);
    expect(r.shape).toBe("windows-non-disclosing");
  });

  it("真实工作区归类为 internal-workspace", () => {
    const r = classifyWindowsPath(win("D:", WORKSPACE, "tools"));
    expect(r.finding).toBe(true);
    expect(r.shape).toBe("windows-internal-workspace");
  });

  it("归一化形式只保留盘符与首段", () => {
    const r = classifyWindowsPath(win("Z:", WORKSPACE, "deep", "deeper", "a.ts"));
    expect(r.normalised).toBe(`z:${BS}${WORKSPACE}${BS}…`);
  });
});

/**
 * ── UNC 网络路径 ──
 *
 * `\\host\share\…` 直接点名一台机器，与 `C:\Users\<name>` 同级敏感。
 * V9 曾把它记为「范围外」，本次补齐。难点在于源码里的 `\\` 有三种含义：
 *
 *   1. 真 UNC 路径        \\<machine>\<share>\src
 *   2. 转义的相对分隔符   "assets\\sub\\a.wav"
 *   3. 正则/字符串转义    \n  \r  \s  \d
 *
 * 天真规则会把三者全部命中 —— 普查得到 135 个候选，绝大多数是噪声，
 * 而噪声会让人关掉扫描器。因此判据靠**锚点**，不靠枚举已知坏例。
 */
describe("UNC 网络路径判据", () => {
  /** 运行时拼出 UNC 路径，本文件不出现完整字面量。 */
  const unc = (host: string, ...rest: string[]): string =>
    `${BS}${BS}${host}${BS}${rest.join(BS)}`;

  const MUST_CATCH: Array<[string, string]> = [
    ["普通机器名", unc(["acme", "build", "agent"].join("-"), "checkout", "src")],
    ["单段 share", unc("unseen-nas-07", "volume1", "a.ts")],
    ["带点的主机名", unc("fileserver01.corp.example", "share", "x")],
    ["带下划线", unc("build_agent_04", "checkout")],
    ["单字符以外的短名", unc("nas7", "d")],
    ["出现在引号后", `"${unc("machine-x", "share", "a")}"`],
    ["出现在赋值后", `const p = '${unc("machine-x", "share", "a")}';`],
    ["出现在空白后", `built on ${unc("machine-x", "share", "a")}`],
  ];

  for (const [label, probe] of MUST_CATCH) {
    it(`**红**：${label}被判为网络路径`, () => {
      const hits = findInternalWorkspacePaths(probe);
      expect(hits.length, `${label}: ${probe}`).toBeGreaterThan(0);
      expect(hits.some((h) => h.shape === "unc-network-path"), `${label} 应判为 UNC`).toBe(true);
    });
  }

  it("**绿**：转义的相对路径不是 UNC", () => {
    /*
     * `assets\\sub\\a.wav` 是 `assets/sub/a.wav` 的转义写法，`sub` 不是主机。
     * 若判据在这里触发，它就会在几十处夹具上误报。
     */
    expect(findInternalWorkspacePaths(`"assets${BS}${BS}sub${BS}${BS}a.wav"`)).toEqual([]);
    expect(findInternalWorkspacePaths(`"${BS}${BS}sub${BS}${BS}a.wav"`).filter((h) => h.shape === "unc-network-path")).toEqual([]);
  });

  it("**绿**：正则与字符串转义码不是主机", () => {
    /*
     * `\\n`、`\\r`、`\\s`、`\\d` 是单字符转义。真实语料里它们出现上百次 ——
     * 这正是天真规则会产生噪声的主要来源。
     */
    for (const code of ["n", "r", "s", "d", "t", "w", "b", "f", "v", "0", "1", "x", "u", "c", "p"]) {
      const probe = `const re = /a${BS}${BS}${code}b/;`;
      expect(
        findInternalWorkspacePaths(probe).filter((h) => h.shape === "unc-network-path"),
        `\\${code} 不应被判为 UNC 主机`,
      ).toEqual([]);
    }
  });

  it("**绿**：盘符路径里的双反斜杠不是 UNC 主机", () => {
    /*
     * `C:\\Windows\\system32` 含 `\\`，但它是盘符路径。若 UNC 规则在此触发，
     * 就会报出一台叫 `Windows` 的主机 —— 纯噪声。
     */
    const probe = `const p = "C:${BS}${BS}Windows${BS}${BS}system32${BS}win.ini";`;
    expect(findInternalWorkspacePaths(probe).filter((h) => h.shape === "unc-network-path")).toEqual([]);
  });

  it("**绿**：合成主机名被允许，且每条都有理由", () => {
    for (const [host, reason] of ALLOWED_UNC_HOSTS) {
      expect(reason.length, `${host} 缺少理由`).toBeGreaterThan(10);
      const probe = `// ${BS}${BS}${host}${BS}share${BS}x`;
      expect(
        findInternalWorkspacePaths(probe).filter((h) => h.shape === "unc-network-path"),
        `合成主机 ${host} 不应被报`,
      ).toEqual([]);
    }
  });

  it("报告不回显主机名", () => {
    /*
     * UNC 主机**就是**机器名。把它打进 CI 日志等于把泄露从树里搬到日志里，
     * 因此归一化形式只保留形状占位符。
     */
    const probe = unc("acme-secret-machine", "share", "a.ts");
    const hits = findInternalWorkspacePaths(probe);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].normalised, "报告不得含主机名").not.toContain("acme-secret-machine");
    expect(hits[0].normalised).toContain("<host>");
  });
});
