import { join } from "node:path";

/**
 * E2E 环境常量。
 *
 * 单一来源，供 playwright.config.ts 与测试文件共用，
 * 避免端口 / 路径在配置与测试里各写一份而漂移。
 */

export const E2E_PORT = 3199;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * 空内容库专用服务器。
 *
 * 为什么需要第二个服务器：内容根是**进程级环境变量**，
 * 无法在浏览器里切换。要真实验证"私有内容库为空时的诚实空状态"，
 * 就必须有一个内容根为空的运行实例 —— 用一个假的空状态分支去测
 * 等于没测到真实路径。
 */
export const E2E_EMPTY_PORT = 3200;
export const E2E_EMPTY_BASE_URL = `http://127.0.0.1:${E2E_EMPTY_PORT}`;

/** 独立数据库：与日常开发库 data/cet6.db 完全隔离。 */
export const E2E_DB_PATH = join(process.cwd(), ".e2e", "cet6-e2e.db");

/** 空库实例的独立数据库（需要单独完成 onboarding 才能进入真题库页面）。 */
export const E2E_EMPTY_DB_PATH = join(process.cwd(), ".e2e", "cet6-e2e-empty.db");

/** 主实例的内容根：由 e2e-server 在启动前写入测试夹具包。 */
export const E2E_CONTENT_ROOT = join(process.cwd(), ".e2e", "content");

/** 空库实例的内容根：刻意不存在，用于验证"目录都不存在"的真实分支。 */
export const E2E_EMPTY_CONTENT_ROOT = join(process.cwd(), ".e2e", "empty-content");

/**
 * 真实试卷冒烟专用实例（`real-paper.local.spec.ts`）。
 *
 * ── 重要：它**不在**默认 Playwright 配置里 ──
 *
 * 这一组常量描述的是一个会读取 `private-content/` 的实例。它**必须**由
 * 人显式选择 `--config playwright.real.config.ts` 才会启动 ——
 * 默认配置（`playwright.config.ts`）中**不存在**任何引用它的 webServer。
 *
 * 为什么当初会出问题：Playwright 的 `webServer` 启动与否取决于**配置**，
 * 而不是取决于选了哪个测试文件。因此"只跑一个合成 spec"并不会阻止
 * 其它已配置的 webServer 一起启动 —— 一个会读私有内容的启动器就这样
 * 被模型操作的默认工作流带起来了。默认因此必须**失败关闭**。
 *
 * 详见 `E2E_REAL_ONLY_SPECS` 与 `SECURITY.md` 的隐私边界一节。
 *
 * 它使用**独立数据库**，与日常库 `data/cet6.db` 和 E2E 库完全隔离。
 */
export const E2E_REAL_PORT = 3210;
export const E2E_REAL_BASE_URL = `http://127.0.0.1:${E2E_REAL_PORT}`;
export const E2E_REAL_DB_PATH = join(process.cwd(), ".e2e", "cet6-real.db");

/**
 * **只在真实内容实例上**有意义的 spec 文件（相对仓库根的路径）。
 *
 * ── 这份清单是"默认配置安全"的载体，不是注释 ──
 *
 * - 默认配置 `playwright.config.ts` 把它用作 `testIgnore`：
 *   正常 `pnpm e2e` / `npx playwright test` **不会**选中它们，
 *   因此也不会有人期待那个会读私有内容的实例存在。
 * - 显式配置 `playwright.real.config.ts` 把它用作 `testMatch`：
 *   只有人主动 `--config playwright.real.config.ts` 时才会跑。
 *
 * 两者必须来自**同一份清单**。若各写一份，新增一个真实 spec 时
 * 很可能只加到一个配置里 —— 那样它会在默认套件里跑到一个不存在的服务上，
 * 或者反过来在默认套件里意外要求真实内容实例。
 *
 * 由 `tests/e2e-privacy-config.test.ts` 断言两个配置消费同一份清单。
 */
export const E2E_REAL_ONLY_SPECS = [
  "real-paper.local.spec.ts",
  "visual-v2.local.spec.ts",
] as const;

/** 截图与 trace 等验收产物目录。 */
export const E2E_ARTIFACTS_DIR = join(process.cwd(), ".e2e", "artifacts");

