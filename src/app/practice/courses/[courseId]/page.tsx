import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, BookOpen } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getCourseCompanionView } from "@/services/course-companion";
import {
  COURSE_SEGMENT_KIND_LABELS,
  type CourseSegmentKind,
} from "@/domain/course";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Notice } from "@/components/ui/states";
import { RevealSegmentButton } from "./reveal-button";

export const dynamic = "force-dynamic";

/**
 * 课程伴随页（Course Companion）—— 课程 → 材料 → 段 的完整层级。
 *
 * ── 这个页面在说什么 ──
 *
 *    "我的课程里有哪些材料，每一段现在是什么状态。"
 *
 * 它刻意**不**在页面加载时把正文渲染出来。正文只经一个 POST 端点
 * 在学习者显式确认后下发 —— 那条边界见 `reveal-button.tsx` 与
 * `src/app/api/course/reveal/route.ts`。
 *
 * ── 三件事必须同时可见（P1 产品范围）──
 *
 * 1. **层级**：段按所属材料分组，保留 manifest 声明的顺序；
 * 2. **来源**：每段给出页码范围，没有锚点时如实说"未登记页码"；
 * 3. **关联**：已核验的 canonical 链接及其当前可用性；目标真题是否可训练、
 *    是否被设为模考保留 —— 后者要在揭示**之前**就明确警告。
 *
 * 课程层不是第二个题库，因此本页不给"开始训练"入口；
 * 它只说明"这段材料对应哪份真题的哪个部分"。
 */
export default async function CourseCompanionPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const view = getCourseCompanionView(repos, state.profile.id, courseId);
  if (!view) notFound();

  const potentialCount = view.segments.filter(
    (segment) => segment.contactState !== "not_contacted",
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/practice/courses"
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-content-faint transition-colors hover:text-content"
      >
        <ArrowLeft className="size-3.5" />
        返回课程
      </Link>

      <PageHeader
        eyebrow={`课程材料 · ${view.provider}${view.edition ? ` · ${view.edition}` : ""}`}
        title={view.title}
        lead={
          view.segments.length > 0
            ? `这份课程共 ${view.segments.length} 段材料，按所属材料分组。` +
              `正文不会随页面一起加载 —— 点「看这段」并确认后才会读取，` +
              `而那次请求会被如实记录下来。`
            : "这份课程当前没有可阅读的段。"
        }
        aside={<span className="font-mono text-[12px] text-content-faint">v{view.contentVersion}</span>}
      />

      {view.packageTrustworthy ? null : (
        <Notice tone="warn" className="mt-5" title="这个课程包当前不可读">
          <p>{view.packageIssue ?? "无法确认课程包与索引一致，因此不提供正文。"}</p>
        </Notice>
      )}

      {view.packageTrustworthy && potentialCount > 0 ? (
        <Notice tone="info" className="mt-5" title="其中几段你此前接触过">
          其中 {potentialCount} 段有你的阅读记录。这不代表你会做或不会做对应的题 ——
          它只说明这些材料对你可能已经不是新的。
        </Notice>
      ) : null}

      {view.segments.length === 0 ? null : (
        <div className="flex flex-col gap-5">
          {view.materials.map((material) => (
            <section key={material.materialId} aria-labelledby={`material-${material.materialId}`}>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2
                  id={`material-${material.materialId}`}
                  className="text-[14px] font-semibold tracking-tight text-content"
                >
                  {material.title}
                </h2>
                <span className="text-[12px] text-content-faint">
                  {material.segments.length} 段
                  {material.representations.length > 0
                    ? ` · ${material.representations.length} 种文件形态`
                    : ""}
                </span>
              </div>

              <ul className="flex flex-col gap-3">
                {material.segments.map((segment) => (
                  <li key={segment.segmentId} data-segment-id={segment.segmentId}>
                    <Panel>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-[14.5px] font-medium text-content">{segment.title}</h3>
                        <span className="text-[12px] text-content-faint">
                          {COURSE_SEGMENT_KIND_LABELS[segment.kind as CourseSegmentKind] ?? segment.kind}
                        </span>
                        <span className="text-[12px] text-content-faint">{segment.anchorLabel}</span>
                      </div>

                      <p className="mt-1.5 text-[12px] text-content-faint">
                        {describeChannels(segment.channels)}
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

                      {/*
                        段级入口（P1-1 已批准路径）。

                        课程页的内联组件是"快速扫一眼"；段级页面提供完整的
                        源位置、关联真题与确认上下文。两者共用同一个 POST
                        端点与同一道服务端风险重确认 —— 不存在第二条正文出口。
                      */}
                      <Link
                        href={`/practice/courses/${view.courseId}/segment/${segment.segmentId}`}
                        className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-content-faint underline-offset-2 transition-colors hover:text-content hover:underline"
                      >
                        单独打开这一段
                      </Link>
                    </Panel>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Panel className="bg-surface">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-content">
          <BookOpen className="size-4 text-content-faint" />
          课程材料与真题的关系
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-content-soft">
          课程材料与历年真题是两类内容。看课程不会被算成「做过真题」；
          真题训练在真题库里进行，两边的事实互不影响。
          若某段课程材料已被人工核验指向某份真题，这里会标出对应关系与它当前是否仍然成立。
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
  return `包含：${labels.join("、")}`;
}
