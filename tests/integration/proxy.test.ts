import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createProxyServer } from '../../src/proxy/server.js';
import { createMockBearlabServer, MockBearlabServer } from '../mocks/bearlab.mock.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { UpstreamCredentialResolver } from '../../src/services/credential-resolver.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { KEY_STATUS, MODEL_GROUPS } from '../../src/config/constants.js';

describe('Reverse Proxy Gateway Integration Tests (Port 12345/v1)', () => {
  let mockBearlab: MockBearlabServer;
  let proxyServer: FastifyInstance;
  const customerService = new CustomerService();
  const prisma = getPrismaClient();

  const testGroupAKey = 'bearlab-secret-key-group-a-1111';
  const testGroupEKey = 'bearlab-secret-key-group-e-2222';
  const testGroupClaudeKey = 'bearlab-secret-key-group-claude-3333';

  const customerIdA = 'proxy-test-user-group-a';
  let customerApiKeyA = '';

  const customerIdAll = 'proxy-test-user-all-groups';
  let customerApiKeyAll = '';

  beforeAll(async () => {
    // 1. Start mock Bearlab server
    mockBearlab = createMockBearlabServer();
    const mockUrl = await mockBearlab.start();

    // 2. Set up UpstreamCredentialResolver with the 3 separate group keys
    const credentialResolver = new UpstreamCredentialResolver({
      keyGroupA: testGroupAKey,
      keyGroupE: testGroupEKey,
      keyGroupClaude: testGroupClaudeKey,
    });

    // 3. Create Fastify Reverse Proxy Server
    proxyServer = createProxyServer({
      upstreamBaseUrl: mockUrl,
      customerService,
      credentialResolver,
    });
    await proxyServer.ready();

    // 4. Create Test Customers in DB
    // Customer 1: Only Group A
    await customerService.findOrCreateCustomer(customerIdA, 'CustomerA');
    const keyResultA = await customerService.generateOrRotateApiKey(customerIdA);
    customerApiKeyA = keyResultA.plainTextApiKey;
    await customerService.assignModelGroup(customerIdA, MODEL_GROUPS.GROUP_A);

    // Customer 2: All Groups (A, E, Claude)
    await customerService.findOrCreateCustomer(customerIdAll, 'CustomerAll');
    const keyResultAll = await customerService.generateOrRotateApiKey(customerIdAll);
    customerApiKeyAll = keyResultAll.plainTextApiKey;
    await customerService.assignModelGroup(customerIdAll, MODEL_GROUPS.GROUP_A);
    await customerService.assignModelGroup(customerIdAll, MODEL_GROUPS.GROUP_E);
    await customerService.assignModelGroup(customerIdAll, MODEL_GROUPS.GROUP_CLAUDE);
  });

  afterAll(async () => {
    await proxyServer.close();
    await mockBearlab.stop();
    try {
      await prisma.customer.deleteMany({
        where: { discordUserId: { in: [customerIdA, customerIdAll] } },
      });
    } catch {
      // Ignore
    }
  });

  describe('1. Healthcheck & Authentication Guards', () => {
    it('GET /health returns 200 without authentication', async () => {
      const response = await proxyServer.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.status).toBe('ok');
      expect(json.service).toBe('SealAPI Hub');
    });

    it('GET /v1/models rejects requests without Authorization header with 401', async () => {
      const response = await proxyServer.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(response.statusCode).toBe(401);
      const json = JSON.parse(response.body);
      expect(json.error.type).toBe('invalid_request_error');
    });

    it('GET /v1/models rejects invalid API keys with 401', async () => {
      const response = await proxyServer.inject({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: 'Bearer nx-live-fake-invalid-key-000000000000000000000000000000000000',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('GET /v1/models rejects disabled keys with 403', async () => {
      // Temporarily disable customer key
      await customerService.updateKeyStatus(customerIdA, KEY_STATUS.DISABLED);

      const response = await proxyServer.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${customerApiKeyA}` },
      });

      expect(response.statusCode).toBe(403);

      // Re-enable key
      await customerService.updateKeyStatus(customerIdA, KEY_STATUS.ACTIVE);
    });
  });

  describe('2. Model Listing Isolation (GET /v1/models)', () => {
    it('returns only Group A models for Customer A and hides other groups', async () => {
      const response = await proxyServer.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${customerApiKeyA}` },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.object).toBe('list');
      expect(json.data.length).toBe(8);

      for (const model of json.data) {
        expect(model.group).toBe(MODEL_GROUPS.GROUP_A);
        expect(model.id).not.toContain('[A]');
        expect(model.id).toContain('-nxg1');
      }
    });

    it('returns all 29 models across groups for Customer with all groups assigned', async () => {
      const response = await proxyServer.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${customerApiKeyAll}` },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.data.length).toBe(29);
    });
  });

  describe('3. Chat Completion Request Forwarding (POST /v1/chat/completions)', () => {
    it('forwards Group A model request with BEARLAB_API_KEY_GROUP_A and translated model ID', async () => {
      const response = await proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyA}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-3-1-pro-high-nxg1',
          messages: [{ role: 'user', content: 'Hello Next AI' }],
          temperature: 0.7,
        },
      });

      expect(response.statusCode).toBe(200);

      // Verify what mock Bearlab upstream received
      const upstreamReq = mockBearlab.lastRequest;
      expect(upstreamReq).toBeDefined();
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${testGroupAKey}`);
      expect(upstreamReq?.body.model).toBe('[A]gemini-3-1-pro-high');
      expect(upstreamReq?.body.messages[0].content).toBe('Hello Next AI');
      expect(upstreamReq?.body.temperature).toBe(0.7);

      // Verify response returned to customer has public model name restored
      const json = JSON.parse(response.body);
      expect(json.model).toBe('gemini-3-1-pro-high-nxg1');
      expect(json.choices[0].message.content).toContain('Mock Bearlab response');
    });

    it('forwards Group E model request with BEARLAB_API_KEY_GROUP_E and translated model ID', async () => {
      const response = await proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyAll}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-2-5-pro-nxge',
          messages: [{ role: 'user', content: 'Testing Group E' }],
        },
      });

      expect(response.statusCode).toBe(200);

      const upstreamReq = mockBearlab.lastRequest;
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${testGroupEKey}`);
      expect(upstreamReq?.body.model).toBe('[E]gemini-2.5-pro');
    });

    it('forwards Group Claude model request with BEARLAB_API_KEY_GROUP_CLAUDE and [次] preserved', async () => {
      const response = await proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyAll}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'claude-sonnet-4-5-nxgc',
          messages: [{ role: 'user', content: 'Testing Claude' }],
        },
      });

      expect(response.statusCode).toBe(200);

      const upstreamReq = mockBearlab.lastRequest;
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${testGroupClaudeKey}`);
      expect(upstreamReq?.body.model).toBe('claude-sonnet-4-5[次]');
    });

    it('handles SSE streaming (stream: true) chunk by chunk without buffering', async () => {
      const response = await proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyA}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-2-5-flash-nxg1',
          messages: [{ role: 'user', content: 'Stream test' }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('data: {"id":"chatcmpl-mock-123"');
      expect(response.body).toContain('data: [DONE]');
    });

    it('rejects model outside customer assigned groups with 403 Forbidden', async () => {
      // Customer A (only Group A) attempts to access Group E model
      const response = await proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyA}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-2-5-pro-nxge',
          messages: [{ role: 'user', content: 'Unauthorized group test' }],
        },
      });

      expect(response.statusCode).toBe(403);
      const json = JSON.parse(response.body);
      expect(json.error.message).toContain("not assigned to your account");
    });

    it('rejects unknown model ID with 404 Model Not Found', async () => {
      const response = await proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyAll}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'non-existent-ai-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });

      expect(response.statusCode).toBe(404);
      const json = JSON.parse(response.body);
      expect(json.error.message).toContain("does not exist");
    });
  });

  describe('5. New API Gateway Upstream Routing', () => {
    let mockNewApiGateway: MockBearlabServer;
    let newApiProxyServer: FastifyInstance;

    const newApiGroupAKey = 'newapi-sk-group-a-secret-777';
    const newApiGroupEKey = 'newapi-sk-group-e-secret-888';
    const newApiClaudeKey = 'newapi-sk-group-claude-secret-999';

    beforeAll(async () => {
      // 1. Mock local New API gateway instance (OpenAI-compatible)
      mockNewApiGateway = createMockBearlabServer();
      const gatewayUrl = await mockNewApiGateway.start();

      // 2. Resolver configured strictly with New API keys (no BearLab keys)
      const newApiResolver = new UpstreamCredentialResolver({
        newApiKeyGroupA: newApiGroupAKey,
        newApiKeyGroupE: newApiGroupEKey,
        newApiKeyGroupClaude: newApiClaudeKey,
      });

      // 3. Proxy pointing to New API gateway
      newApiProxyServer = createProxyServer({
        upstreamBaseUrl: gatewayUrl,
        customerService,
        credentialResolver: newApiResolver,
      });
      await newApiProxyServer.ready();
    });

    afterAll(async () => {
      await newApiProxyServer.close();
      await mockNewApiGateway.stop();
    });

    it('routes NxG1 model to New API gateway with New API Group A key and restores public model name', async () => {
      const response = await newApiProxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyAll}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-3-1-pro-high-nxg1',
          messages: [{ role: 'user', content: 'Testing New API Group A' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      // Customer sees public model ID, not internal upstream ID
      expect(json.model).toBe('gemini-3-1-pro-high-nxg1');

      // Upstream gateway receives translated model ID and New API Group A key
      const upstreamReq = mockNewApiGateway.lastRequest;
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${newApiGroupAKey}`);
      expect(upstreamReq?.body.model).toBe('[A]gemini-3-1-pro-high');
    });

    it('routes NxGE model to New API gateway with New API Group E key', async () => {
      const response = await newApiProxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyAll}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-2-5-pro-nxge',
          messages: [{ role: 'user', content: 'Testing New API Group E' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const upstreamReq = mockNewApiGateway.lastRequest;
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${newApiGroupEKey}`);
      expect(upstreamReq?.body.model).toBe('[E]gemini-2.5-pro');
    });

    it('routes NxGC model to New API gateway with New API Claude key and preserves [次]', async () => {
      const response = await newApiProxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyAll}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'claude-sonnet-4-5-nxgc',
          messages: [{ role: 'user', content: 'Testing New API Claude' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const upstreamReq = mockNewApiGateway.lastRequest;
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${newApiClaudeKey}`);
      expect(upstreamReq?.body.model).toBe('claude-sonnet-4-5[次]');
    });

    it('preserves SSE streaming chunk by chunk with New API gateway', async () => {
      const response = await newApiProxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${customerApiKeyA}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-2-5-flash-nxg1',
          messages: [{ role: 'user', content: 'Streaming test' }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('data: {"id":"chatcmpl-mock-123"');
      expect(response.body).toContain('data: [DONE]');

      const upstreamReq = mockNewApiGateway.lastRequest;
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${newApiGroupAKey}`);
      expect(upstreamReq?.body.model).toBe('[A]gemini-2-5-flash');
    });
  });
});
