const db = require('../models/db');
const config = require('../config');
const { ProviderAdapterFactory } = require('./providerAdapter');
const NodeCache = require('node-cache');

const modelCache = new NodeCache({ stdTTL: 300 });
const providerHealthCache = new NodeCache({ stdTTL: 60 });

const ROUTING_STRATEGY = {
  PRICE: 'price',
  LATENCY: 'latency',
  PRIORITY: 'priority',
  FAILOVER: 'failover'
};

async function getModelByName(modelName) {
  const cacheKey = `model:${modelName}`;
  let model = modelCache.get(cacheKey);
  
  if (!model) {
    const result = await db.query(`
      SELECT 
        m.id, m.model_name, m.upstream_model_name, m.input_price_per_1k_tokens, 
        m.output_price_per_1k_tokens, m.enabled,
        p.id as provider_id, p.name as provider_name, p.base_url, p.auth_type, p.api_key, p.enabled as provider_enabled
      FROM models m
      JOIN providers p ON m.provider_id = p.id
      WHERE m.model_name = $1 AND m.enabled = true AND p.enabled = true
    `, [modelName]);
    
    if (result.rows.length > 0) {
      model = result.rows[0];
      modelCache.set(cacheKey, model);
    }
  }
  
  return model;
}

async function getAvailableProvidersForModel(modelName) {
  const cacheKey = `providers:${modelName}`;
  let providers = modelCache.get(cacheKey);
  
  if (!providers) {
    const result = await db.query(`
      SELECT 
        p.id, p.name, p.base_url, p.auth_type, p.api_key, p.priority,
        ph.success_rate, ph.avg_latency_ms
      FROM models m
      JOIN providers p ON m.provider_id = p.id
      LEFT JOIN provider_health ph ON p.id = ph.provider_id
      WHERE m.model_name = $1 AND m.enabled = true AND p.enabled = true
      ORDER BY p.priority DESC
    `, [modelName]);
    
    providers = result.rows;
    modelCache.set(cacheKey, providers, 60);
  }
  
  return providers;
}

async function getProviderHealth(providerId) {
  const health = providerHealthCache.get(`health:${providerId}`);
  if (health) return health;

  const result = await db.query(`
    SELECT success_rate, avg_latency_ms, error_count, request_count
    FROM provider_health
    WHERE provider_id = $1
  `, [providerId]);

  return result.rows[0] || { success_rate: 100, avg_latency_ms: 0, error_count: 0 };
}

function scoreProvider(provider, strategy) {
  let score = 0;
  
  switch (strategy) {
    case ROUTING_STRATEGY.PRICE:
      score = -(provider.priority || 0);
      break;
    case ROUTING_STRATEGY.LATENCY:
      score = provider.avg_latency_ms || 1000;
      break;
    case ROUTING_STRATEGY.PRIORITY:
    default:
      score = -(provider.priority || 0);
  }

  const health = provider;
  if (health.success_rate < 90) {
    score += 10000;
  }
  
  return score;
}

async function selectProvider(providers, strategy = ROUTING_STRATEGY.PRIORITY) {
  if (!providers || providers.length === 0) {
    return null;
  }

  const availableProviders = providers.filter(p => {
    const health = p;
    return health.success_rate >= 50 || !health.success_rate;
  });

  if (availableProviders.length === 0) {
    return providers[0];
  }

  availableProviders.sort((a, b) => scoreProvider(a, strategy) - scoreProvider(b, strategy));
  
  return availableProviders[0];
}

async function routeRequest(req, strategy = ROUTING_STRATEGY.PRIORITY) {
  const { model: modelName } = req;
  
  const model = await getModelByName(modelName);
  if (!model) {
    throw {
      status: 404,
      message: `Model not found: ${modelName}`,
      code: 'model_not_found'
    };
  }

  const providers = await getAvailableProvidersForModel(modelName);
  const selectedProvider = await selectProvider(providers, strategy);

  if (!selectedProvider) {
    throw {
      status: 503,
      message: 'No available provider for this model',
      code: 'no_provider_available'
    };
  }

  return {
    model,
    provider: selectedProvider
  };
}

