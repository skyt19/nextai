import Fastify, { FastifyInstance } from 'fastify';

export interface MockBearlabServer {
  server: FastifyInstance;
  url: string;
  lastRequest: {
    headers: Record<string, any>;
    body: any;
  } | null;
  start: () => Promise<string>;
  stop: () => Promise<void>;
}

export function createMockBearlabServer(): MockBearlabServer {
  const fastify = Fastify({ logger: false });
  let lastRequest: { headers: Record<string, any>; body: any } | null = null;
  let serverUrl = '';

  fastify.post('/chat/completions', async (request, reply) => {
    lastRequest = {
      headers: request.headers,
      body: request.body,
    };

    const body = request.body as any;
    const auth = request.headers.authorization;

    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.status(401).send({ error: { message: 'Unauthorized upstream', type: 'auth_error' } });
    }

    // Streaming mode
    if (body.stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const chunk1 = {
        id: 'chatcmpl-mock-123',
        object: 'chat.completion.chunk',
        created: 1762084800,
        model: body.model,
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      };

      const chunk2 = {
        id: 'chatcmpl-mock-123',
        object: 'chat.completion.chunk',
        created: 1762084800,
        model: body.model,
        choices: [{ index: 0, delta: { content: ' world!' }, finish_reason: 'stop' }],
      };

      reply.raw.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      reply.raw.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    // Non-streaming mode
    return reply.status(200).send({
      id: 'chatcmpl-mock-456',
      object: 'chat.completion',
      created: 1762084800,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `Mock Bearlab response for model ${body.model}`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 12,
        total_tokens: 22,
      },
    });
  });

  return {
    get server() {
      return fastify;
    },
    get url() {
      return serverUrl;
    },
    get lastRequest() {
      return lastRequest;
    },
    async start() {
      const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
      serverUrl = address;
      return address;
    },
    async stop() {
      await fastify.close();
    },
  };
}
