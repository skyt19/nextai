import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { customerSlashCommands, adminSlashCommands } from '../src/bot/commands/definitions.js';
import { env } from '../src/config/env.js';

async function main() {
  const token = env.DISCORD_BOT_TOKEN;
  const clientId = env.DISCORD_CLIENT_ID;
  const guildId = env.DISCORD_GUILD_ID;

  if (!token || !clientId || !guildId) {
    console.error('Missing Discord configuration in environment.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const allCommands = [...customerSlashCommands, ...adminSlashCommands].map((c) => c.toJSON());

  console.log(`Registering ${allCommands.length} slash commands to guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: allCommands });
  console.log('Slash commands successfully registered to Discord guild!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Registration failed:', err);
  process.exit(1);
});