async function executeWithFailover(req, maxRetries = 2) {
  const { model: modelName, ...rest } = req;
  let lastError = null;
  
  console.log('=== Router received model:', modelName);
  
  if (modelName === 'AIII-Tech' || modelName === 'AIII-Fast') {
    console.log('=== Routing to LM Studio with model:', modelName, 'stream:', rest.stream);
    
    const modelId = modelName === 'AIII-Fast' ? 12 : 13;
    const providerId = 5;
    const lmStudioUrl = 'http://100.86.67.125:1234/v1/chat/completions';
    
    return new Promise((resolve, reject) => {
      const http = require('http');
      const url = new URL(lmStudioUrl);
      
      const postData = JSON.stringify({
        ...rest,
        model: modelName,
        stream: true  // Always use streaming for simplicity
      });
      
      const options = {
        hostname: url.hostname,
        port: url.port || 1234,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 120000
      };
      
      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          reject({ status: 502, message: 'LM Studio error: ' + res.statusCode });
          return;
        }
        
        resolve({
          response: res,
          provider: 'lmstudio',
          model: modelName,
          modelId: modelId,
          providerId: providerId,
          isStream: true  // Always streaming
        });
      });
      
      req.on('error', (err) => {
        reject({ status: 502, message: 'LM Studio request failed: ' + err.message });
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject({ status: 504, message: 'LM Studio request timeout' });
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  // AIII-Code round-robin fallback routing
  if (modelName === 'AIII-Code') {
    console.log('=== Routing AIII-Code with round-robin fallback');
    
    // Define upstream models in priority order
    const upstreamModels = [
      { name: 'lkeap/kimi-k2.5', display: 'Kimi-K2.5' },
      { name: 'lkeap/glm-5', display: 'GLM-5' },
      { name: 'lkeap/minimax-m2.5', display: 'MiniMax-M2.5' }
    ];
    
    for (const upstream of upstreamModels) {
      try {
        const modelData = await getModelByName(upstream.name);
        if (!modelData) {
          console.log(`Model ${upstream.name} not found in database, trying next...`);
          continue;
        }
        
        const providers = await getAvailableProvidersForModel(upstream.name);
        if (!providers || providers.length === 0) {
          console.log(`No providers available for ${upstream.name}, trying next...`);
          continue;
        }
        
        const provider = providers[0];
        console.log(`Trying AIII-Code -> ${upstream.display} via provider ${provider.name}`);
        
        const adapter = ProviderAdapterFactory.create(provider.name, {
          baseUrl: provider.base_url,
          apiKey: provider.api_key || config.providers[provider.name]?.apiKey
        });

        const requestData = {
          ...rest,
          model: upstream.name,
          upstreamModelName: modelData.upstream_model_name
        };

        const response = await adapter.request(requestData);
        const isStream = rest.stream;
        const parsed = adapter.parseResponse(response, isStream);
        
        console.log(`Successfully routed AIII-Code -> ${upstream.display}`);
        
        return {
          response: parsed,
          provider: provider.name,
          model: upstream.name,
          isStream
        };
        
      } catch (error) {
        console.error(`Failed to route to ${upstream.display}:`, error.message);
        lastError = error;
        
        // Try next upstream model
        continue;
      }
    }
    
    // All upstream models failed
    throw {
      status: 502,
      message: 'All AIII-Code upstream models failed: Kimi-K2.5, GLM-5, MiniMax-M2.5',
      code: 'all_models_failed'
    };
  }
  
  const providers = await getAvailableProvidersForModel(modelName);
  
  for (let i = 0; i < Math.min(providers.length, maxRetries + 1); i++) {
    const provider = providers[i];
    
    if (!provider) break;

    try {
      const adapter = ProviderAdapterFactory.create(provider.name, {
        baseUrl: provider.base_url,
        apiKey: provider.api_key || config.providers[provider.name]?.apiKey
      });

      const requestData = {
        ...rest,
        model: modelName,
        upstreamModelName: model.upstream_model_name
      };

      const response = await adapter.request(requestData);
      const isStream = rest.stream;
      const parsed = adapter.parseResponse(response, isStream);
      
      return {
        response: parsed,
        provider: provider.name,
        model: modelName,
        isStream
      };
      
    } catch (error) {
      lastError = error;
      console.error(`Provider ${provider.name} failed:`, error.message);
      
      await updateProviderHealth(provider.id, false, error.response?.status || 500);
    }
  }

  throw {
    status: 502,
    message: lastError?.message || 'All providers failed',
    code: 'all_providers_failed'
  };
}

async function updateProviderHealth(providerId, success, statusCode) {
  try {
    const health = await db.query(`
      SELECT * FROM provider_health WHERE provider_id = $1
    `, [providerId]);

    if (health.rows.length === 0) {
      await db.query(`
        INSERT INTO provider_health (provider_id, success_rate, avg_latency_ms, error_count, request_count)
        VALUES ($1, $2, $3, $4, $5)
      `, [providerId, success ? 100 : 0, 0, success ? 0 : 1, 1]);
    } else {
      const current = health.rows[0];
      const newRequestCount = parseInt(current.request_count) + 1;
      const newErrorCount = success ? parseInt(current.error_count) : parseInt(current.error_count) + 1;
      const newSuccessRate = ((newRequestCount - newErrorCount) / newRequestCount) * 100;

      await db.query(`
        UPDATE provider_health 
        SET success_rate = $1, error_count = $2, request_count = $3, last_checked = NOW()
        WHERE provider_id = $4
      `, [newSuccessRate, newErrorCount, newRequestCount, providerId]);
    }
  } catch (error) {
    console.error('Failed to update provider health:', error);
  }
}

async function listModels() {
  const result = await db.query(`
    SELECT m.model_name, m.display_name, m.description, 
           m.input_price_per_1k_tokens, m.output_price_per_1k_tokens,
           m.context_length, m.modality, m.supports_stream,
           p.name as provider
    FROM models m
    JOIN providers p ON m.provider_id = p.id
    WHERE m.enabled = true AND p.enabled = true
    ORDER BY m.id
  `);
  return result.rows;
}

module.exports = {
  routeRequest,
  executeWithFailover,
  listModels,
  updateProviderHealth,
  ROUTING_STRATEGY
};
