import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, BookOpen, Eye, FileStack } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getCourseCompanionView } from "@/services/course-companion";
import { COURSE_SEGMENT_KIND_LABELS } from "@/domain/course";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Notice } from "@/components/ui/states";
import { RevealSegmentButton } from "../../reveal-button";

export const dynamic = "force-dynamic";

/**
 * 课程段页（Course Companion 的段级入口）。
 *
 * ── 为什么要有这个路由（P1-1）──
 *
 * 已批准的路径是 `/practice/courses/[courseId]/segment/[segmentId]`。
 * 上一轮把揭示做成了课程页里的内联组件，段级导航/确认因此不存在。
 *
 * 本页提供**同一套**揭示能力，但多出三样段级上下文：
 *
 * 1. 这一段在源材料里的位置（页码范围）；
 * 2. 它已核验指向哪些真题、那些真题当前的状态；
 * 3. 揭示前的确认面板（含模考保留的具体警告）。
 *
 * 课程页仍保留内联揭示 —— 那是"快速扫一眼"的路径；本页是
 * "我要认真读这一段"的路径。两者走**同一个** POST 端点与同一道
 * 服务端风险重确认，因此不存在第二条正文出口。
 */
export default async function CourseSegmentPage({
  params,
}: {
  params: Promise<{ courseId: string; segmentId: string }>;
}) {
  const { courseId, segmentId } = await params;
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const view = getCourseCompanionView(repos, state.profile.id, courseId);
  if (!view) notFound();

  const segment = view.segments.find((item) => item.segmentId === segmentId);
  if (!segment) notFound();

  /** 这一段所属的材料分组（用于"返回上一级"的面包屑）。 */
  const material = view.materials.find((group) =>
    group.segments.some((item) => item.segmentId === segmentId),
  );

  return (
    /*
     * 窄阅读栏是**本页自己的排版选择**（长文阅读不宜过宽），
     * 但 gutter 与上下留白由共享画布 `.app-canvas` 统一给出 ——
     * 因此这里不再写 `px-*` / `py-*`，否则网格会与全局 gutter 叠加成双重留白。
     */
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link
        href={`/practice/courses/${courseId}`}
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-content-faint transition-colors hover:text-content"
      >
        <ArrowLeft className="size-3.5" />
        返回{material ? `「${material.title}」` : "课程"}
      </Link>

      <PageHeader
        eyebrow={`${view.title} · ${
          COURSE_SEGMENT_KIND_LABELS[segment.kind as keyof typeof COURSE_SEGMENT_KIND_LABELS] ?? segment.kind
        }`}
        title={segment.title}
        lead={
          segment.anchorLabel === null
            ? "这一段没有登记源页码 —— 这是包作者的声明缺失，不是界面问题。"
            : `位于源材料 ${segment.anchorLabel}。正文不会随页面一起加载，确认后才会读取。`
        }
        aside={<span className="font-mono text-[12px] text-content-faint">v{view.contentVersion}</span>}
      />

      {view.packageTrustworthy ? null : (
        <Notice tone="warn" title="这个课程包当前不可读">
          <p>{view.packageIssue ?? "无法确认课程包与索引一致，因此不提供正文。"}</p>
        </Notice>
      )}

      {/*
        ── 关联真题（P1-1 要求的段级可见性）──

        只列**当前可用**的 verified 链接。每条同时给出：
        · 目标粒度（哪一年哪一套的哪个大题）；
        · 当前策略状态（训练池 / 模考保留）；
        · 不可用时的**可读原因**（而不是一个空列表）。
      */}
      <Panel>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-content">
          <FileStack className="size-4 text-content-faint" />
          这段材料对应的真题
        </h2>

        {segment.linkedPapers.length === 0 ? (
          <p className="mt-2 text-[13px] leading-relaxed text-content-soft">
            目前没有已核验的对应关系指向某份真题。未匹配是合法状态 ——
            它不代表这段材料不是课程材料，只代表还没有人核验它对应哪道题。
          </p>
        ) : (
          <ul className="mt-2.5 flex flex-col gap-2">
            {segment.linkedPapers.map((paper) => (
              <li
                key={paper.paperId}
                className="rounded-sm border border-edge bg-surface-sunken px-3 py-2.5"
              >
                <p className="text-[13px] font-medium text-content">{paper.targetLabel}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-content-soft">
                  {paper.reservedForMock ? (
                    <span className="font-medium text-warn">
                      这份卷子被你设为模考保留 —— 阅读这段材料会被记为一次接触，
                      让它不再满足「严格未见模考」的前提。
                    </span>
                  ) : paper.trainable ? (
                    <>这份卷子在训练池，可以直接练。</>
                  ) : (
                    <>这份卷子当前不可开始训练。</>
                  )}
                </p>
                {paper.trainable ? (
                  <Link
                    href={`/practice/papers/${paper.paperId}`}
                    className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-accent underline-offset-2 hover:underline"
                  >
                    <BookOpen className="size-3.5" />
                    去看这份真题
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/*
        ── 揭示区 ──

        与课程页内联组件是**同一个**组件、同一条 POST、同一道服务端
        风险重确认。段级页面额外把确认面板放在更显眼的位置。
      */}
      <Panel>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-content">
          <Eye className="size-4 text-content-faint" />
          阅读正文
        </h2>
        <p className="mt-1.5 text-[12px] text-content-faint">
          包含：{describeChannels(segment.channels)}
        </p>

        {view.packageTrustworthy ? (
          <RevealSegmentButton
            courseId={segment.courseId}
            segmentId={segment.segmentId}
            courseContentVersion={segment.courseContentVersion}
            contactState={segment.contactState}
            linkedPapers={segment.linkedPapers}
            riskFingerprint={segment.riskFingerprint}
            requiresConfirmation={segment.requiresConfirmation}
          />
        ) : null}
      </Panel>

      <Panel className="bg-surface">
        <h2 className="text-[15px] font-semibold tracking-tight text-content">看过材料不等于会做题</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-content-soft">
          课程材料与历年真题是两类内容。看课程不会被算成「做过真题」，
          也不代表你会做或不会做对应的题 —— 它只说明刺激材料对你已经不是新的。
        </p>
      </Panel>
    </div>
  );
}

/** 把内容通道列表说成人话（不暴露内部字段名）。 */
function describeChannels(
  channels: Array<"text" | "transcript" | "referenceTranslation" | "notes">,
): string {
  if (channels.length === 0) return "这一段没有正文内容。";
  const labels = channels.map((channel) => {
    switch (channel) {
      case "text":
        return "正文";
      case "transcript":
        return "文字稿";
      case "referenceTranslation":
        return "参考译文";
      case "notes":
        return "讲解";
    }
  });
  return labels.join("、");
}
