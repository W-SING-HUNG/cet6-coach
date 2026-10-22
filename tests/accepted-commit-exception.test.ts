import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStatusCodeFinding, findInternalStatusCodes } from "../tools/internal-status-code-scan.mjs";

/**
 * 已公开提交的**精确例外**回归。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 历史审计引入了一条例外：Owner 已接受某个已公开的合并提交里的内部状态代号，
 * 因此不重写历史。第一版实现只按 **commit SHA** 放行：
 *
 *     const accepted = ACCEPTED_LEGACY.get(sha);
 *     if (accepted !== undefined) { seenLegacy.add(sha); continue; }   // 跳过全部
 *
 * 但注释写的是「exact commit SHA **plus the exact token**」。实现与承诺不一致，
 * 而且窄的那个才是要的：提交对象不可变，**规则与被扫描的树都会变**。同一个
 * 提交里一旦出现第二个不同的代号（追加说明、`--reuse-message` 复用正文、
 * 变体写法），旧实现会把它一起放行 —— 一份发给 A 的许可被用来放行 B。
 *
 * 现在例外键是 `SHA → Map<token 摘要, 理由>`，只有两者都命中才抑制。
 *
 * ── 这里怎么验证（不触碰真实历史）──
 *
 * 真实基线提交的 SHA 无法在测试里重建，所以用一个**合成提交**：往它的正文里
 * 塞进「一个被接受的代号 + 一个不同的代号」，再只为前者写入接受条目，然后断言
 * 后者仍被拒绝。这样断言的是**规则本身**，与具体历史无关。
 */

const MODULE_FILES = ["internal-status-code-scan.mjs", "audit-history.mjs"];

