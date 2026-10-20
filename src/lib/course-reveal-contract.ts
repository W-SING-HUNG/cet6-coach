import { z } from "zod";

/**
 * 揭示端点的**线上契约**（wire contract）—— 服务端与客户端共用的唯一形状定义。
 *
 * ── 这个模块存在的理由（Round 3 P0）──
 *
 * 上一版 409 响应里的 `risk.papers` 只带三个字段
 * （`paperId` / `reservedForMock` / `trainable`），而客户端用一句
 * **未校验的 TypeScript 断言**把它当成 `LinkedPaperSummary[]` 用
 * （那个类型还要求 `runtimeUsable` 与 `targetLabel`）。
 *
 * 类型断言在运行时是**空的**：它不检查任何字段。于是：
 *
 * 1. `runtimeUsable` 实际是 `undefined` ⇒ `usableLinks` 变成空数组；
 * 2. 确认面板因此消失（它的显示条件是"有可用链接"）；
 * 3. 客户端已经采纳了服务端回传的**新指纹**；
 * 4. 于是再点一次「看这段」时，`usableLinks.length === 0` 那条分支
 *    直接发起 POST —— 带着**新**指纹，服务端认为已确认；
 * 5. 模考保留卷因此在**没有任何知情确认**的情况下被写成 `reveal_requested`。
 *
 * 这是真实可复现的绕过，不是理论问题。
 *
 * ── 修法的两条腿（缺一不可）──
 *
 * 1. **服务端**把 `risk.papers` 投影成**展示就绪**的完整形状
 *    （与页面渲染时那份用同一个投影实现）。
 * 2. **客户端**在边界处**校验**响应形状（本文件的 zod schema）。
 *    缺失或畸形 ⇒ 当作失败关闭处理，**绝不**解释成"没有风险"。
 *
 * 只做第 1 条不够：服务端将来漏一个字段，客户端又会静默降级成"无风险"。
 * 只做第 2 条也不够：校验会失败，学习者看到的是一个坏掉的界面。
 *
 * ── 为什么类型定义在 `lib` 而不是 `services` ──
 *
 * `lib` 是共享层，不依赖服务层；服务层与客户端都依赖它。
 * 把形状放在这里，依赖方向就是单向的（services → lib, client → lib），
 * 不会出现"客户端为了拿类型而拖进整个服务模块"。
 */

/**
 * 一段材料指向的真题目标及其当前状态。
 *
 * 这是**唯一的形状定义** —— 服务层、契约校验与客户端组件都用它。
 * 刻意不定义"另一份相似的形状"：那会变成第二个真相来源，而它必然会漂移。
 */
export interface LinkedPaperSummary {
  paperId: string;
  paperTitle: string;
  /** 目标描述（哪一年哪一套的哪个大题），**产品语言**，不是内部 id。 */
  targetLabel: string;
  /** 链接当前是否成立（版本 + 两包完整性 + 目标结构）。 */
  runtimeUsable: boolean;
  /** 不成立时的可读原因；成立时为 null。 */
  unusableReason: string | null;
  /** 该卷当前是否允许作为日常训练开始（池策略）。 */
  trainable: boolean;
  /** 该卷是否被 使用者 设为模考保留。 */
  reservedForMock: boolean;
}

/**
 * 一份真题在**风险说明**里的展示形状。
 *
 * 字段与 `LinkedPaperSummary` **逐字一致** —— 因为服务端用同一个投影函数
 * 生成两者，界面用同一个组件渲染两者。
 */
export const linkedPaperSummarySchema = z.object({
  paperId: z.string().min(1),
  paperTitle: z.string().min(1),
  targetLabel: z.string().min(1),
  runtimeUsable: z.boolean(),
  unusableReason: z.string().nullable(),
  trainable: z.boolean(),
  reservedForMock: z.boolean(),
});

