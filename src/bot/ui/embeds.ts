import { EmbedBuilder } from 'discord.js';
import { CustomerProfile } from '../../types/customer.js';
import { CalculationSnapshot } from '../../services/calculator.service.js';
import { env } from '../../config/env.js';

export class BotEmbeds {
  public static ticketWelcome(username: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('🎫 SealAPI Hub — สั่งซื้อแพ็กเกจโมเดล')
      .setDescription(
        `ยินดีต้อนรับคุณ **${username}**!\n\nกรุณาเลือกกลุ่มโมเดล AI ที่ท่านต้องการใช้งานด้านล่างนี้:\n` +
          `• **Group A [NxG1]**: โมเดล Gemini รุ่น Fast & High\n` +
          `• **Group E [NxGE]**: โมเดล Gemini รุ่น Pro & Search\n` +
          `• **Group Claude [NxGC]**: โมเดล Claude 4.5/5 (Sonnet, Opus & Haiku)\n\n` +
          `*การสั่งซื้อและการชำระเงินทั้งหมดจะดำเนินรายการอย่างปลอดภัยในห้อง Ticket ส่วนตัวนี้*`
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'SealAPI Hub' });
  }

  /**
   * Stage 3: Payment Instructions
   * Strictly displays ONLY customer-relevant info:
   * - Selected model group
   * - Purchased Reference Requests
   * - Final THB payment amount
   * - PromptPay QR Code
   * - Payment instructions
   *
   * STRICT PRIVACY: NEVER exposes provider cost, CNY, exchange rate, markup, or Bearlab IDs.
   */
  public static paymentInstructions(params: {
    groupDisplayName: string;
    referenceRequests: number;
    paymentId: string;
    finalAmountThb: string;
    promptPayId?: string;
    hasQrAttachment?: boolean;
  }): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle('💳 ข้อมูลการชำระเงิน (Payment Instructions)')
      .setDescription(
        `กรุณาชำระเงินตามยอดสุทธิที่ระบุด้านล่าง และแนบภาพสลิปการโอนเงินลงในห้อง Ticket นี้โดยตรง\n\n` +
          `• **กลุ่มโมเดล:** **${params.groupDisplayName}**\n` +
          `• **จำนวน Reference Requests:** **${params.referenceRequests.toLocaleString('en-US')} คำขอ**\n\n` +
          `### 💰 **ยอดชำระสุทธิ: ฿${params.finalAmountThb} THB**\n\n` +
          `**รหัสอ้างอิงการชำระเงิน (Payment ID):** \`${params.paymentId}\`\n` +
          (params.promptPayId ? `**บัญชี PromptPay:** \`${params.promptPayId}\`\n\n` : `\n`) +
          `**ขั้นตอนการชำระเงิน:**\n` +
          `1. โอนเงินหรือสแกน QR Code PromptPay ยอด **฿${params.finalAmountThb} THB**\n` +
          `2. แนบภาพหลักฐานการโอนเงิน (สลิป PNG, JPG, WEBP) **เข้ามาในห้อง Ticket นี้โดยตรง**\n` +
          `3. เจ้าหน้าที่จะทำการตรวจสอบยอดเงินและเปิดใช้งาน API Key ให้ท่านทันที\n\n` +
          `⚠️ *หมายเหตุ: เพื่อความปลอดภัย กรุณาอย่าส่งสลิปผ่านทางข้อความส่วนตัว (DM)*`
      )
      .setColor(0xfee75c)
      .setFooter({ text: `Payment Ref: ${params.paymentId}` });

    if (params.hasQrAttachment) {
      embed.setImage('attachment://promptpay-qr.png');
    }

    return embed;
  }

  public static slipReceivedUnderReview(paymentId: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('📥 ได้รับสลิปการโอนเงินแล้ว')
      .setDescription(
        `ระบบได้บันทึกหลักฐานการชำระเงินของท่านเรียบร้อยแล้ว และส่งต่อให้เจ้าหน้าที่ตรวจสอบ\n\n` +
          `• **รหัสอ้างอิง:** \`${paymentId}\`\n` +
          `• **สถานะ:** \`UNDER_REVIEW (รอการตรวจสอบ)\`\n\n` +
          `เจ้าหน้าที่จะทำการตรวจสอบความถูกต้องและดำเนินการเปิดสิทธิ์ให้ท่านโดยเร็วที่สุด ท่านจะได้รับการแจ้งเตือนในห้องนี้ทันทีที่ได้รับอนุมัติ`
      )
      .setColor(0x3ba55c)
      .setTimestamp();
  }

  public static adminReviewNotification(params: {
    paymentId: string;
    customerDiscordId: string;
    customerUsername: string;
    packageName: string;
    groupId: string;
    expectedAmountThb: string;
    slipUrl?: string;
  }): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle('🔍 ตรวจสอบสลิปการชำระเงิน (Admin Review Required)')
      .setDescription(
        `**ลูกค้า:** <@${params.customerDiscordId}> (${params.customerUsername})\n` +
          `**User ID:** \`${params.customerDiscordId}\`\n` +
          `**แพ็กเกจ:** ${params.packageName} [${params.groupId}]\n` +
          `**ยอดที่ต้องชำระ:** **฿${params.expectedAmountThb} THB**\n` +
          `**Payment ID:** \`${params.paymentId}\``
      )
      .setColor(0xeb459e)
      .setTimestamp();

    if (params.slipUrl) {
      embed.setImage(params.slipUrl);
    }

    return embed;
  }

  public static paymentApproved(params: {
    packageName: string;
    groupId: string;
    assignedQuotaCny: string;
    plainTextApiKey?: string;
    gatewayUrl?: string;
    allowedModels?: string[];
  }): EmbedBuilder {
    // Consistent currency formatting without duplication (e.g. ¥5.00 CNY)
    const cleanRaw = params.assignedQuotaCny.replace(/[¥\sCNYcny]/g, '');
    const num = Number(cleanRaw);
    const formattedQuota = isNaN(num) ? params.assignedQuotaCny : `¥${num.toFixed(2)} CNY`;
    const gatewayEndpoint = params.gatewayUrl || env.NEWAPI_PUBLIC_ENDPOINT;

    let desc =
      `🎉 **การชำระเงินของท่านได้รับการตรวจสอบและอนุมัติเรียบร้อยแล้ว!**\n\n` +
      `• **แพ็กเกจที่เปิดใช้งาน:** ${params.packageName} [${params.groupId}]\n` +
      `• **เครดิตอ้างอิงที่ได้รับ:** ${formattedQuota}\n` +
      `• **กลุ่มโมเดล:** \`${params.groupId}\`\n` +
      `• **API Gateway Endpoint:** \`${gatewayEndpoint}\`\n\n`;

    if (params.allowedModels && params.allowedModels.length > 0) {
      const displayModels = params.allowedModels.slice(0, 5).join('`, `');
      const extraCount = params.allowedModels.length - 5;
      const extraText = extraCount > 0 ? ` และอีก ${extraCount} โมเดล` : '';
      desc += `• **โมเดลที่สามารถเรียกใช้งานได้:** \`${displayModels}\`${extraText}\n\n`;
    }

    if (params.plainTextApiKey) {
      desc +=
        `### 🔑 **New API Customer Token ของคุณ:**\n` +
        `\`\`\`\n${params.plainTextApiKey}\n\`\`\`\n` +
        `⚠️ **คำเตือนความปลอดภัย:** กรุณาคัดลอกและบันทึก API Token นี้ไว้ทันที! ห้ามเปิดเผยหรือส่งต่อคีย์นี้ให้บุคคลอื่น ระบบจะไม่แสดงคีย์นี้ซ้ำอีกเพื่อความปลอดภัยสูงสุด\n\n`;
    }

    desc +=
      `**วิธีเชื่อมต่อใช้งาน:**\n` +
      `ตั้งค่าในโปรแกรมที่รองรับ OpenAI API (Cursor, LibreChat, Python SDK, NextChat) ดังนี้:\n` +
      `• **Base URL:** \`${gatewayEndpoint}\`\n` +
      `• **API Key (Bearer Token):** นำ New API Customer Token ด้านบนไปใส่ในช่อง Bearer Token`;

    return new EmbedBuilder()
      .setTitle('✅ เปิดใช้งานสิทธิ์สำเร็จ (Access Activated)')
      .setDescription(desc)
      .setColor(0x57f287);
  }

  public static paymentRejected(reason: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('❌ การตรวจสอบสลิปไม่สำเร็จ (Payment Rejected)')
      .setDescription(
        `สลิปการโอนเงินของท่านไม่สามารถอนุมัติได้เนื่องจากสาเหตุต่อไปนี้:\n\n` +
          `> ${reason}\n\n` +
          `กรุณาแนบสลิปที่ถูกต้องเข้ามาในห้อง Ticket นี้อีกครั้ง หรือติดต่อเจ้าหน้าที่เพื่อขอความช่วยเหลือ`
      )
      .setColor(0xed4245);
  }

  /**
   * Strictly implements Customer Profile display according to Master Specification:
   * 1. Username
   * 2. UserID
   * 3. API Key
   * 4. Balance
   * 5. Key Status
   * 6. Payment History
   *
   * STRICT PRIVACY CORRECTION:
   * - Removed any mention of Bearlab AI or internal provider execution.
   * - Never exposes provider costs, FX rates, markups, or private credentials.
   */
  public static customerProfile(profile: CustomerProfile): EmbedBuilder {
    const historyCount = profile.paymentHistory.length;
    return new EmbedBuilder()
      .setTitle(`📊 ข้อมูลบัญชีและยอดคงเหลือ`)
      .setDescription(
        `• **ชื่อผู้ใช้:** **${profile.username}**\n` +
          `• **User ID:** \`${profile.userId}\`\n` +
          `• **ยอดคงเหลือ:** **${profile.balance}**\n` +
          `• **สถานะ API Key:** \`${profile.keyStatus}\`\n` +
          `• **ประวัติการชำระเงิน:** ${historyCount} รายการที่บันทึกไว้`
      )
      .setColor(0x5865f2);
  }

  /**
   * Embed for manual API key issuance requested by admin.
   * Prominently displays Endpoint, Key, and Group Model as requested.
   */
  public static manualKeyIssued(params: {
    plainTextKey: string;
    tokenName: string;
    groupId: string;
    groupDisplayName: string;
    requests: number;
    baseCostCny: number;
    markup: number;
    quotaCny: { toFixed: (n: number) => string } | string | number;
    quotaUnits: number;
    allowedModels?: string[];
    gatewayUrl?: string;
    discordUserId: string;
    username: string;
  }): EmbedBuilder {
    const endpoint = params.gatewayUrl || env.NEWAPI_PUBLIC_ENDPOINT || 'https://next-newapi.onrender.com/v1';
    const quotaCnyStr =
      typeof params.quotaCny === 'object' && params.quotaCny !== null && 'toFixed' in params.quotaCny
        ? params.quotaCny.toFixed(2)
        : Number(params.quotaCny).toFixed(2);

    let desc =
      `## 🔑 SealAPI — ออก API Key สำเร็จ (Manual Token Issued)\n\n` +
      `**Endpoint :** \`${endpoint}\`\n` +
      `**Key :** \`${params.plainTextKey}\`\n` +
      `**Group Model :** **${params.groupDisplayName}** (\`${params.groupId}\`)\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `### 📋 ข้อมูลผู้ใช้งานและรายละเอียดโควต้า\n` +
      `• **ผู้ใช้งาน:** <@${params.discordUserId}> (\`${params.username}\`)\n` +
      `• **User ID:** \`${params.discordUserId}\`\n` +
      `• **Token Name:** \`${params.tokenName}\`\n` +
      `• **จำนวนคำขอ (Requests):** **${params.requests.toLocaleString('en-US')} Requests**\n` +
      `• **สูตรคำนวณ:** ต้นทุน ¥${params.baseCostCny} × ตัวคูณ ${params.markup} × ${params.requests} req\n` +
      `• **โควต้าที่ได้รับ (CNY):** **¥${quotaCnyStr} CNY**\n` +
      `• **เครดิตในระบบ NewAPI:** **${params.quotaUnits.toLocaleString('en-US')} Quota Units**\n\n` +
      `### 🔑 คัดลอก API Key โดยตรง:\n` +
      `\`\`\`\n${params.plainTextKey}\n\`\`\`\n` +
      `⚠️ *คำเตือน: โปรดเก็บรักษา API Key นี้อย่างปลอดภัย หลีกเลี่ยงการเปิดเผยในพื้นที่สาธารณะ*\n\n`;

    if (params.allowedModels && params.allowedModels.length > 0) {
      const displayModels = params.allowedModels.slice(0, 6).join('`, `');
      const extra = params.allowedModels.length > 6 ? ` และอีก ${params.allowedModels.length - 6} โมเดล` : '';
      desc += `### 🤖 โมเดลที่รองรับในกลุ่มนี้:\n\`${displayModels}\`${extra}\n\n`;
    }

    desc +=
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `### 🚀 วิธีการเชื่อมต่อใช้งาน (Quick Setup Guide)\n` +
      `• **Base URL / Endpoint:** \`${endpoint}\`\n` +
      `• **API Key (Bearer Token):** \`${params.plainTextKey}\`\n` +
      `• รองรับทั้ง Cursor, NextChat, LibreChat, Cline, Roo Code, SillyTavern, Python SDK\n`;

    return new EmbedBuilder()
      .setTitle('✨ จัดการออก API Key สำเร็จเรียบร้อยแล้ว')
      .setDescription(desc)
      .setColor(0x00d26a)
      .setFooter({ text: 'SealAPI Hub • Manual Token Provisioning System' })
      .setTimestamp();
  }

  /**
   * Embed sent directly to the customer via DM when an admin issues a key manually.
   */
  public static manualKeyCustomerDm(params: {
    plainTextKey: string;
    groupDisplayName: string;
    groupId: string;
    requests: number;
    allowedModels?: string[];
    gatewayUrl?: string;
  }): EmbedBuilder {
    const endpoint = params.gatewayUrl || env.NEWAPI_PUBLIC_ENDPOINT || 'https://next-newapi.onrender.com/v1';

    let desc =
      `ยินดีต้อนรับสู่บริการ **SealAPI**! แอดมินได้ทำการออก API Key ใหม่สำหรับท่านเรียบร้อยแล้ว:\n\n` +
      `**Endpoint :** \`${endpoint}\`\n` +
      `**Key :** \`${params.plainTextKey}\`\n` +
      `**Group Model :** **${params.groupDisplayName}**\n` +
      `**จำนวนคำขอ:** **${params.requests.toLocaleString('en-US')} Requests**\n\n` +
      `### 🔑 นำ API Key ด้านล่างนี้ไปใช้งาน:\n` +
      `\`\`\`\n${params.plainTextKey}\n\`\`\`\n` +
      `⚠️ *คำแนะนำด้านความปลอดภัย: กรุณาคัดลอกและบันทึกคีย์นี้ไว้ใช้งาน ห้ามส่งต่อให้ผู้อื่น*\n\n`;

    if (params.allowedModels && params.allowedModels.length > 0) {
      const displayModels = params.allowedModels.slice(0, 6).join('`, `');
      const extra = params.allowedModels.length > 6 ? ` และอีก ${params.allowedModels.length - 6} โมเดล` : '';
      desc += `### 🤖 โมเดลที่พร้อมใช้งาน:\n\`${displayModels}\`${extra}\n\n`;
    }

    desc +=
      `**วิธีตั้งค่าในโปรแกรม (Cursor, NextChat, LibreChat, etc.):**\n` +
      `• **Base URL:** \`${endpoint}\`\n` +
      `• **API Key:** นำ Key ด้านบนไปใส่ในช่อง Bearer Token\n\n` +
      `หากมีข้อสงสัยหรือต้องการความช่วยเหลือ สามารถเปิด Ticket สอบถามทีมงานได้ตลอดเวลาครับ!`;

    return new EmbedBuilder()
      .setTitle('🎉 คุณได้รับ API Key จาก SealAPI')
      .setDescription(desc)
      .setColor(0x57f287)
      .setFooter({ text: 'SealAPI Hub' })
      .setTimestamp();
  }
}