/**
 * **视觉评审专用**实例（`review-visual.spec.ts`）。
 *
 * 它用**长文本合成夹具**拍一套"接近真实布局、但可以安全提交 Git"的截图
 * （见 `scripts/e2e-server-review.ts` 的说明）。与另外三个实例完全隔离：
 * 独立内容根、独立数据库、独立端口，因此不会干扰其余门禁。
 */
export const E2E_REVIEW_PORT = 3220;
export const E2E_REVIEW_BASE_URL = `http://127.0.0.1:${E2E_REVIEW_PORT}`;
export const E2E_REVIEW_DB_PATH = join(process.cwd(), ".e2e", "cet6-review.db");
export const E2E_REVIEW_CONTENT_ROOT = join(process.cwd(), ".e2e", "review-content");

/** 评审实例里那份长文本夹具试卷的 id（来源恒为 test_fixture）。 */
export const E2E_REVIEW_PAPER_ID = "fixture-cet6-2024-12-set1-review";

/**
 * **使用者 历史状态专用**实例（端口 3230 / 3231）。
 *
 * ── 为什么必须是一个独立实例，而不是复用主实例 ──
 *
 * 阅读收敛的验收对象是 使用者的**真实历史状态**：库里躺着一条更早生成、
 * 至今 pending、引用合成篇章 `reading_passage / read-city-trees` 的阅读任务，
 * 它出现在 Today 的「补做」区里。要端到端证明"这条历史任务现在被投影成
 * 真实真题 CTA 并能进入 Expert 工作面"，就必须**真的**有那样一行数据。
 *
 * 主实例做不到，原因有两条，都是结构性的：
 *
 * 1. **主实例由 planner 生成任务**，它产出的已经全是 `reading_target` ——
 *    因此主实例上根本没有"历史合成行"这个对象，测的不是 使用者的路径。
 * 2. **主实例的数据库被全部 spec 共享**，而 Playwright 按文件名字母序串行执行。
 *    早先的写法靠 `zz-` 前缀把本 spec 排到最后，这只在"全套件一起跑"时成立 ——
 *    单独跑、或排在别的 spec 之前跑，状态前提就不满足。那是**顺序依赖**，
 *    不是契约。
 *
 * 独立实例把这两条一起解决：它有自己的内容根、自己的数据库、自己的端口，
 * 启动时由 `scripts/e2e-server-legacy.ts` 写入**精确的 使用者 历史状态**。
 * 因此该 spec 与其它 spec 之间**没有任何共享状态** ——
 * 单跑、先跑、后跑的结果完全相同。
 *
 * 两个端口分担两种库存状态，因为它们对用户的含义不同、文案也必须不同：
 * - `3230`（eligible）：库里有可训练的真实阅读大题 → 历史任务应被
 *   **投影成真实真题 CTA**（F1），且不再渲染重复入口（F2）。
 * - `3231`（reserved_only）：有卷子但**全部设为模考保留** → 历史任务应给出
 *   「被设为模考保留」这一**具体**原因，且绝不消耗保留材料。
 */
export const E2E_LEGACY_PORT = 3230;
export const E2E_LEGACY_BASE_URL = `http://127.0.0.1:${E2E_LEGACY_PORT}`;
export const E2E_LEGACY_DB_PATH = join(process.cwd(), ".e2e", "cet6-legacy.db");
export const E2E_LEGACY_CONTENT_ROOT = join(process.cwd(), ".e2e", "legacy-content");

export const E2E_LEGACY_RESERVED_PORT = 3231;
export const E2E_LEGACY_RESERVED_BASE_URL = `http://127.0.0.1:${E2E_LEGACY_RESERVED_PORT}`;
export const E2E_LEGACY_RESERVED_DB_PATH = join(process.cwd(), ".e2e", "cet6-legacy-reserved.db");
export const E2E_LEGACY_RESERVED_CONTENT_ROOT = join(
  process.cwd(),
  ".e2e",
  "legacy-reserved-content",
);

/**
 * 历史遗留阅读任务引用的**合成**素材。
 *
 * 这两个值刻意写死：它们就是 使用者 库里那一行的 `contentRef`
 * （`src/content/practice-library.ts` 的 `read-city-trees`，
 * 标题「为什么城市需要树」）。验收要证明的正是"引用这个合成条目的
 * 历史任务不再渲染合成内容"。
 */
