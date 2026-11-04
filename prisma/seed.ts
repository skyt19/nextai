import { getPrismaClient, disconnectPrisma } from '../src/db/client.js';
import { STATIC_MODEL_CATALOG } from '../src/services/catalog-data.js';
import { MODEL_GROUPS } from '../src/config/constants.js';

async function main() {
  const prisma = getPrismaClient();

  console.log('[Seed] Seeding 29 models into Model Catalog...');
  for (const model of STATIC_MODEL_CATALOG) {
    await prisma.modelCatalogEntry.upsert({
      where: { publicModelId: model.publicModelId },
      create: {
        publicModelId: model.publicModelId,
        displayName: model.displayName,
        originalBearlabModelId: model.originalBearlabModelId,
        groupId: model.groupId,
        baseCostCny: model.baseCostCny,
        markup: model.markup,
        sellingPriceCny: model.sellingPriceCny,
        enabled: model.enabled,
      },
      update: {
        displayName: model.displayName,
        originalBearlabModelId: model.originalBearlabModelId,
        groupId: model.groupId,
        baseCostCny: model.baseCostCny,
        markup: model.markup,
        sellingPriceCny: model.sellingPriceCny,
        enabled: model.enabled,
      },
    });
  }

  console.log('[Seed] Seeding starter packages...');
  const defaultPackages = [
    {
      name: 'Group A Starter 100',
      groupId: MODEL_GROUPS.GROUP_A,
      referenceRequests: 100,
      referenceModelCostCny: '0.020',
      markup: '2.5',
      sellingPriceThb: '51.00',
      bufferCny: '1.0',
    },
    {
      name: 'Group A Pro 250',
      groupId: MODEL_GROUPS.GROUP_A,
      referenceRequests: 250,
      referenceModelCostCny: '0.020',
      markup: '2.5',
      sellingPriceThb: '128.00',
      bufferCny: '2.0',
    },
    {
      name: 'Group E Starter 100',
      groupId: MODEL_GROUPS.GROUP_E,
      referenceRequests: 100,
      referenceModelCostCny: '0.030',
      markup: '3.0',
      sellingPriceThb: '90.00',
      bufferCny: '1.0',
    },
    {
      name: 'Group E Pro 250',
      groupId: MODEL_GROUPS.GROUP_E,
      referenceRequests: 250,
      referenceModelCostCny: '0.030',
      markup: '3.0',
      sellingPriceThb: '225.00',
      bufferCny: '2.0',
    },
    {
      name: 'Group Claude Starter 100',
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      referenceRequests: 100,
      referenceModelCostCny: '0.030',
      markup: '2.5',
      sellingPriceThb: '75.00',
      bufferCny: '1.0',
    },
    {
      name: 'Group Claude Pro 250',
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      referenceRequests: 250,
      referenceModelCostCny: '0.030',
      markup: '2.5',
      sellingPriceThb: '188.00',
      bufferCny: '2.0',
    },
  ];

  for (const pkg of defaultPackages) {
    const existing = await prisma.package.findFirst({
      where: { name: pkg.name },
    });
    if (!existing) {
      await prisma.package.create({ data: pkg });
    }
  }

  console.log('[Seed] Database seed completed successfully.');
}

main()
  .catch((err) => {
    console.error('[Seed] Error during seeding:', err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectPrisma();
  });
