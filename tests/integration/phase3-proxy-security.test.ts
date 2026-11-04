import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createProxyServer } from '../../src/proxy/server.js';
import { createMockBearlabServer, MockBearlabServer } from '../mocks/bearlab.mock.js';
import { CustomerService } from '../../src/services/customer.service.js';
import { UpstreamCredentialResolver } from '../../src/services/credential-resolver.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('Phase 3: Reverse Proxy Security & Edge Case Testing', () => {
  let mockBearlab: MockBearlabServer;
  let proxyServer: FastifyInstance;
  const customerService = new CustomerService();
  const prisma = getPrismaClient();

  const fakeGroupAKey = 'fake-secret-group-a-key-9999999999';
  const fakeGroupEKey = 'fake-secret-group-e-key-8888888888';
  const fakeGroupClaudeKey = 'fake-secret-group-claude-key-7777777777';

  const testUserId = 'phase3-security-test-user';
  let testCustomerApiKey = '';
  let customerDbId = '';

  beforeAll(async () => {
    // 1. Mock Bearlab server strictly bound to 127.0.0.1
    mockBearlab = createMockBearlabServer();
    const mockUrl = await mockBearlab.start();

    // 2. Upstream Credential Resolver with isolated fake keys
    const credentialResolver = new UpstreamCredentialResolver({
      keyGroupA: fakeGroupAKey,
      keyGroupE: fakeGroupEKey,
      keyGroupClaude: fakeGroupClaudeKey,
    });

    // 3. Fastify Reverse Proxy Server
    proxyServer = createProxyServer({
      upstreamBaseUrl: mockUrl,
      customerService,
      credentialResolver,
    });
    await proxyServer.ready();

    // 4. Create customer with Group A and 100.00 CNY balance
    const { customerId } = await customerService.findOrCreateCustomer(testUserId, 'SecurityTester');
    customerDbId = customerId;
    const keyResult = await customerService.generateOrRotateApiKey(testUserId);
    testCustomerApiKey = keyResult.plainTextApiKey;
    await customerService.assignModelGroup(testUserId, MODEL_GROUPS.GROUP_A);
    await customerService.updateRecordedBalance(testUserId, '100.00');
  });

  afterAll(async () => {
    await proxyServer.close();
    await mockBearlab.stop();
    try {
      await prisma.customer.deleteMany({
        where: { discordUserId: testUserId },
      });
    } catch {
      // Ignore
    }
  });

  it('1. Authentication via Nextai-Api-Key header works identically to Bearer token', async () => {
    const response = await proxyServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'nextai-api-key': testCustomerApiKey,
        'content-type': 'application/json',
      },
      payload: {
        model: 'gemini-3-1-pro-high-nxg1',
        messages: [{ role: 'user', content: 'Testing custom header auth' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.choices[0].message.content).toContain('Mock Bearlab response');
  });

  it('2. Cross-group request is rejected with 403 Forbidden', async () => {
    // Customer has only Group A; calling Group Claude model
    const response = await proxyServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${testCustomerApiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        model: 'claude-sonnet-4-5-nxgc',
        messages: [{ role: 'user', content: 'Testing Claude' }],
      },
    });

    expect(response.statusCode).toBe(403);
    const json = JSON.parse(response.body);
    expect(json.error.message).toContain('not assigned to your account');
  });

  it('3. Credential isolation: fake upstream key is NEVER exposed in headers, body, or error messages', async () => {
    const response = await proxyServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${testCustomerApiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        model: 'gemini-3-1-pro-high-nxg1',
        messages: [{ role: 'user', content: 'Check secrets' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(fakeGroupAKey);
    expect(JSON.stringify(response.headers)).not.toContain(fakeGroupAKey);
  });

  it('4. Zero local billing deduction: customer balance is unchanged after request', async () => {
    const custBefore = await prisma.customer.findUniqueOrThrow({
      where: { id: customerDbId },
    });
    expect(new Decimal(custBefore.balance.toString()).toFixed(2)).toBe('100.00');

    // Perform completion
    await proxyServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${testCustomerApiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        model: 'gemini-3-1-pro-high-nxg1',
        messages: [{ role: 'user', content: 'Test billing' }],
      },
    });

    const custAfter = await prisma.customer.findUniqueOrThrow({
      where: { id: customerDbId },
    });
    expect(new Decimal(custAfter.balance.toString()).toFixed(2)).toBe('100.00');
  });

  it('5. Malformed JSON returns 400 Bad Request', async () => {
    const response = await proxyServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${testCustomerApiKey}`,
        'content-type': 'application/json',
      },
      body: '{ malformed json... ',
    });

    expect(response.statusCode).toBe(400);
  });

  it('6. Missing model field returns 400 Bad Request', async () => {
    const response = await proxyServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${testCustomerApiKey}`,
        'content-type': 'application/json',
      },
      payload: {
        messages: [{ role: 'user', content: 'No model specified' }],
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.error.message).toContain("Missing or invalid 'model'");
  });

  it('7. Handles concurrent requests cleanly without race conditions', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      proxyServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${testCustomerApiKey}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'gemini-3-1-pro-high-nxg1',
          messages: [{ role: 'user', content: `Concurrent query ${i}` }],
        },
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.choices[0].message.content).toContain('Mock Bearlab response');
    }
  });
});
