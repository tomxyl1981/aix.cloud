require('dotenv').config();
const { Pool } = require('pg');
const config = require('../config');

const masterPool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: 'postgres',
});

async function createDatabase() {
  const dbName = config.db.database;
  
  try {
    const result = await masterPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );
    
    if (result.rows.length === 0) {
      await masterPool.query(`CREATE DATABASE ${dbName}`);
      console.log(`Database "${dbName}" created successfully`);
    } else {
      console.log(`Database "${dbName}" already exists`);
    }
  } catch (error) {
    console.error('Error creating database:', error.message);
  } finally {
    await masterPool.end();
  }
}

async function runMigrations() {
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
  });

  const migrations = `
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- API Keys table
    CREATE TABLE IF NOT EXISTS api_keys (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      scopes VARCHAR(100)[] DEFAULT '{chat,completions}',
      rate_limit INTEGER DEFAULT 100,
      revoked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      last_used_at TIMESTAMP
    );

    -- Providers table
    CREATE TABLE IF NOT EXISTS providers (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      base_url VARCHAR(255) NOT NULL,
      auth_type VARCHAR(50) NOT NULL DEFAULT 'bearer',
      api_key VARCHAR(255),
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER DEFAULT 100,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Models table
    CREATE TABLE IF NOT EXISTS models (
      id BIGSERIAL PRIMARY KEY,
      provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_name VARCHAR(100) NOT NULL,
      upstream_model_name VARCHAR(100) NOT NULL,
      display_name VARCHAR(255),
      description TEXT,
      input_price_per_1k_tokens NUMERIC(10, 6) DEFAULT 0,
      output_price_per_1k_tokens NUMERIC(10, 6) DEFAULT 0,
      context_length INTEGER DEFAULT 4096,
      modality VARCHAR(50) DEFAULT 'text',
      supports_stream BOOLEAN DEFAULT true,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Unique constraint for model_name
    ALTER TABLE models ADD CONSTRAINT unique_model_name UNIQUE (model_name);

    -- User Balances table
    CREATE TABLE IF NOT EXISTS user_balances (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance NUMERIC(15, 6) NOT NULL DEFAULT 0,
      total_spent NUMERIC(15, 6) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Usage Records table
    CREATE TABLE IF NOT EXISTS usage_records (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      model_id BIGINT NOT NULL REFERENCES models(id),
      provider_id BIGINT NOT NULL REFERENCES providers(id),
      model VARCHAR(100) NOT NULL,
      provider VARCHAR(100) NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_total INTEGER NOT NULL DEFAULT 0,
      cost NUMERIC(15, 8) NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      status_code INTEGER,
      error_message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_user_id ON usage_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_models_model_name ON models(model_name);

    -- Provider Health Check table
    CREATE TABLE IF NOT EXISTS provider_health (
      id BIGSERIAL PRIMARY KEY,
      provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      success_rate NUMERIC(5, 2) DEFAULT 100,
      avg_latency_ms INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      request_count INTEGER DEFAULT 0,
      last_checked TIMESTAMP NOT NULL DEFAULT now()
    );
  `;

  try {
    await pool.query(migrations);
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration error:', error.message);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log('Creating database...');
  await createDatabase();
  
  console.log('Running migrations...');
  await runMigrations();
  
  console.log('Setup complete!');
}

main();
