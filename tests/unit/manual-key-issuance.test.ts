import { describe, it, expect, vi } from 'vitest';
import { TokenProvisioningService } from '../../src/services/token-provisioning.service.js';
import { BotEmbeds } from '../../src/bot/ui/embeds.js';
import { adminSlashCommands } from '../../src/bot/commands/definitions.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('Manual Key Issuance & /issue-key Command Tests', () => {
  it('should define the /issue-key admin slash command with username, requests (250 starter), and group options', () => {
    const issueKeyCmd = adminSlashCommands.find((c) => c.name === 'issue-key');
    expect(issueKeyCmd).toBeDefined();

    const json = issueKeyCmd!.toJSON();
    expect(json.name).toBe('issue-key');
    expect(json.description).toContain('ออก API Key');

    const optNames = json.options?.map((o: any) => o.name);
    expect(optNames).toContain('username');
    expect(optNames).toContain('requests');
    expect(optNames).toContain('group');
    expect(optNames).toContain('markup');
    expect(optNames).toContain('custom_name');

    // Verify requests choices has 250 Starter Pack
    const reqOpt: any = json.options?.find((o: any) => o.name === 'requests');
    expect(reqOpt).toBeDefined();
    const reqChoices = reqOpt.choices.map((c: any) => c.value);
    expect(reqChoices).toEqual([250, 500, 750, 1000]);
  });

  it('should correctly calculate quota CNY and NewAPI units for all groups including 250 Starter Pack', async () => {
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

    // Test Group Claude: 250 Starter Pack requests × 0.03 base cost × 2.5 markup = 18.75 CNY
    const resultClaude = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      requests: 250,
      username: 'somchai_ig',
    });

    expect(resultClaude.baseCostCny).toBe(0.03);
    expect(resultClaude.markup).toBe(2.5);
    expect(resultClaude.quotaCny.toNumber()).toBe(18.75);
    expect(resultClaude.quotaUnits).toBe(1399254);
    expect(resultClaude.plainTextKey).toContain('sk-test-mock-key-');
    expect(resultClaude.tokenName).toBe('SxGC - somchai_ig');
    expect(resultClaude.groupDisplayName).toContain('Group Claude [SxGC]');

    // Test Group Claude LM (SxCGL): 250 Starter Pack requests × 0.03 base cost × 2.5 markup = 18.75 CNY
    const resultClaudeLm = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_CLAUDE_LM,
      requests: 250,
      username: 'snxrff_ig',
    });

    expect(resultClaudeLm.baseCostCny).toBe(0.03);
    expect(resultClaudeLm.markup).toBe(2.5);
    expect(resultClaudeLm.quotaCny.toNumber()).toBe(18.75);
    expect(resultClaudeLm.quotaUnits).toBe(1399254);
    expect(resultClaudeLm.tokenName).toBe('SxCGL - snxrff_ig');
    expect(resultClaudeLm.groupDisplayName).toContain('Group Claude LM [SxCGL]');

    // Test Group A: 250 requests × 0.02 base cost × 2.5 markup = 12.50 CNY
    const resultA = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_A,
      requests: 250,
      username: 'UserA',
    });

    expect(resultA.baseCostCny).toBe(0.02);
    expect(resultA.markup).toBe(2.5);
    expect(resultA.quotaCny.toNumber()).toBe(12.5);
    expect(resultA.quotaUnits).toBe(932836);
    expect(resultA.tokenName).toBe('SxG1 - UserA');

    // Test Group E: 250 requests × 0.03 base cost × 3.0 markup = 22.50 CNY
    const resultE = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_E,
      requests: 250,
      username: 'UserE',
    });

    expect(resultE.baseCostCny).toBe(0.03);
    expect(resultE.markup).toBe(3.0);
    expect(resultE.quotaCny.toNumber()).toBe(22.5);
    expect(resultE.quotaUnits).toBe(1679104);
    expect(resultE.tokenName).toBe('SxGE - UserE');

    // Test custom markup override: e.g. 3.0 markup on Group Claude 500 reqs (500 × 0.03 × 3.0 = 45 CNY)
    const resultCustom = await service.issueManualToken({
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      requests: 500,
      markup: 3.0,
      username: 'UserClaude',
    });

    expect(resultCustom.markup).toBe(3.0);
    expect(resultCustom.quotaCny.toNumber()).toBe(45.0);
  });

  it('should format BotEmbeds.manualKeyIssued with Endpoint, Key, Username, Token Name, Request, and YouTube Video link without exposing internal details', () => {
    const embed = BotEmbeds.manualKeyIssued({
      plainTextKey: 'sk-sealapi-sample-key-abcdef123456',
      tokenName: 'SxGC - snxrff_buyer',
      groupId: 'SxGC',
      groupDisplayName: 'Group Claude [SxGC] (Claude 3.5/3.7 & Opus)',
      requests: 250,
      gatewayUrl: 'https://next-newapi.onrender.com/v1',
      username: 'snxrff_buyer',
      videoUrl: 'https://youtu.be/9KkDWaEsuHc',
    });

    const data = embed.toJSON();
    expect(data.title).toContain('SealAPI');
    expect(data.color).toBe(0x00d26a); // Emerald Green

    // Specified required fields
    expect(data.description).toContain('Endpoint :');
    expect(data.description).toContain('https://next-newapi.onrender.com/v1');
    expect(data.description).toContain('Key :');
    expect(data.description).toContain('sk-sealapi-sample-key-abcdef123456');
    expect(data.description).toContain('ผู้ใช้งาน :');
    expect(data.description).toContain('snxrff_buyer');
    expect(data.description).toContain('Token Name :');
    expect(data.description).toContain('SxGC - snxrff_buyer');
    expect(data.description).toContain('Request :');
    expect(data.description).toContain('250 Requests (Starter Pack)');
    expect(data.description).toContain('Group Model :');
    expect(data.description).toContain('Group Claude [SxGC]');
    expect(data.description).toContain('https://youtu.be/9KkDWaEsuHc');

    // Specified omitted fields
    expect(data.description).not.toContain('UserID');
    expect(data.description).not.toContain('สูตรคำนวณ');
    expect(data.description).not.toContain('โควต้าที่ได้รับ');
    expect(data.description).not.toContain('เครดิตในระบบ');
    expect(data.description).not.toContain('โมเดลที่รองรับ');
  });

  it('should format BotEmbeds.adminProfitReport with exact cost, revenue, profit, and margin breakdown', () => {
    const embed = BotEmbeds.adminProfitReport({
      username: 'snxrff_buyer',
      tokenName: 'SxGC - snxrff_buyer',
      groupId: 'SxGC',
      groupDisplayName: 'Group Claude [SxGC] (Claude 3.5/3.7 & Opus)',
      requests: 250,
      baseCostCny: 0.03,
      markup: 2.5,
      cnyToThbRate: 5.08,
    });

    const data = embed.toJSON();
    expect(data.title).toContain('ข้อมูลต้นทุนและกำไรสำหรับแอดมิน');
    expect(data.color).toBe(0xf1c40f); // Gold
    expect(data.description).toContain('ราคาขายลูกค้า');
    expect(data.description).toContain('99.00 THB');
    expect(data.description).toContain('ต้นทุนผู้ให้บริการ');
    expect(data.description).toContain('38.10 THB');
    expect(data.description).toContain('กำไรสุทธิโดยประมาณ');
    expect(data.description).toContain('60.90 THB');
    expect(data.description).toContain('อัตรากำไร');
    expect(data.description).toContain('61.5%');
  });

  it('should define the /set-balance admin slash command with autocomplete, requests, note, and mode', () => {
    const cmd = adminSlashCommands.find((c) => c.name === 'set-balance');
    expect(cmd).toBeDefined();

    const json = cmd!.toJSON();
    expect(json.name).toBe('set-balance');
    expect(json.description).toContain('ปรับยอดโควต้า Token ใน NewAPI');

    const optNames = json.options?.map((o: any) => o.name);
    expect(optNames).toContain('token');
    expect(optNames).toContain('requests');
    expect(optNames).toContain('note');
    expect(optNames).toContain('mode');

    const tokenOpt: any = json.options?.find((o: any) => o.name === 'token');
    expect(tokenOpt.autocomplete).toBe(true);
    expect(tokenOpt.required).toBe(true);

    const reqOpt: any = json.options?.find((o: any) => o.name === 'requests');
    expect(reqOpt.required).toBe(true);
  });

  it('should format BotEmbeds.balanceUpdated with correct calculation, rounded requests, and note', () => {
    const embed = BotEmbeds.balanceUpdated({
      tokenId: 10,
      tokenName: 'SxGC - somchai_ig',
      maskedKey: 'sk-3xny...WlH',
      groupId: 'SxGC',
      groupDisplayName: 'Group Claude [SxGC] (Claude 3.5/3.7 & Opus)',
      rawRequests: 249.7,
      roundedRequests: 250,
      baseCostCny: 0.03,
      markup: 2.5,
      quotaCny: new Decimal(18.75),
      calculatedUnits: 1399254,
      previousUnits: 500000,
      newRemainUnits: 1399254,
      mode: 'set',
      note: 'เติมเงินเพิ่มจาก IG',
    });

    const data = embed.toJSON();
    expect(data.title).toContain('ปรับปรุงยอดโควต้าสำเร็จ');
    expect(data.color).toBe(0x00d26a);
    expect(data.description).toContain('SxGC - somchai_ig');
    expect(data.description).toContain('250 Requests');
    expect(data.description).toContain('249.7 ➔ ปัดเศษเป็น **250**');
    expect(data.description).toContain('¥18.75 CNY');
    expect(data.description).toContain('1,399,254 Quota Units');
    expect(data.description).toContain('เติมเงินเพิ่มจาก IG');
  });
});
