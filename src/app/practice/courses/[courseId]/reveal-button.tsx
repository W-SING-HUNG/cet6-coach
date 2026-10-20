"use client";

import { useState } from "react";
import { Eye, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/states";
import { REVEAL_ROUTE_PATH } from "@/lib/course-reveal-route";
import {
  parseRevealResponse,
  riskViewAllowsReveal,
  type RevealRiskView,
} from "@/lib/course-reveal-contract";
import { sanitizeDisplayText } from "@/lib/display-safety";
import type { LinkedPaperSummary } from "@/services/course-link-projection";
import type { SegmentContactState } from "@/services/course-companion";

/**
 * 课程伴随界面（Course Companion）的揭示控件。
 *
 * ── 它刻意**不**做的事 ──
 *
 * 不在页面加载时取正文、不预取、不做 hover 预载、不用 Server Action。
 * 正文只有一个入口：学习者点「看这段」、看清风险、**显式**确认，
 * 然后走一次 POST。
 *
 * 理由不是风格，而是隐私边界：这段材料是付费课程内容，它只有在
 * 学习者**明确要求看它**的那一刻才应该离开服务层。
 *
 * ── 两件事必须由两个不同的机制保证（Round 3 的核心认识）──
 *
 * | 机制 | 保证什么 |
 * | --- | --- |
 * | 服务端指纹比对 | 确认时的风险状态 == 当前风险状态 |
 * | **本组件的状态机** | 学习者**显式**点过「确认阅读」 |
 *
 * 指纹**不能**承担第二件事：它只证明"两个状态相等"。一个自动重试的
 * 客户端完全可以回传一个正确的指纹而不经过任何人工确认。
 * 因此本组件必须自己维护"这一步是显式确认"。
 *
 * ── Round 3 P0：上一版的绕过（必须记住，否则会改回去）──
 *
 * 上一版的点击处理器里有一条捷径：
 *
 * ```ts
 * if (usableLinks.length === 0) { void reveal(); return; }  // ← 绕过
 * ```
 *
 * 而 409 之后 `usableLinks` **必然**为空：服务端回传的 `risk.papers`
 * 只有三个字段，客户端用一句未校验的类型断言把它当成完整形状，
 * 于是 `runtimeUsable` 是 `undefined`，过滤后数组为空。结果是：
 *
 * 1. 确认面板消失（显示条件也是"有可用链接"）；
 * 2. 客户端已采纳服务端回传的**新**指纹；
 * 3. 再点一次「看这段」⇒ 走上面那条捷径 ⇒ 直接 POST 新指纹；
 * 4. 模考保留卷在**没有任何知情确认**的情况下被写成 `reveal_requested`。
 *
 * 修法有三条腿，缺一不可：
 *
 * 1. 服务端回**展示就绪**的完整风险视图（`papers` 是完整的
 *    `LinkedPaperSummary`，与页面渲染同一个投影）；
 * 2. 客户端在边界**校验**响应形状（`parseRevealResponse`），
 *    畸形 ⇒ 失败关闭，绝不解释成"没有风险"；
 * 3. **点击处理器里没有任何直接 POST 的分支** —— 只有「确认阅读」
 *    能发起请求。这一条由架构门禁固定。
 *
 * ── 状态机 ──
 *
 * | 状态 | 含义 |
 * | --- | --- |
 * | `step = "idle"` | 只显示按钮 |
 * | `step = "confirm"` | 确认面板已打开，等待显式确认 |
 *
 * 另有两个"记忆"：
 *
 * - `riskContext`：面板展示与 POST 使用的**当前**风险（初始来自页面渲染，
 *   409 后换成服务端回传的更新版）；
 * - `confirmedFingerprint`：本次会话里学习者**显式确认过**的指纹。
 *   它与 `riskContext.fingerprint` 相等时才允许跳过面板再次揭示 ——
 *   那是"同一次确认覆盖同一个未变风险"，不是"少确认一次"。
 *   409 会把它清空（**作废旧确认**）。
 *
 * ── 措辞纪律（P0-5）──
 *
 * 「已看过」只用于**已确认**的看过事件（`confirmed_seen`）。
 * 只请求过揭示时显示「请求过阅读」—— 请求不证明读过，
 * 系统不能对一件它不知道的事用确定的语气说话。
 */

/** 服务端返回的一段正文投影（字段与 `CourseSegmentContent` 一致）。 */
interface RevealedContent {
  courseId: string;
  segmentId: string;
  courseContentVersion: number;
  kind: string;
  title: string;
  text: string | null;
  transcript: string | null;
  referenceTranslation: string | null;
  notes: string | null;
}

/** 接触状态的界面措辞（唯一实现）。 */
const CONTACT_LABEL: Record<SegmentContactState, string | null> = {
  not_contacted: null,
  potential_contact: "请求过阅读",
  confirmed_seen: "已看过",
};

export function RevealSegmentButton({
  courseId,
  segmentId,
  courseContentVersion,
  contactState,
  linkedPapers,
  riskFingerprint,
  requiresConfirmation,
}: {
  courseId: string;
  segmentId: string;
  courseContentVersion: number;
  contactState: SegmentContactState;
  linkedPapers: LinkedPaperSummary[];
  /** 页面渲染时的风险指纹；POST 原样回传，由服务端重新比对。 */
  riskFingerprint: string;
  /**
   * 页面渲染时的"是否需要确认"。
   *
   * **未匹配段同样是 `true`** —— 界面据这个契约决定要不要确认步骤，
   * 而不是自己看 `linkedPapers.length`（那正是 P1 缺陷的形态：
   * 未匹配时直接揭示，与质量门禁矛盾）。
   */
  requiresConfirmation: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 网络层失败时给出的可操作原因（与业务失败分开显示）。 */
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [content, setContent] = useState<RevealedContent | null>(null);

  /**
   * 确认步骤是否打开。
   *
   * 刻意**不**在页面加载时就自动打开：面板要由学习者的一次点击带出来，
   * 这样"他看到了警告"与"他点了按钮"是两件可区分的事。
   */
  const [step, setStep] = useState<"idle" | "confirm">("idle");

  /**
   * 当前风险上下文（面板展示 + POST 使用）。
   *
   * 初始来自页面渲染（服务端已投影成完整形状）；409 后换成服务端回传的
   * 更新版 —— **经过校验**才采纳。
   */
  const [riskContext, setRiskContext] = useState<RevealRiskView>({
    fingerprint: riskFingerprint,
    risky: linkedPapers.length > 0,
    requiresConfirmation,
    unprovableReason: null,
    papers: linkedPapers,
  });

  /**
   * 本次会话里学习者**显式确认过**的指纹。
   *
   * `null` = 还没确认过任何风险。409 会把它清空 —— 那是"作废旧确认"
   * 的具体落点。
   */
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);

  /** 风险已变的提示（展示服务端回传的**具体**更新内容）。 */
  const [changeNotice, setChangeNotice] = useState<string | null>(null);

  /**
   * 本次会话内的接触状态。
   *
   * ── 为什么需要它（实测 UX 缺陷）──
   *
   * 徽标来自服务端渲染的初值。学习者点第一次「看这段」并确认之后，
   * 那个徽标**不会**自己出现 —— 它要等一次刷新。于是同一个按钮旁
   * 一会儿有徽标、一会儿没有，取决于刷没刷新。
   *
   * 因此这里在揭示成功后立刻置位。它**不**替代服务端状态
   * （刷新后以服务端为准），只是消除这次不一致。
   */
  const [contact, setContact] = useState(contactState);

  /**
   * 唯一会发起揭示请求的函数。
   *
   * **它只能由「确认阅读」按钮（或"同一次已确认风险"的再次读取）调用。**
   * 架构门禁检查本文件里没有任何其它调用点 —— 上一版的绕过正是
   * "点击处理器直接调它"。
   */
  async function submitReveal(fingerprint: string) {
    setPending(true);
    setError(null);
    setNetworkError(null);
    try {
      const response = await fetch(REVEAL_ROUTE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          courseId,
          segmentId,
          courseContentVersion,
          confirmedRiskFingerprint: fingerprint,
        }),
      });

      /*
       * ── 边界校验（Round 3 P0 第 2 条腿）──
       *
       * 绝不把响应直接断言成某个形状：未校验的类型断言在运行时是空的，
       * 而那正是绕过产生的地方。畸形响应 ⇒ 失败关闭，**不**采纳其中的
       * 任何字段（尤其不采纳指纹）。
       */
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        setError("服务返回了无法解析的内容，因此没有读取正文。请刷新页面后重试。");
        return;
      }

      const parsed = parseRevealResponse(raw);

      if (parsed.kind === "invalid") {
        /*
         * 响应不可信 ⇒ 停在这里。
         *
         * 刻意**不**清空 `confirmedFingerprint`：学习者确实确认过，
         * 问题在服务端响应。但也**不**据此放行任何东西 —— 界面保持
         * 关闭状态，只给一条可操作的提示。
         */
        setError(`服务返回了无法识别的结果，因此没有读取正文（${parsed.reason}）。请刷新页面后重试。`);
        setStep("idle");
        return;
      }

      if (parsed.kind === "failure") {
        const failure = parsed.payload;

        /*
         * 409 = 风险已变。
         *
         * 刻意**不**把它显示成红色错误：那不是"出了错"，而是
         * "前提变了，请重新确认"。把它做成错误会让学习者以为功能坏了，
         * 从而想方设法绕过去 —— 而那正是要避免的。
         */
        if (failure.code === "risk_changed") {
          /*
           * 形状自相矛盾（说"有风险"却没有目标、也没有不可求证原因）
           * ⇒ 不采纳。宁可让学习者刷新，也不能拿一份不完整的风险视图
           * 去获得"确认"。
           */
          if (!failure.risk || !riskViewAllowsReveal(failure.risk)) {
            setError("服务返回的风险说明不完整，因此没有读取正文。请刷新页面后重试。");
            setStep("idle");
            return;
          }

          /*
           * 采纳**经过校验的**更新风险视图，并作废旧确认。
           *
           * 三重效果：
           * 1. 面板展示的是新事实（含具体卷子与目标的名字）；
           * 2. `confirmedFingerprint` 清空 ⇒ 旧确认不再有效；
           * 3. `step` 回到 `"confirm"` ⇒ **必须**再点一次「确认阅读」。
           *    「看这段」与「重新确认」都不会发起请求（见下方处理器）。
           */
          setRiskContext(failure.risk);
          setConfirmedFingerprint(null);
          setChangeNotice(failure.error);
          setStep("confirm");
          return;
        }

        // 其它业务失败（404 等）：如实说明，不猜。
        setError(failure.error);
        setStep("idle");
        return;
      }

      // 成功。
      const payload = parsed.payload;
      setContent(payload.content);
      /*
       * 请求已落库 ⇒ 至少是「请求过阅读」。
       *
       * 刻意**不**直接置成 `confirmed_seen`：服务端记录的是
       * `reveal_requested`（潜在接触），它不等于"确实看过"。
       * 已确认的看过要由内容呈现类事件来产生。
       */
      setContact((current) => (current === "confirmed_seen" ? current : "potential_contact"));
      setConfirmedFingerprint(payload.riskFingerprint);
      setStep("idle");
      setChangeNotice(null);
    } catch {
      /*
       * 网络层失败（P2-C）。
       *
       * 刻意**不**把 `Failed to fetch` 这类浏览器原文抛给学习者：
       * 它既不是中文，也没有告诉他该做什么。这里给一条可操作的中文说明
       * 与一个**可用的重试入口**。
       */
      setNetworkError("和本机服务的连接中断了，因此没有读取正文。请确认服务仍在运行，然后重试。");
      setStep("confirm");
    } finally {
      setPending(false);
    }
  }

  /**
   * 「看这段」/「再看这段」的点击处理器。
   *
   * ── 这里**没有**任何直接 POST 的分支 ──
   *
   * 上一版的绕过就长在这里。现在的规则是唯一的：
   *
   * - 若这个风险在本次会话已被**显式确认**过（指纹相同），
   *   则允许再次读取 —— 那是"同一次确认覆盖同一个未变风险"；
   * - 否则**只打开确认面板**，不发起任何请求。
   */
  function onOpenClick() {
    setError(null);
    setNetworkError(null);
    if (confirmedFingerprint !== null && confirmedFingerprint === riskContext.fingerprint) {
      void submitReveal(riskContext.fingerprint);
      return;
    }
    setStep("confirm");
  }

  if (content) {
    return (
      <div className="mt-3 border-t border-edge pt-3" data-risk-fingerprint={riskContext.fingerprint}>
        <SegmentBody content={content} />
        {/*
          揭示成功后仍然显示徽标与收起入口。

          刻意不在这里早退：正文出现时如果把控件整个换掉，学习者就看不到
          "我刚才那次点击被记录下来了"这个反馈，也失去收起入口。
        */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {CONTACT_LABEL[contact] ? <ContactBadge state={contact} /> : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setContent(null)}
            icon={<Eye className="size-3.5" />}
          >
            收起
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2" data-risk-fingerprint={riskContext.fingerprint}>
      <div className="flex flex-wrap items-center gap-2">
        {CONTACT_LABEL[contact] ? <ContactBadge state={contact} /> : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpenClick}
          disabled={pending}
          loading={pending}
          loadingText="读取中…"
          icon={pending ? undefined : <Eye className="size-3.5" />}
        >
          {contact === "not_contacted" ? "看这段" : "再看这段"}
        </Button>

        {/*
          「重新确认」在风险已变时出现。
          它**只**把面板带回视野（并清掉提示），**不**发起请求 ——
          这一点由架构门禁固定。
        */}
        {step === "idle" && confirmedFingerprint === null && riskContext.requiresConfirmation ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setChangeNotice(null);
              setStep("confirm");
            }}
            icon={<RefreshCw className="size-3.5" />}
          >
            查看风险说明
          </Button>
        ) : null}
      </div>

      {changeNotice ? (
        <Notice tone="warn" className="mt-1" title="风险状态已变化，请重新确认">
          <p>{changeNotice}</p>
        </Notice>
      ) : null}

      {step === "confirm" ? (
        <ConfirmationPanel
          risk={riskContext}
          pending={pending}
          onCancel={() => setStep("idle")}
          /*
           * 唯一发起揭示的入口。
           *
           * 它直接调用 `submitReveal` —— 因为"点这个按钮"就是显式确认
           * 本身。不需要（也不应该）再加一个中间布尔值。
           */
          onConfirm={() => void submitReveal(riskContext.fingerprint)}
        />
      ) : null}

      {networkError ? (
        <Notice tone="danger" className="mt-1" title="没有连上本机服务">
          <p>{networkError}</p>
          {/* 可用的重试入口：重试的是**同一个已确认风险**。 */}
          <div className="mt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submitReveal(riskContext.fingerprint)}
              disabled={pending}
              loading={pending}
              loadingText="重试中…"
            >
              重试
            </Button>
          </div>
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" className="mt-1">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

/** 接触状态徽标（措辞由 `CONTACT_LABEL` 统一决定）。 */
function ContactBadge({ state }: { state: SegmentContactState }) {
  const label = CONTACT_LABEL[state];
  if (label === null) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-edge-strong bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-content-soft">
      <Eye className="size-3" />
      {label}
    </span>
  );
}

/**
 * 揭示前的确认面板。
 *
 * ── 三种情形共用同一个面板 ──
 *
 * 1. **有可用链接**：列出对应哪份真题的哪个部分、那份卷子现在的策略状态；
 * 2. **未匹配**：如实说明"没有已核验的对应关系"（P1）——
 *    并且明确说这**不是**"严格未见安全"的证明；
 * 3. **风险不可求证**：说明为什么无法判断，并要求确认。
 *
 * 三种情形都要求显式确认。这不是过度谨慎："未匹配"恰恰是最需要确认的
 * 情形 —— 页面渲染之后有人新建一条链接，学习者的确认必须重新发生。
 */
function ConfirmationPanel({
  risk,
  pending,
  onCancel,
  onConfirm,
}: {
  risk: RevealRiskView;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const reserved = risk.papers.filter((paper) => paper.reservedForMock);

  return (
    <div
      className="rounded-sm border border-warn/30 bg-warn-soft px-3 py-2.5"
      data-testid="reveal-confirmation"
    >
      <p className="flex items-start gap-2 text-[12.5px] font-medium text-warn">
        <ShieldAlert className="mt-px size-3.5 shrink-0" />
        {risk.unprovableReason !== null
          ? "这段材料的风险当前无法求证"
          : risk.papers.length > 0
            ? "这段课程材料已被核验指向下列真题"
            : "这段材料还没有已核验的对应关系"}
      </p>

      {risk.unprovableReason !== null ? (
        <p className="mt-2 text-[12px] leading-relaxed text-content-soft">
          {/*
            客户端再消毒一次（P2-A 的纵深防御）。
            服务端在进契约前已经消过毒，但"不可求证原因"是**低层错误消息**
            拼出来的字符串，将来新增来源时服务端可能漏掉 —— 而这里
            是它真正显示给人的最后一站。
          */}
          {sanitizeDisplayText(risk.unprovableReason)}
        </p>
      ) : null}

      {risk.papers.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-content-soft">
          {risk.papers.map((paper) => (
            <li key={paper.paperId}>
              · <PaperTargetLine paper={paper} />
              {paper.reservedForMock ? (
                <span className="ml-1 font-medium text-warn">（这份卷子被你设为模考保留）</span>
              ) : paper.trainable ? (
                <span className="ml-1 text-content-faint">（在训练池，可直接练）</span>
              ) : (
                <span className="ml-1 text-content-faint">（当前不可开始训练）</span>
              )}
            </li>
          ))}
        </ul>
      ) : risk.unprovableReason === null ? (
        /*
         * 未匹配的诚实说明（P1）。
         *
         * 关键是第二句：界面上不能有任何暗示"因此它是安全的"。
         * 未匹配只说明**系统还不知道**，不说明这段材料与严格模考无关。
         */
        <p className="mt-2 text-[12px] leading-relaxed text-content-soft">
          系统目前没有找到这段材料与任何真题之间经人工核验的对应关系。
          未匹配是合法状态 —— 但它只是「还不知道」，并不证明这段材料
          与严格未见模考无关。确认后才会读取正文，这次请求也会被记录下来。
        </p>
      ) : null}

      {reserved.length > 0 ? (
        <p className="mt-2 border-t border-warn/20 pt-2 text-[12px] leading-relaxed text-warn">
          阅读这段材料会被记录为一次接触，而它会让上面标出的保留卷不再满足
          「严格未见模考」的前提 —— 未触碰的材料是有限资源，不是可随意消耗的余额。
        </p>
      ) : null}

      {risk.papers.length > 0 && risk.unprovableReason === null ? (
        <p className="mt-2 text-[12px] leading-relaxed text-content-soft">
          确认后才会读取正文，并且这次请求会被记录下来。
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onConfirm} disabled={pending} loading={pending} loadingText="读取中…">
          确认阅读
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          取消
        </Button>
      </div>
    </div>
  );
}

/**
 * 一份真题的**目标说明行**。
 *
 * 导出是为了让 `tests/reveal-target-line.test.tsx` 能直接测它的切分逻辑 ——
 * 刻意从产品文件 import 而不是在测试里复制一份：复制的那份会与产品漂移，
 * 而缺陷恰恰在切分逻辑里（Final P2）。
 *
 * ── 为什么不再直接把 `targetLabel` 当一个字符串渲染 ──
 *
 * `targetLabel` 现在可能包含同一份卷子的**多个**语义目标
 * （Round 3 P1-M：一段材料可以同时对应第 1 组、第 2 组、整个大题）。
 * 服务端用 `；` 把它们拼成一个串，因为线上契约要求它是**一个字段**
 * （客户端要校验它）。
 *
 * 但界面上把三个目标挤在一行里很难读，而在 390px 宽的手机上更糟。
 * 因此这里把它拆开渲染：卷名一行，每个目标一行缩进的子项，
 * 并保留诚实的条数。
 *
 * 拆解只影响**呈现**，不影响契约 —— 校验仍在 `targetLabel` 上做。
 *
 * ── 为什么用 `paperTitle` 当边界，而不是重新切分字符串（Final P2）──
 *
 * 上一版用 `head.indexOf(" · ")` 找"卷名与目标的分界"。但**卷名本身
 * 就可能含 `" · "`**：`2024 年 12 月 · set1` 是标准形态
 * （年份 · 场次 · 套别）。于是：
 *
 * - 卷名被截成 `2024 年 12 月`，**丢掉套别**；
 * - `set1` 被当成第一个目标的一部分；
 * - 极端情况下还会多出一个孤立的 bullet。
 *
 * 学习者看到"我确认的是 2024 年 12 月"—— 而库里有**好几套** 12 月卷子。
 * 这不是排版瑕疵，是**确认范围再次被写错**。
 *
 * 修法不是"换个更聪明的分隔符"（那只是把歧义推到下一个形态），
 * 而是用**已知字段**当边界：`paperTitle` 是契约里独立校验过的字段，
 * 服务端保证 `targetLabel` 以它开头。因此用**长度**切，
 * 完全不依赖分隔符的形状。
 */
export function PaperTargetLine({ paper }: { paper: LinkedPaperSummary }) {
  const label = paper.targetLabel;

  /*
   * ① 单目标：契约串就是「卷名 · 目标」，直接渲染。
   *
   * 判据是"没有计数后缀"，与上一版一致 —— 单目标不加计数是产品约定。
   */
  const countMarker = "（共 ";
  const cut = label.indexOf(countMarker);
  if (cut < 0) {
    return <span>{label}</span>;
  }

  /*
   * ② 多目标：`<paperTitle> · <目标1；目标2；…>（共 N 个目标）`
   *
   * 用 `paperTitle` 的**长度**定位边界，而不是找分隔符 ——
   * 卷名里的 `" · "` 因此完全不影响切分。
   */
  const head = label.slice(0, cut);
  const countText = label
    .slice(cut)
    .replace(/^（共\s*/, "")
    .replace(/\s*个目标）$/, "");

  /*
   * 边界必须**先验证**再切：服务端保证 `targetLabel` 以 `paperTitle` 开头，
   * 但契约只校验"非空字符串"，不校验这个前缀关系。因此若前缀不匹配
   * （服务端将来改了拼装格式），**原样显示整个可读字符串** ——
   * 那比猜一个结构、把卷名切错要好。
   */
  if (!head.startsWith(paper.paperTitle)) {
    return <span>{label}</span>;
  }

  // 跳过卷名与其后的分隔符（` · `），剩下的是目标列表。
  const rest = head.slice(paper.paperTitle.length).replace(/^\s*·\s*/, "");
  const targets = rest.split("；").filter((item) => item.trim() !== "");

  /*
   * ③ 兜底：切出来的目标数为 0（分隔符形态与预期不符）时，
   * 同样原样显示，不渲染一个只有卷名和计数的空壳。
   */
  if (targets.length === 0) {
    return <span>{label}</span>;
  }

  return (
    <span className="flex flex-col gap-0.5">
      {/* 完整卷名（含套别）—— 用 paperTitle 原值，不是从 label 切的。 */}
      <span className="font-medium text-content">{paper.paperTitle}</span>
      <span className="flex flex-col gap-0.5 pl-3">
        {targets.map((target) => (
          <span key={target}>· {target}</span>
        ))}
      </span>
      <span className="pl-3 text-content-faint">共 {countText} 个目标</span>
    </span>
  );
}

/**
 * 揭示出来的正文。
 *
 * 只呈现四个内容通道（主体文本 / 文字稿 / 参考译文 / 讲解）。
 * 标题重复出现是故意的：它把"我现在读的是哪一段"钉在正文上方，
 * 学习者在长列表里翻动时不需要回到上面找。
 */
function SegmentBody({ content }: { content: RevealedContent }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] font-medium text-content-faint">{content.title}</p>

      {content.text ? (
        <p className="whitespace-pre-line text-[13.5px] leading-[1.75] text-content">{content.text}</p>
      ) : null}

      {content.transcript ? (
        <div className="border-l-2 border-edge-strong pl-3">
          <p className="mb-1 text-[12px] font-medium text-content-faint">文字稿</p>
          <p className="whitespace-pre-line text-[13.5px] leading-[1.75] text-content-soft">
            {content.transcript}
          </p>
        </div>
      ) : null}

      {content.referenceTranslation ? (
        <div className="border-l-2 border-edge-strong pl-3">
          <p className="mb-1 text-[12px] font-medium text-content-faint">参考译文</p>
          <p className="whitespace-pre-line text-[13.5px] leading-[1.75] text-content-soft">
            {content.referenceTranslation}
          </p>
        </div>
      ) : null}

      {content.notes ? (
        <div className="border-l-2 border-edge-strong pl-3">
          <p className="mb-1 text-[12px] font-medium text-content-faint">讲解 / 语言点</p>
          <p className="whitespace-pre-line text-[13.5px] leading-[1.75] text-content-soft">
            {content.notes}
          </p>
        </div>
      ) : null}

      {/*
        诚实边界：看过材料 ≠ 会做题。这句限定必须在这里出现，
        否则"看了解析"会被读成"已经掌握了"。
      */}
      <p className="border-t border-edge pt-2 text-[12px] leading-relaxed text-content-faint">
        看过材料不代表会做或不会做对应的题 —— 它只说明刺激材料对你已经不是新的。
      </p>
    </div>
  );
}
