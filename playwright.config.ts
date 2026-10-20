import { defineConfig, devices } from "@playwright/test";
import { E2E_ARTIFACTS_DIR, E2E_BASE_URL, E2E_REAL_ONLY_SPECS } from "./e2e/config";
import { SYNTHETIC_WEB_SERVERS } from "./e2e/web-servers";

/**
 * 默认 Playwright 配置 —— **只使用合成内容**。
 *
 * ── 本文件最重要的一条性质：默认失败关闭 ──
 *
 * 这里列出的每一个 webServer 的内容根都指向 `.e2e/` 下的**合成夹具**目录。
 * 默认配置中**不存在任何**会读取 `private-content/` 的启动器，
 * 且 `testIgnore` 把只在真实内容上才有意义的 spec 排除掉。
 *
 * 因此下面这些命令都**不可能**读到私有内容：
 *
 *   pnpm e2e                              # 全量
 *   npx playwright test                   # 全量
 *   npx playwright test e2e/freshness.spec.ts   # 任选定向
 *
 * ── 为什么必须这样做（实测隐私缺陷）──
 *
 * Playwright 的 webServer **启动与否取决于配置，不取决于选了哪个测试文件**。
 * 曾经本文件里挂着 `scripts/e2e-server-real.ts`（内容根 = `private-content/`），
 * 于是模型操作的一次**定向**测试 `npx playwright test e2e/freshness.spec.ts`
 * 也把它一并启动，真实试卷包被导入了本地测试库 `.e2e/cet6-real.db`。
 * 没有任何命令行开关能表达"别启动那个" —— 因此修法是把它**移出默认配置**，
 * 而不是"记得别跑那个 spec"。
 *
 * 需要真实内容链路的验证（本机有私有材料、且由人主动执行）走
 * `playwright.real.config.ts`，见下方说明。
 *
 * ── 其余关键点 ──
 * - E2E 使用**独立数据库**（CET6_DB_PATH → `.e2e/*.db`），与日常开发库
 *   `data/cet6.db` 完全隔离。
 * - 使用生产构建（`next start`）而非 dev server：dev 的编译抖动会让跨页面
 *   流程不稳定，而生产构建才是验收对象。
 * - `workers: 1` 且 `fullyParallel: false`：流程是状态化的
 *   （onboarding → 诊断 → 训练）共享同一数据库，必须串行。
 * - 只用单一 chromium project，viewport 在各个测试内部显式设定。
 *   早先按 project 拆分 mobile/desktop 会让两个 project 争用同一份数据库，
 *   产生与布局无关的假失败（实测踩到）。
 *
 * ── 真实内容（人工执行，不属默认工作流）──
 *
 *   pnpm e2e:real          # = playwright test --config playwright.real.config.ts
 *
 * 该路径**不在**默认套件里，也**不是**自动化 / 评审的标准验证流程。
 * 它的存在只为保留本机真实内容链路的可重复人工检查。
 */
export default defineConfig({
  testDir: "./e2e",
  /*
   * 只在真实内容实例上才有意义的 spec 从默认套件中排除。
   *
   * 它们引用的服务在默认配置里**根本不启动**，因此若不排除，
   * 它们会在每个断言上都失败（探针连不上服务）—— 那既是噪声，
   * 也会诱使人"顺手把真实启动器加回默认配置"，正是我们要避免的方向。
   *
   * 清单来自 `e2e/config.ts` 的 `E2E_REAL_ONLY_SPECS`，与显式配置
   * 用的是**同一份** —— 由 tests/e2e-privacy-config.test.ts 守护。
   */
  testIgnore: E2E_REAL_ONLY_SPECS.map((name) => `**/${name}`),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: `${E2E_ARTIFACTS_DIR}/test-results`,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  /*
   * 只挂合成启动器。**不要**在这里添加任何读取 `private-content/` 的服务器 ——
   * 那会立刻让 `tests/e2e-privacy-config.test.ts` 失败，并重新打开这个缺陷。
   */
  webServer: [...SYNTHETIC_WEB_SERVERS],
});
