import { describe, expect, it } from "vitest";
import {
  ALLOWED_SHAPES,
  ALLOWED_UNC_HOSTS,
  __testing,
  classifyWindowsPath,
  describeFinding,
  findInternalWorkspacePaths,
} from "../tools/workspace-path-scan.mjs";

/*
 * `__testing` 暴露的判据内部口径。允许表断言必须与检测器**用同一套词表**，
 * 否则两者会对同一个词给出不同答案（N-PR3-2 的教训之一）。
 */
const { PLACEHOLDER_SEGMENTS, OS_SEGMENTS } = __testing;

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

  it("允许表不得成为后门：条目必须逐条可解释且不得复合具名", () => {
    /*
     * 反向保护：允许表是唯一能静默放行一条路径的机制，因此它自身也必须
     * 受约束。
     *
     * ── 旧实现为什么必须换掉（N-PR3-2）──
     *
     * 上一版把 `process.cwd()` 的各级父目录名当作"真实目录名"，再断言允许表
     * 首段不在其中。这让**用例结果取决于检出位置**：允许表里有以 `temp`
     * 为首段的条目，只要仓库被检出在任何名为 `temp` 的层级下（临时目录、
     * CI 的临时工作区），用例立刻变红；换个目录名又变绿。实测：同一棵树在
     * 工作区下通过，检出到临时目录层级下即报"允许表收录了真实目录名"。
     *
     * 而且这个方向是反的：它指控的是"允许表里有个词恰好等于我脚下某个目录
     * 名"，而真正的后门是"允许表里有一个真实安装名"。后者与 cwd 无关。
     *
     * ── 现在的判据（与 cwd 无关）──
     *
     * 一条都不得是**复合具名**形态（`acme-staging`、`owner_checkout`）。允许
     * 表收录的是夹具词汇 —— 单个普通词（`root`、`study`、`temp`、`some`）、
     * 或明确的合成名（`sample-root`、`synthetic-user`）。真实安装目录几乎总是
     * 多段复合名，而复合名一旦进表就等于把某个具体安装加进了白名单。
     *
     * 注意这里**不**复述检测器的词表：允许表的作用恰恰是覆盖检测器对个别
     * 夹具词的判断（`root`、`study` 确实"像一个安装名"），所以用检测器去
     * 判定允许表会自相矛盾。判据只约束"允许表能长什么样"。
     */
    const SYNTHETIC_ALLOWED = /^(?:sample|synthetic|fixture|example|dummy|fake)[-_]/i;

    for (const [shape] of ALLOWED_SHAPES) {
      const first = shape.replace(/^[a-z]:[\\/]/, "").replace(/[\\/]…$/, "");
      const lowered = first.toLowerCase();

      const singleWord = !/[-_.]/.test(first);
      const syntheticName = SYNTHETIC_ALLOWED.test(first);
      const placeholder = PLACEHOLDER_SEGMENTS.has(lowered);
      const osFurniture = OS_SEGMENTS.has(lowered);

      expect(
        singleWord || syntheticName || placeholder || osFurniture,
        `允许表收录了复合具名目录（${shape}）—— 这类形态只可能是真实安装名`,
      ).toBe(true);
    }
  });

  /**
   * ── N-PR3-2 的固定回归：判定与检出目录名无关 ──
   *
   * 把旧算法的判定函数显式写出来，在两组输入上跑：一组目录名碰巧等于允许表
   * 词汇，一组是中性名。旧断言在两组之间结论**不同**（前者红、后者绿）——
   * 这就是缺陷。新判据不读 cwd，所以两组结论必须一致。
   */
  it("允许表判定与检出目录名无关（N-PR3-2 回归）", () => {
    /*
     * 这些目录名的首段都出现在 `ALLOWED_SHAPES` 里，且在真实机器上都可能是
     * 检出路径的某一级。运行时拼出，本文件不落完整字面量。
     */
    const collidingCheckouts = ["temp", "repo", "some", "synthetic-user", "sample-root"].map(
      (segment) => win("C:", segment, "checkout"),
    );
    const neutralCheckouts = ["workspace", "dev", "ci-run-42"].map((segment) =>
      win("C:", segment, "checkout"),
    );

    /** 旧算法：把 cwd 各级父目录名当作"真实目录名"，再与允许表首段比对。 */
    const oldRuleFails = (cwd: string): boolean => {
      const realNames = new Set(
        cwd
          .replace(/\\/g, "/")
          .split("/")
          .filter(Boolean)
          .map((segment) => segment.toLowerCase())
          .filter((segment) => segment.length >= 2),
      );
      return [...ALLOWED_SHAPES.keys()].some((shape) =>
        realNames.has(shape.replace(/^[a-z]:[\\/]/, "").replace(/[\\/]…$/, "").toLowerCase()),
      );
    };

    /*
     * 前提：旧算法确实在"名字碰撞"组上变红、在中性组上不变红。若这条前提
     * 不成立，本回归就证明不了任何事 —— 所以它本身也是断言。
     */
    expect(collidingCheckouts.filter(oldRuleFails).length, "旧算法应在碰撞组上失败").toBe(
      collidingCheckouts.length,
    );
    expect(neutralCheckouts.filter(oldRuleFails).length, "旧算法在中性组上不应失败").toBe(0);

    /*
     * 新判据：完全不读 cwd。同一份允许表在任何检出位置下结论一致。
     */
    const SYNTHETIC_ALLOWED = /^(?:sample|synthetic|fixture|example|dummy|fake)[-_]/i;
    const verdict = (): boolean =>
      [...ALLOWED_SHAPES.keys()].every((shape) => {
        const first = shape.replace(/^[a-z]:[\\/]/, "").replace(/[\\/]…$/, "");
        const lowered = first.toLowerCase();
        return (
          !/[-_.]/.test(first) ||
          SYNTHETIC_ALLOWED.test(first) ||
          PLACEHOLDER_SEGMENTS.has(lowered) ||
          OS_SEGMENTS.has(lowered)
        );
      });

    const verdicts = [...collidingCheckouts, ...neutralCheckouts].map(() => verdict());
    expect(new Set(verdicts).size, "判定结果必须与 cwd 无关（两组完全一致）").toBe(1);
    expect(verdicts[0], "允许表必须通过该判定").toBe(true);
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
