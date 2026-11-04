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
