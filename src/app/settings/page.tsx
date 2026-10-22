import { redirect } from "next/navigation";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { isRealAIEnabled, getGradingProvider } from "@/ai";
import { Notice } from "@/components/ui/states";
import { SettingsForms } from "./settings-forms";
import { DEFAULT_ONBOARDING } from "@/services/onboarding";

export const metadata = { title: "设置" };
export const dynamic = "force-dynamic";

/**
 * 设置。
 *
 * ── 宽度 ──
 * 属于 `focused` 外壳（AppShell 判定 /settings 是表单类路由），
 * 因此画布宽度由 `[data-shell="focused"] .app-canvas` 统一给出。
 * 页面里**刻意不再写** `max-w-2xl` —— 两处并存的宽度规则正是"某处忘了改"的来源。
 *
 * 窄宽度在这里是**表单工效**的选择而不是妥协：设置项是短标签 + 短输入，
 * 拉满 1440 只会让标签与输入框之间隔着半米。这是"任务决定宽度"的正面例子。
 */
export default async function SettingsPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const provider = getGradingProvider();
  const realAI = isRealAIEnabled();

  return (
    <div className="flex flex-col gap-7">
      <header className="border-b border-edge pb-5">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content">
          设置
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-content-soft">
          考试目标与常规学习时间会直接影响计划生成。改完立刻生效，不需要重建账号。
        </p>
      </header>

      <SettingsForms profile={state.profile} goal={state.goal} defaults={DEFAULT_ONBOARDING} />

      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-content">AI 批改服务</h2>
        {realAI ? (
          <Notice tone="success" title={`已接入：${provider.id}`}>
            写作与翻译会由真实 AI 服务批改，反馈中会标注为「AI 批改」。
          </Notice>
        ) : (
          <Notice tone="warn" title="未配置 AI 服务">
            当前写作与翻译使用本地规则评分（provider：{provider.id}）。
            它只检查字数、段落结构、衔接词和关键信息点覆盖率，
            <strong className="font-medium text-content">不能评价表达质量、搭配和语体</strong>
            ，也无法解释语义层面的错误原因。
            <span className="mt-1.5 block">
              所有本地评分结果都会明确标注来源，不会冒充 AI 批改。
              接入真实服务只需在 provider 注册表中新增实现，领域层代码不需要改动。
            </span>
          </Notice>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-content">数据与存储</h2>
        <ul className="space-y-3 rounded-md border border-edge bg-surface-raised px-4 py-4 text-[13px] leading-relaxed text-content-soft">
          <li>
            <span className="font-medium text-content">存储位置</span>：本地 SQLite 文件（开发环境为{" "}
            <code className="rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">
              data/cet6.db
            </code>
            ）。所有 onboarding、诊断、计划、作答记录都真实落盘，刷新或重启不会丢失。
          </li>
          <li>
            <span className="font-medium text-content">访问边界</span>：UI 与 domain 层不能直接访问数据库，
            只能通过 repository 接口。这是为了将来迁移到 Supabase/Postgres 时不用改业务代码。
          </li>
          <li>
            <span className="font-medium text-content">云同步</span>：尚未实现。本地优先是刻意的选择 ——
            它让产品在没有账号和网络的情况下也能完整使用。
          </li>
          <li>
            <span className="font-medium text-content">本地开发端口</span>：
            <code className="mx-1 rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">
              pnpm dev
            </code>
            固定使用 <span className="tabular font-mono">3100</span>
            （3000 留给其他项目），且只监听回环。因此开发地址是{" "}
            <code className="rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">
              http://127.0.0.1:3100
            </code>
            。请用这个地址打开：<code className="rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">
              localhost
            </code>
            与它在本机浏览器里是两个不同来源，写操作只接受规范地址。
          </li>
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-content">当前使用范围</h2>
        <ul className="space-y-2 rounded-md border border-edge bg-surface-raised px-4 py-4 text-[13px] leading-relaxed text-content-soft">
          <li>
            · 已实现：真实真题阅读训练（逐题作答、交卷判分、逐题回看）、诊断、能力画像、
            确定性计划生成、翻译与写作反馈、错因记录、复习队列、进度统计
          </li>
          <li>· 未实现：真实听力训练（缺音频素材）、FSRS 自适应调度、云同步、口语</li>
          <li>· 不会实现：没有验证依据的 CET 分数预测</li>
        </ul>
      </section>
    </div>
  );
}
