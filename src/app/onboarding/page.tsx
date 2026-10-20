import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { estimateDiagnosticMinutes, getDiagnosticItems } from "@/services/diagnostic";
import { OnboardingForm } from "./onboarding-form";

export const metadata = { title: "开始使用" };
// 读取数据库状态决定表单默认值，必须请求时渲染
export const dynamic = "force-dynamic";

/**
 * Onboarding。
 *
 * 使用者的已知信息（考试日期、目标分、学习时间）已作为默认值填入，
 * 因此这里不是"重新问一遍"，而是"确认或修改"。
 */
export default async function OnboardingPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  const minutes = estimateDiagnosticMinutes();

  return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="reveal">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-content-faint">Setup</p>
        <h1 className="text-[30px] leading-tight font-semibold tracking-tight text-content sm:text-[38px]">
          先确认三件事
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-content-soft">
          这些是计划算法的输入：考试日期决定总节奏，目标分决定努力程度，每日可用时间决定今天排什么。
          <br />
          已经知道的信息已经替你填好了，改掉不对的地方即可。
        </p>
      </header>

      <div className="mt-8">
        <OnboardingForm
          existing={state.profile}
          existingGoal={state.goal}
          diagnosticMinutes={minutes}
          itemCount={getDiagnosticItems().length}
        />
      </div>
    </div>
  );
}
