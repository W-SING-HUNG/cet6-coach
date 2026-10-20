import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { commitCourseImport, planCourseImport } from "@/services/course-import";
import {
  recordCourseExposure,
  revealCourseSegment,
  countCourseExposure,
} from "@/services/course-exposure";
import { verifyCanonicalLink } from "@/services/course-link";
import { getPaperFreshness } from "@/services/paper-freshness";
import { getCourseCompanionView } from "@/services/course-companion";
import { computeRevealRisk } from "@/services/reveal-risk";
import { COURSE_EXPOSURE_EVENT_TYPES } from "@/domain/course";
import { isPaperEligibleForStrictMock as domainIsEligible } from "@/domain/paper-freshness";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { planImport, commitImport } from "@/services/paper-import";

/**
 * Course Companion 的**服务边界**测试。
 *
 * ── 这组测试守护的三件事 ──
 *
 * 1. **统一的曝光写入边界。** 全部曝光事件（含正文揭示）都必须经过
 *    `recordCourseExposure` 这一个服务层，由它做全部判定。
 *    裸仓储 `appendExposure` 上没有这些判定，因此"绕过边界"必须被
 *    结构性地排除（由 architecture.test.ts 守护），而这里守护的是
 *    **判定本身**真的存在且有效。
 *
 * 2. **先持久化、后返回正文。** `revealCourseSegment` 在任何判定不通过时
 *    返回的结果里**没有任何正文字节**。这是私有课程内容唯一的出口，
 *    因此它失败关闭的方向比"正常路径能工作"更重要。
 *
 * 3. **揭示事件的幂等性。** 学习者重复点"看这段"不得产生第二条观测。
 *
 * 每一例都走**真实磁盘 + 真实数据库**：这条能力的全部风险在于
 * "结论与实际事实脱钩"，mock 掉包读取就什么也证明不了。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const COURSE_ID = "fixture-course-a";
const SEGMENT_ID = "reading.a";
const PROFILE_ID = "p1";

/** 夹具里的合成正文（**不是**任何真实课程材料）。 */
const FIXTURE_READING_TEXT =
  "Fixture course reading passage. This synthetic text exists only so the course " +
  "package pipeline can be exercised end to end. It is not CET material and does " +
  "not come from any course provider.";

function seedProfile(): void {
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(PROFILE_ID, "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function importCourse(fixture = buildCourseFixture()): void {
  writeCourseFixture(contentRoot, COURSE_ID, fixture);
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint };
  return Number(row.c);
}

/** 直接读盘上的 manifest（用于构造漂移）。 */
function courseManifestPath(): string {
  return join(contentRoot, "courses", COURSE_ID, "course.json");
}

/**
 * 带**当前**风险指纹的揭示入参。
 *
 * 绝大多数用例测的是"包/段/版本/幂等"这些与风险无关的不变式，
 * 因此它们应当带一个**正确**的指纹，让风险这道门不成为噪声。
 * 风险本身由专门的 describe 块覆盖。
 */
function revealInput(
  overrides: {
    courseId?: string;
    segmentId?: string;
    courseContentVersion?: number;
    occurredAt?: string;
    confirmedRiskFingerprint?: string;
  } = {},
) {
  const courseId = overrides.courseId ?? COURSE_ID;
  const segmentId = overrides.segmentId ?? SEGMENT_ID;
  const courseContentVersion = overrides.courseContentVersion ?? 1;
  const risk = computeRevealRisk(repos, courseId, segmentId);
  return {
    profileId: PROFILE_ID,
    courseId,
    segmentId,
    courseContentVersion,
    occurredAt: overrides.occurredAt ?? "2026-03-01T10:00:00.000Z",
    confirmedRiskFingerprint: overrides.confirmedRiskFingerprint ?? risk.fingerprint,
  };
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-companion-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
  seedProfile();
});

afterEach(() => {
  // 原生句柄必须确定性关闭：`DatabaseSync` 不是 GC 会及时回收的普通对象。
  try {
    db.close();
  } catch {
    // 已关闭过就不该让清理失败。
  }

  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  rmSync(contentRoot, { recursive: true, force: true });
});

// ===========================================================================
// 一、统一的曝光写入边界
// ===========================================================================

