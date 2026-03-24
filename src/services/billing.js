const db = require('../models/db');

async function recordUsage(userId, apiKeyId, modelId, providerId, modelName, providerName, usage, latencyMs, statusCode, errorMessage = null) {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const tokensIn = usage.prompt_tokens || 0;
    const tokensOut = usage.completion_tokens || 0;
    const tokensTotal = usage.total_tokens || tokensIn + tokensOut;

    let totalCost = 0;
    if (modelId > 0) {
      const modelResult = await client.query(`
        SELECT input_price_per_1k_tokens, output_price_per_1k_tokens
        FROM models WHERE id = $1
      `, [modelId]);

      if (modelResult.rows[0]) {
        const prices = modelResult.rows[0];
        // 按总tokens计算: 1M = 10元, 即 1K = 0.01元
        totalCost = (tokensTotal / 1000) * 0.01;
      }
    }

    await client.query(`
      INSERT INTO usage_records 
        (user_id, api_key_id, model_id, provider_id, model, provider, 
         tokens_in, tokens_out, tokens_total, cost, latency_ms, status_code, error_message)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [userId, apiKeyId, modelId, providerId, modelName, providerName, 
        tokensIn, tokensOut, tokensTotal, totalCost, latencyMs, statusCode, errorMessage]);

    await client.query(`
      UPDATE user_balances 
      SET balance = balance - $1, total_spent = total_spent + $1, updated_at = NOW()
      WHERE user_id = $2
    `, [totalCost, userId]);

    await client.query('COMMIT');

    return {
      tokensIn,
      tokensOut,
      tokensTotal,
      cost: totalCost
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to record usage:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function getUserBalance(userId) {
  const result = await db.query(`
    SELECT balance, total_spent, updated_at
    FROM user_balances WHERE user_id = $1
  `, [userId]);
  
  return result.rows[0] || { balance: 0, total_spent: 0 };
}

async function getUserUsage(userId, startDate, endDate, limit = 100) {
  const result = await db.query(`
    SELECT 
      ur.id, ur.model, ur.provider, ur.tokens_in, ur.tokens_out, 
      ur.tokens_total, ur.cost, ur.latency_ms, ur.status_code, 
      ur.created_at
    FROM usage_records ur
    WHERE ur.user_id = $1
      AND ($2::timestamp IS NULL OR ur.created_at >= $2)
      AND ($3::timestamp IS NULL OR ur.created_at <= $3)
    ORDER BY ur.created_at DESC
    LIMIT $4
  `, [userId, startDate, endDate, limit]);
  
  return result.rows;
}

async function getUserUsageSummary(userId, startDate, endDate) {
  const result = await db.query(`
    SELECT 
      ur.model,
      ur.provider,
      SUM(ur.tokens_in) as total_tokens_in,
      SUM(ur.tokens_out) as total_tokens_out,
      SUM(ur.tokens_total) as total_tokens,
      SUM(ur.cost) as total_cost,
      COUNT(*) as request_count,
      AVG(ur.latency_ms) as avg_latency
    FROM usage_records ur
    WHERE ur.user_id = $1
      AND ($2::timestamp IS NULL OR ur.created_at >= $2)
      AND ($3::timestamp IS NULL OR ur.created_at <= $3)
    GROUP BY ur.model, ur.provider
    ORDER BY total_cost DESC
  `, [userId, startDate, endDate]);
  
  return result.rows;
}

async function addBalance(userId, amount) {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    await client.query(`
      UPDATE user_balances 
      SET balance = balance + $1, updated_at = NOW()
      WHERE user_id = $2
    `, [amount, userId]);
    
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to add balance:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  recordUsage,
  getUserBalance,
  getUserUsage,
  getUserUsageSummary,
  addBalance
};
