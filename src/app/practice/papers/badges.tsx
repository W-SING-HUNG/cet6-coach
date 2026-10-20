import { cn } from "@/lib/utils";
import {
  PAPER_PROGRESS_LABELS,
  PAPER_SOURCE_KIND_LABELS,
  PAPER_VERIFICATION_LABELS,
  isPaperReservedForMock,
  type PaperPool,
  type PaperProgressState,
  type PaperSourceKind,
  type PaperVerificationStatus,
} from "@/domain/paper";
import {
  PAPER_FRESHNESS_LABELS,
  explainPaperFreshness,
  type PaperFreshness,
  type PaperFreshnessState,
} from "@/domain/paper-freshness";
import { PACKAGE_STATUS_LABELS, type PackageStatus } from "@/content/paper";

/**
 * 试卷库的徽标。
 *
 * 一条硬约束：**来源类型必须与核验状态同时可见**。
 * 只有核验状态时，"未核验的示例包"看起来会像"还没核对过的真题" ——
 * 那正是产品内容策略要杜绝的混淆。因此来源徽标不能被省略。
 */

const TONES = {
  neutral: "border-edge bg-surface-sunken text-content-soft",
  accent: "border-accent/25 bg-accent-soft text-accent",
  warn: "border-warn/25 bg-warn-soft text-warn",
  danger: "border-danger/25 bg-danger-soft text-danger",
} as const;

type Tone = keyof typeof TONES;

export function Badge({
  tone = "neutral",
  children,
  title,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] leading-tight tracking-wide",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SourceKindBadge({ kind }: { kind: PaperSourceKind }) {
  const tone: Tone = kind === "real_past_paper" ? "accent" : kind === "test_fixture" ? "danger" : "warn";
  return (
    <Badge tone={tone} title="内容来源类型：真题、示例包与测试夹具必须可以区分">
      {PAPER_SOURCE_KIND_LABELS[kind]}
    </Badge>
  );
}

export function VerificationBadge({ status }: { status: PaperVerificationStatus }) {
  const tone: Tone = status === "verified" ? "accent" : status === "partially_verified" ? "warn" : "neutral";
  return <Badge tone={tone}>{PAPER_VERIFICATION_LABELS[status]}</Badge>;
}

export function PoolBadge({ pool }: { pool: PaperPool }) {
  return isPaperReservedForMock({ pool }) ? (
    <Badge tone="warn" title="刻意保留，留到后期做真实模考">
      模考保留
    </Badge>
  ) : (
    <Badge tone="neutral">训练池</Badge>
  );
}

export function ProgressBadge({ progress }: { progress: PaperProgressState }) {
  const tone: Tone = progress === "reserved_mock" ? "warn" : "neutral";
  return <Badge tone={tone}>{PAPER_PROGRESS_LABELS[progress]}</Badge>;
}

