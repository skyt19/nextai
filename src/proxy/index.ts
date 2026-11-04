import { env } from '../config/env.js';
import { createProxyServer } from './server.js';
import { UpstreamCredentialResolver } from '../services/credential-resolver.service.js';
import { disconnectPrisma } from '../db/client.js';

async function main() {
  const credentialResolver = new UpstreamCredentialResolver({
    newApiKeyGroupA: env.NEWAPI_API_KEY_GROUP_A,
    newApiKeyGroupE: env.NEWAPI_API_KEY_GROUP_E,
    newApiKeyGroupClaude: env.NEWAPI_API_KEY_GROUP_CLAUDE,
  });

  const proxy = createProxyServer({
    upstreamBaseUrl: env.NEWAPI_BASE_URL,
    credentialResolver,
    enableLegacyProxy: env.ENABLE_LEGACY_PROXY,
  });

  try {
    const address = await proxy.listen({ port: env.PORT, host: env.HOST });
    console.log(`[ReverseProxy] Gateway active at: ${address}`);
    console.log(`[ReverseProxy] Endpoints:`);
    console.log(`   - GET  ${address}/v1/models`);
    console.log(`   - POST ${address}/v1/chat/completions`);
    console.log(`   - GET  ${address}/health`);
  } catch (err) {
    console.error('[ReverseProxy] Failed to start:', err);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\n[ReverseProxy] Shutting down...');
    await proxy.close();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
