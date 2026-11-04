import { TokenProvisioningService } from '../dist/src/services/token-provisioning.service.js';
import { NewApiManagementService } from '../dist/src/services/newapi-management.service.js';
import { getPrismaClient } from '../dist/src/db/client.js';
import { env } from '../dist/src/config/env.js';

const prisma = getPrismaClient();
const paymentId = 'd60f5f4a-5821-4e9d-ae77-6ceb578aea88';
const adminDiscordId = '791637707318755368';

async function step1_reissueToken() {
  console.log('=== STEP 1: REISSUE TOKEN FOR PAYMENT ===');
  const service = new TokenProvisioningService();
  const result = await service.reissueTokenForApprovedPayment(paymentId, adminDiscordId);

  console.log('Reissue Result:');
  console.log('- Token Record ID:', result.tokenRecord.id);
  console.log('- New API Token ID:', result.tokenRecord.newApiTokenId);
  console.log('- Token Name:', result.tokenRecord.tokenName);
  console.log('- Quota CNY:', result.tokenRecord.quotaCny);
  console.log('- Provisioning Status:', result.tokenRecord.provisioningStatus);
  console.log('- Has Plaintext Key in Result:', Boolean(result.plainTextKey));
  console.log('- Plaintext Key Prefix:', result.plainTextKey?.slice(0, 7));

  return result;
}

async function step2_verifyQuota(newApiTokenId) {
  console.log('\n=== STEP 2: VERIFY REMAINING QUOTA IN NEW API ===');
  const newApi = new NewApiManagementService();
  const token = await newApi.getToken(newApiTokenId);

  console.log('New API Token Details:');
  console.log('- ID:', token.id);
  console.log('- Name:', token.name);
  console.log('- Group:', token.group);
  console.log('- Remain Quota:', token.remain_quota);
  console.log('- Used Quota:', token.used_quota);
  console.log('- Status:', token.status);
  console.log('- Model Limits Enabled:', token.model_limits_enabled);
  console.log('- Model Limits:', token.model_limits);

  return token;
}

async function step3_verifyModelList(plainTextKey) {
  console.log('\n=== STEP 3: VERIFY MODEL LIST WITH CUSTOMER KEY ===');
  const res = await fetch('http://127.0.0.1:3000/v1/models', {
    headers: {
      Authorization: `Bearer ${plainTextKey}`
    }
  });

  console.log('GET /v1/models Status:', res.status);
  const data = await res.json();
  const models = data?.data?.map(m => m.id);
  console.log('Allowed Models Count:', models?.length);
  console.log('Allowed Models:', models);

  return models;
}

async function step4_testChatCompletion(plainTextKey) {
  console.log('\n=== STEP 4: TEST CHAT COMPLETION WITH CUSTOMER KEY ===');
  const res = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${plainTextKey}`
    },
    body: JSON.stringify({
      model: '[A]gemini-2-5-flash-lite',
      messages: [
        { role: 'user', content: 'Reply with the word "PONG" only.' }
      ],
      max_tokens: 10
    })
  });

  console.log('POST /v1/chat/completions Status:', res.status);
  const data = await res.json();
  console.log('Chat Completion Response:');
  console.log('- Content:', data?.choices?.[0]?.message?.content);
  console.log('- Model:', data?.model);
  console.log('- Usage:', data?.usage);

  return data;
}

async function step5_deliverToDiscord(tokenRecordId) {
  console.log('\n=== STEP 5: DELIVER TO DISCORD PRIVATE TICKET ===');
  const botToken = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const customerDiscordId = '791637707318755368';
  const categoryId = env.DISCORD_TICKET_CATEGORY_ID;

  // 1. Create a fresh private ticket channel for shiina.chan on Discord
  console.log('Creating private ticket channel on Discord...');
  const createChannelRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${botToken}`
    },
    body: JSON.stringify({
      name: `ticket-shiina-chan-recovery`,
      type: 0,
      parent_id: categoryId,
      permission_overwrites: [
        {
          id: guildId, // @everyone
          type: 0,
          deny: '1024' // ViewChannel
        },
        {
          id: customerDiscordId, // customer
          type: 1,
          allow: '68608' // ViewChannel, SendMessages, ReadMessageHistory, AttachFiles
        },
        {
          id: env.DISCORD_CLIENT_ID, // bot
          type: 1,
          allow: '68608'
        }
      ]
    })
  });

  if (!createChannelRes.ok) {
    const errText = await createChannelRes.text();
    throw new Error(`Failed to create Discord ticket channel: ${createChannelRes.status} ${errText}`);
  }

  const channelData = await createChannelRes.json();
  const newChannelId = channelData.id;
  console.log(`Created private ticket channel: <#${newChannelId}> (${channelData.name})`);

  // 2. Update payment ticketChannelId in database to the active channel
  await prisma.payment.update({
    where: { id: paymentId },
    data: { ticketChannelId: newChannelId }
  });

  // 3. Deliver token using TokenProvisioningService
  const channelObj = {
    send: async (msg) => {
      const sendRes = await fetch(`https://discord.com/api/v10/channels/${newChannelId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`
        },
        body: JSON.stringify(msg)
      });
      if (!sendRes.ok) {
        throw new Error(`Discord message send failed with status ${sendRes.status}: ${await sendRes.text()}`);
      }
      return await sendRes.json();
    }
  };

  const service = new TokenProvisioningService();
  const deliveryResult = await service.deliverTokenToDiscord(tokenRecordId, channelObj);
  console.log('Delivery Result:', deliveryResult);

  // 4. Verify DB state after delivery
  const updatedRecord = await prisma.customerTokenRecord.findUnique({
    where: { id: tokenRecordId }
  });
  console.log('Database state after delivery:');
  console.log('- Status:', updatedRecord.provisioningStatus);
  console.log('- Has Encrypted Key:', Boolean(updatedRecord.encryptedKey));
  console.log('- Delivered At:', updatedRecord.deliveredAt);

  return { newChannelId, deliveryResult, updatedRecord };
}

async function main() {
  try {
    const step1 = await step1_reissueToken();
    const newApiTokenId = step1.tokenRecord.newApiTokenId;
    const plainTextKey = step1.plainTextKey;

    const step2 = await step2_verifyQuota(newApiTokenId);
    const step3 = await step3_verifyModelList(plainTextKey);
    const step4 = await step4_testChatCompletion(plainTextKey);
    const step5 = await step5_deliverToDiscord(step1.tokenRecord.id);

    console.log('\n=== REAL INTEGRATION COMPLETED SUCCESSFULLY! ===');
  } catch (err) {
    console.error('\n❌ REAL INTEGRATION FAILED:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
