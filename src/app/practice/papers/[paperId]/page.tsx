import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, Clock, Headphones, Info, Lock, Play } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getPaperDetailView } from "@/services/papers";
import { isTrainableReadingSection } from "@/domain/expert-training";
import type { PaperDetail } from "@/content/paper";
import {
  SECTION_QUESTION_COUNTS,
  SECTION_SCORE_WEIGHTS,
  WRITTEN_EXAM_DURATION_MINUTES,
  isPaperReservedForMock,
  isPaperStartableForPractice,
  sectionSkill,
  type PaperSectionType,
} from "@/domain/paper";
import {
  explainStrictMockIneligibility,
  isPaperEligibleForStrictMock,
  describeFreshnessTargets,
} from "@/domain/paper-freshness";
import { SKILL_LABELS } from "@/domain/types";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Notice } from "@/components/ui/states";
import { PACKAGE_STATUS_LABELS } from "@/content/paper";
import { percent } from "@/lib/utils";
import { StrictMockEligibility, PackageStatusBadge, PoolBadge, SourceKindBadge, VerificationBadge } from "../badges";
import { PoolSwitch } from "./pool-switch";

export const dynamic = "force-dynamic";

/**
 * 试卷详情。
 *
 * 这个页面的首要职责是**如实呈现官方结构**，而不是尽快让用户开始刷题。
 * 因此它按官方顺序列出全部 8 个大题（即使当前包是部分内容），
 * 并明确区分三件事：
 * - 内容包里有这一部分（可以进入浏览结构）
 * - 内容包里没有这一部分（如实说缺，不假装）
 * - 执行模式还没实现（"后续阶段"，而不是一个点了没反应的按钮）
 */

const GROUP_LABELS: Record<PaperSectionType, string> = {
  writing: "作文",
  "listening.long_conversation": "长对话",
  "listening.passage": "听力篇章",
  "listening.talk_report_lecture": "讲话 / 报道 / 讲座",
  "reading.banked_cloze": "选词填空",
  "reading.matching": "长篇阅读（匹配）",
  "reading.careful_reading": "仔细阅读",
  translation: "段落翻译",
};

