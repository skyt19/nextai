import { getPrismaClient, disconnectPrisma } from '../src/db/client.js';

async function main() {
  const prisma = getPrismaClient();

  console.log('[Migration] Creating tickets table if not exists...');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "tickets" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "discord_channel_id" TEXT NOT NULL,
      "discord_guild_id" TEXT NOT NULL,
      "owner_discord_id" TEXT NOT NULL,
      "customer_id" TEXT,
      "category" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "claimed_by_discord_id" TEXT,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "closed_at" DATETIME,
      "closed_by_discord_id" TEXT,
      "deleted_at" DATETIME,
      "deleted_by_discord_id" TEXT,
      CONSTRAINT "tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "tickets_discord_channel_id_key" ON "tickets"("discord_channel_id");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "tickets_owner_discord_id_status_idx" ON "tickets"("owner_discord_id", "status");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "tickets_category_status_idx" ON "tickets"("category", "status");
  `);

  console.log('[Migration] Tickets table created successfully.');
}

main()
  .catch((e) => {
    console.error('[Migration] Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectPrisma();
  });
