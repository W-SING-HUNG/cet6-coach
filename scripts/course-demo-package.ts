#!/usr/bin/env node
/**
 * 生成一个**合成**课程包到指定内容根（仅供验证/演示 CLI 行为）。
 *
 * 硬约束与 `scripts/course-fixture.ts` 相同：provider 写死为
 * `test_fixture_provider`，内容为通用合成文本，**不是**任何真实课程材料。
 * 它存在的理由是让 `pnpm course:validate` / `course:import` / `course:link`
 * 能在**真实磁盘形态**上被验证，而不是只在单元测试的内存夹具上。
 *
 * 用法：node --experimental-transform-types --import ./scripts/alias-loader.mjs \
 *         scripts/course-demo-package.ts <content-root> [--malformed] [--drift]
 *
 * `--malformed`：把资产 checksum 改错（验证资产校验门禁）。
 * `--drift`：**在不升 contentVersion 的前提下**改动盘上的 course.json
 *            （验证"包漂移必须让链接立即不可用"这条 fail-closed 语义）。
 */

import { buildCourseFixture, writeCourseFixture } from "./course-fixture";

const root = process.argv[2];
const malformed = process.argv.includes("--malformed");
const drift = process.argv.includes("--drift");

if (!root) {
  console.error("用法：course-demo-package.ts <content-root> [--malformed] [--drift]");
  process.exitCode = 1;
} else {
  const fixture = buildCourseFixture({ id: "demo-course-a", title: "演示课程包（合成夹具）" });
  const dir = writeCourseFixture(root, "demo-course-a", fixture);
  console.log(`已写入合成课程包：${dir}`);

  if (malformed) {
    // 制造一个**真实的**破坏：把 manifest 里的一个 checksum 改错。
    // 这比把 JSON 写坏更有价值 —— 它验证的是资产校验路径，而不是 JSON 解析路径。
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const manifestPath = join(dir, "course.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets: Array<{ checksum: string }>;
    };
    manifest.assets[0].checksum = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log("已破坏第一个资产的 checksum（用于验证校验和门禁）");
  }

  if (drift) {
    // 关键：**保持 contentVersion 不变**，只改内容。
    // 这正是"版本比对会全部通过、而内容已经换了"的 fail-open 形态。
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const manifestPath = join(dir, "course.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      segments: Array<{ id: string; text?: string | null }>;
    };
    const first = manifest.segments[0];
    first.text = `DRIFTED WITHOUT VERSION BUMP: ${first.text ?? ""}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(
      "已在**不递增 contentVersion** 的前提下改动 course.json（用于验证包漂移必须 fail closed）",
    );
  }
}
