const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('../models/db');
const { getUserBalance, getUserUsage, getUserUsageSummary } = require('../services/billing');
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/email');
const verificationCodeManager = require('../services/verificationCodeManager');
const logger = require('../utils/logger');

const sessionStore = new Map();

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, session] of sessionStore) {
    if (now > session.expire) {
      sessionStore.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(`Cleaned up ${cleaned} expired sessions`);
  }
}, 60000);

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip'] 
    || req.connection.remoteAddress 
    || req.ip 
    || 'unknown';
}

router.post('/send-code', async (req, res) => {
  const { email, type } = req.body;
  const clientIp = getClientIp(req);
  
  if (!email) {
    return res.status(400).json({ error: '邮箱地址不能为空' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  if (!type || !['register', 'login', 'reset'].includes(type)) {
    return res.status(400).json({ error: '无效的验证类型' });
  }

  const rateCheck = verificationCodeManager.canSendCode(email, clientIp);
  if (!rateCheck.allowed) {
    logger.warn(`Rate limit triggered for ${email} from ${clientIp}: ${rateCheck.reason}`);
    return res.status(429).json({ 
      error: rateCheck.message,
      remainingSeconds: rateCheck.remainingSeconds || undefined
    });
  }

  const code = generateCode();
  
  try {
    await emailService.sendVerificationEmail(email, code, type);
    
    verificationCodeManager.storeCode(email, code, type, clientIp);
    
    logger.info(`Verification code sent to ${email} from IP ${clientIp}`);
    
    res.json({ 
      success: true, 
      message: '验证码已发送到您的邮箱',
      ...(process.env.NODE_ENV === 'development' && { code })
    });
  } catch (error) {
    logger.error(`Failed to send verification code to ${email}:`, error.message);
    res.status(500).json({ error: '发送验证码失败，请稍后重试' });
  }
});

router.post('/register', async (req, res) => {
  const { email, code, password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: '请输入6位验证码' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: '密码长度至少为8位' });
  }

  const verification = verificationCodeManager.verifyCode(email, code);
  if (!verification.valid) {
    return res.status(400).json({ 
      error: verification.message,
      remainingAttempts: verification.remainingAttempts 
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    
    const result = await db.query(`
      INSERT INTO users (email, password_hash, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email, name, created_at
    `, [email, passwordHash, name || null]);

    if (result.rows.length === 0) {
      return res.status(409).json({ error: '用户已存在' });
    }

    const user = result.rows[0];

    await db.query(`
      INSERT INTO user_balances (user_id, balance, total_spent)
      VALUES ($1, 10, 0)
    `, [user.id]);

    const token = uuidv4().replace(/-/g, '');
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');

    await db.query(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
      VALUES ($1, $2, $3, 'Default Key', ARRAY['chat', 'completions'])
    `, [user.id, keyHash, token]);

    logger.info(`New user registered: ${email}`);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at
      },
      api_key: `AIII-Cloud ${token}`
    });

  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

router.post('/login', async (req, res) => {
  const { email, code, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: '请输入6位验证码' });
  }

  const verification = verificationCodeManager.verifyCode(email, code);
  if (!verification.valid) {
    return res.status(400).json({ 
      error: verification.message,
      remainingAttempts: verification.remainingAttempts 
    });
  }

  try {
    const result = await db.query(`
      SELECT id, email, password_hash, name FROM users WHERE email = $1
    `, [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: '用户不存在' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: '密码错误' });
    }

    let keyResult = await db.query(`
      SELECT id, key_prefix FROM api_keys WHERE user_id = $1 AND revoked = false LIMIT 1
    `, [user.id]);

    let apiKey;
    if (keyResult.rows.length === 0) {
      apiKey = uuidv4().replace(/-/g, '');
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      await db.query(`
        INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
        VALUES ($1, $2, $3, 'Default Key', ARRAY['chat', 'completions'])
      `, [user.id, keyHash, apiKey]);
    } else {
      apiKey = keyResult.rows[0].key_prefix;
    }

    const sessionToken = uuidv4().replace(/-/g, '');
    
    logger.info(`User logged in: ${email}`);
    
    sessionStore.set(sessionToken, {
      userId: user.id,
      apiKey: apiKey,
      email: user.email,
      expire: Date.now() + (7 * 24 * 60 * 60 * 1000)
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      session_token: sessionToken
    });

  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

router.post('/logout', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (sessionToken) {
    sessionStore.delete(sessionToken);
    logger.info('User logged out');
  }
  res.json({ success: true });
});

router.get('/validate-session', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('AIII-Cloud-Session ')) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  const sessionToken = authHeader.substring(19);
  if (req.session.sessionToken === sessionToken) {
    res.json({ valid: true });
  } else {
    res.status(401).json({ error: 'Invalid session' });
  }
});

router.get('/me', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sessionData = sessionStore.get(sessionToken);
  if (!sessionData || Date.now() > sessionData.expire) {
    if (sessionData) sessionStore.delete(sessionToken);
    return res.status(401).json({ error: 'Session expired' });
  }
  
  try {
    const balance = await getUserBalance(sessionData.userId);
    res.json({
      user: {
        id: sessionData.userId,
        email: sessionData.email
      },
      balance: balance.balance,
      total_spent: balance.total_spent
    });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

router.get('/api-key', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sessionData = sessionStore.get(sessionToken);
  if (!sessionData || Date.now() > sessionData.expire) {
    if (sessionData) sessionStore.delete(sessionToken);
    return res.status(401).json({ error: 'Session expired' });
  }
  res.json({ api_key: `AIII-Cloud ${sessionData.apiKey}` });
});

router.post('/usage', async (req, res) => {
  const email = req.body.email || req.headers['x-user-email'];
  
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { start_date, end_date, limit } = req.body;
  
  try {
    const result = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.json({ usage: [] });
    }
    const userId = result.rows[0].id;
    
    const usage = await getUserUsage(
      userId, 
      start_date || null, 
      end_date || null, 
      parseInt(limit) || 100
    );
    res.json({ usage });
  } catch (error) {
    logger.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

router.post('/usage/summary', async (req, res) => {
  const sessionToken = req.headers['x-session-token'] || req.body.session_token;
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sessionData = sessionStore.get(sessionToken);
  if (!sessionData || Date.now() > sessionData.expire) {
    if (sessionData) sessionStore.delete(sessionToken);
    return res.status(401).json({ error: 'Session expired' });
  }
  
  const { start_date, end_date } = req.body;
  
  try {
    const summary = await getUserUsageSummary(
      sessionData.userId, 
      start_date || null, 
      end_date || null
    );
    res.json({ summary });
  } catch (error) {
    logger.error('Get usage summary error:', error);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});

router.post('/keys', async (req, res) => {
  const email = req.body.email;
  
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized - no email', body: req.body });
  }
  
  try {
    const result = await db.query(`
      SELECT ak.id, ak.name, ak.scopes, ak.rate_limit, ak.revoked, ak.created_at, ak.last_used_at, ak.key_prefix
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE u.email = $1
    `, [email]);
    
    const keys = result.rows.map(k => ({
      ...k,
      key: k.key_prefix ? `AIII-Cloud ${k.key_prefix}` : null
    }));
    
    res.json({ keys });
  } catch (error) {
    logger.error('Get keys error:', error);
    res.status(500).json({ error: 'Failed to get API keys' });
  }
});

router.post('/keys/create-with-code', async (req, res) => {
  const { email, code, name } = req.body;
  const clientIp = getClientIp(req);
  
  if (!email || !code) {
    return res.status(400).json({ error: '邮箱和验证码必填' });
  }

  const rateCheck = verificationCodeManager.canSendCode(email, clientIp);
  if (!rateCheck.allowed && rateCheck.reason === 'ip_limit') {
    return res.status(429).json({ error: rateCheck.message });
  }
  
  const verification = verificationCodeManager.verifyCode(email, code);
  if (!verification.valid) {
    return res.status(400).json({ 
      error: verification.message,
      remainingAttempts: verification.remainingAttempts 
    });
  }
  
  try {
    const userResult = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const userId = userResult.rows[0].id;
    const token = uuidv4().replace(/-/g, '');
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    
    const result = await db.query(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, scopes, created_at
    `, [userId, keyHash, token, name || 'Default Key', ['chat', 'completions']]);
    
    logger.info(`New API key created for ${email}`);
    
    res.status(201).json({
      key: {
        ...result.rows[0],
        key: `AIII-Cloud ${token}`
      }
    });
  } catch (error) {
    logger.error('Create key error:', error);
    res.status(500).json({ error: '创建失败' });
  }
});

router.post('/keys', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sessionData = sessionStore.get(sessionToken);
  if (!sessionData || Date.now() > sessionData.expire) {
    if (sessionData) sessionStore.delete(sessionToken);
    return res.status(401).json({ error: 'Session expired' });
  }
  
  const { name, scopes } = req.body;
  
  try {
    const token = uuidv4().replace(/-/g, '');
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    
    const result = await db.query(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, scopes, created_at
    `, [sessionData.userId, keyHash, token, name || 'New Key', scopes || ['chat', 'completions']]);
    
    res.status(201).json({
      key: {
        ...result.rows[0],
        key: `AIII-Cloud ${token}`
      }
    });
  } catch (error) {
    logger.error('Create key error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/keys/:id', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sessionData = sessionStore.get(sessionToken);
  if (!sessionData || Date.now() > sessionData.expire) {
    if (sessionData) sessionStore.delete(sessionToken);
    return res.status(401).json({ error: 'Session expired' });
  }
  
  const { id } = req.params;
  
  try {
    const countResult = await db.query(`
      SELECT COUNT(*) as count FROM api_keys WHERE user_id = $1 AND revoked = false
    `, [sessionData.userId]);
    
    if (parseInt(countResult.rows[0].count) <= 1) {
      return res.status(400).json({ error: '至少需要保留一个API Key' });
    }
    
    await db.query(`
      UPDATE api_keys SET revoked = true 
      WHERE id = $1 AND user_id = $2
    `, [id, sessionData.userId]);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Revoke key error:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

module.exports = router;
