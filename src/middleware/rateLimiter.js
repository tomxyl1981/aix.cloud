const rateLimit = require('express-rate-limit');
const db = require('../models/db');

const createRateLimiter = (maxRequests = 10) => {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: maxRequests, // requests per minute (default 10)
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        message: 'Rate limit exceeded',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded'
      }
    },
    keyGenerator: (req) => {
      return req.apiKey ? req.apiKey.id : req.ip;
    }
  });
};

module.exports = {
  createRateLimiter
};
