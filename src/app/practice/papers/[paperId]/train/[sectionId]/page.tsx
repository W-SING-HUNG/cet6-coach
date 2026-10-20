import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Info, Play } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getSectionTrainingState, listReadingTargets } from "@/services/expert-training";
import { getPaperDetail } from "@/services/papers";
import { isPaperStartableForPractice, RESERVED_PAPER_REASON } from "@/domain/paper";
import { Notice } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { startReadingRunAction } from "@/app/practice/papers/train-actions";
import { Reader } from "./reader";

export const dynamic = "force-dynamic";

/**
 * 真实真题阅读训练页。
 *
 * 三条状态、各有明确出路（不允许死胡同）：
 *
 * 1. **还没开始** → 说清这次训练会发生什么，然后给一个真能用的开始按钮。
 * 2. **进行中**     → 交给回答工作区（`Reader`）接管整屏。
 * 3. **已完成**     → 同一套分栏内逐题回看；可重做（会开启新会话）。
 *
 * ── v2 的页面结构变化 ──
 * 这个路由属于 `immersive` 外壳（见 AppShell）：不渲染应用导航，画布不设 max-width。
 * 因此本页**不再包一层返回链接与元数据行** —— 那些信息现在由训练头承担
 * （它同时是唯一的"离开"出口）。两个返回入口和一个顶部元数据条会让工作区
 * 顶部落三层 chrome，而它们对正在做题的人没有价值。
 *
 * 关于"重做"的诚实性：重复练习同一份材料是合法的（它支持保持），
 * 但每次都开启**新的会话**并留下独立事实 —— 不会覆盖上一次的记录。
 */

