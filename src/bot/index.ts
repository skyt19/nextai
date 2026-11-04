import { env } from '../config/env.js';
import { NextAiDiscordBot } from './client.js';
import { disconnectPrisma } from '../db/client.js';

async function main() {
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
    promptPayId: env.PROMPTPAY_ID,
  });

  if (!env.DISCORD_BOT_TOKEN) {
    console.error('[DiscordBot] DISCORD_BOT_TOKEN is required to run the bot.');
    process.exit(1);
  }

  try {
    await discordBot.start();
    console.log('[DiscordBot] Bot is online and listening for events.');
  } catch (err: any) {
    console.error('[DiscordBot] Failed to start:', err.message);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\n[DiscordBot] Shutting down...');
    if (discordBot.client.isReady()) {
      await discordBot.client.destroy();
    }
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
