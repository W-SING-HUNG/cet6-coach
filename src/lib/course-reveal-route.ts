/**
 * 课程正文揭示端点的**路径常量**。
 *
 * ── 为什么它必须单独一个文件（实测构建失败）──
 *
 * 客户端组件需要这个路径去 `fetch`。若它从
 * `src/app/api/course/reveal/route.ts` import，就会把整个 Route Handler
 * 拉进客户端 bundle —— 而那个模块 import 了 `node:sqlite`（经 repository
 * 层）。Next 的 Turbopack 因此报：
 *
 *     the chunking context (unknown) does not support external modules
 *     (request: node:sqlite)
 *
 * 根因不是"路径写错了"，而是**共享常量的位置把服务端依赖带进了客户端**。
 * 因此这里放一个**零依赖**的常量模块：客户端与服务端都从它取路径，
 * 于是"两处各写一个字面量"这种漂移也不可能发生。
 *
 * 这个文件**不得** import 任何服务端模块（由 tests/architecture.test.ts 守护）。
 */

/** 课程正文揭示端点。只有 POST 会返回正文。 */
export const REVEAL_ROUTE_PATH = "/api/course/reveal";