export function PackageStatusBadge({ status }: { status: PackageStatus }) {
  const tone: Tone = status === "ok" ? "neutral" : status === "drifted" ? "warn" : "danger";
  return (
    <Badge tone={tone} title="内容包与数据库索引的一致性">
      {PACKAGE_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * 「严格未见模考资格」的**唯一呈现组件**（三态都覆盖）。
 *
 * ── 为什么必须存在（实测缺陷）──
 *
 * 详情页原先在 `strictMockEligible` 分支里**自己写了一段 pristine 文案**，
 * 而 `FreshnessNotice` 对 pristine 返回 `null`。后果是具体的：
 *
 * - domain 的 `explainPaperFreshness` 里那句**证据范围限定**
 *   （"这个结论的依据是**本系统内**的课程记录与人工核验链接，
 *   它不代表你在系统之外从未见过这份材料"）**永远不会被渲染**；
 * - 学习者看到的是一段页面自己写的、没有这个限定的说法 ——
 *   读起来像是系统在断言"你完全没见过这份材料"，
 *   而那是一句系统**无权作出**的绝对断言。
 *
 * 因此把三态收敛到这一个组件：**合格与不合格走同一份权威措辞**，
 * 页面不再自带任何新鲜度文案。这样"限定被漏掉"在结构上不可能发生 ——
 * 要漏就得同时改掉这个组件里唯一的渲染路径。
 *
 * ── 为什么 pristine 不显示徽标（而不是"不显示说明"）──
 *
 * 徽标是**注意力信号**。`pristine` 是保留卷的**默认预期状态**，
 * 给它一个绿标会让"已接触 / 无法确认"这两条真正的信息淹没在满屏徽标里。
 * 但**说明**必须保留 —— 它是那句证据范围限定唯一的落点。
 * 因此本组件区分两件事：**徽标**（只有异常态才显示）与
 * **说明**（三态都显示）。
 */
export function StrictMockEligibility({ freshness }: { freshness: PaperFreshness }) {
  const eligible = freshness.state === "pristine";

  return (
    <>
      <p className="text-[12px] font-medium text-content-soft">严格未见模考资格</p>
      <p
        className={cn(
          "mt-1 text-[12px] leading-relaxed",
          eligible ? "text-content-faint" : freshness.state === "exposed" ? "text-warn" : "text-content-soft",
        )}
      >
        {/*
          三态都直接渲染 domain 的权威措辞 —— 不做任何页面侧改写，
          也不加前缀标签（前缀会与措辞里的主语重复，且可能引入重复标点）。
        */}
        {explainPaperFreshness(freshness)}
      </p>
    </>
  );
}

/**
 * 模考**新鲜度**徽标。
 *
 * ── 只在"模考保留"上出现（这个限定是产品语义，不是样式选择）──
 *
 * "严格未见模考"这个承诺**只在保留卷上被作出**：训练池的卷子本来就是拿来练的，
 * 练过一次当然就不再"没见过"，那不是问题而是预期。若在训练池卷上也打这个徽标，
 * 它会立刻退化成噪声，而噪声会让真正需要注意的那一条也被忽略。
 *
 * ── 它在说什么 ──
 *
 * 它陈述的是**内容事实**，不是学习表现：
 * "系统是否还能诚实地说这份卷子你完全没见过。"
 * 因此措辞里没有掌握度、分数、弱项，也没有"污染/失效"这类把事实说成缺陷的词。
 *
 * `pristine` 刻意**不给徽标** —— 那是保留卷的**默认预期状态**，
 * 给它一个绿标只会让"已接触/无法确认"这两条真正的信息淹没在满屏徽标里。
 * 合格的卷子由池徽标本身（"模考保留"）如实表达，不需要第二句话说同一件事。
 *
 * 注意：**不给徽标**不等于**不给说明**。pristine 的证据范围限定由
 * `StrictMockEligibility` 渲染（见其说明），两者分工不同。
 */
export function FreshnessBadge({ freshness }: { freshness: PaperFreshness }) {
  if (freshness.state === "pristine") return null;
  return <FreshnessNotice freshness={freshness} as="badge" />;
}

/**
 * 新鲜度的**说明块**（含为什么）。
 *
 * 徽标只有三五个字，无法回答"为什么它不再是严格未见模考" ——
 * 而那是 UX 验收明确要求的一件事。因此列表与详情各自在徽标之外
 * 渲染这块说明，且文案与徽标同源（domain 层唯一措辞）。
 */
export function FreshnessNotice({
  freshness,
  as = "block",
  className,
}: {
  freshness: PaperFreshness;
  as?: "badge" | "block";
  className?: string;
}) {
  if (freshness.state === "pristine") return null;

  const tone = freshness.state === "exposed" ? "warn" : "neutral";

  if (as === "badge") {
    return (
      <Badge tone={tone} title={explainPaperFreshness(freshness)}>
        {PAPER_FRESHNESS_LABELS[freshness.state]}
      </Badge>
    );
  }

  return (
    <p
      className={cn(
        "text-[12px] leading-relaxed",
        freshness.state === "exposed" ? "text-warn" : "text-content-soft",
        className,
      )}
    >
      {PAPER_FRESHNESS_LABELS[freshness.state]}
      {"： "}
      {explainPaperFreshness(freshness)}
    </p>
  );
}

/** 新鲜度状态的说明文案（供页面判断是否需要额外提示时使用）。 */
export function freshnessToneOf(state: PaperFreshnessState): Tone {
  return state === "exposed" ? "warn" : state === "uncertain" ? "neutral" : "accent";
}
