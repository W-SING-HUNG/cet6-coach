import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Headphones, Music, Play, Quote } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getPaperDetail } from "@/services/papers";
import { isTrainableReadingSection } from "@/domain/expert-training";
import type { PaperGroup, PaperQuestion } from "@/content/paper";
import {
  SECTION_LABELS,
  SECTION_QUESTION_COUNTS,
  SECTION_SCORE_WEIGHTS,
  sectionSkill,
  type PaperSectionType,
} from "@/domain/paper";
import { SKILL_LABELS } from "@/domain/types";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Notice } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { percent } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 大题结构浏览。
 *
 * 为什么需要这个页面（而不是直接进入作答）：
 * 导入的真题是**外部内容**，第一条真实使用者是"核对它到底对不对"。
 * 这个页面就是核对入口：能看清每一组的刺激材料、音频引用、原文、题面、
 * 选项与答案，才能判断这份包值不值得信。
 *
 * 两个刻意的产品决定：
 * 1. 答案默认折叠。这是浏览页，不是答题页 —— 一眼看到答案会毁掉这份卷子的训练价值。
 * 2. 听力音频提供**最简播放器**（整卷录音，可播放/拖动），但不做听写、
 *    按题切分或精听模式 —— 那些属于后续阶段。做一半的训练模式比不做更糟。
 */

const GROUP_NOUN: Record<PaperSectionType, string> = {
  writing: "题目",
  "listening.long_conversation": "长对话",
  "listening.passage": "篇章",
  "listening.talk_report_lecture": "讲座 / 讲话 / 报道",
  "reading.banked_cloze": "文章",
  "reading.matching": "文章",
  "reading.careful_reading": "文章",
  translation: "题目",
};

