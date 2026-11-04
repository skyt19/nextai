import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { UpstreamCredentialResolver } from '../../services/credential-resolver.service.js';
import { BearlabUpstreamClient } from '../upstream/bearlab.client.js';

export interface ChatRouteOptions {
  credentialResolver: UpstreamCredentialResolver;
  upstreamBaseUrl: string;
}

export function createChatRoute(options: ChatRouteOptions): FastifyPluginAsync {
  return async function chatPlugin(fastify: FastifyInstance): Promise<void> {
    fastify.post('/v1/chat/completions', async (request, reply) => {
      const customer = request.customer;
      if (!customer) {
        reply.status(401).send({ error: { message: 'Unauthorized', type: 'invalid_request_error' } });
        return;
      }

      const body = request.body as Record<string, any> | undefined;

      if (!body || typeof body !== 'object') {
        reply.status(400).send({
          error: {
            message: 'Invalid request body. Expected JSON object.',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const requestedModel = body.model;
      if (!requestedModel || typeof requestedModel !== 'string') {
        reply.status(400).send({
          error: {
            message: "Missing or invalid 'model' parameter in request body.",
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (!Array.isArray(body.messages)) {
        reply.status(400).send({
          error: {
            message: "Missing or invalid 'messages' array in request body.",
            type: 'invalid_request_error',
          },
        });
        return;
      }

      try {
        // 1. Resolve model existence, group permissions, and select group New API key
        const context = options.credentialResolver.resolveRequestContext(
          requestedModel,
          customer.allowedGroups
        );

        // 2. Forward to New API gateway with translated model ID and group credential
        await BearlabUpstreamClient.forwardChatCompletion({
          upstreamBaseUrl: options.upstreamBaseUrl,
          upstreamApiKey: context.upstreamApiKey,
          upstreamModelId: context.upstreamModelId || context.originalBearlabModelId,
          originalPayload: body,
          reply,
        });
      } catch (err: any) {
        const statusCode = err.statusCode || 500;
        reply.status(statusCode).send({
          error: {
            message: err.message || 'Internal proxy error.',
            type: err.code || 'api_error',
            code: statusCode,
          },
        });
      }
    });
  };
}
