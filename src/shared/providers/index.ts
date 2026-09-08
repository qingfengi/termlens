import type { ChatProvider, ProviderConfig, ProviderProtocol } from '../types/provider'
import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { OpenAICompatibleProvider } from './openai-compatible'

export { ProviderError, extractJson } from './http'
export { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider }

/** 按协议实例化对应适配器（FR-7.1） */
export function createChatProvider(config: ProviderConfig): ChatProvider {
  switch (config.protocol) {
    case 'openai':
      return new OpenAICompatibleProvider(config)
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'gemini':
      return new GeminiProvider(config)
    default: {
      const exhaustive: never = config.protocol
      throw new Error(`未知协议：${String(exhaustive)}`)
    }
  }
}

/** 各协议的默认端点，仅作为新建 Provider 时的初始值，用户可改（C-08） */
export const PROTOCOL_DEFAULTS: Record<
  ProviderProtocol,
  { baseUrl: string; model: string; label: string }
> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    label: 'OpenAI 兼容（含 DeepSeek / Kimi / 通义 / Ollama 等）'
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-latest',
    label: 'Anthropic 原生'
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-1.5-flash',
    label: 'Google Gemini 原生'
  }
}

/** 收集完整流式输出为字符串，便于非流式场景复用同一套适配器 */
export async function collectText(
  provider: ChatProvider,
  req: Parameters<ChatProvider['chat']>[0]
): Promise<string> {
  let out = ''
  for await (const chunk of provider.chat(req)) {
    if (chunk.type === 'delta' && chunk.text) out += chunk.text
    if (chunk.type === 'error') throw new Error(chunk.error ?? '模型调用失败')
  }
  return out
}
