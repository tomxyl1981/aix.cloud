const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

class StreamingHandler {
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    this.setupHandlers();
  }

  setupHandlers() {
    this.io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('chat', async (data) => {
        await this.handleChat(socket, data);
      });

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
      });
    });
  }

  async handleChat(socket, data) {
    const { model, messages, temperature, max_tokens, apiKey } = data;

    if (!model || !messages || !apiKey) {
      socket.emit('error', { message: 'Missing required parameters' });
      return;
    }

    try {
      const router = require('./services/router');
      const routeInfo = await router.routeRequest({ model });

      const provider = routeInfo.provider;
      const providerConfig = require('./config').providers[provider.name];

      const url = `${provider.base_url}/chat/completions`;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerConfig?.apiKey || provider.api_key}`
      };

      const body = {
        model: routeInfo.model.upstream_model_name,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: max_tokens ?? 4096,
        stream: true
      };

      const response = await axios.post(url, body, {
        headers,
        responseType: 'stream',
        timeout: 120000
      });

      let buffer = '';

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') {
              socket.emit('done', {});
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const chunkData = this.parseSSEChunk(parsed);
              if (chunkData) {
                socket.emit('chunk', chunkData);
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      });

      response.data.on('end', () => {
        socket.emit('done', {});
      });

      response.data.on('error', (error) => {
        socket.emit('error', { message: error.message });
      });

    } catch (error) {
      console.error('Streaming error:', error);
      socket.emit('error', { 
        message: error.message || 'Request failed',
        code: error.code || 'unknown_error'
      });
    }
  }

  parseSSEChunk(data) {
    if (!data.choices || !data.choices[0]) return null;

    const choice = data.choices[0];
    return {
      id: data.id,
      object: 'chat.completion.chunk',
      created: data.created,
      model: data.model,
      choices: [{
        index: choice.index,
        delta: choice.delta || {},
        finish_reason: choice.finish_reason
      }]
    };
  }
}

module.exports = StreamingHandler;
