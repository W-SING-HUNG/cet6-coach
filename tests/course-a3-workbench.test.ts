// @vitest-environment node
/**
 * A3 受控课程接入 · 界面外壳与源码级边界。
 *
 * ── 这个文件守的是"只有真实浏览器才发现得了"的那一类缺陷 ──
 *
 * 本轮实测踩到两次同一个形态：`a3-client-script.ts` 导出的是
 * `String.raw` 原文，而我在**注释里写了反引号** —— 它提前结束了模板字符串，
 * 于是整个脚本在编译期就被截断。
 *
 * 那正是本项目已登记过的 F1 缺陷形态：
 * 两层转义把脚本截断，整页交互全死，而 HTTP 仍 200、所有字符串正则断言
 * 全部照过。因此这里必须有一条**机械门禁**：
 *
 * 1. 从**真实渲染输出**里抽出的内联脚本必须能被 V8 编译；
 * 2. 原文里不得出现反引号或 `${}` 插值（那会改变脚本字节）；
 * 3. 外壳本身必须是零参数静态文档。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { A3_CLIENT_SCRIPT } from "@/content/course-pipeline/a3-client-script";
import { renderA3Shell } from "@/content/course-pipeline/a3-page";
import { ADJUDICATION_CLIENT_SCRIPT } from "@/content/course-pipeline/adjudication-client-script";
import { renderAdjudicationShell } from "@/content/course-pipeline/adjudication-page";

const REPO_ROOT = join(__dirname, "..");

/** 从 HTML 里抽出内联 `<script>` 的正文（**真实渲染输出**，不是源文件）。 */
function inlineScriptOf(html: string): string {
  const match = /<script>\s*([\s\S]*?)\s*<\/script>/.exec(html);
  expect(match, "外壳里必须恰好有一段内联脚本").not.toBeNull();
  return match![1];
}

describe("A3 · 客户端脚本的单层转义边界（F1 形态）", () => {
  it("A3 客户端脚本原文不含反引号（那会提前结束 String.raw 模板）", () => {
    const source = readFileSync(join(REPO_ROOT, "src/content/course-pipeline/a3-client-script.ts"), "utf8");
    const body = /export const A3_CLIENT_SCRIPT = String\.raw`([\s\S]*)`;\s*$/.exec(source);
    expect(body, "未找到 String.raw 原文").not.toBeNull();
    const backticks = body![1].match(/`/g) ?? [];
    expect(
      backticks.length,
      "脚本原文里不得出现反引号 —— 它会提前结束模板字符串，整页交互全死而 HTTP 仍 200（F1 形态）。" +
        "注释里请用引号而不是反引号。",
    ).toBe(0);
  });

  it("A3 客户端脚本原文不含任何插值", () => {
    const script = A3_CLIENT_SCRIPT;
    expect(script.includes("${"), "脚本原文不得含 ${} 插值").toBe(false);
  });

  it("从**真实渲染输出**抽出的 A3 内联脚本能被 V8 编译", () => {
    const html = renderA3Shell();
    const script = inlineScriptOf(html);
    // `new Function` 走真实解析器：语法错误立刻抛
    expect(() => new Function(script)).not.toThrow();
  });

  it("A2 客户端脚本同样遵守单层转义边界（回归）", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/content/course-pipeline/adjudication-client-script.ts"),
      "utf8",
    );
    const body = /export const ADJUDICATION_CLIENT_SCRIPT = String\.raw`([\s\S]*)`;\s*$/.exec(source);
    expect(body, "未找到 A2 的 String.raw 原文").not.toBeNull();
    expect((body![1].match(/`/g) ?? []).length, "A2 脚本原文里不得出现反引号").toBe(0);
    expect(ADJUDICATION_CLIENT_SCRIPT.includes("${"), "A2 脚本原文不得含插值").toBe(false);
    expect(() => new Function(inlineScriptOf(renderAdjudicationShell()))).not.toThrow();
  });
});

