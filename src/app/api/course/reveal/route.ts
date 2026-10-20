import { NextResponse } from "next/server";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { revealCourseSegment } from "@/services/course-exposure";
import { REVEAL_ROUTE_PATH } from "@/lib/course-reveal-route";
import { sanitizeDisplayText } from "@/lib/display-safety";
import {
  explainLocalRejection,
  guardLocalRequest,
  type LocalGuard,
} from "@/lib/loopback-guard";

export const dynamic = "force-dynamic";

/**
 * 课程正文揭示端点（Course Companion 的唯一正文出口）。
 *
 * ── 为什么它是一个 Route Handler，而不是 Server Action ──
 *
 * 实测结论：Server Action 的入参是序列化的 React 调用载荷，`fetch` 打过去
 * 会得到"无法识别的 Server Action"错误。本端点最重要的性质恰恰是
 * **安全负向测试**（缺失/跨站/不同端口 Origin 必须 403）—— 那需要一个
 * 能用 `node:http` 直接打、且能自定义请求头的普通 HTTP 端点。
 *
 * ── 安全边界是**两层**，缺一不可 ──
 *
 * | 层 | 位置 | 判据 |
 * | --- | --- | --- |
 * | 集中边界 | `src/proxy.ts`（全部请求） | Host 是回环 |
 * | 本端点 | 本文件 | Origin **精确同一来源** + 已登录 |
 *
 * 第二层刻意**不复用**第一层的宽松判据：`http://127.0.0.1:3199` 与
 * `http://127.0.0.1:3200` 都是回环，但它们是两个不同的服务。
 * 一个同时跑着多个本地服务的机器上，"都是回环"不等于"是同一个人"。
 *
 * 四条硬约束（每条都有对应测试）：
 *
 * 1. **只有 POST。** GET / HEAD / PUT / PATCH / DELETE 一律 405。
 *    正文与曝光写入都不得由 GET、SSR、RSC 或 prefetch 触发。
 * 2. **可信回环 Origin。** 缺失、无效、null、跨站、**不同端口**一律 403。
 * 3. **先持久化、后返回正文。** 曝光落库失败或包不可求证时，
 *    响应里**没有任何正文字节**。
 * 4. **服务端重新确认风险。** 学习者确认过的风险指纹必须与 POST 时
 *    重新算出的指纹一致，否则 **409** 且不写曝光、不下发正文。
 * 5. **不缓存。** `Cache-Control: no-store` + `nosniff` + `no-referrer`。
 */

/** 端点路径常量（UI 与测试共用，避免两处各写一个字面量）。 */
export { REVEAL_ROUTE_PATH };

/** 不允许的方法集合（显式拒绝比"fall through 到 404"更诚实）。 */
function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "只接受 POST。" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/** 拒绝的响应：**不含任何正文内容**，只说原因。 */
function rejected(reason: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: reason },
    {
      status: 403,
      headers: noStoreHeaders(),
    },
  );
}

/**
 * 响应头（**唯一实现**）。
 *
 * `no-store` 是实测判据，不是照抄源码：私有正文一旦被任何中间层
 * （浏览器磁盘缓存、Service Worker、反向代尔）留住，它就离开了
 * "只发给本机浏览器"的控制范围。
 */
function noStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export async function POST(request: Request): Promise<Response> {
  // ── 守卫 1：Origin 必须**精确同一来源**（协议+主机名+端口）──
  //
  // 与 `src/proxy.ts` 的 Host 守卫是两层：那一层挡 LAN 与 DNS rebinding，
  // 这一层挡"另一个本地服务"与跨站写。两层判据刻意不同（见文件头）。
  const guard: LocalGuard = guardLocalRequest({
    host: request.headers.get("host") ?? undefined,
    origin: request.headers.get("origin") ?? undefined,
  });
  if (!guard.ok) {
    return rejected(explainLocalRejection(guard.reason));
  }

  // ── 守卫 3：必须已登录（单学习者应用；未登录说明请求不是来自正常使用路径）──
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) {
    return NextResponse.json(
      { ok: false, error: "还没有完成初始设置，无法读取课程内容。" },
      { status: 403, headers: noStoreHeaders() },
    );
  }

  // ── 解析请求体（有上限：正文端点不接受任意大的输入）──
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "请求体不是合法 JSON。" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { ok: false, error: "请求体必须是一个对象。" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  const payload = body as {
    courseId?: unknown;
    segmentId?: unknown;
    courseContentVersion?: unknown;
    /**
     * 学习者**确认过的**风险指纹。
     *
     * 它由页面渲染时随段一起下发，POST 原样回传。服务端据此判断
     * "学习者看到的警告"是否仍然描述当前风险（P0-1）。
     */
    confirmedRiskFingerprint?: unknown;
  };

  // 标识必须是字符串，版本必须是整数。**不接受**任何形式的"猜一个默认值" ——
  // 那是把调用方的输入错误变成服务端的猜测。
  if (typeof payload.courseId !== "string" || payload.courseId.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "缺少 courseId。" },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  if (typeof payload.segmentId !== "string" || payload.segmentId.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "缺少 segmentId。" },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  if (
    typeof payload.courseContentVersion !== "number" ||
    !Number.isInteger(payload.courseContentVersion) ||
    payload.courseContentVersion < 1
  ) {
    return NextResponse.json(
      { ok: false, error: "courseContentVersion 必须是正整数。" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  // ── 服务边界：全部判定 + 风险重确认 + 先持久化 + 后取正文 ──
  const result = revealCourseSegment(repos, {
    profileId: state.profile.id,
    courseId: payload.courseId,
    segmentId: payload.segmentId,
    courseContentVersion: payload.courseContentVersion,
    confirmedRiskFingerprint:
      typeof payload.confirmedRiskFingerprint === "string"
        ? payload.confirmedRiskFingerprint
        : undefined,
  });

  if (!result.ok) {
    /*
     * 失败关闭：**响应里没有任何正文字节**。
     *
     * 这是本端点最重要的性质。包漂移、段不存在、版本不匹配、读不到包、
     * 风险状态已变 —— 全部只回可读原因。调用方无从区分"内容不存在"与
     * "内容存在但不给"，而那正是我们想要的：私有正文的下发只有一个充分条件。
     *
     * `risk_changed` 用 **409**：它不是"请求坏了"（4xx 的参数问题），
     * 而是"前提已变，请重新确认"（语义上接近冲突）。响应体带**更新后的**
     * 风险视图，UI 据此重渲染确认面板。
     */
    const status = result.code === "risk_changed" ? 409 : 404;
    return NextResponse.json(
      {
        ok: false,
        /*
         * 在**显示边界**消毒：失败原因可能来自低层 `catch`，而那些消息
         * 常常带磁盘路径（P2-B）。这里统一抹掉。
         */
        error: sanitizeDisplayText(result.error),
        code: result.code,
        risk: result.code === "risk_changed" ? result.risk : undefined,
      },
      { status, headers: noStoreHeaders() },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      recorded: result.recorded,
      content: result.content,
      /**
       * 本次下发所依据的风险指纹（UI 可据此核对与展示的一致性）。
       */
      riskFingerprint: result.risk.fingerprint,
      /*
       * ── 关于 `contentChecksum` / `indexedContentVersion`（P2-A）──
       *
       * 服务层算出这两个值（它需要它们来证明"下发的正文来自被校验的
       * 那一版"），但**响应体刻意不带它们**。
       *
       * 理由是最小暴露面：这两个值标识的是私有内容的**身份**
       * （manifest 校验和 + 内容版本）。客户端不需要它们做任何决定 ——
       * 界面只渲染正文。把它们放进响应，等于让"这份私有内容的指纹"
       * 出现在浏览器内存、开发者工具与任何日志里，而收益为零。
       *
       * 上一轮的服务层文档声称响应包含它们，那与实现不一致；
       * 现在文档与实现对齐：**服务层有、响应体没有**，且写明理由。
       *
       * 需要核对的调用方（测试、CLI）直接在服务层取 —— 那里它们本来就有。
       */
      event: {
        id: result.event.id,
        eventType: result.event.eventType,
        occurredAt: result.event.occurredAt,
        courseContentVersion: result.event.courseContentVersion,
      },
    },
    { status: 200, headers: noStoreHeaders() },
  );
}

/**
 * 其它方法一律 405。
 *
 * 显式为每个方法导出（而不是依赖 Next 的默认行为）：这样"GET 不得
 * 触发正文下发或曝光写入"是一条**写在本文件里**的契约，
 * 而不是"恰好框架也是这样处理的"。
 */
export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function HEAD(): Promise<Response> {
  return methodNotAllowed();
}

export async function PUT(): Promise<Response> {
  return methodNotAllowed();
}

export async function PATCH(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
