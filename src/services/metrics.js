const promClient = require('prom-client');

const register = new promClient.Registry();

promClient.collectDefaultMetrics({ register });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5, 10]
});

const httpRequestTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const llmRequestDuration = new promClient.Histogram({
  name: 'llm_request_duration_seconds',
  help: 'Duration of LLM requests in seconds',
  labelNames: ['model', 'provider'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
});

const llmTokensTotal = new promClient.Counter({
  name: 'llm_tokens_total',
  help: 'Total number of tokens processed',
  labelNames: ['model', 'provider', 'type'],
  buckets: [100, 1000, 10000, 100000]
});

const llmRequestsTotal = new promClient.Counter({
  name: 'llm_requests_total',
  help: 'Total number of LLM requests',
  labelNames: ['model', 'provider', 'status']
});

const userBalance = new promClient.Gauge({
  name: 'user_balance',
  help: 'User balance in credits',
  labelNames: ['user_id']
});

register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestTotal);
register.registerMetric(llmRequestDuration);
register.registerMetric(llmTokensTotal);
register.registerMetric(llmRequestsTotal);
register.registerMetric(userBalance);

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route ? req.route.path : req.path;
    
    httpRequestDuration.labels(req.method, route, res.statusCode).observe(duration);
    httpRequestTotal.labels(req.method, route, res.statusCode).inc();
  });
  
  next();
}

module.exports = {
  register,
  metricsMiddleware,
  httpRequestDuration,
  llmRequestDuration,
  llmTokensTotal,
  llmRequestsTotal,
  userBalance
};
