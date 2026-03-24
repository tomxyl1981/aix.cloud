const crypto = require('crypto');
const db = require('../models/db');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('AIII-Cloud ')) {
    return res.status(401).json({
      error: {
        message: 'Missing or invalid authorization header',
        type: 'invalid_request_error',
        param: null,
        code: 'unauthorized'
      }
    });
  }

  const apiKey = authHeader.substring(11);
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  try {
    const result = await db.query(`
      SELECT 
        ak.id, ak.user_id, ak.name, ak.scopes, ak.rate_limit, ak.revoked,
        u.email, u.id as user_id
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.key_hash = $1 AND ak.revoked = false
    `, [keyHash]);

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          param: null,
          code: 'unauthorized'
        }
      });
    }

    const apiKeyData = result.rows[0];

    // Check user balance
    const balanceResult = await db.query(`
      SELECT balance FROM user_balances WHERE user_id = $1
    `, [apiKeyData.user_id]);

    const balance = balanceResult.rows[0]?.balance || 0;

    // Attach user data to request
    req.apiKey = {
      id: apiKeyData.id,
      userId: apiKeyData.user_id,
      name: apiKeyData.name,
      scopes: apiKeyData.scopes,
      rateLimit: apiKeyData.rate_limit,
      email: apiKeyData.email,
      balance: balance
    };

    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({
      error: {
        message: 'Authentication failed',
        type: 'server_error',
        param: null,
        code: 'internal_error'
      }
    });
  }
}

async function updateKeyLastUsed(apiKeyId) {
  try {
    await db.query(`
      UPDATE api_keys SET last_used_at = NOW() WHERE id = $1
    `, [apiKeyId]);
  } catch (error) {
    console.error('Failed to update last_used_at:', error);
  }
}

module.exports = {
  authenticate,
  updateKeyLastUsed
};
