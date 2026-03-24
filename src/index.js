require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const session = require('express-session');
const crypto = require('crypto');
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const { testConnection } = require('./models/db');
const { register, metricsMiddleware } = require('./services/metrics');
const StreamingHandler = require('./services/streaming');

const v1Routes = require('./routes/v1');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');

const app = express();
const server = http.createServer(app);

const streaming = new StreamingHandler(server);

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: false
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/admin', express.static('public/admin'));
app.use(metricsMiddleware);

app.get('/', (req, res) => {
  res.sendFile('public/index.html', { root: '.' });
});

app.get('/login', (req, res) => {
  res.sendFile('public/login.html', { root: '.' });
});

app.get('/register', (req, res) => {
  res.sendFile('public/login.html', { root: '.' });
});

app.get('/chat', (req, res) => {
  res.sendFile('public/chat.html', { root: '.' });
});

app.get('/dashboard', (req, res) => {
  res.sendFile('public/dashboard.html', { root: '.' });
});

app.get('/models', (req, res) => {
  res.sendFile('public/models.html', { root: '.' });
});

app.get('/pricing', (req, res) => {
  res.sendFile('public/pricing.html', { root: '.' });
});

app.get('/docs', (req, res) => {
  res.sendFile('public/docs.html', { root: '.' });
});

app.get('/about', (req, res) => {
  res.sendFile('public/about.html', { root: '.' });
});

app.get('/contact', (req, res) => {
  res.sendFile('public/contact.html', { root: '.' });
});

app.get('/privacy', (req, res) => {
  res.sendFile('public/privacy.html', { root: '.' });
});

app.get('/terms', (req, res) => {
  res.sendFile('public/terms.html', { root: '.' });
});

app.get('/industries', (req, res) => {
  res.sendFile('public/industries.html', { root: '.' });
});

app.get('/rankings', (req, res) => {
  res.sendFile('public/rankings.html', { root: '.' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

app.use('/v1', v1Routes);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);

app.use((err, req, res, next) => {
  logger.error(err);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error',
      param: null,
      code: 'internal_error'
    }
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = process.env.PORT || 80;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on port ${PORT}`);
  testConnection();
});

const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, closing server...`);
  server.close(() => {
    logger.info('HTTP server closed');
    const { pool } = require('./models/db');
    pool.end().then(() => {
      logger.info('Database pool closed');
      process.exit(0);
    });
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