export const E2E_LEGACY_SYNTHETIC_TITLE = "为什么城市需要树";
export const E2E_LEGACY_SYNTHETIC_BODY = "City planners once treated trees as decoration";
export const E2E_LEGACY_SYNTHETIC_CONTENT_ID = "read-city-trees";

/** E2E 夹具试卷的标识（来源类型恒为 test_fixture，绝不冒充真题）。 */
export const E2E_FIXTURE_PAPERS = [
  { id: "fixture-cet6-2023-06-set1", year: 2023, session: "June", variant: "set1" },
  { id: "fixture-cet6-2024-12-set1", year: 2024, session: "December", variant: "set1" },
  { id: "fixture-cet6-2024-12-set2", year: 2024, session: "December", variant: "set2" },
] as const;

/**
 * **本地标注页面**专用实例（端口 3240）。
 *
 * ── 为什么它必须是一个独立的 webServer，而不是某个 spec 自己起的服务 ──
 *
 * 被验收的对象是 `GET /` **真实响应字节**里那段内联脚本 —— 也就是
 * 使用者 真正打开的那个页面。要让 Chromium 加载它，就必须有一个
 * **真实的回环服务**在监听；页面本身不接受任何参数（它是静态外壳，
 * 不含私有数据），因此这里直接把 `renderAnnotationShell()` 的输出
 * 交给 `startAnnotationServer` 提供。
 *
 * ── 安全与隔离（四条）──
 *
 * 1. **合成正文**：可标注的行是写死的合成字符串，**不是**任何真实讲义；
 * 2. **不读数据库**：这个实例完全不碰 `data/cet6.db`（标注服务器在结构上
 *    就没有打开数据库的能力，由源码级门禁守护）；
 * 3. **token 由服务端生成**：spec 从启动脚本打印的一行里取回
 *    `http://127.0.0.1:3240/#token=…`，因此走的是**真实**认证握手，
 *    而不是"假装有 token"；
 * 4. 端口 3240 与 3199 / 3200 / 3210 / 3220 / 3230 / 3231 都不冲突。
 */
export const E2E_ANNOTATION_PORT = 3240;
export const E2E_ANNOTATION_BASE_URL = `http://127.0.0.1:${E2E_ANNOTATION_PORT}`;
/** token 交接文件：由启动脚本写入，spec 读取。**不含任何课程内容**。 */
export const E2E_ANNOTATION_HANDOFF_PATH = join(process.cwd(), ".e2e", "annotation-handoff.json");
/** 合成计划落盘位置（隔离在 .e2e 下，绝不进 private-content/）。 */
export const E2E_ANNOTATION_PLAN_PATH = join(process.cwd(), ".e2e", "annotation-plan.json");

/** 使用者 历史状态实例里那份可训练夹具试卷的 id。 */
export const E2E_LEGACY_PAPER_ID = "fixture-cet6-2024-12-set1";

/**
 * **重复逾期别名专用**实例（端口 3260）。
 *
 * ── 为什么需要它 ──
 *
 * 缺陷的**症状是用户可见的**：库里存在多条指向同一份真实材料的逾期历史条目时，
 * 系统会把"当天可用时间"算成"不够用"，Today 于是在明明还有时间与内容的情况下
 * 显示一个被压空（或几乎压空）的计划 —— 实测 10 条别名把 60 分钟日压到只剩 7 分钟，
 * 30 分钟日直接归零。
 *
 * 复现这个症状需要"同一目标有多条逾期别名"这一**精确状态**：
 * 主实例由 planner 生成任务（不会产生这种重复别名），
 * 而 legacy 实例刻意只写一条别名（它的断言是围绕单条历史行建立的）。
 *
 * 因此这里按相同的纪律给它**独立内容根 + 独立数据库 + 独立端口**，
 * 状态在启动时写死，与其它 spec 之间零共享。
 *
 * 全部内容为**合成夹具**：试卷 `sourceKind` 恒为 `test_fixture`。
 * 它不碰 `private-content/`，也不碰 `data/cet6.db`。
 */
