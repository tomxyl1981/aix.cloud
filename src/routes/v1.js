const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { handleChatCompletion, handleModelsList } = require('../controllers/chatController');

const defaultRateLimiter = createRateLimiter(10);

router.get('/models', handleModelsList);

router.use(authenticate);

router.post('/chat/completions', defaultRateLimiter, handleChatCompletion);

router.get('/models/:model', async (req, res) => {
  const { model } = req.params;
  const { listModels } = require('../services/router');
  
  try {
    const models = await listModels();
    const found = models.find(m => m.model_name === model);
    
    if (!found) {
      return res.status(404).json({
        error: {
          message: `Model not found: ${model}`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found'
        }
      });
    }
    
    res.json({
      id: found.model_name,
      object: 'model',
      created: 0,
      owned_by: found.provider,
      display_name: found.display_name,
      description: found.description,
      pricing: {
        prompt: found.input_price_per_1k_tokens,
        completion: found.output_price_per_1k_tokens
      },
      context_length: found.context_length,
      supports_stream: found.supports_stream
    });
  } catch (error) {
    console.error('Get model error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to get model',
        type: 'server_error',
        param: null,
        code: 'internal_error'
      }
    });
  }
});

module.exports = router;