export default async function PaperSectionPage({
  params,
}: {
  params: Promise<{ paperId: string; sectionId: string }>;
}) {
  const { paperId, sectionId } = await params;
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const detail = getPaperDetail(repos, paperId);
  if (!detail) notFound();

  const section = detail.content?.sections.find((item) => item.id === sectionId) ?? null;
  if (!section) notFound();

  const type = section.type as PaperSectionType;
  const assetsById = new Map(detail.assets.map((asset) => [asset.id, asset]));
  const questionCount = section.groups.reduce((sum, group) => sum + group.questions.length, 0);

  return (
    <div>
      <Link
        href={`/practice/papers/${paperId}`}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-content-faint transition-colors hover:text-content"
      >
        <ArrowLeft className="size-3.5" />
        返回试卷
      </Link>

      <PageHeader
        eyebrow={`${detail.record.year} · ${SECTION_LABELS[type]}`}
        title={SECTION_LABELS[type]}
        lead={`本部分官方题量 ${SECTION_QUESTION_COUNTS[type]} 题，占卷面 ${percent(
          SECTION_SCORE_WEIGHTS[type],
        )}，归属 ${SKILL_LABELS[sectionSkill(type)]} 模块。这份包里有 ${questionCount} 题，分 ${
          section.groups.length
        } 组。`}
      />

      <Notice tone="info" className="mt-5" title="这是结构浏览，不是作答">
        按这部分作答、计时交卷与结果回写属于后续阶段。当前可以核对题面、选项、答案与听力素材是否齐备 ——
        导入的真题在第一次使用前值得先人工确认一遍。
      </Notice>

      {/* 阅读三题型已有可用的作答训练，从这里直接进入 —— 浏览页是核对入口，
          训练页是真正的训练入口，两者职责不同但应当互相可达。 */}
      {isTrainableReadingSection(section.type) ? (
        <Panel className="mt-5 border-accent/30 bg-surface-raised">
          <h2 className="text-[15px] font-semibold tracking-tight text-content">可以直接作答这一部分</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-content-soft">
            阅读三种题型已支持在真题上作答、交卷并看到确定性的对错结果与正确答案。
            本页只用来核对内容是否正确，不显示作答界面。
          </p>
          <div className="mt-3">
            <Link href={`/practice/papers/${paperId}/train/${section.id}`}>
              <Button icon={<Play className="size-3.5" />}>进入作答训练</Button>
            </Link>
          </div>
        </Panel>
      ) : null}

      <div className="mt-7 flex flex-col gap-6">
        {section.groups.map((group, index) => (
          <GroupPanel
            key={group.id}
            group={group}
            index={index}
            noun={GROUP_NOUN[type]}
            paperId={paperId}
            audio={group.audioAssetId ? assetsById.get(group.audioAssetId) ?? null : null}
            missingAudio={Boolean(group.audioAssetId) && !assetsById.has(group.audioAssetId ?? "")}
          />
        ))}
      </div>

      <section className="mt-9">
        <Panel className="bg-surface">
          <h2 className="text-[15px] font-semibold tracking-tight text-content">这一部分怎么练</h2>
          <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-content-soft">
            {type.startsWith("listening.") ? (
              <>
                <li>· 听力考的是音频理解，因此必须用原始录音训练，而不是读原文。</li>
                <li>· 原文（transcript）的用途是做完之后核对没听出来的地方，提前看会毁掉训练效果。</li>
                <li>· 播放器可正常播放整卷录音；听写、按题跳转与精听模式属于后续阶段。</li>
              </>
            ) : type === "reading.matching" ? (
              <>
                <li>· 长篇阅读考的是定位与同义替换，关键在「先看陈述再回原文找」。</li>
                <li>· 一组陈述共享同一篇文章，因此这 10 条不会被拆成互不相关的单题。</li>
              </>
            ) : type === "reading.banked_cloze" ? (
              <>
                <li>· 选词填空的考点是词性与上下文搭配，词库每词至多使用一次。</li>
                <li>· 10 个空共享同一篇文章，拆开就丢掉了考点本身。</li>
              </>
            ) : type === "writing" ? (
              <>
                <li>· 写作是本项目后期唯一需要 AI 批改的部分，本阶段只保存题面与要求。</li>
                <li>· 没有参考范文时它留空，不生成 —— 生成的范文会污染对真实水平的判断。</li>
              </>
            ) : type === "translation" ? (
              <>
                <li>· 翻译为汉译英段落，本阶段只保存原文、说明与（若有）参考译文。</li>
              </>
            ) : (
              <>
                <li>· 仔细阅读每题独立作答，但同组题目共享文章，因此保留分组关系。</li>
              </>
            )}
          </ul>
        </Panel>
      </section>
    </div>
  );
}
function GroupPanel({
  group,
  index,
  noun,
  paperId,
  audio,
  missingAudio,
}: {
  group: PaperGroup;
  index: number;
  noun: string;
  paperId: string;
  audio: { id: string; relativePath: string; mimeType: string; bytes: number } | null;
  missingAudio: boolean;
}) {
  const first = group.questions[0]?.number ?? group.firstNumber;
  const last = group.questions[group.questions.length - 1]?.number ?? first;

  return (
    <Panel>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-semibold tracking-tight text-content">
          第 {index + 1} {noun}
          <span className="ml-2 font-mono text-[11px] font-normal text-content-faint">
            第 {first}–{last} 题 · {group.questions.length} 题
          </span>
        </h2>
        {group.audioAssetId ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-content-faint">
            <Headphones className="size-3.5" />
            {group.audioAssetId}
          </span>
        ) : null}
      </div>

      {group.instructions ? (
        <p className="mt-2 text-[13px] leading-relaxed text-content-soft">{group.instructions}</p>
      ) : null}

      {missingAudio ? (
        <Notice tone="danger" className="mt-3" title="音频引用无法解析">
          这一组声明了音频资产 {group.audioAssetId}，但它不在索引里。内容包可能已被改动。
        </Notice>
      ) : null}

      {audio ? (
        <div className="mt-3 rounded-sm border border-edge bg-surface-sunken px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-content-soft">
            <Music className="size-3.5 shrink-0 text-content-faint" />
            <span className="break-all">{audio.relativePath}</span>
            <span className="text-content-faint">{audio.mimeType}</span>
            <span className="text-content-faint">{(audio.bytes / 1024 / 1024).toFixed(1)} MB</span>
          </div>
          {/* 最小可消费证明：真实音频能被产品读取与播放。
              这不是听力训练模式（那属于后续阶段），只是一个播放器 —— 因此
              preload="none" 不预载几十 MB，也不做进度/分段/听写。 */}
          {paperId ? (
            <audio
              className="mt-2.5 w-full"
              controls
              preload="none"
              src={`/practice/papers/${paperId}/asset/${audio.id}`}
            >
              你的浏览器不支持音频播放。
            </audio>
          ) : null}
        </div>
      ) : null}

      {group.passage ? (
        <div className="mt-4 border-l-2 border-edge-strong pl-4">
          <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] text-content-faint">
            <Quote className="size-3" />
            文章
          </p>
          <div className="whitespace-pre-line text-[13.5px] leading-[1.75] text-content-soft">{group.passage}</div>
        </div>
      ) : null}

      {group.paragraphs ? (
        <div className="mt-4 border-l-2 border-edge-strong pl-4">
          <p className="mb-2 font-mono text-[11px] text-content-faint">段落（{group.paragraphs.length} 段）</p>
          <div className="flex flex-col gap-2">
            {group.paragraphs.map((paragraph) => (
              <div key={paragraph.label} className="flex gap-3">
                <span className="mt-0.5 shrink-0 font-mono text-[12px] font-semibold text-content-faint">
                  {paragraph.label}
                </span>
                <p className="text-[13.5px] leading-[1.7] text-content-soft">{paragraph.text}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {group.wordBank ? (
        <div className="mt-4">
          <p className="mb-1.5 font-mono text-[11px] text-content-faint">词库（{group.wordBank.length} 个）</p>
          <div className="flex flex-wrap gap-1.5">
            {group.wordBank.map((word) => (
              <span
                key={word}
                className="rounded-sm border border-edge bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] text-content-soft"
              >
                {word}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <ol className="mt-4 flex flex-col gap-3">
        {group.questions.map((question) => (
          <QuestionItem key={question.id} question={question} />
        ))}
      </ol>

      {group.transcript ? (
        <details className="mt-4 rounded-sm border border-warn/25 bg-warn-soft px-3.5 py-2.5">
          <summary className="cursor-pointer text-[13px] font-medium text-warn">
            听力原文（建议做完再展开）
          </summary>
          <p className="mt-2 whitespace-pre-line text-[13px] leading-[1.75] text-content-soft">{group.transcript}</p>
        </details>
      ) : null}
    </Panel>
  );
}

function QuestionItem({ question }: { question: PaperQuestion }) {
  const answerText = describeAnswer(question);

  return (
    <li className="border-t border-edge pt-3 first:border-t-0 first:pt-0">
      <p className="flex gap-2.5 text-[13.5px] leading-relaxed text-content">
        <span className="tabular shrink-0 font-mono text-[12px] font-semibold text-content-faint">
          {question.number}
        </span>
        <span className="min-w-0">
          {question.kind === "mcq"
            ? question.stem
            : question.kind === "matching_statement"
              ? question.statement
              : question.kind === "banked_cloze_blank"
                ? `第 ${question.blankId} 空`
                : question.kind === "writing"
                  ? question.prompt
                  : question.sourceText}
        </span>
      </p>

      {question.kind === "mcq" ? (
        <ul className="mt-2 ml-6 flex flex-col gap-1">
          {question.options.map((option) => (
            <li key={option.id} className="flex gap-2 text-[13px] text-content-soft">
              <span className="shrink-0 font-mono text-[12px] text-content-faint">{option.id}</span>
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {question.kind === "writing" ? (
        <div className="mt-2 ml-6 space-y-1 text-[12.5px] text-content-faint">
          {question.instructions ? <p>要求：{question.instructions}</p> : null}
          {question.minWords !== null || question.maxWords !== null ? (
            <p className="font-mono">
              词数：{question.minWords ?? "—"}–{question.maxWords ?? "—"}
            </p>
          ) : null}
          {question.referenceEssay ? (
            <details>
              <summary className="cursor-pointer text-content-soft">参考范文（若有）</summary>
              <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-content-soft">
                {question.referenceEssay}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}

      {question.kind === "translation" ? (
        <div className="mt-2 ml-6 space-y-1 text-[12.5px] text-content-faint">
          {question.instructions ? <p>要求：{question.instructions}</p> : null}
          {question.referenceTranslation ? (
            <details>
              <summary className="cursor-pointer text-content-soft">参考译文</summary>
              <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-content-soft">
                {question.referenceTranslation}
              </p>
            </details>
          ) : (
            <p>这份包里没有参考译文。</p>
          )}
        </div>
      ) : null}

      <details className="mt-2 ml-6">
        <summary className="cursor-pointer text-[12px] text-content-faint hover:text-content-soft">答案与解析</summary>
        <div className="mt-1.5 space-y-1 text-[12.5px] text-content-soft">
          <p className="font-mono">{answerText}</p>
          {question.explanation ? <p className="leading-relaxed">{question.explanation}</p> : null}
        </div>
      </details>
    </li>
  );
}

/** 把不同题型的答案统一描述为一行可读文本。 */
function describeAnswer(question: PaperQuestion): string {
  switch (question.kind) {
    case "mcq":
      return `答案：${question.answer}`;
    case "banked_cloze_blank":
      return `答案：${question.answer}`;
    case "matching_statement":
      return `匹配段落：${question.answerParagraph}`;
    case "writing":
      return "主观题：无标准答案";
    case "translation":
      return "主观题：无标准答案";
  }
}
