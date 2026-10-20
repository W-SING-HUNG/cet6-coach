import { defineConfig, devices } from "@playwright/test";
import { E2E_ARTIFACTS_DIR, E2E_REAL_BASE_URL, E2E_REAL_ONLY_SPECS } from "./e2e/config";
import { REAL_CONTENT_WEB_SERVER } from "./e2e/web-servers";

/**
 * **真实内容** Playwright 配置 —— 人工显式执行，不属于默认工作流。
 *
 * ── 它的存在理由 ──
 *
 * 有两件事只有在**真实试卷内容**上才验证得了，合成夹具在原理上做不到：
 *
 * 1. `real-paper.local.spec.ts` —— 真实内容链路
 *    （真实包 → 真实索引 → 浏览器渲染 → 真实音频端点）；
 * 2. `visual-v2.local.spec.ts` —— 真实长度下的布局证据
 *    （夹具篇章只有一句话，拍不出分栏比例、长段可读性、词库换行）。
 *
 * 因此这两个 spec 被**保留**，而不是为了凑通过数删掉。
 *
 * ── 它为什么必须是一个独立配置 ──
 *
 * Playwright 的 webServer 启动与否取决于**配置**，不取决于选了哪个测试文件。
 * 因此只要真实内容启动器出现在默认配置里，任何人跑任何命令
 * （哪怕只跑一个合成 spec）都会把它带起来 —— 这正是本仓库实测发生的
 * 隐私缺陷（真实试卷被导入 `.e2e/cet6-real.db`）。
 *
 * 把它放进一个**单独的、必须显式 `--config` 指定**的文件，是唯一能让默认
 * 工作流"失败关闭"的做法：默认配置里根本没有这个进程可以启动。
 *
 * ── 人工执行方式（唯一入口）──
 *
 *     pnpm e2e:real
 *
 * ── 它不是默认工作流的一部分 ──
 *
 * - **不**出现在 `pnpm e2e` / `npx playwright test` 的选择范围内；
 * - **不**是自动化 / 独立评审的标准验证流程；
 * - **不**通过"private-content 是否存在"这类自动探测来启用 ——
 *   那会让"本机恰好有私有材料"变成静默放行。启用只能是人的显式动作；
 * - **不**依赖某个未文档化的环境变量。
 *
 * 前置条件（任一不满足即整组跳过，不会让套件变红）：
 *   - 本机 `private-content/` 下有已导入的真实试卷包；
 *   - 已运行 `pnpm build`（本配置用生产构建启动）。
 *
 * ── 内容策略 ──
 *
 * 它**只读**私有内容，并写入**独立**数据库 `.e2e/cet6-real.db`
 * （绝不碰日常库 `data/cet6.db`）。若要在模型操作的工作流中使用本配置，
 * 必须先取得 使用者 明确授权 —— 它会把真实内容载入本机测试链路。
 *
 * ── 为什么这里**只**启动真实内容实例 ──
 *
 * 本配置运行的两个 spec 只访问 `E2E_REAL_BASE_URL`，不需要任何合成实例。
 * 只启动一个服务让"这条命令碰了私有内容"成为**唯一**差异，一眼可辨；
 * 也避免为了人工冒烟而起 7 个无关进程。
 */
export default defineConfig({
  testDir: "./e2e",
  /*
   * **只**选真实内容专用的 spec —— 与默认配置的 `testIgnore` 互补，
   * 且两者消费**同一份**清单 `E2E_REAL_ONLY_SPECS`。
   *
   * 前缀 `**` + `/`（写成 glob）：Playwright 的 testMatch / testIgnore
   * 是按**路径**匹配的，裸文件名在不同版本上不是可靠形态。
   * 清单本身仍是唯一来源。
   */
  testMatch: E2E_REAL_ONLY_SPECS.map((name) => `**/${name}`),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: `${E2E_ARTIFACTS_DIR}/test-results-real`,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: E2E_REAL_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  /*
   * 真实内容启动器**只在这里**出现。默认配置引用它是缺陷 ——
   * 由 `tests/e2e-privacy-config.test.ts` 判定为失败。
   */
  webServer: [REAL_CONTENT_WEB_SERVER],
});