/** 造一个一次性仓库：tools 拷贝自真实树，历史为合成。 */
function makeRepo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "shaexempt-"));
  mkdirSync(join(dir, "tools"), { recursive: true });
  for (const file of MODULE_FILES) {
    copyFileSync(
      new URL(`../tools/${file}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      join(dir, "tools", file),
    );
  }
  writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(dir, ".gitattributes"), "* text=auto\n*.ts text eol=lf\n*.md text eol=lf\n", "utf8");

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).toString();

  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: baseline");
  return { dir, git };
}

/** Replace ACCEPTED_LEGACY in a copied audit-history with a supplied body. */
function patchAcceptance(dir: string, body: string): void {
  const path = join(dir, "tools", "audit-history.mjs");
  const source = readFileSync(path, "utf8");
  const anchor = /const ACCEPTED_LEGACY = new Map\(\[[\s\S]*?\n  \]\);/;
  if (!anchor.test(source)) throw new Error("ACCEPTED_LEGACY anchor not found — the gate's shape changed");
  writeFileSync(path, source.replace(anchor, `const ACCEPTED_LEGACY = new Map([${body}]);`), "utf8");
}

function runAudit(dir: string): { status: number; out: string } {
  const r = spawnSync(process.execPath, [join(dir, "tools", "audit-history.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

describe("已公开提交例外 · 必须精确到 SHA + token", () => {
  it("同一提交里：被接受的代号放行，另一个代号仍被拒绝", () => {
    const { dir, git } = makeRepo();
    try {
      const ACCEPTED = ["PROBEX", "STAGE", "REVIEW", "PASS"].join("_");
      const OTHER = ["PROBEX", "STAGE", "RELEASE", "APPROVED"].join("_");
      git("commit", "-q", "--allow-empty", "-m", `feat: merge\n\nBody has ${ACCEPTED} and also ${OTHER}`);
      /* The acceptance must name the commit that actually carries the tokens. */
      const sha = git("rev-parse", "HEAD").trim();

      // Accept ONLY the first token, for that commit.
      patchAcceptance(
        dir,
        `\n    [\n      ${JSON.stringify(sha)},\n      new Map([\n        [${JSON.stringify(digest(ACCEPTED))}, "probe acceptance"],\n      ]),\n    ],\n  `,
      );

      const { status, out } = runAudit(dir);
      /*
       * 必须因**第二个**代号而失败。旧实现（仅按 SHA 跳过）会在这里放绿，
       * 也就是说本断言正是那个洞的回归锁。
       */
      expect(status, `第二个代号必须被拒绝。输出：\n${out}`).not.toBe(0);
      expect(out, "必须点名剩余的那个代号").toMatch(/internal status code/);
      /*
       * 而且**只**剩下它：被接受的那个不应再出现在报告里。
       * 这正是"按 token 而非整条提交"的核心。
       */
      const reported = out.match(/internal status code \((<PROJECT>_[A-Z_]+)\)/g) ?? [];
      expect(reported.length, `应恰好报告一个代号，实际 ${reported.length}：${out}`).toBe(1);
      expect(reported[0], "被接受的代号不得被报告").toContain("RELEASE_APPROVED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("接受的条目若已不再出现，必须报错（防止例外腐烂成永久白名单）", () => {
    const { dir, git } = makeRepo();
    try {
      const ACCEPTED = ["PROBEX", "STAGE", "REVIEW", "PASS"].join("_");
      /* A commit with NO status code at all, but an acceptance naming a token. */
      git("commit", "-q", "--allow-empty", "-m", "chore: neutral message with no status code");
      const sha = git("rev-parse", "HEAD").trim();
      patchAcceptance(
        dir,
        `\n    [\n      ${JSON.stringify(sha)},\n      new Map([\n        [${JSON.stringify(digest(ACCEPTED))}, "stale acceptance"],\n      ]),\n    ],\n  `,
      );

      const { status, out } = runAudit(dir);
      expect(status, `陈旧例外必须报错。输出：\n${out}`).not.toBe(0);
      expect(out, "必须说明该例外已不再需要").toMatch(/no longer present/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("例外不放宽到日期、目录或分支等宽泛条件", () => {
    /*
     * 静态断言：接受表的结构必须是 `SHA → Map<digest, reason>`。
     * 若有人把它改成按日期/路径匹配，这条会失败 —— 那正是被禁止的方向。
     */
    const source = readFileSync(new URL("../tools/audit-history.mjs", import.meta.url), "utf8");
    const table = /const ACCEPTED_LEGACY = new Map\(\[([\s\S]*?)\n  \]\);/.exec(source)?.[1] ?? "";
    expect(table, "接受表必须存在").not.toBe("");
    // 键必须是 40 位十六进制 SHA。
    expect(table, "必须以 commit SHA 为键").toMatch(/"[0-9a-f]{40}"/);
    // 值必须是 Map（token 摘要 → 理由），不是字符串。
    expect(table, "值必须是 token 摘要映射，不能是单字符串").toMatch(/new Map\(\[/);
    // 摘要必须是 64 位十六进制，且长度正确。
    expect(table, "摘要必须是 SHA-256 十六进制").toMatch(/"[0-9a-f]{64}"/);
    // 不得出现日期/路径/分支式的宽松键。
    // 内部记录路径在运行时拼出：本文件也在被扫描的树里，写死字面量会自己成为
    // 一条泄露 —— 与本仓库其它安全用例的写法一致。
    const internalRecordPath = ["." , "opc"].join("") + "/";
    for (const banned of [/\d{4}-\d{2}-\d{2}/, /refs\/heads/]) {
      expect(table, `不得使用宽泛条件 ${banned}`).not.toMatch(banned);
    }
    expect(table, "不得把内部记录路径写成例外条件").not.toContain(internalRecordPath);
  });

  it("被接受的代号的源码不以任何可直接还原的形式存在", () => {
    /*
     * 例外必须用摘要，不能在文件里写下 token 本身（或分段拼接——那也能还原）。
     * 这条同时守住「扫描器不得携带它所要禁止的材料」。
     */
    const source = readFileSync(new URL("../tools/audit-history.mjs", import.meta.url), "utf8");
    for (const fragment of ["INDEPENDENT", "REVIEW_PASS", "PR3"]) {
      expect(source, `源码不得包含可还原片段 ${fragment}`).not.toContain(fragment);
    }
  });
});

describe("状态代号检测 · 报告的脱敏形式", () => {
  it("报告只保留裁决词，不回显具名首段", () => {
    const token = ["NAMEDPROBE", "STAGE", "REVIEW", "APPROVED"].join("_");
    const [finding] = findInternalStatusCodes(token);
    const rendered = describeStatusCodeFinding(finding);
    expect(rendered).toContain("<PROJECT>");
    expect(rendered).not.toContain("NAMEDPROBE");
    expect(rendered).toContain("APPROVED");
  });
});