describe("A3 · 数据库路径必须是**每次现算**的（隔离缺陷的源码级门禁）", () => {
  /*
   * ── 这条门禁守的是一个实测踩到过的隔离缺陷 ──
   *
   * `DB_FILE` 曾经是模块级常量：`const DB_FILE = process.env.CET6_DB_PATH ?? ...`。
   * 它在 **import 时**求值一次，于是任何"先 import、后设 CET6_DB_PATH"
   * 的启动器（A3 的 E2E 实例、证明脚本）都会拿到**默认库**
   * `<cwd>/data/cet6.db`，而它的读路径也指向那里 ——
   * 于是合成夹具被写进开发库，且**一切断言照过**。
   *
   * 判据因此必须是结构性的：会切换库的调用方一律用 `getDbFile()`。
   */
  it("会切换库的调用方使用 getDbFile()，而不是模块级常量", () => {
    for (const file of [
      "src/repositories/sqlite/index.ts",
      "src/services/course-a3.ts",
      "scripts/a3-capability.ts",
    ]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(source, `${file} 必须 import getDbFile`).toContain("getDbFile");
      // 不得再把常量当作"当前库"使用（`DB_FILE` 只能出现在兼容导出里）
      const usesConstant = /[^A-Za-z_]DB_FILE\b/.test(source.replace(/export const DB_FILE = getDbFile\(\);/, ""));
      expect(usesConstant, `${file} 不得用模块级 DB_FILE 常量作为“当前库”`).toBe(false);
    }
  });

  it("getDbFile() 每次调用都反映当前环境（行为判据）", async () => {
    const { getDbFile } = await import("@/db/client");
    const original = process.env.CET6_DB_PATH;
    try {
      process.env.CET6_DB_PATH = "D:/some/other/place.db";
      expect(getDbFile(), "改了环境变量之后立刻反映新值").toBe("D:/some/other/place.db");
      delete process.env.CET6_DB_PATH;
      expect(getDbFile(), "没有环境变量时回落到默认位置").toMatch(/[\\/]data[\\/]cet6\.db$/);
    } finally {
      if (original === undefined) delete process.env.CET6_DB_PATH;
      else process.env.CET6_DB_PATH = original;
    }
  });
});

describe("A3 · 静态外壳（零参数、无私有数据）", () => {  it("外壳渲染函数是**零参数**（签名即结构守卫）", () => {
    expect(renderA3Shell.length, "renderA3Shell 必须是零参数函数").toBe(0);
  });

  it("两次渲染字节完全相同（不含任何随会话变化的东西）", () => {
    expect(renderA3Shell()).toBe(renderA3Shell());
  });

  it("外壳不含课程正文 / token / 绝对路径", () => {
    const html = renderA3Shell();
    expect(html).not.toContain("#token=");
    expect(/[A-Za-z]:\\/.test(html), "外壳不得含盘符路径").toBe(false);
    // 不得出现任何真实材料标记
    expect(html).not.toContain("SYNTHETIC FIXTURE");
  });

  it("外壳带 no-referrer，且引用 CSP 由服务端下发（这里只断言 meta）", () => {
    const html = renderA3Shell();
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it("三项执行边界各自有独立确认控件，且**没有**「全部完成」按钮", () => {
    const html = renderA3Shell();
    for (const id of ["promoteBtn", "importBtn", "linkPreviewBtn", "linkCommitBtn"]) {
      expect(html, `缺少独立确认控件 ${id}`).toContain(`id="${id}"`);
    }
    /*
     * 判据必须落在**按钮**上，而不是任何出现"全部完成"的地方。
     *
     * 页面上确实有一处「全部完成」—— 那是完成后的**提示面板**
     * （`#donePanel`，三项都成功后才显示，里面只有一个去 Companion 的链接）。
     * 把"出现这四个字"当成缺陷会误报；真正的缺陷是**一个按钮**能同时
     * 批准三项。因此这里只检查所有 `<button>` 的可见文字。
     */
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length, "页面上应当有若干按钮").toBeGreaterThan(0);
    for (const button of buttons) {
      expect(
        /全部完成|一键|全部执行|全部接入/.test(button),
        `按钮里不得出现把三项合并的措辞：${button.slice(0, 80)}`,
      ).toBe(false);
    }
    // `#donePanel` 里不得含任何按钮（它只是完成后的引导）
    const donePanel = /<section class="panel" id="donePanel"[\s\S]*?<\/section>/.exec(html);
    expect(donePanel, "未找到完成面板").not.toBeNull();
    expect(/<button/.test(donePanel![0]), "#donePanel 不得含按钮").toBe(false);
  });

  it("每个执行边界都说明了写入位置与不可逆性", () => {
    const html = renderA3Shell();
    expect(html).toContain("private-content/courses/");
    expect(html).toContain("不可逆");
    expect(html, "导入必须说明首次会触发迁移").toContain("v8 → v9");
    expect(html, "建链必须说明行不可改不可删").toContain("不能改也不能删");
  });
});