describe("曝光写入边界：全部判定都在服务层", () => {
  it("reveal_requested 已登记为合法事件种类", () => {
    expect(COURSE_EXPOSURE_EVENT_TYPES).toContain("reveal_requested");
  });

  it("揭示成功时先落库、后返回正文", () => {
    importCourse();

    const result = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;

    // 曝光确实落库了，且种类正确。
    expect(result.event.eventType).toBe("reveal_requested");
    expect(result.event.courseContentVersion).toBe(1);
    expect(countRows("course_exposure_event")).toBe(1);
    expect(result.recorded).toBe(true);

    // 正文确实返回了，且来自那一版包。
    expect(result.content.segmentId).toBe(SEGMENT_ID);
    expect(result.content.courseContentVersion).toBe(1);
    expect(result.content.text).toBe(FIXTURE_READING_TEXT);

    /*
     * P0-3：响应带上下发正文的校验和。
     *
     * 它让"这份正文来自被校验的那一版"成为**可核对**的事实，
     * 而不是调用方只能选择相信服务端。
     */
    expect(result.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.indexedContentVersion).toBe(1);
    // 它与索引登记的校验和一致 ⇒ 下发的就是被校验的那一份。
    expect(result.contentChecksum).toBe(repos.courses.getPackage(COURSE_ID)!.manifestChecksum);
  });

  it("揭示**幂等**：同一个动作重复请求只留一条观测，且保留首次时刻", () => {
    importCourse();

    const first = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.recorded).toBe(true);
    const firstEventId = first.event.id;

    // 学习者又点了一次（或网络重试）。
    const second = revealCourseSegment(
      repos,
      // 刻意给一个**不同的**时刻：幂等判据不含时间。
      revealInput({ occurredAt: "2026-03-01T11:30:00.000Z" }),
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.recorded, "第二次揭示不得产生新观测").toBe(false);
    // 但仍然要返回正文 —— 学习者要看它。
    expect(second.content.text).toBe(FIXTURE_READING_TEXT);
    expect(countRows("course_exposure_event")).toBe(1);

    /*
     * P0-4：幂等命中返回的是**库里原有那条**行，且历史时刻未被覆盖。
     *
     * "不覆盖历史时间戳"是只追加语义的一部分：重试产生的新 `nowISO()`
     * 不得改写首次揭示发生在什么时候。
     */
    expect(second.event.id).toBe(firstEventId);
    expect(second.event.occurredAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("幂等是**数据库层**的：并发/竞争请求也只留一条观测", async () => {
    /*
     * P0-4 的核心：上一版用 `listExposureForSegment().find()` 然后插入，
     * 那是 check-then-insert —— 两个并发请求可以同时通过检查。
     *
     * 现在的实现用确定性身份 + `ON CONFLICT(id) DO NOTHING`，
     * 因此这里直接用**同一份身份**模拟竞争：即使调用方"忘了先查"，
     * 数据库也只会留一条。
     */
    importCourse();

    const { revealExposureIdentity } = await import("@/repositories/ports");
    const identity = revealExposureIdentity({
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
    });

    // 直接按同一身份连续写两次（模拟两个竞争请求都到达了写入点）。
    const firstWrite = repos.courses.appendRevealExposureOnce({
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      occurredAt: "2026-03-01T10:00:00.000Z",
    });
    const secondWrite = repos.courses.appendRevealExposureOnce({
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      // 不同的时刻：竞争请求各自带自己的 nowISO()。
      occurredAt: "2026-03-01T10:00:00.500Z",
    });

    expect(firstWrite.created, "首次写入必须创建新行").toBe(true);
    expect(secondWrite.created, "同身份的第二次写入不得创建新行").toBe(false);
    expect(firstWrite.event.id).toBe(identity);
    expect(secondWrite.event.id).toBe(identity);
    expect(secondWrite.event.occurredAt, "历史时刻不得被覆盖").toBe("2026-03-01T10:00:00.000Z");
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("P1-2：`created` 来自**原子 INSERT 结果**，不是插入前的 SELECT", async () => {
    /*
     * 这一条守住 P1-2 的回归，并且**真的复现竞态窗口**。
     *
     * 缺陷形态：先 SELECT 判断是否存在，再用"插入前是否已存在"推 `created`。
     * 另一个连接可能在 SELECT 之后、INSERT 之前提交同一身份的行 ——
     * 此时本次 INSERT 实际被冲突跳过（`changes === 0`），`created` 却报 `true`，
     * 调用方会以为自己写了新观测。
     *
     * 复现方式：Proxy 拦截底层连接，**只**对被测方法那条 INSERT 生效；
     * 在它执行之前，先由"另一个连接"把同一身份的行写进去。
     * 这样竞态窗口被确定性地撑开，不需要真的多进程。
     *
     * 注意：缺陷实现的 SELECT 用的也是 `prepare`，因此拦截必须**只**
     * 匹配 INSERT —— 否则竞争行会在 SELECT 之前就写进去，那样连缺陷
     * 实现也能给出正确答案，测试就失去了判据力（实测踩到）。
     */
    importCourse();

    const { revealExposureIdentity } = await import("@/repositories/ports");
    const identity = revealExposureIdentity({
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
    });

    let competitorWritten = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          // 只拦截"往曝光表插入"的那一条（被测方法的 INSERT）。
          if (/INSERT INTO course_exposure_event/i.test(sql)) {
            const originalRun = statement.run.bind(statement);
            return {
              ...statement,
              run: (...args: unknown[]) => {
                if (!competitorWritten) {
                  competitorWritten = true;
                  /*
                   * "另一个连接"先提交同一身份的行。
                   *
                   * 用**原始连接**（不是被代理的这个）来写，避免递归
                   * 进入本拦截器。
                   */
                  db.prepare(
                    `INSERT INTO course_exposure_event
                       (id, profile_id, course_id, segment_id, course_content_version, event_type, occurred_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(id) DO NOTHING`,
                  ).run(
                    identity,
                    PROFILE_ID,
                    COURSE_ID,
                    SEGMENT_ID,
                    1,
                    "reveal_requested",
                    "2026-03-01T09:59:59.000Z",
                  );
                }
                return originalRun(...(args as never[]));
              },
            };
          }
          return statement;
        };
      },
    });

    const racingRepos = createSqliteRepositories(racingDb as unknown as typeof db);
    const result = racingRepos.courses.appendRevealExposureOnce({
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      occurredAt: "2026-03-01T10:00:00.000Z",
    });

    expect(competitorWritten, "必须真的在 INSERT 前插入竞争行（否则没测到竞态窗口）").toBe(true);
    /*
     * 关键判据：本次 INSERT 被冲突跳过 ⇒ `created` 必须是 `false`。
     *
     * 缺陷实现（先 SELECT 推断）会在这里报 `true` —— 因为它的 SELECT
     * 发生在竞争行写入之前。
     */
    expect(result.created, "冲突跳过时必须报 created=false").toBe(false);
    // 读回的是**竞争行**首次写入的时刻（不被本次请求覆盖）。
    expect(result.event.occurredAt).toBe("2026-03-01T09:59:59.000Z");
    expect(result.event.id).toBe(identity);
    // 库里只有一行。
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM course_exposure_event WHERE id = ?")
      .get(identity) as { c: number | bigint };
    expect(Number(row.c)).toBe(1);
  });

  it("**一个已验证快照**：校验与下发之间换包，绝不会返回另一份正文", () => {
    /*
     * 这是 P0-3 的判据。
     *
     * 上一版先读一次包做校验、落库曝光，然后**又解析一次** `course.json`
     * 取正文。那两次读取之间盘上的文件可以被换掉，于是"校验过的内容"
     * 与"下发的内容"不是同一份 —— 而曝光会声称它对应被校验的那一版。
     *
     * 现在校验与下发共用同一次读取的结果（`integrity.content`），
     * 因此这条路径上不存在第二次读盘。
     *
     * 判据用**确定性**的方式证明：在 `appendExposure` 的那一刻换掉盘上
     * 的正文，然后断言下发的仍是校验时那一份。
     */
    importCourse();
    const originalChecksum = repos.courses.getPackage(COURSE_ID)!.manifestChecksum;

    const result = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 下发的是校验时那一份（响应里带校验和，可核对）。
    expect(result.contentChecksum).toBe(originalChecksum);
    expect(result.content.text).toBe(FIXTURE_READING_TEXT);
    // 而不是任何后来被换上去的内容。
    expect(result.content.text).not.toContain("换掉的");
  });

  it("**一个已验证快照（确定性）**：写入那一刻换包，绝不会返回另一份正文", () => {    /*
     * 这是 P0-3 最强的一条判据。
     *
     * 它不依赖"恰好没读到"这种偶然，而是**主动**在写入曝光的那一刻
     * 换掉盘上的 `course.json`。若实现是"校验一次、下发前再读一次"，
     * 这次换包必然让下发的内容变成另一份 —— 测试因此变红。
     *
     * 做法：包一层 `repos`，让 `appendRevealExposureOnce` 在委托给真实
     * 实现之前先改盘。这是对竞态窗口的确定性复现。
     */
    importCourse();
    const originalChecksum = repos.courses.getPackage(COURSE_ID)!.manifestChecksum;
    const manifestPath = courseManifestPath();

    let swapped = false;
    /*
     * 用 `Proxy` 只拦截那一个方法，其余全部委托原对象。
     *
     * 刻意不用 `{ ...repos.courses }`：`repos.courses` 是**类实例**，
     * 展开会丢掉原型方法（实测踩到：`getPackage is not a function`）；
     * 而手动复制原型方法又会丢 `this` 绑定（实测踩到：
     * `Cannot read properties of undefined`）。
     */
    const interceptingCourses = new Proxy(repos.courses, {
      get(target, property, receiver) {
        if (property === "appendRevealExposureOnce") {
          return (input: Parameters<typeof target.appendRevealExposureOnce>[0]) => {
            if (!swapped) {
              swapped = true;
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
              (manifest.segments as Array<Record<string, unknown>>).find(
                (segment) => segment.id === SEGMENT_ID,
              )!.text = "在写入曝光那一刻被换上的正文。";
              writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
            }
            return target.appendRevealExposureOnce(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = revealCourseSegment(
      { ...repos, courses: interceptingCourses },
      revealInput({ occurredAt: "2026-03-01T10:00:00.000Z" }),
    );

    expect(swapped, "必须在写入曝光前完成换包（否则这条测试没测到竞态窗口）").toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 关键：下发的仍是**校验时**那一份，而不是换上去的那一份。
    expect(result.content.text).toBe(FIXTURE_READING_TEXT);
    expect(result.content.text).not.toContain("被换上");
    // 且校验和证明它就是索引登记的那一版。
    expect(result.contentChecksum).toBe(originalChecksum);
  });

  it("**快照在库层面可见**：下发的校验和就是索引登记的校验和", () => {
    importCourse();
    const result = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * 四个字段必须互相对齐（P0-3 第 4 条）：
     * 校验和 ↔ 索引登记值；内容版本 ↔ 请求版本 ↔ 索引版本；
     * 段身份 ↔ 请求的 segmentId。
     */
    expect(result.contentChecksum).toBe(repos.courses.getPackage(COURSE_ID)!.manifestChecksum);
    expect(result.indexedContentVersion).toBe(1);
    expect(result.content.courseContentVersion).toBe(1);
    expect(result.content.segmentId).toBe(SEGMENT_ID);
  });

  it("幂等命中仍重新校验内容完整性（不因为记录过就放行）", () => {
    importCourse();
    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));

    // 包漂移后再次请求：即使此前记录过，也必须失败关闭。
    const manifestPath = courseManifestPath();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.segments as Array<Record<string, unknown>>).find(
      (segment) => segment.id === SEGMENT_ID,
    )!.text = "漂移后的正文。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const again = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-02T10:00:00.000Z" }));

    expect(again.ok, "幂等命中不得跳过校验").toBe(false);
    expect(JSON.stringify(again)).not.toContain("漂移后的正文");
    // 仍然只有首次那一条。
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("不同内容版本的揭示各自算一次（版本参与身份）", () => {
    importCourse();
    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));

    // 升到 v2（内容真的变了）。
    importCourse(buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }));

    const second = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 2, occurredAt: "2026-04-01T10:00:00.000Z" }));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.recorded).toBe(true);
    expect(countRows("course_exposure_event")).toBe(2);
    expect(second.content.text).toBe("A genuinely different v2 body.");
  });

  it("普通曝光与揭示曝光可以并存（同一段既被渲染过又被揭示过）", () => {
    importCourse();

    const rendered = recordCourseExposure(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      eventType: "content_rendered",
      occurredAt: "2026-02-01T10:00:00.000Z",
    });
    expect(rendered.ok).toBe(true);

    const revealed = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-02-02T10:00:00.000Z" }));
    expect(revealed.ok).toBe(true);

    expect(countRows("course_exposure_event")).toBe(2);
    expect(countCourseExposure(repos, PROFILE_ID)).toBe(2);
  });
});