export default async function PaperDetailPage({ params }: { params: Promise<{ paperId: string }> }) {
  const { paperId } = await params;
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const detailView = getPaperDetailView(repos, paperId, state.profile.id);
  if (!detailView) notFound();

  const { detail, freshness } = detailView;
  const { record, content, packageStatus, packageIssue, warnings } = detail;
  const presentTypes = new Set(content?.sections.map((section) => section.type) ?? []);
  /*
   * 训练池策略的**唯一判据**（domain 层纯函数）。
   * 页面不自己写 `pool === "mock_reserve"` —— 那样必然与别处漂移，
   * 而这次缺口的成因正是"同一条规则只有部分入口遵守"。
   */
  const startable = isPaperStartableForPractice(record);
  /*
   * 严格未见模考资格（**唯一判据**，domain 层纯函数）。
   *
   * 它与 `startable` 是**两个不同的问题**，因此刻意不是同一个谓词：
   *   - `startable`：这份卷子的**策略池**允许它作为日常训练开始吗？（使用者的策略）
   *   - `strictMockEligible`：系统还能诚实地说它**完全没见过**吗？（内容事实）
   *
   * 一份保留卷可以同时"不可开始训练"且"已接触过" —— 两个结论并存且都必须可见。
   */
  const strictMockEligible = freshness ? isPaperEligibleForStrictMock(freshness) : null;

  return (
    <div>
      <Link
        href="/practice/papers"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-content-faint transition-colors hover:text-content"
      >
        <ArrowLeft className="size-3.5" />
        返回真题库
      </Link>

      <PageHeader
        eyebrow={`${record.examType} · ${record.year}`}
        title={`${record.year} 年 ${
          record.session === "June" ? "6 月" : record.session === "September" ? "9 月" : "12 月"
        }${record.variant !== "single" ? ` · ${record.variant}` : ""}`}
        lead={
          record.provenance.note ||
          "这份试卷没有记录来源说明 —— 缺少来源说明的内容不应被视为可用的真题。"
        }
        aside={
          <div className="flex flex-wrap items-center gap-1.5">
            <SourceKindBadge kind={record.sourceKind} />
            <VerificationBadge status={record.verificationStatus} />
            <PoolBadge pool={record.pool} />
            <PackageStatusBadge status={packageStatus} />
          </div>
        }
      />

      {/* 内容包异常时，先如实说明，再展示结构 —— 而不是展示一个半成品 */}
      {packageStatus !== "ok" ? (
        <Notice tone={packageStatus === "drifted" ? "warn" : "danger"} className="mt-5" title={PACKAGE_STATUS_LABELS[packageStatus]}>
          <p>{packageIssue ?? "内容包状态异常。"}</p>
          {packageStatus === "drifted" ? (
            <p className="mt-1.5 font-mono text-[12px] text-content-faint">pnpm content:import</p>
          ) : null}
        </Notice>
      ) : null}

      {content === null && packageStatus === "ok" ? (
        <Notice tone="warn" className="mt-5" title="无法解析试卷内容">
          内容包存在但未能解析出结构，因此这里不展示任何题目。这是包的问题，不是页面问题。
        </Notice>
      ) : null}

      {warnings.length > 0 ? (
        <Notice tone="info" className="mt-5" title="内容提醒">
          <ul className="space-y-0.5">
            {warnings.map((warning) => (
              <li key={warning}>· {warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {/*
        ── 严格未见模考的事实陈述（本阶段新增）──

        只在**模考保留**上出现：那份承诺只在这里被作出。

        这段话刻意同时说三件事，缺一不可：
        1. **是什么事实** —— 你在课程中看过这份卷子的哪个部分；
        2. **它不意味着什么** —— 不代表你会做或不会做（那是表现证据的事，
           课程曝光永远不产生表现证据）；
        3. **所以呢** —— 它不再适合作为「严格未见」的模考材料，
           但它仍然按照你的选择留在模考保留。

        池归属**没有**被系统改动 —— 那是 使用者的策略，见下方「备考归属」。
      */}
      {isPaperReservedForMock(record) && freshness && !strictMockEligible ? (
        <Notice
          tone="warn"
          className="mt-5"
          title={freshness.state === "exposed" ? "这不是一份严格未见的模考卷" : "无法确认这份卷子是否仍未接触"}
        >
          <p>{explainStrictMockIneligibility(freshness)}</p>
          {freshness.state === "exposed" ? (
            <p className="mt-1.5 text-[12px] text-content-faint">
              已接触的目标：{describeFreshnessTargets(freshness.matches)}
            </p>
          ) : null}
        </Notice>
      ) : null}

      <PaperMeta detail={detail} />

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight text-content">试卷结构</h2>
          <p className="text-[12px] text-content-faint">
            官方笔试共 {WRITTEN_EXAM_DURATION_MINUTES} 分钟 · 按官方顺序列出
          </p>
        </div>

        <div className="flex flex-col gap-6">
          <StructureBlock
            title="写作"
            types={["writing"]}
            paperId={record.id}
            content={content}
            presentTypes={presentTypes}
            startable={startable}
          />
          <StructureBlock
            title="听力"
            types={["listening.long_conversation", "listening.passage", "listening.talk_report_lecture"]}
            paperId={record.id}
            content={content}
            presentTypes={presentTypes}
            startable={startable}
            accent="listening"
          />
          <StructureBlock
            title="阅读"
            types={["reading.banked_cloze", "reading.matching", "reading.careful_reading"]}
            paperId={record.id}
            content={content}
            presentTypes={presentTypes}
            startable={startable}
          />
          <StructureBlock
            title="翻译"
            types={["translation"]}
            paperId={record.id}
            content={content}
            presentTypes={presentTypes}
            startable={startable}
          />
        </div>
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="text-[15px] font-semibold tracking-tight text-content">备考归属</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-content-soft">
            刻意保留未做过的近年真题作为「模考保留」，后面才能用没见过的卷子做真实模考。
            这是你的策略，系统不会替你判断。
          </p>
          <div className="mt-3">
            <PoolSwitch paperId={record.id} pool={record.pool} />
          </div>

          {/*
            ── 策略与事实必须并排可见（Invariant 3）──

            `pool` 是 使用者的**策略选择**；新鲜度是**内容事实**。两者可以互相矛盾，
            而矛盾必须被如实呈现，不能被系统悄悄消解掉：
            系统**不会**因为"已接触"就把池改成训练池。

            这里刻意放在策略控件的正下方：用户刚做完策略选择，
            紧接着就能看到"这个选择当前意味着什么"。

            ── 三态共用**唯一**呈现组件（实测缺陷修正）──

            这里原先在合格分支里**自己写了一段 pristine 文案**，而
            `FreshnessNotice` 对 pristine 返回 `null` —— 于是 domain 的那句
            **证据范围限定**（"依据是本系统内的课程记录…不代表你在系统之外
            从未见过这份材料"）永远不会被渲染，学习者看到的是一段读起来像
            绝对断言的说法。

            现在三态一律交给 `StrictMockEligibility`：它直接渲染 domain 的
            权威措辞，页面不再自带任何新鲜度文案。层级保持不变
            （小标题 + 一段说明），也没有为合格卷新增徽标。
          */}
          {freshness ? (
            <div className="mt-3 border-t border-edge pt-3">
              <StrictMockEligibility freshness={freshness} />
            </div>
          ) : null}
        </Panel>

        <Panel>
          <h2 className="text-[15px] font-semibold tracking-tight text-content">题目与作答</h2>
          {/*
            ── 这段文案必须跟着池归属变（实测缺陷）──
            它原先无条件说"阅读部分的三个大题现在可以直接作答"。
            但一份被设为模考保留的卷子**不能**开始训练（策略在服务层强制），
            于是这句话在保留卷上就是假的 —— 用户会看到一个说可以、
            却怎么点都进不去的页面。
          */}
          {startable ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-content-soft">
              阅读部分的三个大题<strong className="font-medium text-content">现在可以直接作答</strong> ——
              在真题上作答、交卷、看到确定性的对错结果与正确答案。
            </p>
          ) : (
            <p className="mt-1.5 text-[13px] leading-relaxed text-content-soft">
              这份试卷被设为<strong className="font-medium text-content">模考保留</strong>，
              因此不提供作答训练 —— 刻意留住没做过的真题，后面才能用真正没见过的卷子做模考。
              想现在练它，请先在上方把它移回训练池。
            </p>
          )}
          <ul className="mt-3 space-y-1 text-[12px] text-content-faint">
            <li>· {startable ? "可作答" : "可作答（移回训练池后）"}：选词填空、长篇阅读（匹配）、仔细阅读</li>
            <li>· 仅浏览：听力（需要音频交互）、写作与翻译（需要主观评分）</li>
            <li>· 后续阶段：整卷计时模考、听写与按题精听</li>
          </ul>
        </Panel>
      </section>
    </div>
  );
}

function PaperMeta({ detail }: { detail: PaperDetail }) {
  const { record: paper, assets } = detail;
  const audioCount = assets.filter((asset) => asset.kind === "audio").length;
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);

  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "内容版本", value: <span className="font-mono">v{paper.contentVersion}</span> },
    {
      label: "完整性",
      value: paper.partial ? (
        <span className="text-warn">部分内容（缺少部分大题）</span>
      ) : (
        "完整卷（8 个大题）"
      ),
    },
    { label: "题目总数", value: `${paper.questionCount} 题` },
    {
      label: "媒体资产",
      value:
        assets.length === 0
          ? "无"
          : `${assets.length} 个（音频 ${audioCount}） · ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
    },
    { label: "内容包", value: <span className="font-mono text-[12px]">private-content/cet6/papers/{paper.packagePath}</span> },
    {
      label: "来源引用",
      value: paper.provenance.reference ? (
        <span className="font-mono text-[12px] break-all">{paper.provenance.reference}</span>
      ) : (
        "未记录"
      ),
    },
    {
      label: "核验说明",
      value: paper.provenance.verificationNote ?? <span className="text-content-faint">未记录</span>,
    },
    { label: "导入时间", value: <span className="font-mono text-[12px]">{paper.importedAt}</span> },
  ];

  return (
    <Panel className="mt-6">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-content">
        <Info className="size-4 text-content-faint" />
        来源与版本
      </h2>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 border-b border-edge pb-2 text-[13px]">
            <dt className="shrink-0 text-content-faint">{row.label}</dt>
            <dd className="min-w-0 text-right text-content-soft">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function StructureBlock({
  title,
  types,
  paperId,
  content,
  presentTypes,
  startable,
  accent,
}: {
  title: string;
  types: PaperSectionType[];
  paperId: string;
  content: PaperDetail["content"];
  presentTypes: Set<PaperSectionType>;
  /** 这份试卷当前是否可以作为日常训练材料（池策略）。 */
  startable: boolean;
  accent?: "listening";
}) {
  const sections = (content?.sections ?? []).filter((section) => types.includes(section.type));

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold tracking-tight text-content">
        {accent === "listening" ? <Headphones className="size-4 text-content-faint" /> : null}
        {title}
      </h3>
      <ul className="overflow-hidden rounded-md border border-edge bg-surface-raised">
        {types.map((type) => {
          const section = sections.find((item) => item.type === type);
          const present = presentTypes.has(type);
          const questionCount = section
            ? section.groups.reduce((sum, group) => sum + group.questions.length, 0)
            : 0;

          return (
            <li key={type} className="border-b border-edge px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-[14px] text-content">
                    {GROUP_LABELS[type]}
                    <span className="ml-2 font-mono text-[11px] text-content-faint">
                      官方 {SECTION_QUESTION_COUNTS[type]} 题 · 占卷面 {percent(SECTION_SCORE_WEIGHTS[type])} ·{" "}
                      {SKILL_LABELS[sectionSkill(type)]}
                    </span>
                  </p>
                  {present && section ? (
                    <p className="mt-1 text-[12px] text-content-faint">
                      {section.groups.length} 组 · {questionCount} 题
                      {section.groups.some((group) => group.audioAssetId) ? " · 含音频" : ""}
                    </p>
                  ) : (
                    <p className="mt-1 text-[12px] text-warn">
                      {present ? "内容包里解析不到这一部分" : "这份内容包里没有这一部分"}
                    </p>
                  )}
                </div>

                {present && section ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {/*
                      阅读三题型可直接进入作答训练 —— 但**仅当这份试卷可练**。
                      保留卷结构仍然可见（用户需要知道库里有什么、为什么被保留），
                      只是不给"开始训练"入口，改为显示它为什么现在不能练。
                      "查看结构"对保留卷依然保留：那是浏览，不是消耗材料。
                    */}
                    {isTrainableReadingSection(section.type) ? (
                      startable ? (
                        <Link
                          href={`/practice/papers/${paperId}/train/${section.id}`}
                          className="inline-flex items-center gap-1.5 rounded-sm border border-accent bg-accent-soft px-2.5 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-surface-raised"
                        >
                          <Play className="size-3" />
                          开始训练
                        </Link>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-warn/25 bg-warn-soft px-2.5 py-1.5 text-[12px] font-medium text-warn">
                          <Lock className="size-3" />
                          模考保留
                        </span>
                      )
                    ) : null}
                    <Link
                      href={`/practice/papers/${paperId}/section/${section.id}`}
                      className="inline-flex items-center gap-1.5 rounded-sm border border-edge-strong bg-surface-raised px-2.5 py-1.5 text-[12px] font-medium text-content transition-colors hover:border-content-faint"
                    >
                      查看结构
                      <ArrowRight className="size-3" />
                    </Link>
                  </div>
                ) : (
                  <span className="shrink-0 rounded-sm border border-edge bg-surface-sunken px-2.5 py-1.5 text-[12px] text-content-faint">
                    无内容
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {title === "听力" ? (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-content-faint">
          <Clock className="mt-px size-3.5 shrink-0" />
          听力合计 35% 卷面。可以进入各部分查看结构并播放原始录音；
          听写与按题精听属于后续阶段。
        </p>
      ) : null}
    </div>
  );
}
