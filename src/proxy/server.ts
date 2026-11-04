import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CustomerService } from '../services/customer.service.js';
import { ModelCatalogService } from '../services/catalog.service.js';
import { UpstreamCredentialResolver } from '../services/credential-resolver.service.js';
import { createAuthMiddleware } from './middleware/auth.middleware.js';
import { createModelsRoute } from './routes/models.route.js';
import { createChatRoute } from './routes/chat.route.js';

export interface ProxyServerOptions {
  port?: number;
  host?: string;
  upstreamBaseUrl: string;
  customerService?: CustomerService;
  catalogService?: ModelCatalogService;
  credentialResolver: UpstreamCredentialResolver;
  enableLegacyProxy?: boolean;
}

export function createProxyServer(options: ProxyServerOptions): FastifyInstance {
  const isProxyEnabled = options.enableLegacyProxy !== false;
  const fastify = Fastify({
    logger: false, // Security: suppress raw payload logging
    bodyLimit: 10 * 1024 * 1024, // 10 MB maximum request payload protection
  });

  // Enable CORS for web-based AI clients (e.g. LibreChat, Chatbot-UI)
  fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Nextai-Api-Key'],
  });

  // Protect against brute-force / DoS attacks
  fastify.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  // Healthcheck endpoint (unauthenticated)
  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'Next AI Proxy Hub',
    role: 'NextAI Admin & Business Management System',
    legacyProxy: isProxyEnabled ? 'enabled' : 'disabled',
    gatewayEndpoint: options.upstreamBaseUrl,
    timestamp: new Date().toISOString(),
  }));

  // Root endpoint: Return HTML with auto-redirect to YouTube (200 OK for UptimeRobot, browser redirect)
  fastify.get('/', async (request, reply) => {
    const targetUrl = 'https://youtu.be/lvXILr0sISQ?si=3UKvK_ibpsWijCSm';
    reply.type('text/html').code(200).send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="2; url=${targetUrl}">
  <title>NextAI - กำลังพาท่านไป...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .card {
      background: #1e293b;
      padding: 2.5rem;
      border-radius: 1rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      border: 1px solid #334155;
      max-width: 500px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #38bdf8; }
    p { font-size: 1rem; color: #94a3b8; margin-bottom: 1.5rem; }
    .spinner {
      width: 40px;
      height: 40px;
      margin: 0 auto 1.5rem;
      border: 4px solid #334155;
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    a {
      color: #38bdf8;
      text-decoration: none;
      word-break: break-all;
      font-weight: 500;
    }
    a:hover { text-decoration: underline; }
  </style>
  <script>
    setTimeout(function() {
      window.location.href = "${targetUrl}";
    }, 1500);
  </script>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>NextAI Hub</h1>
    <p>กำลังพาท่านไปที่ URL:<br><br><a href="${targetUrl}">${targetUrl}</a></p>
    <p style="font-size: 0.875rem; color: #64748b;">หากหน้าเว็บไม่เปลี่ยนเส้นทางโดยอัตโนมัติ กรุณากดที่ลิงก์ด้านบน</p>
  </div>
</body>
</html>`);
  });

  if (!isProxyEnabled) {
    // Disabled Routing Behavior: Reject all /v1/* requests with 410 Gone (Proxy Deprecated)
    fastify.all('/v1/*', async (request, reply) => {
      reply.status(410).send({
        error: {
          message:
            'NextAI Node.js Proxy is deprecated in favor of direct New API Gateway access. Please route customer requests directly to the New API endpoint.',
          type: 'proxy_deprecated',
          code: 410,
          gatewayEndpoint: options.upstreamBaseUrl,
        },
      });
    });

    return fastify;
  }

  const customerService = options.customerService || new CustomerService();
  const catalogService = options.catalogService || new ModelCatalogService();

  // Apply authentication hook to all /v1/* endpoints
  const authMiddleware = createAuthMiddleware(customerService);
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1/')) {
      await authMiddleware(request, reply);
    }
  });

  // Register V1 routes
  fastify.register(createModelsRoute(catalogService));
  fastify.register(
    createChatRoute({
      credentialResolver: options.credentialResolver,
      upstreamBaseUrl: options.upstreamBaseUrl,
    })
  );

  return fastify;
}
