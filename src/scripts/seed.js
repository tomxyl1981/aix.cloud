require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const config = require('../config');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
});

async function seed() {
  console.log('Starting seed...');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create test user
    const passwordHash = await bcrypt.hash('test123456', 10);
    const userResult = await client.query(`
      INSERT INTO users (email, password_hash, name)
      VALUES ('test@aii.cloud', $1, 'Test User')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `, [passwordHash]);
    
    const userId = userResult.rows[0].id;
    console.log('Test user created/updated:', userId);

    // Create user balance
    await client.query(`
      INSERT INTO user_balances (user_id, balance, total_spent)
      VALUES ($1, 100.00, 0)
      ON CONFLICT (user_id) DO UPDATE SET balance = user_balances.balance + 10
    `, [userId]);

    // Create API key for test user
    const testApiKey = 'sk-aix-' + require('uuid').v4().replace(/-/g, '');
    const keyHash = require('crypto').createHash('sha256').update(testApiKey).digest('hex');
    
    await client.query(`
      INSERT INTO api_keys (user_id, key_hash, name, scopes)
      VALUES ($1, $2, 'Test Key', ARRAY['chat', 'completions'])
      ON CONFLICT DO NOTHING
    `, [userId, keyHash]);
    
    console.log('Test API Key:', testApiKey);

    // Insert providers
    const providers = [
      { name: 'openai', display_name: 'OpenAI', base_url: 'https://api.openai.com/v1', auth_type: 'bearer', priority: 100 },
      { name: 'anthropic', display_name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', auth_type: 'header', priority: 90 },
      { name: 'google', display_name: 'Google', base_url: 'https://generativelanguage.googleapis.com/v1', auth_type: 'query', priority: 80 },
      { name: 'deepseek', display_name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', auth_type: 'bearer', priority: 70 },
      { name: 'lkeap', display_name: 'lkeap', base_url: 'http://127.0.0.1:8080/v1', auth_type: 'bearer', priority: 60 },
    ];

    for (const provider of providers) {
      await client.query(`
        INSERT INTO providers (name, display_name, base_url, auth_type, priority, enabled)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (name) DO NOTHING
      `, [provider.name, provider.display_name, provider.base_url, provider.auth_type, provider.priority]);
    }

    // Get provider IDs
    const providerResult = await client.query('SELECT id, name FROM providers');
    const providerMap = {};
    providerResult.rows.forEach(row => {
      providerMap[row.name] = row.id;
    });

    // Insert models
    const models = [
      // OpenAI models
      { provider: 'openai', model_name: 'openai/gpt-4o', upstream: 'gpt-4o', display_name: 'GPT-4o', input_price: 5.0, output_price: 15.0, context: 128000 },
      { provider: 'openai', model_name: 'openai/gpt-4o-mini', upstream: 'gpt-4o-mini', display_name: 'GPT-4o Mini', input_price: 0.15, output_price: 0.6, context: 128000 },
      { provider: 'openai', model_name: 'openai/gpt-4-turbo', upstream: 'gpt-4-turbo', display_name: 'GPT-4 Turbo', input_price: 10.0, output_price: 30.0, context: 128000 },
      { provider: 'openai', model_name: 'openai/gpt-3.5-turbo', upstream: 'gpt-3.5-turbo', display_name: 'GPT-3.5 Turbo', input_price: 0.5, output_price: 1.5, context: 16385 },
      
      // Anthropic models
      { provider: 'anthropic', model_name: 'anthropic/claude-3-5-sonnet', upstream: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet', input_price: 3.0, output_price: 15.0, context: 200000 },
      { provider: 'anthropic', model_name: 'anthropic/claude-3-opus', upstream: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus', input_price: 15.0, output_price: 75.0, context: 200000 },
      { provider: 'anthropic', model_name: 'anthropic/claude-3-haiku', upstream: 'claude-3-haiku-20240307', display_name: 'Claude 3 Haiku', input_price: 0.25, output_price: 1.25, context: 200000 },
      
      // Google models
      { provider: 'google', model_name: 'google/gemini-1.5-pro', upstream: 'gemini-1.5-pro', display_name: 'Gemini 1.5 Pro', input_price: 1.25, output_price: 5.0, context: 2000000 },
      { provider: 'google', model_name: 'google/gemini-1.5-flash', upstream: 'gemini-1.5-flash', display_name: 'Gemini 1.5 Flash', input_price: 0.075, output_price: 0.3, context: 1000000 },
      
      // DeepSeek models
      { provider: 'deepseek', model_name: 'deepseek/deepseek-chat', upstream: 'deepseek-chat', display_name: 'DeepSeek Chat', input_price: 0.14, output_price: 0.28, context: 64000 },
      { provider: 'deepseek', model_name: 'deepseek/deepseek-coder', upstream: 'deepseek-coder', display_name: 'DeepSeek Coder', input_price: 0.14, output_price: 0.28, context: 64000 },

      // lkeap models
      { provider: 'lkeap', model_name: 'lkeap/kimi-k2.5', upstream: 'kimi-k2.5', display_name: 'Kimi K2.5', input_price: 0.0, output_price: 0.0, context: 256000 },
      { provider: 'lkeap', model_name: 'lkeap/glm-5', upstream: 'glm-5', display_name: 'GLM 5', input_price: 0.0, output_price: 0.0, context: 128000 },
      { provider: 'lkeap', model_name: 'lkeap/minimax-m2.5', upstream: 'minimax-m2.5', display_name: 'MiniMax M2.5', input_price: 0.0, output_price: 0.0, context: 200000 },
    ];

    for (const model of models) {
      const providerId = providerMap[model.provider];
      if (providerId) {
        await client.query(`
          INSERT INTO models (provider_id, model_name, upstream_model_name, display_name, input_price_per_1k_tokens, output_price_per_1k_tokens, context_length, enabled)
          VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          ON CONFLICT (model_name) DO NOTHING
        `, [providerId, model.model_name, model.upstream, model.display_name, model.input_price, model.output_price, model.context]);
      }
    }

    await client.query('COMMIT');
    console.log('Seed completed successfully!');
    console.log('\n=== Test Credentials ===');
    console.log('Email: test@aii.cloud');
    console.log('Password: test123456');
    console.log('API Key:', testApiKey);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seed error:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
