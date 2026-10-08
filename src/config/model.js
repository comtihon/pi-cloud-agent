// agent_config → pi model + auth.
//
//   1. extra.llm_base_url + model → a custom OpenAI-compatible provider
//      (contextWindow / maxTokens from extra when carrier sends them).
//   2. model matching a built-in model id → that model, with the API key set
//      as the provider's runtime key.
//   3. otherwise → anthropic runtime key, pi auto-selects the model.

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 16_384

function positiveInt(...values) {
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return undefined
}

/** contextWindow / maxTokens for a custom model, from extra or defaults. */
export function customModelLimits(extra = {}) {
  return {
    contextWindow: positiveInt(extra.contextWindow, extra.context_window, extra.llm_context_window) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: positiveInt(extra.maxTokens, extra.max_tokens, extra.llm_max_tokens) ?? DEFAULT_MAX_TOKENS,
  }
}

/**
 * @param {object} agentConfig
 * @param {{AuthStorage: any, ModelRegistry: any}} pi  the pi SDK classes
 */
export function resolveModelConfig(agentConfig = {}, { AuthStorage, ModelRegistry }) {
  const { model: modelStr, credentials = {}, extra = {} } = agentConfig || {}
  const keyEnvName = extra?.llm_api_key_env || 'ANTHROPIC_API_KEY'
  const apiKey = credentials?.[keyEnvName]

  const authStorage = AuthStorage.inMemory({})
  const modelRegistry = ModelRegistry.inMemory(authStorage)

  if (extra?.llm_base_url && modelStr) {
    const { contextWindow, maxTokens } = customModelLimits(extra)
    modelRegistry.registerProvider('custom-llm', {
      baseUrl: extra.llm_base_url,
      apiKey: apiKey || '',
      api: 'openai-completions',
      models: [{
        id: modelStr,
        name: modelStr,
        api: 'openai-completions',
        reasoning: false,
        // Text-only unless carrier says the endpoint takes images.
        input: Array.isArray(extra.llm_input) ? extra.llm_input : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
      }],
    })
    const model = modelRegistry.find('custom-llm', modelStr)
    if (model) return { authStorage, modelRegistry, model }
  }

  if (modelStr) {
    const match = modelRegistry.getAll().find((m) => m.id === modelStr)
    if (match) {
      if (apiKey) authStorage.setRuntimeApiKey(match.provider, apiKey)
      return { authStorage, modelRegistry, model: match }
    }
  }

  if (apiKey) authStorage.setRuntimeApiKey('anthropic', apiKey)
  return { authStorage, modelRegistry, model: undefined }
}
