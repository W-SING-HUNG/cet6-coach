#!/usr/bin/env node
/**
 * 生成一份**合成试卷夹具**到指定内容根（仅供验证/演示 CLI 行为）。
 *
 * 与 `scripts/paper-fixture.ts` 同源：`sourceKind` 写死为 `test_fixture`，
 * 内容为合成文本，**不是**真题。
 *
 * 用法：node --experimental-transform-types --import ./scripts/alias-loader.mjs \
 *         scripts/course-demo-paper.ts <content-root> [contentVersion]
 */

import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";

const root = process.argv[2];
const contentVersion = Number(process.argv[3] ?? "1");

if (!root) {
  console.error("用法：course-demo-paper.ts <content-root> [contentVersion]");
  process.exitCode = 1;
} else {
  const fixture = buildFixturePackage({ contentVersion });
  const dir = writeFixturePackage(root, "demo-paper-set1", fixture);
  console.log(`已写入合成试卷夹具：${dir}（contentVersion=${contentVersion}）`);
}
