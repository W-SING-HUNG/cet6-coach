import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, FileStack, LibraryBig } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getPaperLibrary } from "@/services/papers";
import type { PaperSummary } from "@/content/paper";
import { PAPER_POOLS, isPaperReservedForMock, type PaperPool } from "@/domain/paper";
import { PageHeader, Panel } from "@/components/ui/panel";
import { EmptyState, Notice } from "@/components/ui/states";
import { cn } from "@/lib/utils";
import {
  FreshnessBadge,
  FreshnessNotice,
  PackageStatusBadge,
  PoolBadge,
  ProgressBadge,
  SourceKindBadge,
  VerificationBadge,
} from "./badges";
import type { PaperFreshness } from "@/domain/paper-freshness";

export const metadata = { title: "真题" };
export const dynamic = "force-dynamic";

/**
 * 真题库。
 *
 * 与 Practice 的分工：Practice 是"我可以刻意选什么来练"，
 * 这里是"内容库里有哪些卷子、它们来自哪里、可信到什么程度"。
 *
 * ── v2 的结构变化：从卡片堆改为行式清单 ──
 * v1 每份试卷是一张卡片，内部**纵向**塞了 4–5 个徽标、标题、一行元数据、
 * 一行操作。三份卷子就是三张同样形状的卡片，扫视成本很高；
 * 而真正要做的决定只有一个 —— "要不要打开它"。
 *
 * v2 把它压成**一行**：左边是身份（年份/场次/套别）+ 一行紧凑元数据 +
 * 徽标行；右边是一个主操作。因此同一屏能看到全部卷子，
 * 并且能横向比较"哪份是真题、哪份还没核验"。
 *
 * ── 这个页面最重要的性质：诚实的空状态 ──
 * 没有导入真题时显示"没有找到内容包 + 怎么放内容 + 当前实例实际使用的目录"，
 * 而不会为了好看塞一份假卷子进来。
 * 显示的目录必须是**这个实例真实使用的**路径（E2E 会验证它包含 not-created）。
 */

const POOL_FILTERS: Array<{ value: PaperPool | "all"; label: string }> = [
  { value: "all", label: "全部" },
  ...PAPER_POOLS.map((pool) => ({ value: pool, label: pool === "training" ? "训练池" : "模考保留" })),
];

function parsePool(value: string | undefined): PaperPool | "all" {
  if (value === "training" || value === "mock_reserve") return value;
  return "all";
}

