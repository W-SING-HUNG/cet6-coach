import { AI_UNAVAILABLE_MESSAGE, type AIGradingProvider, type AIResult } from "./provider";
import { LocalStubGradingProvider } from "./providers/local-stub";

/**
 * Provider 解析。
 *
 * Phase 1 只注册本地 stub。接入真实 LLM 时在这里新增 provider，
 * 领域层代码不需要任何改动 —— 这是本文件存在的全部理由。
 *
 * 真实 provider 的接入点（Phase 2）：
 *   if (process.env.AI_API_KEY) providers.push(new OpenAICompatProvider({ ... }));
 * 届时 domain 层仍然只见到 AIGradingProvider 接口。
 */

let cached: AIGradingProvider | null = null;

export function getGradingProvider(): AIGradingProvider {
  if (cached) return cached;

  const registered: AIGradingProvider[] = [new LocalStubGradingProvider()];

  // 选择第一个可用的 provider；本地 stub 永远可用，因此这里必然有结果。
  cached = registered.find((p) => p.isAvailable()) ?? new LocalStubGradingProvider();
  return cached;
}

/** 是否已经接入真实 AI。UI 用它决定是否显示"AI 未配置"提示。 */
export function isRealAIEnabled(): boolean {
  const provider = getGradingProvider();
  return provider.id !== "local-stub";
}

export function unavailableResult<T>(message = AI_UNAVAILABLE_MESSAGE): AIResult<T> {
  return {
    status: "unavailable",
    source: "none",
    providerId: "none",
    data: null,
    message,
  };
}

export * from "./provider";
