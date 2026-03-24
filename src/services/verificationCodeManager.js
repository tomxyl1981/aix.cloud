const logger = require('../utils/logger');

class VerificationCodeManager {
  constructor() {
    this.codes = new Map();
    this.attempts = new Map();
    this.emailTimestamps = new Map();
    this.ipTimestamps = new Map();
    
    this.COOLDOWN_SECONDS = parseInt(process.env.EMAIL_COOLDOWN_SECONDS) || 60;
    this.MAX_ATTEMPTS = parseInt(process.env.MAX_VERIFICATION_ATTEMPTS) || 5;
    this.CODE_EXPIRY_MS = (parseInt(process.env.CODE_EXPIRY_MINUTES) || 5) * 60 * 1000;
    this.MAX_CODES_PER_HOUR = parseInt(process.env.MAX_CODES_PER_HOUR) || 60;
    this.MAX_CODES_PER_IP_PER_HOUR = parseInt(process.env.MAX_CODES_PER_IP_PER_HOUR) || 60;
    
    this.startCleanupInterval();
  }

  startCleanupInterval() {
    setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  cleanup() {
    const now = Date.now();
    let cleanedCodes = 0;
    let cleanedAttempts = 0;
    
    for (const [email, record] of this.codes) {
      if (now > record.expiresAt) {
        this.codes.delete(email);
        this.attempts.delete(email);
        cleanedCodes++;
      }
    }
    
    for (const [email, attemptData] of this.attempts) {
      if (!this.codes.has(email)) {
        this.attempts.delete(email);
        cleanedAttempts++;
      }
    }
    
    if (cleanedCodes > 0 || cleanedAttempts > 0) {
      logger.debug(`Cleanup: removed ${cleanedCodes} expired codes, ${cleanedAttempts} attempt records`);
    }
  }

  canSendCode(email, ip) {
    const now = Date.now();
    
    const emailRecord = this.codes.get(email);
    if (emailRecord) {
      const timeSinceLastSend = (now - emailRecord.createdAt) / 1000;
      if (timeSinceLastSend < this.COOLDOWN_SECONDS) {
        const remainingSeconds = Math.ceil(this.COOLDOWN_SECONDS - timeSinceLastSend);
        return {
          allowed: false,
          reason: 'cooldown',
          remainingSeconds,
          message: `请等待 ${remainingSeconds} 秒后再试`
        };
      }
    }
    
    const emailCount = this.getRecentCount(this.emailTimestamps, email, 3600000);
    if (emailCount >= this.MAX_CODES_PER_HOUR) {
      return {
        allowed: false,
        reason: 'email_limit',
        message: `该邮箱已达到每小时发送上限 (${this.MAX_CODES_PER_HOUR} 次)，请稍后再试`
      };
    }
    
    const ipCount = this.getRecentCount(this.ipTimestamps, ip, 3600000);
    if (ipCount >= this.MAX_CODES_PER_IP_PER_HOUR) {
      return {
        allowed: false,
        reason: 'ip_limit',
        message: '该IP发送验证码过于频繁，请稍后再试'
      };
    }
    
    return { allowed: true };
  }

  getRecentCount(timestampsMap, key, windowMs) {
    const now = Date.now();
    const timestamps = timestampsMap.get(key) || [];
    const recent = timestamps.filter(ts => now - ts < windowMs);
    timestampsMap.set(key, recent);
    return recent.length;
  }

  recordTimestamp(timestampsMap, key) {
    const timestamps = timestampsMap.get(key) || [];
    timestamps.push(Date.now());
    timestampsMap.set(key, timestamps);
  }

  storeCode(email, code, type, ip) {
    const now = Date.now();
    
    this.codes.set(email, {
      code,
      type,
      ip,
      createdAt: now,
      expiresAt: now + this.CODE_EXPIRY_MS,
      verified: false
    });
    
    this.attempts.set(email, {
      count: 0,
      lastAttempt: now
    });
    
    this.recordTimestamp(this.emailTimestamps, email);
    this.recordTimestamp(this.ipTimestamps, ip);
    
    logger.info(`Verification code stored for ${email}, type: ${type}, ip: ${ip}`);
  }

  canAttemptVerification(email) {
    const record = this.codes.get(email);
    if (!record) {
      return {
        allowed: false,
        message: '验证码已过期，请重新获取'
      };
    }
    
    if (Date.now() > record.expiresAt) {
      this.codes.delete(email);
      this.attempts.delete(email);
      return {
        allowed: false,
        message: '验证码已过期，请重新获取'
      };
    }
    
    const attemptData = this.attempts.get(email) || { count: 0 };
    if (attemptData.count >= this.MAX_ATTEMPTS) {
      this.codes.delete(email);
      this.attempts.delete(email);
      return {
        allowed: false,
        message: `验证失败次数过多 (${this.MAX_ATTEMPTS} 次)，请重新获取验证码`
      };
    }
    
    return { allowed: true };
  }

  recordAttempt(email) {
    const attemptData = this.attempts.get(email) || { count: 0 };
    attemptData.count += 1;
    attemptData.lastAttempt = Date.now();
    this.attempts.set(email, attemptData);
    
    const remainingAttempts = this.MAX_ATTEMPTS - attemptData.count;
    logger.warn(`Failed verification attempt for ${email}, remaining: ${remainingAttempts}`);
    
    return remainingAttempts;
  }

  verifyCode(email, code) {
    const canAttempt = this.canAttemptVerification(email);
    if (!canAttempt.allowed) {
      return {
        valid: false,
        message: canAttempt.message
      };
    }
    
    const record = this.codes.get(email);
    
    if (record.code !== code) {
      const remainingAttempts = this.recordAttempt(email);
      return {
        valid: false,
        remainingAttempts,
        message: remainingAttempts > 0 
          ? `验证码错误，还剩 ${remainingAttempts} 次机会`
          : '验证失败次数过多，请重新获取验证码'
      };
    }
    
    this.codes.delete(email);
    this.attempts.delete(email);
    
    logger.info(`Verification successful for ${email}`);
    return { valid: true };
  }

  getStats() {
    return {
      activeCodes: this.codes.size,
      activeAttempts: this.attempts.size,
      trackedEmails: this.emailTimestamps.size,
      trackedIps: this.ipTimestamps.size
    };
  }
}

module.exports = new VerificationCodeManager();