export const E2E_DUPLICATE_PORT = 3260;
export const E2E_DUPLICATE_BASE_URL = `http://127.0.0.1:${E2E_DUPLICATE_PORT}`;
export const E2E_DUPLICATE_DB_PATH = join(process.cwd(), ".e2e", "cet6-duplicate.db");
export const E2E_DUPLICATE_CONTENT_ROOT = join(process.cwd(), ".e2e", "duplicate-content");

/**
 * 重复别名实例写入的逾期别名条数。
 *
 * 取 10：它是评审复现里被压得最狠的一档（60 分钟日 → 7 分钟，30 分钟日 → 0）。
 * 值随实例一起固定在配置里，spec 直接引用，避免两处各写一个数字而漂移。
 */
export const E2E_DUPLICATE_ALIAS_COUNT = 10;

/**
 * 重复别名实例里"今天"的可用分钟数。
 *
 * 取 30：评审复现的三档里**症状最极端**的一档 ——
 * 30 分钟日 + 10 条别名时计划占用降到 **0**，系统声称时间不够。
 * 因此浏览器断言"计划占用 > 0"在这个实例上是**因果紧致**的：
 * 它正是缺陷会打破的那条线，而不是随手挑的下界。
 *
 * （60 分钟日时缺陷只会把计划压到 7 分钟，`> 0` 拦不住它。）
 */
export const E2E_DUPLICATE_DAY_MINUTES = 30;

/** 重复别名实例里那份夹具试卷的 id。 */
export const E2E_DUPLICATE_PAPER_ID = "fixture-cet6-2024-12-set1";

/**
 * **课程伴随界面（Course Companion）专用**实例（端口 3265）。
 *
 * ── 为什么必须是一个独立实例 ──
 *
 * 被验收的对象是"课程材料列表 → 显式揭示某一段 → 正文经 POST 下发"
 * 这条完整链路，以及它的**安全负向**（跨站/缺失 Origin 必须 403）。
 * 它要求库里同时存在：
 *
 * 1. 一份**已导入**的合成课程包（否则列表页是空状态）；
 * 2. 一段**已被揭示过**的材料（用于验证「已看过」标记）；
 * 3. 一份**已漂移**的课程包（用于验证漂移时失败关闭）。
 *
 * 主 E2E 实例的库里根本没有课程包（它只导试卷），因此造不出这个状态；
 * 而它的库被全部 spec 共享、按文件名字母序串行执行 ——
 * 在那里临时造状态会给别的 spec 留副作用，也会让自己变成顺序依赖
 * （同一个根因）。
 *
 * 因此这里给它**独立内容根 + 独立数据库 + 独立端口**，状态在启动时写死。
 *
 * 全部内容都是**合成夹具**：课程 provider 由夹具构造器写死为
 * `test_fixture_provider`，正文是合成字符串。它不碰 `private-content/`，
 * 也不碰 `data/cet6.db`。
 */
export const E2E_COMPANION_PORT = 3265;
export const E2E_COMPANION_BASE_URL = `http://127.0.0.1:${E2E_COMPANION_PORT}`;
export const E2E_COMPANION_DB_PATH = join(process.cwd(), ".e2e", "cet6-companion.db");
export const E2E_COMPANION_CONTENT_ROOT = join(process.cwd(), ".e2e", "companion-content");

/** 主课程夹具 id（合成，provider 恒为 test_fixture_provider）。 */
export const E2E_COMPANION_COURSE_ID = "fixture-course-companion";

/** 已漂移的课程夹具 id —— 用于验证"漂移时不给正文入口"。 */
export const E2E_COMPANION_DRIFTED_COURSE_ID = "fixture-course-companion-drifted";

/** 已被揭示过的那一段。 */
export const E2E_COMPANION_SEGMENT_ID = "reading.a";

/**
 * **回环绑定与同源一致性证明**专用端口（3266 / 3267）。
 *
 * 它起真实服务器来验证"服务真的只监听回环"以及 `pnpm dev` 与 `pnpm start`
 * 与可信来源一致（P0-2）。两个端口刻意不同：证明端口是配置出来的，
 * 而不是写死的 —— 写死端口的守卫会把 `start`（或 `dev`）那个实例挡掉。
 *
 * 使用**自己的**合成库与内容根：证明会自建课程夹具并走一次授权揭示，
 * 因此不能借用 companion 的库（那会让两个实例互相干扰）。
 */
