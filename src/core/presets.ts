import type { AnthropicAuthMode } from './types'

export interface ProviderPreset {
  id: string
  name: string
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
  anthropicAuth: AnthropicAuthMode
  /** Where users create a key. */
  keyUrl?: string
}

// Model IDs are intentionally not hardcoded: they change too often. Pittacus Relay
// fetches the live list from the provider once a key is entered.
export const PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    anthropicAuth: 'both',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    anthropicBaseUrl: 'https://api.moonshot.cn/anthropic',
    openaiBaseUrl: 'https://api.moonshot.cn/v1',
    anthropicAuth: 'both',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    anthropicAuth: 'both',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'qwen',
    name: '阿里云百炼 Qwen',
    anthropicBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    openaiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    anthropicAuth: 'both',
    keyUrl: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    anthropicBaseUrl: 'https://api.minimaxi.com/anthropic',
    openaiBaseUrl: 'https://api.minimaxi.com/v1',
    anthropicAuth: 'both',
    keyUrl: 'https://platform.minimaxi.com/'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    anthropicBaseUrl: 'https://api.anthropic.com',
    anthropicAuth: 'x-api-key',
    keyUrl: 'https://platform.claude.com/'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    openaiBaseUrl: 'https://api.openai.com/v1',
    anthropicAuth: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    openaiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    anthropicAuth: 'bearer',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    anthropicAuth: 'bearer',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'custom',
    name: '自定义',
    anthropicAuth: 'both'
  }
]