// ===========================================================================
// 二、失败关闭：正文绝不从不被求证的状态下发
// ===========================================================================

describe("揭示失败关闭：任何判定不过都不下发正文", () => {
  it("课程包不在索引中 ⇒ 拒绝，且不写任何观测", () => {
    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: "no-such-course",
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/不在索引中/);
    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("段不存在 ⇒ 拒绝，且不写任何观测", () => {
    importCourse();
    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: "no-such-segment",
      courseContentVersion: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/不存在/);
    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("内容版本不匹配 ⇒ 拒绝", () => {
    importCourse();
    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 7,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/版本不匹配/);
    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("**manifest 漂移**（版本不变、盘上内容被换）⇒ 拒绝，且不写任何观测", () => {
    /*
     * 这是本组测试最重要的一条。
     *
     * 缺陷形态：只比"内容版本相等"时，直接在盘上换掉 course.json 而不升版本，
     * 揭示端点会把一份**索引从未登记过**的材料发给学习者 ——
     * 而曝光会声称"当时看到的是 v1"。
     */
    importCourse();

    const manifestPath = courseManifestPath();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const segments = manifest.segments as Array<Record<string, unknown>>;
    const target = segments.find((segment) => segment.id === SEGMENT_ID);
    expect(target, "夹具里必须有 reading.a 段").toBeDefined();
    target!.text = "盘上被换掉的正文 —— 索引从未登记过它。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
    });

    expect(result.ok, "包漂移必须失败关闭").toBe(false);
    if (result.ok) return;
    // 失败原因必须说清是漂移，而不是"段不存在"之类。
    expect(result.error).toMatch(/校验和|改动/);
    /*
     * 而且必须是**包校验**挡下的，不是风险重确认挡下的。
     *
     * 变异测试会把漂移判定改成恒假；若那时测试仍然绿，说明是风险那层
     * 无意中兜住了 —— 那会让"漂移必须有独立判据"这件事失去证明。
     * 因此这里额外要求：漂移被拒时**不带** `risk_changed` 码。
     */
    expect(result.code, "漂移应由包校验挡下，而不是风险重确认").toBeUndefined();
    // 关键：没有任何观测落库，也没有正文泄漏到结果里。
    expect(countRows("course_exposure_event")).toBe(0);
    expect(JSON.stringify(result)).not.toContain("盘上被换掉的正文");
  });

  it("包被删掉 ⇒ 拒绝", () => {
    importCourse();
    rmSync(join(contentRoot, "courses", COURSE_ID), { recursive: true, force: true });

    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
    });

    expect(result.ok).toBe(false);
    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("**已揭示过但此刻包漂移** ⇒ 仍然拒绝（幂等不得成为绕过口）", () => {
    /*
     * 这条守住一个具体的绕过路径：
     *
     * 第一次揭示成功 ⇒ 库里有了 `reveal_requested` 记录；
     * 之后包被换掉 ⇒ 第二次揭示若因为"已经记录过"就放行，
     * 它会把一份索引未登记的材料发出来。
     *
     * 因此幂等命中**不能**跳过校验：本用例证明它没有跳过。
     */
    importCourse();

    const first = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));
    expect(first.ok).toBe(true);

    const manifestPath = courseManifestPath();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const segments = manifest.segments as Array<Record<string, unknown>>;
    segments.find((segment) => segment.id === SEGMENT_ID)!.text = "换掉的正文。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const second = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-02T10:00:00.000Z" }));

    expect(second.ok, "幂等命中不得跳过包校验").toBe(false);
    expect(JSON.stringify(second)).not.toContain("换掉的正文");
    // 曝光表没有被追加（只有第一次那条）。
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("未登记的事件种类被拒绝（含揭示路径）", () => {
    importCourse();
    const result = recordCourseExposure(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      eventType: "not_a_real_event" as never,
    });
    expect(result.ok).toBe(false);
    expect(countRows("course_exposure_event")).toBe(0);
  });
});

// ===========================================================================
// 三、揭示曝光的接触语义（P0-5）+ 回退约束
// ===========================================================================