export const E2E_LOOPBACK_PROOF_PORT = 3266;
export const E2E_LOOPBACK_PROOF_DEV_PORT = 3267;
export const E2E_LOOPBACK_PROOF_DB_PATH = join(process.cwd(), ".e2e", "cet6-loopback-proof.db");
export const E2E_LOOPBACK_PROOF_CONTENT_ROOT = join(
  process.cwd(),
  ".e2e",
  "loopback-proof-content",
);

/**
 * 伴随实例里那份**已核验链接**的合成真题。
 *
 * 用途：验证"揭示已核验指向真题的段之前给出明确警告"（P1）。
 * 它被设为模考保留，因此警告必须是具体的"这会消耗保留材料"。
 */
export const E2E_COMPANION_LINKED_PAPER_ID = "fixture-cet6-2024-12-set1";

/**
 * **模考新鲜度专用**实例（端口 3250）。
 *
 * ── 为什么必须是一个独立实例 ──
 *
 * 被验收的对象是"一份被标为模考保留的试卷，其内容已经通过课程材料被接触过"
 * 这个**事实状态**，以及界面对它的呈现。它要求同时存在：
 *
 * 1. 一份**已核验**的 canonical 链接（课程段 → 真题大题）；
 * 2. 一条**早于**该链接、且落在同一课程内容版本上的课程曝光；
 * 3. 另一份卷子上有一条**已失效**的链接（课程升版后）—— 用于验证
 *    "无法确认"不会被当成"没见过"。
 *
 * 主 E2E 实例上这三样都不存在（它没有课程包、没有链接、没有曝光），
 * 而主实例的库被全部 spec 共享、按文件名字母序串行执行 ——
 * 在那里临时造状态会给别的 spec 留下副作用，也会让自己变成顺序依赖
 * （同一个根因）。
 *
 * 因此这里给它**独立内容根 + 独立数据库 + 独立端口**，状态在启动时写死，
 * 与其它 spec 之间零共享。
 *
 * 全部内容都是**合成夹具**：试卷 `sourceKind` 由夹具构造器写死为
 * `test_fixture`，课程包的 provider 写死为 `test_fixture_provider`。
 * 它不碰 `private-content/`，也不碰 `data/cet6.db`。
 */
export const E2E_FRESHNESS_PORT = 3250;
export const E2E_FRESHNESS_BASE_URL = `http://127.0.0.1:${E2E_FRESHNESS_PORT}`;
export const E2E_FRESHNESS_DB_PATH = join(process.cwd(), ".e2e", "cet6-freshness.db");
export const E2E_FRESHNESS_CONTENT_ROOT = join(process.cwd(), ".e2e", "freshness-content");

/** 三份夹具保留卷：分别是 pristine / exposed / uncertain。 */
export const E2E_FRESHNESS_PRISTINE_PAPER_ID = "fixture-cet6-2023-06-set1";
export const E2E_FRESHNESS_EXPOSED_PAPER_ID = "fixture-cet6-2024-12-set1";
export const E2E_FRESHNESS_UNCERTAIN_PAPER_ID = "fixture-cet6-2024-12-set2";

/** 课程夹具 id（合成，provider 恒为 test_fixture_provider）。 */
export const E2E_FRESHNESS_EXPOSED_COURSE_ID = "fixture-course-exposed";
export const E2E_FRESHNESS_STALE_COURSE_ID = "fixture-course-stale";

/**
 * **A1 只读检查工作台专用**实例（端口 3270）。
 *
 * ── 为什么必须是一个独立的 webServer ──
 *
 * 被验收的对象是**真实浏览器**里的完整 A1 流程：打开工作台 → 选文件夹
 * （在本实例上由启动脚本预置一个**合成**源根，因此不需要真的弹出系统对话框）
 * → 勾选范围 → 检查 → 读四步结果，以及键盘可达性、状态播报、窄视口、
 * 加载 / 错误 / 禁用态。
 *
 * 它需要一份**真实的合成源目录**（含嵌套目录、五类材料、对抗性形态），
 * 而那正是主实例没有的东西 —— 主实例只导试卷。
 *
 * 与其它实例同一条纪律：**独立内容根 + 独立端口**，
 * 零共享状态，全部内容为合成夹具。
 *
 * `CET6_A1_E2E_SOURCE` 交给启动脚本：它把源根**预置**进 A1 能力对象，
 * 于是 spec 一打开就有目录树可勾选 —— 而"选取窗口本身"的取消 / 失败形态
 * 由 `tests/course-a1-workbench.test.ts` 与 `course:a1-proof` 在
 * 进程层覆盖（真弹一个模态窗口在自动化里无人可关）。
 */
