import { CustomerService } from '../src/services/customer.service.js';
import { MODEL_GROUPS } from '../src/config/constants.js';
import { disconnectPrisma } from '../src/db/client.js';

async function main() {
  const customerService = new CustomerService();
  const testDiscordId = '123456789012345678';
  const testUsername = 'NextAiDemoTester';

  console.log(`[TestSetup] Creating or finding test customer (${testUsername})...`);
  await customerService.findOrCreateCustomer(testDiscordId, testUsername);

  // Generate new API Key
  const { plainTextApiKey } = await customerService.generateOrRotateApiKey(testDiscordId);

  // Assign All Groups for testing
  await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_A);
  await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_E);
  await customerService.assignModelGroup(testDiscordId, MODEL_GROUPS.GROUP_CLAUDE);

  // Credit reference balance
  await customerService.updateRecordedBalance(testDiscordId, '100.00');

  console.log('\n======================================================');
  console.log('✅ TEST CUSTOMER CREATED SUCCESSFULLY');
  console.log('======================================================');
  console.log(`Username:        ${testUsername}`);
  console.log(`Discord User ID: ${testDiscordId}`);
  console.log(`API Key:         ${plainTextApiKey}`);
  console.log(`Assigned Groups: NxG1, NxGE, NxGC`);
  console.log(`Recorded Balance: ¥100.00 CNY`);
  console.log('======================================================\n');
  console.log('You can now test your reverse proxy with:');
  console.log(`curl http://localhost:12345/health\n`);
  console.log(`curl -H "Authorization: Bearer ${plainTextApiKey}" http://localhost:12345/v1/models\n`);
  console.log(`curl -X POST http://localhost:12345/v1/chat/completions \\`);
  console.log(`  -H "Authorization: Bearer ${plainTextApiKey}" \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"model": "gemini-3-1-pro-high-nxg1", "messages": [{"role": "user", "content": "Hello Next AI"}]}'`);
  console.log('======================================================\n');

  await disconnectPrisma();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
