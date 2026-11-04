import { env } from './config/env.js';
import { createProxyServer } from './proxy/server.js';
import { NextAiDiscordBot } from './bot/client.js';
import { UpstreamCredentialResolver } from './services/credential-resolver.service.js';
import { disconnectPrisma } from './db/client.js';

async function bootstrap() {
  console.log('====================================================');
  console.log('  NEXT AI PROXY HUB — API RESELLER GATEWAY & BOT   ');
  console.log('====================================================');
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`Proxy Gateway Port: ${env.PORT}`);
  console.log(`Public Base URL: ${env.PUBLIC_API_BASE_URL}`);
  console.log(`Upstream Gateway Provider: ${env.NEWAPI_BASE_URL}`);

  // 1. Initialize Upstream Credential Resolver with the 3 separate New API group keys
  const credentialResolver = new UpstreamCredentialResolver({
    newApiKeyGroupA: env.NEWAPI_API_KEY_GROUP_A,
    newApiKeyGroupE: env.NEWAPI_API_KEY_GROUP_E,
    newApiKeyGroupClaude: env.NEWAPI_API_KEY_GROUP_CLAUDE,
  });

  // 2. Start Admin & Business Management Backend (Fastify)
  const proxy = createProxyServer({
    upstreamBaseUrl: env.NEWAPI_BASE_URL,
    credentialResolver,
    enableLegacyProxy: env.ENABLE_LEGACY_PROXY,
  });

  try {
    const address = await proxy.listen({ port: env.PORT, host: env.HOST });
    console.log(`[AdminBackend] Service listening at: ${address}`);
    console.log(`[AdminBackend] Primary Customer Gateway: ${env.NEWAPI_PUBLIC_ENDPOINT}`);
    console.log(`[AdminBackend] Legacy Proxy Status: ${env.ENABLE_LEGACY_PROXY ? 'ENABLED' : 'DEPRECATED/DISABLED'}`);
    console.log(`[AdminBackend] Healthcheck: ${address}/health`);
  } catch (err) {
    console.error('[ReverseProxy] Failed to start server:', err);
    process.exit(1);
  }

  // 3. Initialize & Start Discord Bot
  const adminIds = env.DISCORD_ADMIN_USER_IDS.split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const discordBot = new NextAiDiscordBot({
    token: env.DISCORD_BOT_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    ticketCategoryId: env.DISCORD_TICKET_CATEGORY_ID,
    ticketPanelChannelId: env.TICKET_PANEL_CHANNEL_ID,
    ticketLogChannelId: env.TICKET_LOG_CHANNEL_ID,
    supportRoleId: env.SUPPORT_ROLE_ID,
    adminReviewChannelId: env.DISCORD_ADMIN_REVIEW_CHANNEL_ID,
    adminUserIds: adminIds,
    gatewayUrl: env.PUBLIC_API_BASE_URL,
  });

  if (env.DISCORD_BOT_TOKEN) {
    try {
      await discordBot.start();
    } catch (err: any) {
      console.error('[DiscordBot] Startup error:', err.message);
    }
  } else {
    console.log('[DiscordBot] DISCORD_BOT_TOKEN not configured. Discord Bot disabled (Proxy active).');
  }

  // 4. Graceful Shutdown Handlers
  const handleShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    try {
      await proxy.close();
      if (discordBot.client.isReady()) {
        await discordBot.client.destroy();
      }
      await disconnectPrisma();
      console.log('[Server] Shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrap();
