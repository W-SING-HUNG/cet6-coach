import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 历史门禁的**覆盖完整性**回归。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * `.github/workflows/verify.yml` 使用 `actions/checkout@v4` 的默认检出，即
 * **只取 1 个提交**。`audit-history.mjs` 扫的是 `git log --all`，在 depth-1 克隆
 * 上只能看到那一个提交，于是它报 `no internal process vocabulary in 1 message(s)`
 * 并 **PASS** —— 而当时的可达历史有 16 个提交。`audit-object-database.mjs` 确实
 * 会 unshallow，但它在同一 Job 里**排在历史审计之后**，所以绿灯已经发出去了。
 *
 * 实测（4 提交探针仓库，第 3 个提交带合成状态代号）：
 *
 *   历史审计（浅克隆）      → exit 0，"in 1 message(s)"     ← 缺陷
 *   对象审计（触发 unshallow）
 *   历史审计（历史已完整）  → exit 1，"in 4 message(s)"
 *
 * 这不是"已确认发生了新泄露"，但它违反"公开历史必须完整检查"这一验收标准：
 * 绿色的历史结论不能建立在一个被截断的图上。
 *
 * ── 修复的两层 ──
 *
 *   1. workflow 用 `fetch-depth: 0` 取全量历史（把常见情形做对）；
 *   2. `audit-history.mjs` 自带完成度检查：先尝试 unshallow，**然后验证**历史
 *      确实完整；仍不完整就 **fail-closed**。
 *
 * 两层都要有：只有 1，离线/部分成功的 fetch 仍会留下截断图；只有 2，CI 会因为
 * 检出配置而非代码变红，那种红最终会被人关掉。
 *
 * ── 样本只用合成标识 ──
 *
 * 所有代号都是明显虚构的 `PROBE`/`ZPROBE` 系列，不重现任何真实内部状态代号。
 */

const REPO_ROOT = process.cwd();
const TOOLS = ["audit-history.mjs", "internal-status-code-scan.mjs"];

/** 合成的内部验收状态代号 —— 运行时拼出，源码不落完整字面量。 */
const syntheticCode = (project: string): string =>
  [project, "STAGE", "REVIEW", "APPROVED"].join("_");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).toString();

interface Probe {
  dir: string;
  origin: string;
  shallow: string;
}

/**
 * 造一个 4 提交的探针仓库，第 3 个提交（HEAD 的祖先）携带合成状态代号，然后
 * 取一个 depth-1 克隆 —— 等价于 `actions/checkout@v4` 的默认行为。
 */
function makeProbe(prefix: string): Probe {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const origin = join(dir, "origin");
  const shallow = join(dir, "shallow");

  mkdirSync(join(origin, "tools"), { recursive: true });
  for (const file of TOOLS) {
    copyFileSync(join(REPO_ROOT, "tools", file), join(origin, "tools", file));
  }
  writeFileSync(join(origin, "README.md"), "# probe\n", "utf8");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(origin, ".gitattributes"), "* text=auto\n*.ts text eol=lf\n*.md text eol=lf\n", "utf8");

  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "user.email", "t@example.com");
  git(origin, "config", "user.name", "T");
  git(origin, "config", "commit.gpgsign", "false");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "chore: root");
  git(origin, "commit", "-q", "--allow-empty", "-m", "chore: second neutral commit");
  /* The violation lives in an ANCESTOR, not in HEAD. */
  git(origin, "commit", "-q", "--allow-empty", "-m",
    `feat: ancestor with violation\n\nBody carries ${syntheticCode("ZPROBE")} here.`);
  git(origin, "commit", "-q", "--allow-empty", "-m", "chore: neutral HEAD");

  git(dir, "clone", "-q", "--depth", "1", `file:///${origin.replace(/\\/g, "/")}`, shallow);
  return { dir, origin, shallow };
}

