const axios = require('axios');

class BaseAdapter {
  constructor(config) {
    this.config = config;
  }

  async request(req, logger) {
    throw new Error('Method not implemented');
  }

  parseResponse(response) {
    throw new Error('Method not implemented');
  }

  buildError(error, provider) {
    const status = error.response?.status;
    const data = error.response?.data;
    
    let message = 'Request to provider failed';
    let code = 'provider_error';

    if (data?.error?.message) {
      message = data.error.message;
    } else if (data?.message) {
      message = data.message;
    } else if (error.message) {
      message = error.message;
    }

    if (status === 401) {
      code = 'invalid_api_key';
      message = 'Invalid API key for provider';
    } else if (status === 429) {
      code = 'rate_limit_error';
      message = 'Provider rate limit exceeded';
    } else if (status >= 500) {
      code = 'provider_server_error';
    } else if (status >= 400) {
      code = 'invalid_request_error';
    }

    return {
      provider,
      status,
      message,
      code,
      raw: data
    };
  }
}

class OpenAIAdapter extends BaseAdapter {
  async request(req) {
    const { model, messages, temperature, max_tokens, stream, ...rest } = req;
    
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`
    };

    const body = {
      model: req.upstreamModelName,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
      stream: stream ?? false,
      ...rest
    };

    const response = await axios.post(url, body, {
      headers,
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    return response;
  }

  parseResponse(response, isStream = false) {
    if (isStream) {
      return response;
    }

    const data = response.data;
    return {
      id: data.id,
      object: 'chat.completion',
      created: data.created,
      model: data.model,
      choices: data.choices,
      usage: data.usage,
      provider: 'openai'
    };
  }
}

class AnthropicAdapter extends BaseAdapter {
  async request(req) {
    const { model, messages, temperature, max_tokens, stream } = req;
    
    const url = `${this.config.baseUrl}/messages`;
    
    const systemMessage = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');
    
    const body = {
      model: req.upstreamModelName,
      messages: userMessages,
      system: systemMessage?.content,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
      stream: stream ?? false
    };

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01'
    };

    const response = await axios.post(url, body, {
      headers,
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    return response;
  }

  parseResponse(response, isStream = false) {
    if (isStream) {
      return response;
    }

    const data = response.data;
    
    let content = '';
    if (data.content && Array.isArray(data.content)) {
      content = data.content.map(c => c.text || '').join('');
    }

    return {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(data.created_at / 1000),
      model: data.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: data.stop_reason
      }],
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens
      },
      provider: 'anthropic'
    };
  }
}

class GoogleAdapter extends BaseAdapter {
  async request(req) {
    const { model, messages, temperature, max_tokens, stream } = req;
    
    const url = `${this.config.baseUrl}/models/${req.upstreamModelName}:generateContent?key=${this.config.apiKey}`;
    
    const lastMessage = messages[messages.length - 1];
    const contents = [{
      role: lastMessage.role === 'user' ? 'user' : 'model',
      parts: [{ text: lastMessage.content }]
    }];

    const body = {
      contents,
      generationConfig: {
        temperature: temperature ?? 0.7,
        maxOutputTokens: max_tokens ?? 2048,
        stream
      }
    };

    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    return response;
  }

  parseResponse(response, isStream = false) {
    if (isStream) {
      return response;
    }

    const data = response.data;
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return {
      id: `google-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.upstreamModelName,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: data.candidates?.[0]?.finishReason
      }],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata?.totalTokenCount || 0
      },
      provider: 'google'
    };
  }
}

class DeepSeekAdapter extends BaseAdapter {
  async request(req) {
    const { model, messages, temperature, max_tokens, stream, ...rest } = req;
    
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`
    };

    const body = {
      model: req.upstreamModelName,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
      stream: stream ?? false,
      ...rest
    };

    const response = await axios.post(url, body, {
      headers,
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    return response;
  }

  parseResponse(response, isStream = false) {
    if (isStream) {
      return response;
    }

    const data = response.data;
    return {
      id: data.id,
      object: 'chat.completion',
      created: data.created,
      model: data.model,
      choices: data.choices,
      usage: data.usage,
      provider: 'deepseek'
    };
  }
}

class ProviderAdapterFactory {
  static create(providerName, config) {
    switch (providerName) {
      case 'openai':
        return new OpenAIAdapter(config);
      case 'anthropic':
        return new AnthropicAdapter(config);
      case 'google':
        return new GoogleAdapter(config);
      case 'deepseek':
        return new DeepSeekAdapter(config);
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }
}

module.exports = {
  BaseAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  DeepSeekAdapter,
  ProviderAdapterFactory
};
