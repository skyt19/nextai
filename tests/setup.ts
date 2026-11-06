import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

// Ensure PostgreSQL DATABASE_URL is available for Prisma
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('file:')) {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres.rotkeqiskjwzechfporj:0926671327df@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true';
}

// 2. Set fake test credentials to guarantee real keys are never loaded or probed
process.env.NODE_ENV = 'test';
process.env.NEWAPI_BASE_URL = 'http://127.0.0.1:54321/v1';
process.env.UPSTREAM_BASE_URL = 'http://127.0.0.1:54321/v1';
process.env.NEWAPI_API_KEY_GROUP_A = 'fake-newapi-key-group-a';
process.env.NEWAPI_API_KEY_GROUP_E = 'fake-newapi-key-group-e';
process.env.NEWAPI_API_KEY_GROUP_CLAUDE = 'fake-newapi-key-group-claude';
process.env.BEARLAB_API_KEY_GROUP_A = 'fake-bearlab-key-group-a';
process.env.BEARLAB_API_KEY_GROUP_E = 'fake-bearlab-key-group-e';
process.env.BEARLAB_API_KEY_GROUP_CLAUDE = 'fake-bearlab-key-group-claude';

// 3. Global network guard: Strictly block any real outbound network requests
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  // Allow local mock servers (127.0.0.1 / localhost)
  if (url.includes('127.0.0.1') || url.includes('localhost')) {
    return originalFetch(input, init);
  }

  // Intercept Frankfurter API with deterministic offline fixture
  if (url.includes('api.frankfurter.dev') || url.includes('frankfurter')) {
    const fixtureData = [
      { date: '2026-11-03', base: 'CNY', quote: 'THB', rate: 5.0764 },
      { date: '2026-11-03', base: 'CNY', quote: 'USD', rate: 0.1415 },
    ];
    return new Response(JSON.stringify(fixtureData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Prohibit any other outbound network request (including real BearLab, OpenAI, Discord, etc.)
  throw new Error(`[CRITICAL SECURITY GUARD] Prohibited outbound network call to '${url}' in isolated test mode!`);
};
