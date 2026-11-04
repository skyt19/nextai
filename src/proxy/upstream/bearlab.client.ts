import { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';

export interface ForwardChatOptions {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  upstreamModelId: string;
  originalPayload: Record<string, any>;
  reply: FastifyReply;
  timeoutMs?: number;
}

export class BearlabUpstreamClient {
  /**
   * Forwards a chat completion request to Bearlab AI.
   * Seamlessly handles both SSE streaming and non-streaming JSON responses.
   * STRICT SECURITY: Bearlab API keys and internal URLs are never logged or exposed.
   */
  public static async forwardChatCompletion(options: ForwardChatOptions): Promise<void> {
    const { upstreamBaseUrl, upstreamApiKey, upstreamModelId, originalPayload, reply, timeoutMs = 60000 } = options;

    const targetUrl = `${upstreamBaseUrl}/chat/completions`;

    // Clone request payload and replace ONLY the model identifier
    const transformedBody: Record<string, any> = {
      ...originalPayload,
      model: upstreamModelId,
    };

    const isStreaming = Boolean(transformedBody.stream);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${upstreamApiKey}`,
          Accept: isStreaming ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(transformedBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // 1. Handle upstream errors
      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch {
          errorData = { message: `Upstream error ${response.status}: ${response.statusText}` };
        }

        // Sanitize error message to ensure no upstream secrets are included
        const sanitizedMessage = typeof errorData.error?.message === 'string'
          ? errorData.error.message.replace(upstreamApiKey, '[REDACTED]')
          : 'Upstream provider returned an error.';

        reply.status(response.status).send({
          error: {
            message: sanitizedMessage,
            type: errorData.error?.type || 'upstream_error',
            code: response.status,
          },
        });
        return;
      }

      // 2. Handle SSE Streaming Response (without full buffering)
      if (isStreaming && response.body) {
        reply.raw.writeHead(response.status, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const nodeStream = Readable.fromWeb(response.body as any);

        nodeStream.on('data', (chunk) => {
          reply.raw.write(chunk);
        });

        nodeStream.on('end', () => {
          reply.raw.end();
        });

        nodeStream.on('error', (err) => {
          console.error('[ReverseProxy] Streaming error from upstream:', err.message);
          reply.raw.destroy(err);
        });

        return;
      }

      // 3. Handle standard non-streaming JSON Response
      const responseJson: any = await response.json();

      // Ensure public model name is restored if upstream reflects Bearlab ID
      if (responseJson && typeof responseJson === 'object' && responseJson.model) {
        responseJson.model = originalPayload.model;
      }

      reply.status(response.status).send(responseJson);
    } catch (err: any) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        reply.status(504).send({
          error: {
            message: 'Gateway Timeout: Upstream server did not respond in time.',
            type: 'gateway_timeout',
            code: 504,
          },
        });
        return;
      }

      reply.status(502).send({
        error: {
          message: 'Bad Gateway: Unable to reach upstream server.',
          type: 'bad_gateway',
          code: 502,
        },
      });
    }
  }
}

export const NewApiUpstreamClient = BearlabUpstreamClient;
export const UpstreamClient = BearlabUpstreamClient;
