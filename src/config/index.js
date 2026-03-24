require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'aix_cloud',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret',
  },

  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    google: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1',
      apiKey: process.env.GOOGLE_API_KEY,
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
    },
    lkeap: {
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: process.env.LKEAP_API_KEY || '',
    },
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};
