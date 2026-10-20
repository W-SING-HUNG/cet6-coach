import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, FileStack, LibraryBig } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { listCourseCompanionViews } from "@/services/course-companion";
import { coursesDirDisplayLabel } from "@/content/paper/paths";
import { PageHeader, Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";

export const metadata = { title: "课程" };
export const dynamic = "force-dynamic";

/**
 * 课程列表（Course Companion 的入口）。
 *
 * ── 与真题库的分工 ──
 *
 * 真题库是"内容库里有哪些卷子、它们来自哪里、可信到什么程度"；
 * 这里是"我买过/导入过哪些课程材料"。
 *
 * 课程层**不是**第二个题库（`content/course/types.ts` 的架构约束）：
 * 因此本页不给任何训练入口，也不显示 canonical 链接状态。
 */
export default async function CoursesPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const views = listCourseCompanionViews(repos, state.profile.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Course Companion"
        title="课程材料"
        lead="你导入的课程材料按包列出。正文不会随页面一起加载 —— 点进具体课程后，每一段都要显式点「看这段」才会读取。"
      />

      {views.length === 0 ? (
        <EmptyState
          icon={<LibraryBig className="size-6" />}
          title="还没有导入任何课程包"
          description={
            <>
              课程内容存放在本机私有目录，需要你自行导入 —— 产品不会生成课程内容来填充这里。
              <span className="mt-2 block font-mono text-[12px] text-content-faint">
                {coursesDirDisplayLabel()}
              </span>
            </>
          }
          action={
            <div className="flex flex-col items-center gap-2">
              <code className="rounded-sm border border-edge bg-surface-sunken px-2 py-1 font-mono text-[12px] text-content-soft">
                pnpm course:validate
              </code>
              <p className="max-w-md text-[12px] leading-relaxed text-content-faint">
                把课程包放进上面的目录后运行校验；确认无误再用 <code>pnpm course:import --commit</code> 写入索引。
                完整包格式见仓库 <code>docs/course-package.md</code>。
              </p>
            </div>
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-md border border-edge bg-surface-raised">
          {views.map((view, index) => (
            <li
              key={view.courseId}
              className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 ${
                index !== views.length - 1 ? "border-b border-edge" : ""
              }`}
            >
              <div className="min-w-0">
                <h2 className="text-[14.5px] font-medium text-content">{view.title}</h2>
                <p className="mt-0.5 text-[12px] text-content-faint">
                  {view.provider}
                  {view.edition ? ` · ${view.edition}` : ""} · v{view.contentVersion} ·{" "}
                  {view.segments.length} 段材料
                </p>
                {/*
                  课程 id 必须可见：它是 `pnpm course:*` 命令的操作对象，
                  而"我导入的是哪一个"只有 id 能唯一回答。用等宽字体 ——
                  它是一个标识符，不是句子。
                */}
                <p className="mt-0.5 font-mono text-[11px] break-all text-content-faint">
                  {view.courseId}
                </p>
                {view.packageTrustworthy ? null : (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-warn">{view.packageIssue}</p>
                )}
              </div>

              <Link
                href={`/practice/courses/${view.courseId}`}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-sm border border-edge-strong bg-surface-raised px-3 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
              >
                打开课程
                <ArrowRight className="size-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Panel className="bg-surface">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-content">
          <FileStack className="size-4 text-content-faint" />
          为什么正文要一段一段点开
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-content-soft">
          课程材料是你购买的付费内容。因此它不会随页面一起下载，只在你明确点开某一段时才读取；
          而每次读取都会被如实记录下来 —— 这既是隐私边界，也让你以后能回看自己看过什么。
        </p>
      </Panel>
    </div>
  );
}