describe("reveal_requested 的接触语义（潜在接触，不是已确认看过）", () => {
  const PAPER_ID = "fixture-cet6-2024-12-v1";
  const SECTION = "reading.careful_reading";

  function importPaper(): void {
    writeFixturePackage(
      contentRoot,
      PAPER_ID,
      buildFixturePackage({ id: PAPER_ID, year: 2024, session: "December", variant: "set1" }),
    );
    const plan = planImport(repos, { only: [PAPER_ID] });
    expect(plan.report.counts.insert).toBe(1);
    expect(commitImport(repos, plan).ok).toBe(true);
  }

  /** 建立一条指向 PAPER_ID 的已核验链接。 */
  function link(verificationRef: string) {
    return verifyCanonicalLink(repos, {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION,
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef,
    });
  }

  it("**只有** reveal_requested ⇒ uncertain（潜在接触），绝不是 pristine", () => {
    /*
     * P0-5 的核心判据。
     *
     * 请求只说明"学习者要求看"，不证明他读到了。因此结论必须是
     * `uncertain`（无法证明仍未见）—— 而不是 `exposed`（已证明接触），
     * 更绝不是 `pristine`（完全没接触过）。
     */
    importPaper();
    importCourse();

    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-02-01T10:00:00.000Z" }));
    expect(link("合成夹具核验：仅揭示曝光").ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_ID, PAPER_ID);
    expect(freshness.state, "只请求过揭示必须是 uncertain").toBe("uncertain");
    expect(freshness.matches, "潜在接触不得产生正面证据").toEqual([]);
    expect(freshness.unresolved.map((item) => item.code)).toContain("potential_contact_only");

    // 而它仍然**不满足**严格未见模考资格（失败关闭）。
    expect(
      domainIsEligible(freshness),
      "潜在接触不得被当成严格未见模考",
    ).toBe(false);
  });

  it("揭示 + 已确认看过 ⇒ exposed（正面证据压过潜在接触）", () => {
    importPaper();
    importCourse();

    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-02-01T10:00:00.000Z" }));
    // 同一段上追加一条**已确认**的看过事件。
    recordCourseExposure(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      eventType: "content_rendered",
      occurredAt: "2026-02-02T10:00:00.000Z",
    });
    expect(link("合成夹具核验：混合事件").ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_ID, PAPER_ID);
    expect(freshness.state, "有已确认看过 ⇒ exposed").toBe("exposed");
    expect(freshness.matches).toHaveLength(1);
    /*
     * 正面证据的 `eventTypes` 只列**已确认**接触的事件。
     *
     * 这是有意的：`exposed` 的含义是"已证明接触"，而 `reveal_requested`
     * 不构成证明。把它列进证据会让证据看起来比实际更强。
     */
    expect(freshness.matches[0].eventTypes).toEqual(["content_rendered"]);
  });

  it("**版本漂移**：揭示落在 v1、链接核验在 v2 ⇒ uncertain（不是 pristine）", () => {
    importPaper();
    importCourse();

    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-02-01T10:00:00.000Z" }));

    // 课程升到 v2，然后在 v2 上核验链接。
    importCourse(buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }));
    expect(
      verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 2,
        segmentId: SEGMENT_ID,
        paperId: PAPER_ID,
        paperContentVersion: 1,
        sectionId: SECTION,
        targetScope: "section",
        verificationStatus: "verified",
        verificationRef: "合成夹具核验：版本漂移",
      }).ok,
    ).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_ID, PAPER_ID);
    expect(freshness.state, "版本漂移必须失败关闭").toBe("uncertain");
    expect(freshness.unresolved.map((item) => item.code)).toContain("exposure_version_mismatch");
  });

  it("**迟核验**：先揭示、后核验，历史揭示仍参与判定（回退约束）", () => {
    /*
     * 这一条是回退约束的直接判据：即使 Companion UI 被撤回，
     * 已经持久化的 reveal_requested 也必须持续参与新鲜度判断。
     */
    importPaper();
    importCourse();

    // 揭示时该段还没有任何链接。
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-02-01T10:00:00.000Z" }));
    expect(getPaperFreshness(repos, PROFILE_ID, PAPER_ID).state).toBe("pristine");

    // 两周后才核验出对应关系。
    expect(link("合成夹具核验：迟核验").ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_ID, PAPER_ID);
    expect(freshness.state, "迟核验必须让旧揭示参与判定").toBe("uncertain");
  });

  it("重复揭示不放大结论（一次与五次得到同一结论）", () => {
    importPaper();
    importCourse();

    for (let index = 0; index < 5; index += 1) {
      const reveal = revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: `2026-02-0${index + 1}T10:00:00.000Z` }));
      expect(reveal.ok).toBe(true);
    }
    // 原子幂等：只留一条。
    expect(countRows("course_exposure_event")).toBe(1);

    expect(link("合成夹具核验：重复揭示").ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_ID, PAPER_ID);
    expect(freshness.state).toBe("uncertain");
    expect(freshness.matches).toEqual([]);
  });

  it("**回退兼容**：直接写库的 reveal_requested 行同样参与判定", () => {
    /*
     * 这一条守护"UI 被撤回"那条路径：将来若 Companion 界面不存在了，
     * 直接落在库里的 `reveal_requested` 行仍必须被投影逻辑读到。
     *
     * 判据是绕过服务层、直接用仓储写入（模拟历史数据或迁移产物）。
     */
    importPaper();
    importCourse();

    repos.courses.appendExposure({
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      eventType: "reveal_requested",
      occurredAt: "2026-02-01T10:00:00.000Z",
    });
    expect(link("合成夹具核验：回退兼容").ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_ID, PAPER_ID).state).toBe("uncertain");
  });

  it("其它 profile 的揭示不影响本 profile 的结论", () => {
    importPaper();
    importCourse();
    db.prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("p2", "Other", 30, 60, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    revealCourseSegment(repos, {
      profileId: "p2",
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      occurredAt: "2026-02-01T10:00:00.000Z",
    });
    expect(link("合成夹具核验：profile 隔离").ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_ID, PAPER_ID).state).toBe("pristine");
  });
});

// ===========================================================================
// 四、伴随视图只读：列表页绝不下发正文
// ===========================================================================

describe("伴随视图：只有身份与状态，没有正文", () => {
  it("列表视图不含任何正文通道内容", () => {
    importCourse();

    const view = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.packageTrustworthy).toBe(true);
    expect(view.segments.length).toBeGreaterThan(0);

    // 序列化后绝不含正文。
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(FIXTURE_READING_TEXT);
    // 也不含合成中文段落 / 参考译文。
    expect(serialized).not.toContain("夹具用的合成中文段落");
    expect(serialized).not.toContain("Fixture reference translation");

    // 但通道存在性必须报出来（界面据此说"这段有参考译文"）。
    const segment = view.segments.find((item) => item.segmentId === SEGMENT_ID);
    expect(segment?.channels).toContain("text");
  });

  it("揭示过的段标记为「请求过阅读」，而不是「已看过」", () => {
    /*
     * P0-5：揭示只记录"请求过"，它不证明读过。
     * 因此界面的措辞必须是潜在接触（`potential_contact`），
     * 而不是已确认看过（`confirmed_seen`）。
     */
    importCourse();

    const before = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;
    expect(before.segments.find((item) => item.segmentId === SEGMENT_ID)?.contactState).toBe(
      "not_contacted",
    );

    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));

    const after = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;
    expect(after.segments.find((item) => item.segmentId === SEGMENT_ID)?.contactState).toBe(
      "potential_contact",
    );
  });

  it("有已确认看过事件时标记为「已看过」", () => {
    importCourse();

    // 记录一条**已确认**接触的事件（内容被呈现）。
    recordCourseExposure(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      eventType: "content_rendered",
      occurredAt: "2026-03-01T10:00:00.000Z",
    });

    const view = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;
    expect(view.segments.find((item) => item.segmentId === SEGMENT_ID)?.contactState).toBe(
      "confirmed_seen",
    );
  });

  it("课程升版后，旧版本的接触不算新版本的", () => {
    importCourse();
    revealCourseSegment(repos, revealInput({ courseId: COURSE_ID, segmentId: SEGMENT_ID, courseContentVersion: 1, occurredAt: "2026-03-01T10:00:00.000Z" }));

    importCourse(buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }));

    const view = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;
    expect(view.contentVersion).toBe(2);
    expect(view.segments.find((item) => item.segmentId === SEGMENT_ID)?.contactState).toBe(
      "not_contacted",
    );
  });

  it("段按 manifest 的材料分组，并保留顺序与页码锚点", () => {
    importCourse();

    const view = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;

    // 分组来自 manifest 的 materials，顺序一致。
    expect(view.materials.length).toBeGreaterThan(0);
    const first = view.materials[0];
    expect(first.segments.length).toBeGreaterThan(0);

    // 扁平视图与分组视图包含同样多的段（不重不漏）。
    const groupedCount = view.materials.reduce((sum, material) => sum + material.segments.length, 0);
    expect(groupedCount).toBe(view.segments.length);

    // reading.a 有页码锚点（夹具声明 1–3 页）。
    const readingA = view.segments.find((item) => item.segmentId === SEGMENT_ID);
    expect(readingA?.anchorLabel).toMatch(/第 \d+/);
    // method.1 没有页码锚点 ⇒ 如实为 null。
    const methodNote = view.segments.find((item) => item.segmentId === "method.1");
    expect(methodNote?.anchorLabel).toBeNull();
  });

  it("包漂移时如实报告不可读，而不是假装成空课程", () => {
    importCourse();

    const manifestPath = courseManifestPath();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.segments as Array<Record<string, unknown>>).find(
      (segment) => segment.id === SEGMENT_ID,
    )!.text = "漂移后的正文。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const view = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;
    expect(view.packageTrustworthy).toBe(false);
    expect(view.packageIssue).toMatch(/校验和|改动/);
    expect(view.segments).toEqual([]);
  });
});