export default async function TrainPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string; sectionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { paperId, sectionId } = await params;
  const { error } = await searchParams;

  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const detail = getPaperDetail(repos, paperId);
  if (!detail) notFound();

  const profileId = state.profile.id;
  const listed = listReadingTargets(repos, profileId, paperId);
  const target = listed?.targets.find((item) => item.sectionId === sectionId) ?? null;

  // 只读：GET 不创建任何记录（见 expert-training 的 getSectionTrainingState）
  const training = getSectionTrainingState(repos, profileId, paperId, sectionId);

  if (!target) {
    if (training.ok) notFound();
    // 试卷存在、大题存在，但不属于可训练范围（听力/写作/翻译）—— 明确说明，不给死胡同
    if (training.code === "not_trainable") {
      return (
        <FramedScreen>
          <BackLink paperId={paperId} />
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-content sm:text-[26px]">
            这一部分暂不支持作答训练
          </h1>
          <p className="mt-2.5 text-[14px] leading-relaxed text-content-soft">{training.error}</p>
          <div className="mt-5 rounded-md border border-edge bg-surface-raised px-4 py-4">
            <p className="text-[13px] leading-relaxed text-content-soft">
              V1 先交付阅读三种题型的确定性判分训练。写作与翻译需要主观评分，听力需要音频交互 ——
              做一半的训练模式比不做更糟，因此它们保持「浏览结构」，不假装可以作答。
            </p>
            <div className="mt-4">
              <Link href={`/practice/papers/${paperId}`}>
                <Button variant="secondary">返回试卷</Button>
              </Link>
            </div>
          </div>
        </FramedScreen>
      );
    }
    notFound();
  }

  // 会话可用：工作区接管整屏
  if (training.ok) {
    return (
      <div className="min-h-dvh bg-surface">
        {error ? (
          <div className="px-4 pt-4 sm:px-6 lg:px-8">
            <Notice tone="danger" title="无法开始训练">
              {error}
            </Notice>
          </div>
        ) : null}
        <Reader paperId={paperId} sectionId={sectionId} session={training.session} />
      </div>
    );
  }

  /*
   * ── 模考保留：直接输入 URL 也必须被挡住（fail closed）──
   *
   * 服务层已经拒绝创建会话（`startReadingRun` 的池守卫），但**页面不能靠
   * "按钮点了会被拒"** 来表达策略 —— 那会让学习者看到一个说可以开始、
   * 点下去才失败的界面。
   *
   * 因此这里在渲染前就分流：保留态只给"为什么不能练"与恢复路径
   * （回试卷页调整池归属），**不渲染任何开始/继续/再练一次的动作**。
   *
   * 它放在 `training.ok` 之前：保留期间即使库里存在进行中会话，
   * 也不把它交给工作区渲染 —— 那会变成绕过策略的入口。
   * 会话与历史事实留在库里，改回训练池后照常可见（无迁移、无销毁）。
   */
  if (!isPaperStartableForPractice(detail.record)) {
    return (
      <FramedScreen>
        <BackLink paperId={paperId} />
        <p className="text-[12px] font-medium text-content-faint">
          {listed?.paperTitle ?? "真实真题"} · 阅读训练
        </p>
        <h1 className="mt-1.5 text-[22px] leading-tight font-semibold tracking-tight text-content sm:text-[26px]">
          这份试卷当前不能开始训练
        </h1>
        <Notice tone="warn" className="mt-4" title="模考保留">
          {RESERVED_PAPER_REASON}
        </Notice>
        <p className="mt-4 text-[13.5px] leading-relaxed text-content-soft">
          保留它的原因：刻意留住没做过的真题，后面才能用真正没见过的卷子做模考。
          未触碰的材料是有限资源，不是可以随意消耗的余额。
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-edge pt-4">
          <Link href={`/practice/papers/${paperId}`}>
            <Button icon={<ArrowLeft className="size-4" />}>去调整训练池归属</Button>
          </Link>
          <Link
            href={`/practice/papers/${paperId}/section/${sectionId}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-edge-strong px-3.5 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
          >
            查看结构
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </FramedScreen>
    );
  }

  return (
    <FramedScreen>
      <BackLink paperId={paperId} />

      {error ? (
        <Notice tone="danger" className="mb-5" title="无法开始训练">
          {error}
        </Notice>
      ) : null}

      <StartPanel
        paperId={paperId}
        sectionId={sectionId}
        label={target.label}
        questionCount={target.questionCount}
        groupCount={target.groupCount}
        paperTitle={listed!.paperTitle}
        /* 内容版本不一致时也要把原因显示出来 —— 用户需要知道
           为什么上次的未完成训练不能继续，而不是看到一个没有解释的开始屏。 */
        issue={
          training.code === "unavailable" || training.code === "content_changed"
            ? training.error
            : null
        }
      />
    </FramedScreen>
  );
}

/**
 * 沉浸式外壳下仍需要一个**受控的阅读宽度**。
 *
 * 开始屏与说明屏不是任务界面：它的内容是若干段说明文字，
 * 拉满 1440 只会让每行过长、反而更难读。因此这里主动限制宽度 ——
 * 这就是"任务决定宽度"的正面例子：宽画布给作答，窄栏给阅读型表单。
 */
function FramedScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">{children}</div>
    </div>
  );
}

function BackLink({ paperId }: { paperId: string }) {
  return (
    <Link
      href={`/practice/papers/${paperId}`}
      className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-content-soft transition-colors hover:text-content"
    >
      <ArrowLeft className="size-3.5" />
      返回试卷
    </Link>
  );
}

/**
 * 未开始状态。
 *
 * 这一屏的职责是"说清接下来会发生什么"，然后把决定权交给学习者。
 * 四条说明覆盖了他真正需要知道的边界：判分依据、信息封闭、
 * 草稿的真实存活范围、以及重复练习不会覆盖历史。
 */
function StartPanel({
  paperId,
  sectionId,
  label,
  questionCount,
  groupCount,
  paperTitle,
  issue,
}: {
  paperId: string;
  sectionId: string;
  label: string;
  questionCount: number;
  groupCount: number;
  paperTitle: string;
  issue: string | null;
}) {
  return (
    <div>
      <p className="text-[12px] font-medium text-content-faint">
        {paperTitle} · 真实真题阅读训练
      </p>
      <h1 className="mt-1.5 text-[24px] leading-tight font-semibold tracking-tight text-content sm:text-[28px]">
        {label}
      </h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-content-soft">
        用这份真题的这一部分作答。共 {questionCount} 题，分 {groupCount} 组，
        题目与答案都来自真题本身。
      </p>

      {issue ? (
        <Notice tone="warn" className="mt-5" title="内容当前不可用">
          {issue}
        </Notice>
      ) : null}

      <section className="mt-6 rounded-md border border-edge bg-surface-raised px-4 py-4 sm:px-5 sm:py-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-content">
          <BookOpen className="size-4 text-content-faint" />
          这次训练是什么样
        </h2>
        <ul className="mt-3 space-y-2 text-[13.5px] leading-relaxed text-content-soft">
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-content-faint" />
            <span>
              <span className="font-medium text-content">原文与题目并排显示。</span>
              作答时原文始终在视野内，两者各自滚动 —— 不需要为了看一句话往回翻几屏。
            </span>
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-content-faint" />
            <span>
              <span className="font-medium text-content">一次一题，可随时跳转。</span>
              底部的上一题 / 下一题常驻，题号按钮可以打开导航器直接跳到任意一题，
              也能看到哪几题还没答、哪几题被你标记过。
            </span>
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-content-faint" />
            <span>
              <span className="font-medium text-content">交卷之前不会显示答案。</span>
              提前看到答案会让这次训练失去意义。交卷后给出确定性的对错结果与正确答案。
            </span>
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-content-faint" />
            <span>
              <span className="font-medium text-content">每次交卷都留下独立记录。</span>
              重复练习不会覆盖上一次的结果。
            </span>
          </li>
        </ul>

        {/*
          如实说明草稿的存活边界。
          草稿在 sessionStorage：切页面再回来还在，关掉标签页就清空。
          说成"不会丢"是过度声明。
        */}
        <p className="mt-4 flex items-start gap-2 border-t border-edge pt-3 text-[12.5px] leading-relaxed text-content-faint">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            草稿暂存在这个标签页的会话存储里：切到别的页面再回来没问题，
            但关闭标签页或浏览器后草稿会清空。交卷之后结果会真实落库，那时就不再依赖标签页。
            因此一次尽量做完；真做不完就先交卷，未作答的题会被如实记为「未作答」。
          </span>
        </p>

        <div className="mt-5 border-t border-edge pt-4">
          <form action={startReadingRunAction}>
            <input type="hidden" name="paperId" value={paperId} />
            <input type="hidden" name="sectionId" value={sectionId} />
            <Button type="submit" size="lg" icon={<Play className="size-4" />}>
              开始训练
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