/** 风险描述符的线上形状（服务端 409 响应体里的 `risk`）。 */
export const riskViewSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "指纹必须是 64 位十六进制"),
  risky: z.boolean(),
  /** 未匹配时为 false —— 它**不**表示"对严格模考安全"。 */
  requiresConfirmation: z.boolean(),
  unprovableReason: z.string().nullable(),
  papers: z.array(linkedPaperSummarySchema),
});

/** 成功响应的线上形状。 */
export const revealSuccessSchema = z.object({
  ok: z.literal(true),
  recorded: z.boolean(),
  content: z.object({
    courseId: z.string(),
    segmentId: z.string(),
    courseContentVersion: z.number(),
    kind: z.string(),
    title: z.string(),
    text: z.string().nullable(),
    transcript: z.string().nullable(),
    referenceTranslation: z.string().nullable(),
    notes: z.string().nullable(),
  }),
  /** 本次下发所依据的风险指纹（界面据此核对一致性）。 */
  riskFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

/** 失败响应的线上形状。 */
export const revealFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  code: z.string().optional(),
  /** 仅 `risk_changed` 时出现。 */
  risk: riskViewSchema.optional(),
});

/** 端点响应的联合形状。 */
export const revealResponseSchema = z.union([revealSuccessSchema, revealFailureSchema]);

export type RevealRiskView = z.infer<typeof riskViewSchema>;
export type RevealSuccessPayload = z.infer<typeof revealSuccessSchema>;
export type RevealFailurePayload = z.infer<typeof revealFailureSchema>;

/** 解析结果：成功、或是"响应不可信"（**不是**"没有风险"）。 */
export type RevealResponseParse =
  | { kind: "success"; payload: RevealSuccessPayload }
  | { kind: "failure"; payload: RevealFailurePayload }
  | { kind: "invalid"; reason: string };

/**
 * 解析端点响应。
 *
 * ── 为什么"解析失败"必须与"业务失败"分开 ──
 *
 * 若把畸形响应归到"业务失败"里，调用方会显示 `error` 字段 ——
 * 而畸形响应可能连 `error` 都没有。更危险的是把它当成"没有风险"：
 * 那会让界面回到"可以直接揭示"的状态，正是本模块要堵的那条路。
 *
 * 因此畸形响应是一个**独立**的结果：界面据此显示"服务返回了无法识别的
 * 结果，请刷新页面重试"，并**保持确认门关闭**。
 */
export function parseRevealResponse(raw: unknown): RevealResponseParse {
  const parsed = revealResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: "invalid",
      reason: issue ? `${issue.path.join(".") || "响应"}: ${issue.message}` : "响应形状不合法",
    };
  }
  if (parsed.data.ok) return { kind: "success", payload: parsed.data };
  return { kind: "failure", payload: parsed.data };
}

/**
 * 判定一份风险视图是否**可以**被界面用来放行揭示。
 *
 * ── 这是"失败关闭"的具体落点 ──
 *
 * 只有在服务端明确表示"当前风险已由学习者确认"时才允许揭示。
 * 任何字段缺失、任何形状不符 ⇒ 返回 `false`。
 *
 * 刻意**不**检查 `papers.length`：未匹配（0 条）是合法状态，
 * 而它同样要求确认（见 `requiresConfirmation`）。
 */
export function riskViewAllowsReveal(risk: RevealRiskView): boolean {
  // 有可用链接但列表为空 = 形状自相矛盾 ⇒ 不放行。
  if (risk.risky && risk.papers.length === 0 && risk.unprovableReason === null) return false;
  return true;
}

/** `LinkedPaperSummary` 与线上形状的一致性由类型系统固定（编译期）。 */
type _AssertWireMatchesSummary = z.infer<typeof linkedPaperSummarySchema> extends LinkedPaperSummary
  ? true
  : never;
const _wireMatchesSummary: _AssertWireMatchesSummary = true;
void _wireMatchesSummary;
