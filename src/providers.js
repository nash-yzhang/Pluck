'use strict';

(function(global) {
  const CWA_PROVIDER_CONFIG = Object.freeze({
    openai: {
      label: 'OpenAI',
      keyLabel: 'OPENAI API KEY',
      keyPlaceholder: 'sk-...',
      keyHint: 'Key stored in chrome.storage.sync and only sent to api.openai.com.',
      models: ['gpt-4o-mini', 'gpt-5-mini', 'gpt-4o'],
      defaultModel: 'gpt-4o-mini',
      requestType: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/chat/completions',
    },
    deepseek: {
      label: 'DeepSeek',
      keyLabel: 'DEEPSEEK API KEY',
      keyPlaceholder: 'sk-...',
      keyHint: 'Key stored in chrome.storage.sync and only sent to api.deepseek.com.',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
      requestType: 'openai-compatible',
      endpoint: 'https://api.deepseek.com/chat/completions',
    },
    claude: {
      label: 'Claude',
      keyLabel: 'ANTHROPIC API KEY',
      keyPlaceholder: 'sk-ant-...',
      keyHint: 'Key stored in chrome.storage.sync and only sent to api.anthropic.com.',
      models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
      defaultModel: 'claude-3-5-sonnet-latest',
      requestType: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
    },
  });

  function cwaListProviders() {
    return Object.keys(CWA_PROVIDER_CONFIG);
  }

  function cwaGetProviderConfig(provider) {
    return CWA_PROVIDER_CONFIG[provider] || CWA_PROVIDER_CONFIG.openai;
  }

  function cwaGetDefaultProvider() {
    return 'openai';
  }

  function cwaGetDefaultModel(provider) {
    return cwaGetProviderConfig(provider).defaultModel;
  }

  function cwaNormalizeSettings(settings) {
    const input = settings || {};
    const provider = CWA_PROVIDER_CONFIG[input.provider] ? input.provider : cwaGetDefaultProvider();
    const cfg = cwaGetProviderConfig(provider);
    const apiKeys = Object.assign({}, input.apiKeys || {});

    if (!apiKeys.openai && input.apiKey) apiKeys.openai = input.apiKey;

    return {
      provider,
      model: cfg.models.indexOf(input.model) >= 0 ? input.model : cfg.defaultModel,
      apiKeys,
    };
  }

  function cwaGetActiveApiKey(settings) {
    const normalized = cwaNormalizeSettings(settings);
    return normalized.apiKeys[normalized.provider] || '';
  }

  function cwaFormatModelBadge(provider, model) {
    return provider + '/' + model;
  }

  global.CWA_PROVIDER_CONFIG = CWA_PROVIDER_CONFIG;
  global.cwaListProviders = cwaListProviders;
  global.cwaGetProviderConfig = cwaGetProviderConfig;
  global.cwaGetDefaultProvider = cwaGetDefaultProvider;
  global.cwaGetDefaultModel = cwaGetDefaultModel;
  global.cwaNormalizeSettings = cwaNormalizeSettings;
  global.cwaGetActiveApiKey = cwaGetActiveApiKey;
  global.cwaFormatModelBadge = cwaFormatModelBadge;
})(typeof globalThis !== 'undefined' ? globalThis : this);