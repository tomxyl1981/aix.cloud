const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    const host = process.env.EMAIL_HOST || 'smtp.qq.com';
    const port = parseInt(process.env.EMAIL_PORT) || 465;
    const secure = process.env.EMAIL_SECURE === 'true' || port === 465;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
      logger.error('Email configuration missing. Please set EMAIL_USER and EMAIL_PASS in your .env file');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5
    });

    this.transporter.verify((error, success) => {
      if (error) {
        logger.error('Email transporter verification failed:', error.message);
      } else {
        logger.info('Email transporter is ready to send messages');
      }
    });
  }

  async sendVerificationEmail(email, code, type) {
    if (!this.transporter) {
      throw new Error('Email transporter not initialized. Check your email configuration.');
    }

    const subject = type === 'register' 
      ? 'AIII Cloud 注册验证码' 
      : 'AIII Cloud 登录验证码';
    
    const purpose = type === 'register' ? '注册' : '登录';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AIII Cloud 验证码</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background-color: #f5f5f5;
      margin: 0;
      padding: 20px;
    }
    .container { 
      max-width: 500px; 
      margin: 0 auto; 
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .header { 
      background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }
    .content { 
      padding: 40px 30px;
      text-align: center;
    }
    .code { 
      font-size: 42px; 
      font-weight: 700; 
      color: #8b5cf6; 
      letter-spacing: 12px;
      margin: 30px 0;
      padding: 20px;
      background: #f3f0ff;
      border-radius: 8px;
      display: inline-block;
    }
    .info {
      color: #666;
      font-size: 14px;
      line-height: 1.6;
      margin-top: 20px;
    }
    .warning {
      color: #dc2626;
      font-size: 13px;
      margin-top: 20px;
      padding: 15px;
      background: #fef2f2;
      border-radius: 6px;
      border-left: 4px solid #dc2626;
    }
    .footer { 
      background: #f9fafb;
      padding: 20px;
      text-align: center;
      color: #9ca3af;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AIII Cloud</h1>
    </div>
    <div class="content">
      <p style="font-size: 18px; color: #333; margin-bottom: 10px;">您正在进行<strong>${purpose}</strong>操作</p>
      <p style="color: #666; margin-bottom: 30px;">请使用以下验证码完成验证：</p>
      <div class="code">${code}</div>
      <div class="info">
        <p>验证码有效期：<strong>5分钟</strong></p>
        <p>此验证码仅可使用一次，请勿泄露给他人</p>
      </div>
      <div class="warning">
        <strong>安全提示：</strong>如果您没有进行此操作，请忽略此邮件并检查账户安全。
      </div>
    </div>
    <div class="footer">
      <p>此邮件由 AIII Cloud 自动发送，请勿回复</p>
      <p>&copy; ${new Date().getFullYear()} AIII Cloud. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

    const text = `AIII Cloud 验证码

您正在进行${purpose}操作。

验证码：${code}

有效期：5分钟

此验证码仅可使用一次，请勿泄露给他人。

如果您没有进行此操作，请忽略此邮件。

© ${new Date().getFullYear()} AIII Cloud`;

    const fromName = process.env.EMAIL_FROM_NAME || 'AIII Cloud';
    const fromEmail = process.env.EMAIL_USER;

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: subject,
      text: text,
      html: html
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      logger.info(`Verification email sent to ${email}, messageId: ${info.messageId}`);
      return {
        success: true,
        messageId: info.messageId,
        previewUrl: nodemailer.getTestMessageUrl?.(info) || null
      };
    } catch (error) {
      logger.error(`Failed to send email to ${email}:`, error.message);
      throw error;
    }
  }

  async close() {
    if (this.transporter) {
      await this.transporter.close();
      logger.info('Email transporter closed');
    }
  }
}

module.exports = new EmailService();