export const E2E_A1_PORT = 3270;
export const E2E_A1_BASE_URL = `http://127.0.0.1:${E2E_A1_PORT}`;
/** A1 实例的 token 交接文件。**只有 URL 与源根标签，不含任何正文。** */
export const E2E_A1_HANDOFF_PATH = join(process.cwd(), ".e2e", "a1-handoff.json");
/** 合成源根（在 `.e2e/a1-source/` 下，绝不进 `private-content/`）。 */
export const E2E_A1_SOURCE_ROOT = join(process.cwd(), ".e2e", "a1-source");
/** 合成 canonical 真题库（在 `.e2e/a1-papers/` 下）。 */
export const E2E_A1_PAPERS_ROOT = join(process.cwd(), ".e2e", "a1-papers");

/**
 * A2 人工审核工作台专用实例（端口 3280）。
 */
export const E2E_A2_PORT = 3280;
export const E2E_A2_BASE_URL = `http://127.0.0.1:${E2E_A2_PORT}`;
export const E2E_A2_HANDOFF_PATH = join(process.cwd(), ".e2e", "a2-workbench.json");

/**
 * **A3 受控课程接入专用**实例（端口 3285 工作台 + 3286 课程伴随）。
 *
 * ── 为什么必须是**两个**实例 ──
 *
 * 被验收的是一条**跨进程**的真实用户路径：在 A3 工作台上完成
 * 晋升 → 导入 → 建链，然后在**产品自己的**课程伴随界面里看到并打开这份课程。
 *
 * 前者是回环 Node 服务（`startAnnotationServer`），后者是 Next.js 应用
 * （`/practice/courses`）。两者只能是两个监听者。
 *
 * ── 它们共享状态，但**不是**共享内存 ──
 *
 * 两个实例指向**同一份**隔离数据库与同一个隔离内容根，因此"工作台写下的
 * 东西，伴随界面真的读得到"是一条被真实检验的性质，而不是同一进程内的
 * 自证。这也是为什么必须用文件 + 数据库交接，而不是把两个界面塞进一个进程。
 *
 * ── 隔离 ──
 *
 * 独立内容根、独立数据库、独立端口。全部内容都是**合成夹具**：课程 provider
 * 与试卷 `sourceKind` 由夹具构造器写死，绝不冒充真实课程或真题。
 * 它**不碰** `private-content/`，也**不碰** `data/cet6.db`。
 */
export const E2E_A3_PORT = 3285;
export const E2E_A3_BASE_URL = `http://127.0.0.1:${E2E_A3_PORT}`;
/** 工作台 token 交接文件：只有 URL 与**相对标签**，不含正文与绝对路径。 */
export const E2E_A3_HANDOFF_PATH = join(process.cwd(), ".e2e", "a3-workbench.json");
export const E2E_A3_DB_PATH = join(process.cwd(), ".e2e", "cet6-a3.db");
export const E2E_A3_CONTENT_ROOT = join(process.cwd(), ".e2e", "a3-content");
/** 合成源根（供工作台直接预置，不弹原生窗口）。 */
export const E2E_A3_SOURCE_ROOT = join(process.cwd(), ".e2e", "a3-source");
/** 合成 canonical 真题包根（供匹配与建链）。 */
export const E2E_A3_PAPERS_ROOT = join(process.cwd(), ".e2e", "a3-papers");

/** 课程伴随实例（Next.js）：读同一份库与内容根。 */
export const E2E_A3_COMPANION_PORT = 3286;
export const E2E_A3_COMPANION_BASE_URL = `http://127.0.0.1:${E2E_A3_COMPANION_PORT}`;

/** A3 夹具课程标识（合成，provider 恒为 test_fixture_provider）。 */
export const E2E_A3_COURSE_ID = "fixture-course-a3";
/** A3 夹具真题卷标识（sourceKind 恒为 test_fixture）。 */
export const E2E_A3_PAPER_ID = "fixture-cet6-2024-12-set1";