export default async function PastPapersPage({
  searchParams,
}: {
  searchParams: Promise<{ pool?: string }>;
}) {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const params = await searchParams;
  const pool = parsePool(params.pool);
  const library = getPaperLibrary(repos, state.profile.id);

  const visible = pool === "all" ? library.summaries : library.summaries.filter((s) => s.record.pool === pool);
  const visibleYears = library.years
    .map((group) => ({ year: group.year, papers: group.papers.filter((p) => visible.includes(p)) }))
    .filter((group) => group.papers.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Past Papers"
        title="真题库"
        lead="真实 CET-6 试卷按年份与场次浏览。内容以规范化试卷包的形式存放在本机私有目录中，由你自行导入与核验 —— 产品不生成模拟题，也不把来源不明的内容标成真题。"
      />

      {library.counts.total === 0 ? (
        <EmptyState
          icon={<LibraryBig className="size-6" />}
          title="还没有导入任何试卷"
          description={
            <>
              私有的真题内容不随代码分发，因此这个库默认是空的 —— 这是真实状态，不是功能缺失。
              <span className="mt-2 block font-mono text-[12px] text-content-faint">
                {library.papersDirLabel}
              </span>
            </>
          }
          action={
            <div className="flex flex-col items-center gap-2">
              <code className="rounded-sm border border-edge bg-surface-sunken px-2 py-1 font-mono text-[12px] text-content-soft">
                pnpm content:validate
              </code>
              <p className="max-w-md text-[12px] leading-relaxed text-content-faint">
                把试卷包放进上面的目录后运行校验；确认无误再用 <code>pnpm content:import</code> 写入索引。
                完整包格式见仓库 <code>docs/past-paper-package.md</code>。
              </p>
            </div>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {POOL_FILTERS.map((filter) => {
              const count =
                filter.value === "all"
                  ? library.counts.total
                  : filter.value === "training"
                    ? library.counts.training
                    : library.counts.mockReserve;
              const active = pool === filter.value;
              return (
                <Link
                  key={filter.value}
                  href={filter.value === "all" ? "/practice/papers" : `/practice/papers?pool=${filter.value}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[13px] transition-colors",
                    active
                      ? "border-accent/35 bg-accent-soft text-accent"
                      : "border-edge bg-surface-raised text-content-soft hover:border-content-faint hover:text-content",
                  )}
                >
                  {filter.label}
                  <span className="tabular font-mono text-[11px] opacity-70">{count}</span>
                </Link>
              );
            })}
            <span className="ml-auto text-[12px] text-content-faint">
              共 {library.counts.total} 份 · 真题 {library.counts.realPapers} 份
            </span>
          </div>

          {library.counts.drifted > 0 || library.counts.unavailable > 0 ? (
            <Notice tone="warn" title="内容包状态需要处理">
              {library.counts.drifted > 0
                ? `有 ${library.counts.drifted} 份试卷的内容包已被改动，索引与磁盘不一致：重新运行 pnpm content:import 可刷新索引。`
                : null}
              {library.counts.unavailable > 0
                ? `${library.counts.drifted > 0 ? " " : ""}有 ${library.counts.unavailable} 份试卷的内容包缺失或校验失败，暂时无法进入。`
                : null}
            </Notice>
          ) : null}

          {/*
            ── 保留卷的新鲜度汇总（本阶段新增的那条事实）──

            "模考保留"承诺的是"留一份**没见过**的卷子做严格模考"。
            若其中若干份已经在课程中接触过（或无法确认是否接触过），
            那个承诺就不再成立 —— 而用户不会自己发现这件事，
            因为卷子在库里看起来一切正常。因此在这里主动说明。
          */}
          {library.freshnessCounts.exposed > 0 || library.freshnessCounts.uncertain > 0 ? (
            <Notice tone="warn" title="有模考保留的试卷已不再是严格未见">
              {library.freshnessCounts.exposed > 0
                ? `有 ${library.freshnessCounts.exposed} 份保留卷的内容已通过课程材料接触过。`
                : null}
              {library.freshnessCounts.uncertain > 0
                ? `${library.freshnessCounts.exposed > 0 ? " " : ""}` +
                  `另有 ${library.freshnessCounts.uncertain} 份无法确认是否仍未接触。`
                : null}
              {" "}
              这不代表你已经会做或不会做这些题 —— 它只说明这些材料已经不再是新的。
              它们仍然可以按你的选择留在模考保留，但请不要再把它们当作「从未见过」的严格模考。
              具体是哪几份见下方标注。
            </Notice>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState
              title="这个筛选条件下没有试卷"
              description="换一个筛选条件，或者把更多试卷留在训练池里。"
              action={
                <Link
                  href="/practice/papers"
                  className="text-[13px] text-accent underline-offset-2 hover:underline"
                >
                  查看全部
                </Link>
              }
            />
          ) : (
            /*
              宽画布下的两列布局：年份分组各占一列（lg 以上）。
              1440 下这样能在一屏看到 4–6 份卷子，而不是两份。
            */
            <div className="grid gap-x-6 gap-y-7 lg:grid-cols-2">
              {visibleYears.map((group) => (
                <section key={group.year}>
                  <h2 className="mb-2.5 flex items-baseline gap-2 text-[15px] font-semibold tracking-tight text-content">
                    {group.year} 年
                    <span className="tabular font-mono text-[11px] font-normal text-content-faint">
                      {group.papers.length} 份
                    </span>
                  </h2>
                  <ul className="overflow-hidden rounded-md border border-edge bg-surface-raised">
                    {group.papers.map((summary, index) => (
                      <PaperRow
                        key={summary.record.id}
                        summary={summary}
                        freshness={library.freshness?.get(summary.record.id) ?? null}
                        last={index === group.papers.length - 1}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <section>
        <Panel className="bg-surface">
          <h2 className="text-[15px] font-semibold tracking-tight text-content">内容策略说明</h2>
          <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] leading-relaxed text-content-soft lg:grid-cols-2">
            <li>· 训练内容优先使用真实历年真题，不使用 AI 生成的模拟题冒充真题。</li>
            <li>· 每份试卷都记录来源、核验状态与内容版本；未核验的内容会明确标注为未核验。</li>
            <li>· 真题内容与音频不随代码仓库分发，只存在于本机私有目录。</li>
            <li>· 建议刻意保留最近几套未做过的真题为「模考保留」，留到后期做真实模考。</li>
          </ul>
        </Panel>
      </section>
    </div>
  );
}

/**
 * 一行一份试卷。
 *
 * 信息分层：身份（年份场次）最重 → 版本与题量次之 → 徽标再次之。
 * 徽标保留全部四种（来源类型、核验状态、备考归属、进度），
 * 因为"内容策略门禁"要求**来源类型与核验状态同时可见** ——
 * 只有核验状态时，"未核验的示例包"会看起来像"还没核对过的真题"。
 *
 * ── 模考新鲜度只加在保留卷上（Invariant 3）──
 *
 * 一份被标为 `mock_reserve` 的试卷**可能**已经在课程中接触过其中内容。
 * 这个矛盾必须被如实呈现：池归属徽标照旧（那是 使用者的策略选择），
 * 旁边再加一条事实（内容是否还新鲜）。系统**不会**因为曝光就把池改掉 ——
 * 那会把"策略"和"事实"两件事悄悄合并成一件。
 */
function PaperRow({
  summary,
  freshness,
  last,
}: {
  summary: PaperSummary;
  freshness: PaperFreshness | null;
  last: boolean;
}) {
  const { record, packageStatus, packageIssue, progress } = summary;
  const readable = packageStatus === "ok" || packageStatus === "drifted";
  /*
   * 只在**模考保留**上呈现新鲜度。
   *
   * 训练池的卷子被接触是正常且预期的 —— 在那里提醒"你见过这部分"只会制造噪声，
   * 而噪声会让保留卷上真正需要注意的那一条也被忽略。
   */
  const showFreshness = isPaperReservedForMock(record) && freshness !== null;

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3",
        !last && "border-b border-edge",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="text-[14.5px] font-medium text-content">
            {record.year} 年
            {record.session === "June" ? " 6 月" : record.session === "September" ? " 9 月" : " 12 月"}
            {record.variant !== "single" ? ` · ${record.variant}` : ""}
          </h3>
          <span className="tabular font-mono text-[11px] text-content-faint">
            v{record.contentVersion} · {record.sectionCount} 个大题 · {record.questionCount} 题
          </span>
          {record.partial ? <span className="text-[11px] font-medium text-warn">部分内容</span> : null}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <SourceKindBadge kind={record.sourceKind} />
          <VerificationBadge status={record.verificationStatus} />
          <PoolBadge pool={record.pool} />
          <ProgressBadge progress={progress} />
          {showFreshness ? <FreshnessBadge freshness={freshness} /> : null}
          {packageStatus !== "ok" ? <PackageStatusBadge status={packageStatus} /> : null}
        </div>

        {packageIssue ? (
          <p className="mt-1.5 text-[12px] leading-relaxed text-warn">{packageIssue}</p>
        ) : null}

        {/*
          徽标只有三五个字，回答不了"为什么它不再是严格未见模考"。
          这块说明与徽标同源（domain 的唯一措辞），因此两处不会说两套话。
        */}
        {showFreshness && freshness.state !== "pristine" ? (
          <FreshnessNotice freshness={freshness} className="mt-1.5" />
        ) : null}
      </div>

      <div className="shrink-0">
        {readable ? (
          <Link
            href={`/practice/papers/${record.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-edge-strong bg-surface-raised px-3 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
          >
            打开试卷
            <ArrowRight className="size-3.5" />
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-danger/25 bg-danger-soft px-3 text-[12px] text-danger">
            <FileStack className="size-3.5" />
            内容不可读
          </span>
        )}
      </div>
    </li>
  );
}
