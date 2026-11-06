import { describe, it, expect, vi } from 'vitest';
import { TokenProvisioningService } from '../../src/services/token-provisioning.service.js';
import { BotEmbeds } from '../../src/bot/ui/embeds.js';
import { adminSlashCommands } from '../../src/bot/commands/definitions.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('Manual Key Issuance & /issue-key Command Tests', () => {
  it('should define the /issue-key admin slash command with correct options', () => {
    const issueKeyCmd = adminSlashCommands.find((c) => c.name === 'issue-key');
    expect(issueKeyCmd).toBeDefined();

    const json = issueKeyCmd!.toJSON();
    expect(json.name).toBe('issue-key');
    expect(json.description).toContain('ออก API Key ให้ผู้ใช้ NewAPI');

    const optNames = json.options?.map((o: any) => o.name);
    expect(optNames).toContain('group');
    expect(optNames).toContain('requests');
    expect(optNames).toContain('user');
    expect(optNames).toContain('user_id');
    expect(optNames).toContain('username');
    expect(optNames).toContain('markup');
    expect(optNames).toContain('custom_name');
    expect(optNames).toContain('dm_customer');
  });

  it('should correctly calculate quota CNY and NewAPI units for all groups', async () => {
    let idCounter = 100;
    const mockNewApiService: any = {
      createToken: vi.fn().mockImplementation(async (input: any) => ({
        id: ++idCounter,
        key: `sk-test-mock-key-${idCounter}-${Math.random().toString(36).substring(2, 8)}`,
        name: input.name,
        remain_quota: input.remain_quota,
      })),
    };

    const service = new TokenProvisioningService(mockNewApiService);

    // Test Group A: 100 requests × 0.02 base cost × 2.5 markup = 5.00 CNY
    const resultA = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_A,
      requests: 100,
      discordUserId: 'test-user-a',
      username: 'UserA',
    });

    expect(resultA.baseCostCny).toBe(0.02);
    expect(resultA.markup).toBe(2.5);
    expect(resultA.quotaCny.toNumber()).toBe(5.0);
    expect(resultA.quotaUnits).toBe(373134);
    expect(resultA.plainTextKey).toContain('sk-test-mock-key-');
    expect(resultA.groupDisplayName).toContain('Group A [NxG1]');

    // Test Group E: 100 requests × 0.03 base cost × 3.0 markup = 9.00 CNY
    const resultE = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_E,
      requests: 100,
      discordUserId: 'test-user-e',
      username: 'UserE',
    });

    expect(resultE.baseCostCny).toBe(0.03);
    expect(resultE.markup).toBe(3.0);
    expect(resultE.quotaCny.toNumber()).toBe(9.0);
    expect(resultE.quotaUnits).toBe(671642);

    // Test Group Claude: 100 requests × 0.03 base cost × 2.5 markup = 7.50 CNY
    const resultClaude = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      requests: 100,
      discordUserId: 'test-user-c',
      username: 'UserClaude',
    });

    expect(resultClaude.baseCostCny).toBe(0.03);
    expect(resultClaude.markup).toBe(2.5);
    expect(resultClaude.quotaCny.toNumber()).toBe(7.5);
    expect(resultClaude.quotaUnits).toBe(559701);

    // Test custom markup override: e.g. 3.5 markup on Group Claude (100 reqs × 0.03 × 3.5 = 10.5 CNY)
    const resultCustom = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      requests: 100,
      markup: 3.5,
      discordUserId: 'test-user-c',
      username: 'UserClaude',
    });

    expect(resultCustom.markup).toBe(3.5);
    expect(resultCustom.quotaCny.toNumber()).toBe(10.5);
  });

  it('should format BotEmbeds.manualKeyIssued with Endpoint, Key, and Group Model', () => {
    const embed = BotEmbeds.manualKeyIssued({
      plainTextKey: 'sk-sealapi-sample-key-abcdef123456',
      tokenName: 'NxGC - 791637707318755368 - somchai',
      groupId: 'NxGC',
      groupDisplayName: 'Group Claude [NxGC] (Claude 3.5/3.7 & Opus)',
      requests: 500,
      baseCostCny: 0.03,
      markup: 2.5,
      quotaCny: new Decimal(37.5),
      quotaUnits: 2798507,
      allowedModels: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'],
      gatewayUrl: 'https://next-newapi.onrender.com/v1',
      discordUserId: '791637707318755368',
      username: 'somchai',
    });

    const data = embed.toJSON();
    expect(data.title).toContain('จัดการออก API Key สำเร็จเรียบร้อยแล้ว');
    expect(data.color).toBe(0x00d26a); // Emerald Green
    expect(data.description).toContain('Endpoint :');
    expect(data.description).toContain('https://next-newapi.onrender.com/v1');
    expect(data.description).toContain('Key :');
    expect(data.description).toContain('sk-sealapi-sample-key-abcdef123456');
    expect(data.description).toContain('Group Model :');
    expect(data.description).toContain('Group Claude [NxGC]');
    expect(data.description).toContain('500 Requests');
    expect(data.description).toContain('¥37.50 CNY');
  });
});