/** 在指定仓库里跑历史审计。 */
function runHistoryAudit(cwd: string, args: string[] = []): { status: number; out: string } {
  const r = spawnSync(process.execPath, [join(cwd, "tools", "audit-history.mjs"), ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * 替换某个仓库副本里的 `ACCEPTED_LEGACY` 表。
 *
 * 合成仓库里不存在真实历史中那个被接受的提交，所以凡是只考察其它性质、又希望
 * 结果只由该性质决定的用例，都需要把例外表置空或改写成与合成历史匹配的内容。
 */
function patchAcceptance(repoDir: string, body: string): void {
  const path = join(repoDir, "tools", "audit-history.mjs");
  const source = readFileSync(path, "utf8");
  const anchor = /const ACCEPTED_LEGACY = new Map\(\[[\s\S]*?\n  \]\);/;
  if (!anchor.test(source)) {
    throw new Error("ACCEPTED_LEGACY anchor not found — the gate's shape changed");
  }
  writeFileSync(path, source.replace(anchor, `const ACCEPTED_LEGACY = new Map([${body}]);`), "utf8");
}

describe("历史门禁 · 覆盖完整性", () => {
  it("浅克隆上运行历史审计会补齐历史并拒绝祖先违规", () => {
    /*
     * 修复前：这里 exit 0、"in 1 message(s)"，祖先违规完全不可见。
     * 修复后：审计自己 unshallow，看到 4 个提交并拒绝。
     */
    const probe = makeProbe("hg-ancestor");
    try {
      const before = Number.parseInt(git(probe.shallow, "rev-list", "--count", "HEAD").trim(), 10);
      expect(before, "探针必须确实是浅克隆").toBe(1);
      expect(git(probe.shallow, "rev-parse", "--is-shallow-repository").trim()).toBe("true");

      const { status, out } = runHistoryAudit(probe.shallow);

      expect(status, `必须拒绝。输出：\n${out}`).not.toBe(0);
      /* 拒绝原因必须是**祖先提交的说明违规**，而不是别的东西。 */
      expect(out, "必须点名状态代号违规").toMatch(/internal status code/);
      /* 而且必须真的看到了 4 个提交，而不是 1 个。 */
      expect(out, "必须覆盖全部 4 个提交").toMatch(/in 4 message\(s\)/);
      expect(out, "不得只扫 1 个提交就报结论").not.toMatch(/in 1 message\(s\)/);

      /* 审计完成后仓库应当不再是浅克隆。 */
      expect(git(probe.shallow, "rev-parse", "--is-shallow-repository").trim()).toBe("false");
    } finally {
      rmSync(probe.dir, { recursive: true, force: true });
    }
  });

  it("无法取得完整历史时 fail-closed（不得只扫可见提交就报通过）", () => {
    const probe = makeProbe("hg-failclosed");
    try {
      /* 让 unshallow 不可能成功：把 origin 指向不存在的路径。 */
      git(probe.shallow, "remote", "set-url", "origin", "file:///nonexistent/probe.git");

      const { status, out } = runHistoryAudit(probe.shallow);

      expect(status, `历史不完整时必须失败。输出：\n${out}`).not.toBe(0);
      expect(out, "必须显式说明历史仍不完整").toMatch(/still shallow|truncated/);
      expect(out, "绝不能声称全部通过").not.toMatch(/all \d+ history checks passed/);
    } finally {
      rmSync(probe.dir, { recursive: true, force: true });
    }
  });

  it("完整历史且无违规时通过，并覆盖全部提交", () => {
    const probe = makeProbe("hg-clean");
    try {
      /*
       * ── 为什么这里要清空例外表 ──
       *
       * 用两个中性提交重建一个干净历史后，`ACCEPTED_LEGACY` 里那条真实例外指的
       * 提交不在这个合成仓库里，于是**反向断言会正确地报"已不再存在"** —— 这是
       * fail-safe 的设计意图，不是缺陷。
       *
       * 本用例只考察"完整历史 + 无违规 → 通过"，所以例外表必须为空；例外表本身
       * 的精确性由下面单独的一组用例负责。若不清空，这条用例会因为一个与它无关
       * 的正确告警而变红。
       */
      const cleanOrigin = join(probe.dir, "clean-origin");
      mkdirSync(join(cleanOrigin, "tools"), { recursive: true });
      for (const file of TOOLS) {
        copyFileSync(join(REPO_ROOT, "tools", file), join(cleanOrigin, "tools", file));
      }
      patchAcceptance(cleanOrigin, "");
      writeFileSync(join(cleanOrigin, "README.md"), "# probe\n", "utf8");
      writeFileSync(join(cleanOrigin, ".gitignore"), "node_modules/\n", "utf8");
      writeFileSync(join(cleanOrigin, ".gitattributes"), "* text=auto\n*.ts text eol=lf\n*.md text eol=lf\n", "utf8");
      git(cleanOrigin, "init", "-q", "-b", "master");
      git(cleanOrigin, "config", "user.email", "t@example.com");
      git(cleanOrigin, "config", "user.name", "T");
      git(cleanOrigin, "config", "commit.gpgsign", "false");
      git(cleanOrigin, "add", "-A");
      git(cleanOrigin, "commit", "-q", "-m", "chore: root");
      git(cleanOrigin, "commit", "-q", "--allow-empty", "-m", "chore: neutral second");
      git(cleanOrigin, "commit", "-q", "--allow-empty", "-m", "chore: neutral HEAD");

      const cleanClone = join(probe.dir, "clean-clone");
      git(probe.dir, "clone", "-q", "--depth", "1", `file:///${cleanOrigin.replace(/\\/g, "/")}`, cleanClone);

      const { status, out } = runHistoryAudit(cleanClone);
      expect(status, `干净历史应通过。输出：\n${out}`).toBe(0);
      expect(out, "必须覆盖 3 个提交").toMatch(/in 3 message\(s\)/);
      expect(out, "完整性检查本身必须通过").toMatch(/reachable history is complete/);
    } finally {
      rmSync(probe.dir, { recursive: true, force: true });
    }
  });
});

describe("历史门禁 · 已接受的旧提交例外仍然精确", () => {
  const AUDIT = new URL("../tools/audit-history.mjs", import.meta.url);

  it("例外表仍以 commit SHA + token 摘要为键（未放宽）", () => {
    const source = readFileSync(AUDIT, "utf8");
    const table = /const ACCEPTED_LEGACY = new Map\(\[([\s\S]*?)\n  \]\);/.exec(source)?.[1] ?? "";
    expect(table, "例外表必须存在").not.toBe("");
    expect(table, "以 40 位 SHA 为键").toMatch(/"[0-9a-f]{40}"/);
    expect(table, "值为 token 摘要映射").toMatch(/new Map\(\[/);
    expect(table, "摘要为 SHA-256 十六进制").toMatch(/"[0-9a-f]{64}"/);
    /* 不得出现日期/分支/记录路径式的宽松条件。 */
    for (const banned of [/\d{4}-\d{2}-\d{2}/, /refs\/heads/]) {
      expect(table, `不得使用宽泛条件 ${banned}`).not.toMatch(banned);
    }
  });

  it("例外不得被新增违规提交借用", () => {
    /*
     * 构造：一个提交带**两个**代号，只为其中一个登记接受条目。
     * 另一个必须仍被拒绝 —— 证明例外精确到 token，而不是整条提交。
     */
    const dir = mkdtempSync(join(tmpdir(), "hg-borrow-"));
    try {
      mkdirSync(join(dir, "tools"), { recursive: true });
      for (const file of TOOLS) {
        copyFileSync(join(REPO_ROOT, "tools", file), join(dir, "tools", file));
      }
      writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
      writeFileSync(join(dir, ".gitattributes"), "* text=auto\n*.ts text eol=lf\n*.md text eol=lf\n", "utf8");
      git(dir, "init", "-q", "-b", "master");
      git(dir, "config", "user.email", "t@example.com");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "chore: baseline");

      const accepted = syntheticCode("ZPROBE");
      const other = ["ZPROBE", "STAGE", "RELEASE", "APPROVED"].join("_");
      git(dir, "commit", "-q", "--allow-empty", "-m", `feat: merge\n\nHas ${accepted} and ${other}`);
      const sha = git(dir, "rev-parse", "HEAD").trim();
      const digest = createDigest(accepted);

      /* 只为 accepted 登记例外。 */
      patchAcceptance(
        dir,
        `\n    [\n      ${JSON.stringify(sha)},\n      new Map([\n        [${JSON.stringify(digest)}, "probe acceptance"],\n      ]),\n    ],\n  `,
      );

      const { status, out } = runHistoryAudit(dir);
      expect(status, `另一个代号必须仍被拒绝。输出：\n${out}`).not.toBe(0);
      const reported = out.match(/internal status code \((<PROJECT>_[A-Z_]+)\)/g) ?? [];
      expect(reported.length, `应恰好报告 1 个代号，实际 ${reported.length}：\n${out}`).toBe(1);
      expect(reported[0], "被接受的那个不得被报告").toContain("RELEASE_APPROVED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** SHA-256 of a token, matching the gate's own digest. */
function createDigest(token: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(token, "utf8").digest("hex");
}
