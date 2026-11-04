import { FastifyRequest, FastifyReply } from 'fastify';
import { CustomerService } from '../../services/customer.service.js';

export interface AuthenticatedCustomer {
  customerId: string;
  discordUserId: string;
  username: string;
  allowedGroups: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    customer?: AuthenticatedCustomer;
  }
}

export function createAuthMiddleware(customerService: CustomerService = new CustomerService()) {
  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    let apiKey: string | undefined;

    const authHeader = request.headers.authorization;
    const customHeader = request.headers['nextai-api-key'] as string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.replace('Bearer ', '').trim();
    } else if (customHeader && customHeader.trim() !== '') {
      apiKey = customHeader.trim();
    }

    if (!apiKey) {
      reply.status(401).send({
        error: {
          message: 'Missing or malformed Authorization header. Expected Bearer token or Nextai-Api-Key header format.',
          type: 'invalid_request_error',
          code: 'unauthorized',
        },
      });
      return;
    }

    try {
      const authResult = await customerService.authenticateApiKey(apiKey);

      request.customer = {
        customerId: authResult.customerId,
        discordUserId: authResult.discordUserId,
        username: authResult.username,
        allowedGroups: authResult.allowedGroups,
      };
    } catch (err: any) {
      const status = err.statusCode || 401;
      reply.status(status).send({
        error: {
          message: err.message || 'Invalid API Key.',
          type: status === 403 ? 'permission_denied' : 'invalid_request_error',
          code: err.code || 'unauthorized',
        },
      });
    }
  };
}
