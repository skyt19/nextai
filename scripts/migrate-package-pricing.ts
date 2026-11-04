import { getPrismaClient, disconnectPrisma } from '../src/db/client.js';

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: any;
  pk: number;
}

async function main() {
  const prisma = getPrismaClient();

  console.log('[Migration] Checking columns on packages table...');
  const columns = (await prisma.$queryRawUnsafe('PRAGMA table_info(packages);')) as ColumnInfo[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('reference_model_id')) {
    console.log('[Migration] Adding column reference_model_id...');
    await prisma.$executeRawUnsafe(`ALTER TABLE "packages" ADD COLUMN "reference_model_id" TEXT;`);
  } else {
    console.log('[Migration] Column reference_model_id already exists.');
  }

  if (!columnNames.has('package_selling_price_thb')) {
    console.log('[Migration] Adding column package_selling_price_thb...');
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "packages" ADD COLUMN "package_selling_price_thb" DECIMAL NOT NULL DEFAULT 51.00;`
    );
  } else {
    console.log('[Migration] Column package_selling_price_thb already exists.');
  }

  // Ensure NxG1 100 requests package is configured properly
  console.log('[Migration] Updating default NxG1 package configuration (51 THB, 0 buffer, 0.020 BP)...');
  await prisma.$executeRawUnsafe(`
    UPDATE "packages"
    SET "package_selling_price_thb" = 51.00,
        "buffer_cny" = 0.0,
        "reference_model_id" = 'gemini-3-1-pro-high-nxg1',
        "reference_model_cost_cny" = 0.020,
        "markup" = 2.5
    WHERE "group_id" = 'NxG1' AND "reference_requests" = 100;
  `);

  console.log('[Migration] Package schema migration completed successfully.');
}

main()
  .catch((e) => {
    console.error('[Migration] Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectPrisma();
  });
