import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ModelCatalogService } from '../../services/catalog.service.js';

export function createModelsRoute(catalogService: ModelCatalogService = new ModelCatalogService()): FastifyPluginAsync {
  return async function modelsPlugin(fastify: FastifyInstance): Promise<void> {
    fastify.get('/v1/models', async (request, reply) => {
      const customer = request.customer;
      if (!customer) {
        reply.status(401).send({ error: { message: 'Unauthorized', type: 'invalid_request_error' } });
        return;
      }

      // Filter models strictly to the customer's allowed model groups
      const openAiList = catalogService.formatOpenAIModelList(customer.allowedGroups);

      return reply.status(200).send(openAiList);
    });
  };
}
