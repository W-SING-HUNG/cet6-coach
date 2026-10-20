import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPaperReservedForMock,
  isPaperStartableForPractice,
  type PaperPool,
} from "@/domain/paper";

/**
 * 训练资格判据的**单一来源**回归门禁。
 *
 * ── 它守的那个真实缺口 ──
 *
 * "能不能开始训练"曾经在不同路径上各写一份判据：
 *
 * - `/practice` 列表页：`paper.progress === "training"`
 * - planner 候选：`paper.progress !== "training"` 就跳过
 * - Today 候选：同上
 * - 真题详情页 / 启动守卫：`isPaperStartableForPractice(record)`
 *
 * 而 `listAllReadingTargets` 当时把 `record.pool` 塞进一个叫 `progress`
 * 且类型为 `string` 的字段 —— 于是调用方"看起来像在比较进度状态"地
 * 绕过了领域层唯一的权威谓词。两份判据迟早漂移，而漂移的后果是
 * **模考保留卷在某一页仍然能开始训练**（历史上真实发生过）。
 *
 * ── 本文件的两层判据 ──
 *
 * 1. **行为层**：对 `training` / `mock_reserve` 两种池归属，谓词结论必须
 *    符合产品规则，且两个谓词互补。
 * 2. **源码层**：`src/` 里不得再出现"训练资格"的裸字符串比较。
 *    这一层是必须的 —— 行为层管不到"某个页面自己又写了一遍比较"。
 */

describe("训练资格 · 领域层谓词的语义", () => {
  it("训练池可开始；模考保留不可开始", () => {
    expect(isPaperStartableForPractice({ pool: "training" })).toBe(true);
    expect(isPaperStartableForPractice({ pool: "mock_reserve" })).toBe(false);
  });

  it("两个谓词在同一输入上严格互补", () => {
    const pools: PaperPool[] = ["training", "mock_reserve"];
    for (const pool of pools) {
      const startable = isPaperStartableForPractice({ pool });
      const reserved = isPaperReservedForMock({ pool });
      expect(startable, `${pool}: 可开始 与 保留 必须互补`).toBe(!reserved);
    }
  });

  it("未知池归属一律按不可开始处理（失败关闭）", () => {
    /*
     * 谓词实现是 `pool === "training"` —— 因此任何将来新增的第三种池归属
     * 默认**不能**开始训练，而不是默认可以。这是正确的失败方向：
     * "意外把保留卷当成日常材料"比"意外不能练"代价高得多。
     */
    const unknown = { pool: "future_pool" as PaperPool };
    expect(isPaperStartableForPractice(unknown)).toBe(false);
    expect(isPaperReservedForMock(unknown)).toBe(false);
  });
});

describe("训练资格 · 源码层不得有第二套判据", () => {
  const ROOT = join(__dirname, "..");

  /** 读取若干 `src/` 下的源码，剥掉注释后返回。 */
  function readCode(relative: string): string {
    return readFileSync(join(ROOT, relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  /**
   * 曾经各自写一份判据的**全部**调用点。
   *
   * 清单刻意写死而不是自动枚举：这些文件是已知的消费方，
   * 新增消费方时应当同时更新本清单（让"加了一处新判据"变成一次
   * 有意识的决定，而不是静默扩散）。
   */
  const CONSUMERS = [
    "src/app/practice/page.tsx",
    "src/services/reading-plan.ts",
    "src/services/expert-training.ts",
    "src/app/practice/papers/[paperId]/page.tsx",
    "src/app/practice/papers/[paperId]/train/[sectionId]/page.tsx",
    "src/app/today/page.tsx",
  ] as const;

  for (const file of CONSUMERS) {
    it(`${file} 不使用裸字符串比较判断训练资格`, () => {
      const code = readCode(file);
      /*
       * 匹配的是"拿训练池的字面量做资格判断"这一形态。
       *
       * 允许的例外（不在本判据范围）：
       * - 领域层 `src/domain/paper.ts` 自身（那是唯一权威实现的所在）；
       * - 纯统计/标签用途（`papers.ts` 的计数、`papers/page.tsx` 的池名标签），
       *   它们回答的是"库里各池有多少份 / 这个池叫什么"，不是"能不能开始练"。
       */
      expect(
        code,
        `${file} 出现了训练资格的裸字符串比较。` +
          `请改用 isPaperStartableForPractice({ pool }) / isPaperReservedForMock({ pool })，` +
          `让 planner、Today、Practice 列表与启动守卫共享同一条规则。`,
      ).not.toMatch(/(?:progress|pool)\s*(?:===|!==)\s*["'](?:training|mock_reserve)["']/);
    });
  }

  it("领域层存在且仅存在一个可开始谓词的定义", () => {
    /*
     * 反向保护：不能有人为了方便又在别处 `export function isPaperStartableForPractice`。
     * 判据是"该函数名的实体实现只出现在 domain/paper.ts"。
     */
    const definitionPattern = /export function isPaperStartableForPractice\b/;
    expect(readCode("src/domain/paper.ts")).toMatch(definitionPattern);

    for (const file of CONSUMERS) {
      expect(
        readCode(file),
        `${file} 不得重新定义 isPaperStartableForPractice`,
      ).not.toMatch(definitionPattern);
    }
  });

  it("服务端启动守卫仍然使用权威谓词（不能被界面改动绕过）", () => {
    /*
     * 界面隐藏按钮**不是**安全边界。真正的守卫在服务层：
     * `startReadingRun` 必须在写入 learning_run 之前核对池归属。
     */
    const service = readCode("src/services/expert-training.ts");
    expect(service).toMatch(/isPaperStartableForPractice\s*\(/);
  });
});
