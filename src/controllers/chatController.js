const { routeRequest, executeWithFailover, updateProviderHealth } = require('../services/router');
const { recordUsage, getUserBalance } = require('../services/billing');
const { authenticate, updateKeyLastUsed } = require('../middleware/auth');
const db = require('../models/db');

async function handleChatCompletion(req, res) {
  const startTime = Date.now();
  const { apiKey } = req;
  
  const { model, messages, temperature, max_tokens, stream, ...rest } = req.body;

  if (!model) {
    return res.status(400).json({
      error: {
        message: 'Missing required parameter: model',
        type: 'invalid_request_error',
        param: 'model',
        code: 'missing_parameter'
      }
    });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Missing required parameter: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'missing_parameter'
      }
    });
  }

  try {
    const balance = await getUserBalance(apiKey.userId);
    if (parseFloat(balance.balance) <= 0) {
      return res.status(402).json({
        error: {
          message: 'Insufficient balance',
          type: 'insufficient_balance',
          param: null,
          code: 'insufficient_balance'
        }
      });
    }

    const result = await executeWithFailover(req.body);
    
    const isStream = result.isStream;

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let rawResponse = '';
      let buffer = '';
      
      result.response.on('data', (chunk) => {
        res.write(chunk);
        rawResponse += chunk.toString();
        buffer += chunk.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop();
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              const json = JSON.parse(data);
              // Try different formats
              let content = '';
              if (json.choices?.[0]?.delta?.content) {
                content = json.choices[0].delta.content;
              } else if (json.choices?.[0]?.text) {
                content = json.choices[0].text;
              } else if (json.content) {
                content = json.content;
              } else if (json.response) {
                content = json.response;
              }
              if (content) {
                buffer += content;
              }
            } catch (e) {}
          } else if (line.trim() && !line.startsWith('event:')) {
            // Plain text response
            buffer += line;
          }
        });
      });
      
      result.response.on('end', async () => {
        // Count all text in the response as output tokens
        const cleanText = rawResponse.replace(/data: /g, '').replace(/\[DONE\]/g, '').replace(/\n/g, ' ').trim();
        const tokensOut = Math.ceil(cleanText.length / 4);
        const tokensIn = Math.ceil(JSON.stringify(req.body.messages).length / 4);
        const usage = { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut };
        
        console.log('=== Usage recorded, raw length:', cleanText.length, 'tokensOut:', tokensOut);
        
        if (usage.total_tokens > 0) {
          await recordUsage(
            apiKey.userId,
            apiKey.id,
            result.modelId || 0,
            result.providerId || 0,
            result.model,
            result.provider,
            usage,
            Date.now() - startTime,
            200
          ).catch(e => console.error('Record usage error:', e));
        }
        res.end();
      });
      
      result.response.on('error', (error) => {
        console.error('Stream error:', error);
        res.end();
      });
      
    } else {
      // Non-streaming: collect response and return
      let data = '';
      result.response.on('data', chunk => { data += chunk.toString(); });
      result.response.on('end', () => {
        try {
          const json = JSON.parse(data);
          res.json(json);
        } catch (e) {
          res.json({ text: data });
        }
      });
      result.response.on('error', () => {
        res.status(502).json({ error: { message: 'Provider error' } });
      });
    }

  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error('Chat completion error:', error);

    if (error.status) {
      return res.status(error.status).json({
        error: {
          message: error.message,
          type: 'provider_error',
          param: null,
          code: error.code
        }
      });
    }

    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
        param: null,
        code: 'internal_error'
      }
    });
  }
}

async function handleModelsList(req, res) {
  try {
    const { listModels } = require('../services/router');
    const models = await listModels();
    
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.model_name,
        object: 'model',
        created: 0,
        owned_by: m.provider,
        permission: [],
        root: m.model_name,
        parent: null,
        display_name: m.display_name,
        description: m.description,
        pricing: {
          prompt: m.input_price_per_1k_tokens,
          completion: m.output_price_per_1k_tokens
        },
        context_length: m.context_length,
        architecture: {
          modality: m.modality
        },
        supports_stream: m.supports_stream
      }))
    });
  } catch (error) {
    console.error('List models error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to list models',
        type: 'server_error',
        param: null,
        code: 'internal_error'
      }
    });
  }
}

module.exports = {
  handleChatCompletion,
  handleModelsList
};