/**
 * P0-1：服务端风险重确认。
 *
 * 这一组证明"UI 确认面板不是安全边界"：学习者确认的是**页面渲染时**
 * 的风险，而服务端必须在写入曝光之前重新评估，并在风险变化时拒绝。
 */
describe("揭示前的服务端风险重确认（P0-1）", () => {
  const PAPER_ID = "fixture-cet6-2024-12-v1";
  const SECTION = "reading.careful_reading";

  function importPaper(): void {
    writeFixturePackage(
      contentRoot,
      PAPER_ID,
      buildFixturePackage({ id: PAPER_ID, year: 2024, session: "December", variant: "set1" }),
    );
    const plan = planImport(repos, { only: [PAPER_ID] });
    expect(plan.report.counts.insert).toBe(1);
    expect(commitImport(repos, plan).ok).toBe(true);
  }

  function link() {
    return verifyCanonicalLink(repos, {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION,
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "合成夹具核验：风险重确认",
    });
  }

  it("未匹配时风险仍可求证，且指纹确定", () => {
    importCourse();
    const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
    expect(risk.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(risk.risky, "未匹配 ⇒ 没有已核验关联").toBe(false);
    expect(risk.unprovableReason).toBeNull();
    expect(risk.papers).toEqual([]);
    // 未匹配**仍然**要求确认（见下一条的理由）。
    expect(risk.requiresConfirmation).toBe(true);
  });

  it("**新建链接** ⇒ 指纹变化", () => {
    importPaper();
    importCourse();
    const before = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    expect(link().ok).toBe(true);
    const after = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    expect(after.fingerprint, "新建链接必须改变指纹").not.toBe(before.fingerprint);
    expect(after.risky).toBe(true);
    expect(after.papers.map((paper) => paper.paperId)).toEqual([PAPER_ID]);
  });

  it("**改成模考保留** ⇒ 指纹再次变化", () => {
    importPaper();
    importCourse();
    expect(link().ok).toBe(true);
    const training = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    repos.papers.setPool(PAPER_ID, "mock_reserve");
    const reserved = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    expect(reserved.fingerprint, "池归属变化必须改变指纹").not.toBe(training.fingerprint);
    expect(reserved.papers[0].reservedForMock).toBe(true);
    expect(training.papers[0].reservedForMock).toBe(false);
  });

  it("**链接失效** ⇒ 指纹也变化（反向也要重新确认）", () => {
    importPaper();
    importCourse();
    expect(link().ok).toBe(true);
    const usable = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    // 真题升版 ⇒ 链接失效。
    writeFixturePackage(
      contentRoot,
      PAPER_ID,
      buildFixturePackage({
        id: PAPER_ID,
        year: 2024,
        session: "December",
        variant: "set1",
        contentVersion: 2,
      }),
    );
    const plan = planImport(repos, { only: [PAPER_ID] });
    expect(commitImport(repos, plan).ok).toBe(true);

    const stale = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
    expect(stale.fingerprint, "链接失效必须改变指纹").not.toBe(usable.fingerprint);
    expect(stale.risky).toBe(false);
  });

  it("**包漂移** ⇒ 风险不可求证（失败关闭，不是「没有风险」）", () => {
    importCourse();
    const manifestPath = courseManifestPath();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.segments as Array<Record<string, unknown>>).find(
      (segment) => segment.id === SEGMENT_ID,
    )!.text = "漂移后的正文。";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
    expect(risk.unprovableReason, "漂移必须报告不可求证").toMatch(/校验和|改动/);
    expect(risk.risky, "不可求证不得被当成没有风险").toBe(true);
    expect(risk.requiresConfirmation).toBe(true);
  });

  it("**缺失指纹** ⇒ 拒绝揭示，且不写曝光", () => {
    importCourse();
    const input = revealInput({ occurredAt: "2026-03-01T10:00:00.000Z" });
    // 刻意删掉确认字段：等同于"学习者没有确认过"。
    delete (input as { confirmedRiskFingerprint?: string }).confirmedRiskFingerprint;

    const result = revealCourseSegment(repos, input);

    expect(result.ok, "未确认风险必须被拒").toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("risk_changed");
    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("**正确指纹** ⇒ 允许揭示，且响应带回同一个指纹", () => {
    importCourse();
    const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      occurredAt: "2026-03-01T10:00:00.000Z",
      confirmedRiskFingerprint: risk.fingerprint,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.risk.fingerprint).toBe(risk.fingerprint);
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("**确认过的风险与下发的正文属于同一次请求状态**", () => {
    /*
     * P0-1 第 8 条：确认的风险、校验的包、下发的正文必须指向同一份状态。
     *
     * 判据是响应里三个字段互相对齐：指纹 ↔ 内容校验和 ↔ 内容版本。
     */
    importCourse();
    const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
    const record = repos.courses.getPackage(COURSE_ID)!;

    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      occurredAt: "2026-03-01T10:00:00.000Z",
      confirmedRiskFingerprint: risk.fingerprint,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.risk.fingerprint).toBe(risk.fingerprint);
    expect(result.contentChecksum).toBe(record.manifestChecksum);
    expect(result.indexedContentVersion).toBe(1);
    expect(result.content.courseContentVersion).toBe(1);
  });

  it("**页面 GET 之后新建链接** ⇒ 揭示被拒（端到端的竞态场景）", () => {
    /*
     * 这是 P0-1 最完整的场景：学习者在"没有关联真题"的状态下确认，
     * 随后有人新建链接，揭示必须被拒。
     */
    importPaper();
    importCourse();

    // 页面渲染时的风险（无链接）。
    const atPageLoad = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    // 页面 GET 与 POST 之间：新建链接。
    expect(link().ok).toBe(true);

    // 学习者点确认（带的是页面那个指纹）。
    const result = revealCourseSegment(repos, {
      profileId: PROFILE_ID,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      occurredAt: "2026-03-01T10:00:00.000Z",
      confirmedRiskFingerprint: atPageLoad.fingerprint,
    });

    expect(result.ok, "新建链接后必须拒绝").toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("risk_changed");
    // 必须回传**更新后的**风险视图。
    if (result.code !== "risk_changed") return;
    expect(result.risk.papers.map((paper) => paper.paperId)).toEqual([PAPER_ID]);
    // 且没有写曝光 —— 这是关键：被拒的揭示不得留下记录。
    expect(countRows("course_exposure_event")).toBe(0);

    // 学习者查看更新后的风险并重新确认 ⇒ 这次成功。
    const retry = revealCourseSegment(
      repos,
      revealInput({ occurredAt: "2026-03-01T10:01:00.000Z", confirmedRiskFingerprint: result.risk.fingerprint }),
    );
    expect(retry.ok, "按更新后的风险重新确认应当成功").toBe(true);
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("伴随视图下发的指纹与服务端重算的**同一个**", () => {
    importPaper();
    importCourse();
    expect(link().ok).toBe(true);

    const view = getCourseCompanionView(repos, PROFILE_ID, COURSE_ID)!;
    const segment = view.segments.find((item) => item.segmentId === SEGMENT_ID)!;
    const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

    // 界面展示的链接与它下发的指纹必须描述同一份事实。
    expect(segment.riskFingerprint).toBe(risk.fingerprint);
    expect(segment.linkedPapers.map((paper) => paper.paperId)).toEqual(risk.papers.map((p) => p.paperId));
  });

  it("指纹比对是**定长**的（不同长度不泄露信息）", async () => {
    const { riskFingerprintMatches } = await import("@/services/reveal-risk");
    const expected = "a".repeat(64);
    expect(riskFingerprintMatches(expected, expected)).toBe(true);
    expect(riskFingerprintMatches(expected, "a".repeat(63))).toBe(false);
    expect(riskFingerprintMatches(expected, "a".repeat(65))).toBe(false);
    expect(riskFingerprintMatches(expected, ""),).toBe(false);
    expect(riskFingerprintMatches(expected, undefined)).toBe(false);
    expect(riskFingerprintMatches(expected, 42)).toBe(false);
  });

  /**
   * Round 3 P3：指纹必须**完整绑定**被确认的风险上下文。
   *
   * ── 这一组守的两条具体缺陷 ──
   *
   * 1. **`segmentId` 不在输入里**：同一课程里两段材料若链接集合为空，
   *    会算出同一个指纹 ⇒"在 A 段确认、在 B 段揭示"可以复用确认上下文。
   * 2. **目标身份不全**：只带 `targetScope`，没带 `sectionId` /
   *    `groupId` / `questionId` ⇒ 同一份卷子换一个大题或题组，
   *    指纹不变。而学习者确认过的是**前者**的警告。
   *
   * 判据形式是"碰撞测试"：构造两个**语义不同**的状态，断言指纹**不同**。
   * 反过来（同一状态两次计算必须相同）由每一条用例的前半部分保证。
   */
  describe("P3 · 风险指纹的完整性与碰撞", () => {
    const OTHER_PAPER = "fixture-cet6-2023-06-v1";
    const OTHER_SEGMENT = "reading.b";

    function importBoth(): void {
      for (const [id, year, session] of [
        [PAPER_ID, 2024, "December"],
        [OTHER_PAPER, 2023, "June"],
      ] as const) {
        writeFixturePackage(
          contentRoot,
          id,
          buildFixturePackage({ id, year, session, variant: "set1" }),
        );
      }
      const plan = planImport(repos, { only: [PAPER_ID, OTHER_PAPER] });
      expect(commitImport(repos, plan).ok).toBe(true);
    }

    function linkAt(overrides: {
      segmentId?: string;
      paperId?: string;
      sectionId?: string;
      targetScope?: "section" | "group" | "question";
      groupId?: string | null;
      questionId?: string | null;
    }) {
      return verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 1,
        segmentId: overrides.segmentId ?? SEGMENT_ID,
        paperId: overrides.paperId ?? PAPER_ID,
        paperContentVersion: 1,
        sectionId: overrides.sectionId ?? SECTION,
        targetScope: overrides.targetScope ?? "section",
        groupId: overrides.groupId ?? null,
        questionId: overrides.questionId ?? null,
        verificationStatus: "verified",
        verificationRef: "合成夹具核验：指纹碰撞",
      });
    }

    it("**同一状态**两次计算必须相同（确定性）", () => {
      importPaper();
      importCourse();
      expect(link().ok).toBe(true);

      const first = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      const second = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(second.fingerprint, "同一状态必须算出同一指纹").toBe(first.fingerprint);
    });

    it("**不同段**（都未匹配）⇒ 指纹必须不同", () => {
      /*
       * 这是 P3 第 1 条的直接判据。
       *
       * 上一版指纹不含 `segmentId`，两段都未匹配时输入完全相同 ⇒
       * 同一指纹 ⇒ 在 A 段的确认可以用来在 B 段揭示。
       */
      importCourse(); // reading.a 与 reading.b 都还没有链接

      const segmentA = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      const segmentB = computeRevealRisk(repos, COURSE_ID, OTHER_SEGMENT);

      expect(segmentA.papers).toEqual([]);
      expect(segmentB.papers).toEqual([]);
      expect(
        segmentA.fingerprint,
        "两段的链接集合都为空，但它们是**不同的**风险上下文 —— 指纹必须区分它们",
      ).not.toBe(segmentB.fingerprint);
    });

    it("**确认不能跨段复用**：A 段的指纹在 B 段被拒", () => {
      importPaper();
      importCourse();
      expect(linkAt({ segmentId: SEGMENT_ID }).ok).toBe(true);

      // 学习者在 A 段确认。
      const atA = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      // 拿 A 段的指纹去揭示 B 段 ⇒ 必须被拒。
      const crossSegment = revealCourseSegment(repos, {
        profileId: PROFILE_ID,
        courseId: COURSE_ID,
        segmentId: OTHER_SEGMENT,
        courseContentVersion: 1,
        occurredAt: "2026-03-01T10:00:00.000Z",
        confirmedRiskFingerprint: atA.fingerprint,
      });

      expect(crossSegment.ok, "跨段复用确认必须被拒").toBe(false);
      if (crossSegment.ok) return;
      expect(crossSegment.code).toBe("risk_changed");
      expect(countRows("course_exposure_event")).toBe(0);
    });

    it("**同一份卷子换大题** ⇒ 指纹必须不同", () => {
      importPaper();
      importCourse();
      expect(linkAt({ sectionId: SECTION }).ok).toBe(true);
      const before = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      // 加一条指向**另一个大题**的链接（同一份卷子）。
      const other = linkAt({ sectionId: "reading.matching" });
      expect(other.ok, other.ok ? "" : JSON.stringify(other.issues)).toBe(true);

      const after = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(
        after.fingerprint,
        "同一份卷子换了大题是一项不同的风险事实 —— 指纹必须变",
      ).not.toBe(before.fingerprint);
    });

    it("**同一份卷子的目标消失** ⇒ 指纹必须不同", () => {
      importPaper();
      importCourse();
      expect(linkAt({ sectionId: SECTION }).ok).toBe(true);
      const withTarget = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      // 换到只有一份卷子、但**不同大题**的状态：用另一份卷子模拟"目标集合变化"。
      importBoth();
      expect(linkAt({ paperId: OTHER_PAPER, sectionId: "reading.matching" }).ok).toBe(true);

      const changed = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(changed.fingerprint, "目标集合变化必须改变指纹").not.toBe(
        withTarget.fingerprint,
      );
      expect(changed.papers.length).toBeGreaterThan(withTarget.papers.length);
    });

    it("**换一份卷子** ⇒ 指纹必须不同", () => {
      importBoth();
      importCourse();
      expect(linkAt({ paperId: PAPER_ID }).ok).toBe(true);
      const first = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      expect(linkAt({ paperId: OTHER_PAPER, sectionId: "reading.matching" }).ok).toBe(true);
      const both = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      expect(both.fingerprint).not.toBe(first.fingerprint);
      expect(both.papers.map((paper) => paper.paperId).sort()).toEqual(
        [OTHER_PAPER, PAPER_ID].sort(),
      );
    });

    it("**未匹配段确认被拒后，按当时的指纹重试可以成功**（不是死锁）", () => {
      /*
       * 失败关闭不能变成"永远无法揭示"：学习者看过风险说明并确认之后，
       * 揭示必须能成功。判据是"用**服务端回传的**指纹重试 ⇒ 200"。
       */
      importCourse();
      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      const result = revealCourseSegment(repos, {
        profileId: PROFILE_ID,
        courseId: COURSE_ID,
        segmentId: SEGMENT_ID,
        courseContentVersion: 1,
        occurredAt: "2026-03-01T10:00:00.000Z",
        confirmedRiskFingerprint: risk.fingerprint,
      });
      expect(result.ok, "未匹配段在确认之后必须可以揭示").toBe(true);
      expect(countRows("course_exposure_event")).toBe(1);
    });
  });

  /**
   * P1-M：一段材料指向同一份卷子的**多个语义目标**时必须全部显示。
   *
   * ── 独立审查复现的缺陷 ──
   *
   * 投影按 paperId 分组后做了 `if (byPaper.has(link.paperId)) continue;`，
   * 于是同一段材料指向同一份卷子的第 1 组、第 2 组、整个大题时，
   * 只显示第一个。指纹正确考虑了全部链接，但学习者看到的确认说明
   * 只提一个 —— 他确认的范围比系统记录的范围小。
   *
   * 这不是"信息过载"，而是**知情同意的范围被悄悄缩小**。
   */
  describe("P1-M · 同一段材料的多个语义目标必须全部显示", () => {
    /** 三段阅读篇章对应的 section 都存在（仔细阅读）。 */
    const SECTION_CAREFUL = "reading.careful_reading";
    const SECTION_MATCHING = "reading.matching";

    function importPaperForMulti(): void {
      writeFixturePackage(
        contentRoot,
        PAPER_ID,
        buildFixturePackage({ id: PAPER_ID, year: 2024, session: "December", variant: "set1" }),
      );
      const plan = planImport(repos, { only: [PAPER_ID] });
      expect(plan.report.counts.insert).toBe(1);
      expect(commitImport(repos, plan).ok).toBe(true);
    }

    /** 建一条指向 PAPER_ID 的链接。 */
    function linkTo(overrides: {
      sectionId: string;
      targetScope: "section" | "group" | "question";
      groupId?: string | null;
      questionId?: string | null;
      segmentId?: string;
    }) {
      return verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 1,
        segmentId: overrides.segmentId ?? SEGMENT_ID,
        paperId: PAPER_ID,
        paperContentVersion: 1,
        sectionId: overrides.sectionId,
        targetScope: overrides.targetScope,
        groupId: overrides.groupId ?? null,
        questionId: overrides.questionId ?? null,
        verificationStatus: "verified",
        verificationRef: "合成夹具核验：多目标",
      });
    }

    it("**同一份卷子的三个不同目标** ⇒ 三个目标全部出现在说明里", () => {
      importPaperForMulti();
      importCourse();

      /*
       * 这正是审查复现的形态：一段材料同时对应同一份卷子的
       * 第 1 组、第 2 组、以及"整个大题"。
       */
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g1" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g2" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "section" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      // 按卷子去重 ⇒ 只有一个条目（不重复出卡片）。
      expect(risk.papers, "同一份卷子只应有一个展示条目").toHaveLength(1);

      const label = risk.papers[0].targetLabel;
      expect(label, "必须出现第 1 组").toContain("第 1 组");
      expect(label, "必须出现第 2 组").toContain("第 2 组");
      expect(label, "必须出现整个大题").toContain("整个大题");
      // 诚实计数：明确说"共 3 个目标"，而不是含糊的"多个"。
      expect(label, "必须给出诚实条数").toContain("共 3 个目标");
    });

    it("**单个目标**时不出现多余的计数与分隔（不增加 UX 复杂度）", () => {
      importPaperForMulti();
      importCourse();
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "section" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(risk.papers).toHaveLength(1);
      expect(risk.papers[0].targetLabel).not.toContain("共 ");
      expect(risk.papers[0].targetLabel).not.toContain("；");
      expect(risk.papers[0].targetLabel).toContain("整个大题");
    });

    it("**不同大题**的目标也全部列出（section 不同 ⇒ 标签不同）", () => {
      importPaperForMulti();
      importCourse();
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "section" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_MATCHING, targetScope: "section" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(risk.papers).toHaveLength(1);

      const label = risk.papers[0].targetLabel;
      expect(label, "必须出现仔细阅读").toContain("仔细阅读");
      expect(label, "必须出现长篇阅读（匹配）").toContain("长篇阅读（匹配）");
      expect(label).toContain("共 2 个目标");
    });

    it("**目标粒度**（section / group / question）标签各自正确", () => {
      importPaperForMulti();
      importCourse();

      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "section" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g1" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "question", groupId: "reading.careful_reading#g1", questionId: "q47" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      const label = risk.papers[0].targetLabel;
      expect(label, "section 粒度").toContain("整个大题");
      expect(label, "group 粒度").toContain("第 1 组");
      /*
       * question 粒度：界面上出现的是**题目 id 本身**（`q47`），
       * 而不是"第 3 题"这种人工编号。
       *
       * 这是有意的诚实：`questionId` 是包内的稳定标识，而"第几题"是
       * 卷面序号 —— 两者不是一回事。编一个"第 N 题"会比显示 id
       * 更漂亮，但那是**猜测**，因此不做。
       */
      expect(label, "question 粒度（显示题目 id，不猜卷面序号）").toContain("q47");
      expect(label, "三个粒度都在").toContain("共 3 个目标");
    });

    it("**同一语义目标重复核验**不得在界面上出现两行一样的字", () => {
      importPaperForMulti();
      importCourse();
      // 同一个目标复核两次（语义目标相同）。
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "section" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "section" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(risk.papers).toHaveLength(1);
      // 去重后仍是单个目标 ⇒ 不加计数。
      expect(risk.papers[0].targetLabel).not.toContain("共 ");
    });

    it("**卷子级策略状态只显示一次**（不因多目标而重复）", () => {
      importPaperForMulti();
      importCourse();
      repos.papers.setPool(PAPER_ID, "mock_reserve");

      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g1" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g2" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      // 卷子级属性：保留/可训练各只有一个值。
      expect(risk.papers).toHaveLength(1);
      expect(risk.papers[0].reservedForMock).toBe(true);
      expect(risk.papers[0].trainable).toBe(false);
    });

    it("**指纹仍然考虑全部目标**（显示修好不影响判定）", () => {
      importPaperForMulti();
      importCourse();

      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g1" }).ok).toBe(true);
      const oneTarget = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g2" }).ok).toBe(true);
      const twoTargets = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);

      /*
       * 多一个目标必须改变指纹 —— 否则"确认了一个目标"与
       * "确认了两个目标"在服务端看起来是同一件事。
       */
      expect(twoTargets.fingerprint).not.toBe(oneTarget.fingerprint);
      // 而展示从"1 个目标"变成"2 个目标"。
      expect(oneTarget.papers[0].targetLabel).not.toContain("共 ");
      expect(twoTargets.papers[0].targetLabel).toContain("共 2 个目标");
    });

  /**
   * P2-A / P2-B：学习者可见的失败消息不得泄露内部信息。
   *
   * 两条独立审查发现：
   * - P2-A：`risk.unprovableReason` 会原样到达浏览器，而它可能带磁盘路径；
   * - P2-B：漂移错误消息里拼了截断的 manifest 校验和。
   *
   * 两者的共同点：**服务层判定完全正确**，但把内部细节泄漏到了界面上。
   */
  describe("P2 · 学习者可见消息的显示安全", () => {
    it("P2-A：不可求证原因**不含**磁盘路径或私有目录名", async () => {
      importCourse();
      // 把包目录删掉 ⇒ 走 `readCoursePackageIntegrity` 的失败分支。
      rmSync(join(contentRoot, "courses", COURSE_ID), { recursive: true, force: true });

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      expect(risk.unprovableReason, "读不到包必须报告不可求证").not.toBeNull();
      expect(risk.unprovableReason).toMatch(/不存在|缺少/);

      const { containsPathLeak } = await import("@/lib/display-safety");
      const reason = risk.unprovableReason ?? "";
      // 不得出现私有目录结构。
      expect(reason, "不得出现 private-content").not.toContain("private-content");
      // 不得出现磁盘路径（Windows 盘符 / POSIX 绝对路径）。
      expect(containsPathLeak(reason), `不可求证原因不得含路径痕迹：${reason}`).toBe(false);
    });

    it("P2-A：消毒函数本身能抹掉各类路径形态", async () => {
      const { sanitizeDisplayText, containsPathLeak } = await import("@/lib/display-safety");

      const cases = [
        "ENOENT: no such file or directory, open 'Q:\\sample-root\\private-content\\courses\\x\\course.json'",
        "课程包不存在或缺少 course.json：private-content/courses/fixture-x",
        "无法读取 /home/owner/.config/nextjs/config.json",
        "\\\\fileserver\\share\\private-content\\x",
      ];
      for (const raw of cases) {
        const cleaned = sanitizeDisplayText(raw);
        expect(
          containsPathLeak(cleaned),
          `消毒后仍含路径痕迹：${raw} ⇒ ${cleaned}`,
        ).toBe(false);
        // 消毒不得把整句吃掉 —— 可读解释要留下。
        expect(cleaned.length, `消毒后不应为空：${raw}`).toBeGreaterThan(0);
      }
    });

    it("P2-B：漂移错误消息**不含**校验和片段，但保留可行动说明", () => {
      importCourse();
      const manifestPath = courseManifestPath();
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      (manifest.segments as Array<Record<string, unknown>>).find(
        (segment) => segment.id === SEGMENT_ID,
      )!.text = "漂移后的正文。";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      const reason = risk.unprovableReason ?? "";
      expect(reason, "漂移必须报告不可求证").toMatch(/改动|重新导入/);

      /*
       * 校验和片段（12 位十六进制 + 省略号）不得出现。
       * 判据用"任意长度的十六进制串"，因为片段长度是实现细节。
       */
      expect(reason, "不得泄露 manifest 校验和片段").not.toMatch(/[0-9a-f]{8,}/);
      // 但可行动的说明必须留下。
      expect(reason, "必须告诉用户该怎么做").toMatch(/重新导入/);
    });

    it("P2-B：漂移的揭示错误消息**不含**校验和片段", () => {
      importCourse();
      const manifestPath = courseManifestPath();
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      (manifest.segments as Array<Record<string, unknown>>).find(
        (segment) => segment.id === SEGMENT_ID,
      )!.text = "漂移后的正文。";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const result = revealCourseSegment(repos, {
        profileId: PROFILE_ID,
        courseId: COURSE_ID,
        segmentId: SEGMENT_ID,
        courseContentVersion: 1,
        occurredAt: "2026-03-01T10:00:00.000Z",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error, "揭示错误不得泄露校验和").not.toMatch(/[0-9a-f]{8,}/);
      // 校验和**判定**仍然有效：漂移仍然被拒。
      expect(result.error).toMatch(/改动|校验和/);
    });
  });

  it("**揭示结果带回完整的风险视图**（409 与 200 用同一投影）", () => {
      importPaperForMulti();
      importCourse();
      repos.papers.setPool(PAPER_ID, "mock_reserve");
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g1" }).ok).toBe(true);
      expect(linkTo({ sectionId: SECTION_CAREFUL, targetScope: "group", groupId: "reading.careful_reading#g2" }).ok).toBe(true);

      const risk = computeRevealRisk(repos, COURSE_ID, SEGMENT_ID);
      const result = revealCourseSegment(repos, {
        profileId: PROFILE_ID,
        courseId: COURSE_ID,
        segmentId: SEGMENT_ID,
        courseContentVersion: 1,
        occurredAt: "2026-03-01T10:00:00.000Z",
        confirmedRiskFingerprint: risk.fingerprint,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.risk.papers[0].targetLabel).toContain("共 2 个目标");
      expect(result.risk.papers[0].reservedForMock).toBe(true);
    });
  });
});

/**
 * 变异脚本的**覆盖声明**必须与实际变异一致。
 *
 * 与 `tests/freshness-wording.test.ts` 的同源守卫同一条理由：
 * 变异测试的价值完全建立在"声称覆盖了什么"与"实际施加了什么"一致之上。
 * 表一旦漂移（插入一个变异后编号整体后移），人就会以为某条守卫被覆盖了，
 * 而实际施加的是别的东西 —— 而每个变异各自仍然是绿的。
 */
describe("Course Companion 变异脚本 · 覆盖声明一致", () => {
  function mutationSource(): string {
    return readFileSync(join(process.cwd(), "scripts/course-companion-mutation.ts"), "utf8");
  }

  it("表里列出的每个 C<n> 都在数组里存在", () => {
    const source = mutationSource();

    const actual = new Map<string, string>();
    const arrayRe = /id:\s*"(C\d+)",\s*\r?\n\s*guard:\s*"([^"]+)"/g;
    let hit: RegExpExecArray | null;
    while ((hit = arrayRe.exec(source)) !== null) actual.set(hit[1], hit[2]);

    expect(actual.size, "变异数组不得为空").toBeGreaterThan(0);

    const tableRows = source
      .split(/\r?\n/)
      // 覆盖表写在文件的 JSDoc 里，因此行首是 ` * `。
      .filter((line) => /^\s*\*\s*\|\s*C\d+\s*\|/.test(line))
      .map((line) => line.replace(/^\s*\*\s*/, "").replace(/^\s*\|/, ""));

    expect(tableRows.length, "覆盖表必须列出全部变异").toBe(actual.size);

    for (const row of tableRows) {
      const cells = row.split("|").map((cell) => cell.trim());
      const id = cells[0];
      const described = cells[1];
      expect(actual.has(id), `覆盖表里的 ${id} 在变异数组里不存在`).toBe(true);

      // 字符级重叠度（同 freshness 的做法：容得下摘要措辞，抓得住编号漂移）。
      const normalize = (text: string): string => text.replace(/\*\*/g, "").replace(/\s/g, "");
      const describedChars = [...new Set(normalize(described))];
      const guardNorm = normalize(actual.get(id)!);
      const overlap = describedChars.filter((char) => guardNorm.includes(char)).length;
      expect(
        overlap / describedChars.length,
        `覆盖表 ${id} 的描述「${described}」与 guard「${actual.get(id)}」重叠度过低 —— 表可能已漂移`,
      ).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("数组里每个变异都被覆盖表列出（无遗漏）", () => {
    const source = mutationSource();
    const ids: string[] = [];
    const arrayRe = /id:\s*"(C\d+)",/g;
    let hit: RegExpExecArray | null;
    while ((hit = arrayRe.exec(source)) !== null) ids.push(hit[1]);

    for (const id of ids) {
      expect(
        new RegExp(`\\|\\s*${id}\\s*\\|`).test(source),
        `变异 ${id} 未在覆盖表中列出`,
      ).toBe(true);
    }
  });

  it("变异脚本不经过 shell 执行（避免 `**` 被 glob 或二次解析）", () => {
    const source = mutationSource();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code, "不得使用 shell: true").not.toMatch(/shell:\s*true/);
    expect(code, "必须直接执行 vitest 入口模块").toContain("vitest.mjs");
    expect(code, "必须逐字传参").toContain("spawnSync(process.execPath");
  });
});
