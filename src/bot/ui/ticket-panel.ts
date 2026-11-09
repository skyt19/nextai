import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';

export class TicketPanelUI {
  /**
   * Main Support Center Embed deployed in TICKET_PANEL_CHANNEL_ID.
   */
  public static supportCenterEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('SealAPI Hub | ศูนย์บริการลูกค้า')
      .setDescription(
        `ยินดีต้อนรับสู่ **SealAPI Hub Support**\n\n` +
          `กรุณาเลือกประเภทของ Ticket ที่ท่านต้องการเปิดบริการ:\n\n` +
          `1. **ซื้อแพ็กเกจโมเดล**\n` +
          `   สำหรับลูกค้าที่ต้องการสั่งซื้อแพ็กเกจโมเดล AI, เติมเครดิตการใช้งาน หรือสอบถามอัตราค่าบริการ\n\n` +
          `2. **สอบถามข้อมูล**\n` +
          `   สำหรับสอบถามข้อมูลทั่วไป, การสนับสนุนทางเทคนิค หรือปัญหาเกี่ยวกับการใช้งาน API\n\n` +
          `*กรุณาเลือกประเภทบริการจากเมนูด้านล่างนี้เพื่อเปิดห้อง Ticket ส่วนตัว*`
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'SealAPI Support Desk' })
      .setTimestamp();
  }

  /**
   * Interactive select menu for the Support Center panel.
   */
  public static categorySelectMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket_select_category')
      .setPlaceholder('เลือกประเภทบริการที่ต้องการ...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('ซื้อแพ็กเกจโมเดล')
          .setDescription('สั่งซื้อแพ็กเกจโมเดล AI หรือเติมเครดิตการใช้งาน')
          .setValue('purchase_model')
          .setEmoji('💳'),
        new StringSelectMenuOptionBuilder()
          .setLabel('สอบถามข้อมูล')
          .setDescription('สอบถามข้อมูลทั่วไปหรือแจ้งปัญหาทางเทคนิค')
          .setValue('general_inquiry')
          .setEmoji('❓')
      );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  /**
   * Welcome message for Purchase Model tickets (Stage 1).
   */
  public static purchaseWelcomeEmbed(username: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('💳 ซื้อแพ็กเกจโมเดล (Stage 1: เลือกกลุ่มโมเดล)')
      .setDescription(
        `ยินดีต้อนรับคุณ <@${username}> สู่ขั้นตอนการสั่งซื้อแพ็กเกจ SealAPI Hub\n\n` +
          `กรุณาเลือก **กลุ่มโมเดล (Model Group)** ที่ท่านต้องการใช้งานจากเมนูด้านล่างนี้:\n\n` +
          `• **SxCGL — Claude LLM Hub Group**: โมเดล Claude LLM Hub (Claude Haiku ยัน Opus 5.5)\n` +
          `• **SxGC — Claude Group**: โมเดลตระกูล Claude 4.5/5 (Sonnet, Opus & Haiku)\n` +
          `• **SxG1 — Gemini Group A**: โมเดล Gemini รุ่น Fast & High (ความเร็วและงานทั่วไป)\n` +
          `• **SxGE — Gemini Group E**: โมเดล Gemini รุ่น Pro & Search (การคิดวิเคราะห์ขั้นสูงและ Search)\n\n` +
          `*หลังจากเลือกกลุ่มโมเดลแล้ว ระบบจะให้ท่านเลือกจำนวน Reference Requests ในขั้นตอนถัดไป*`
      )
      .setColor(0xfee75c);
  }

  /**
   * Selection prompt for Reference Request Quantity (Stage 2).
   */
  public static quantitySelectEmbed(groupDisplayName: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('📦 เลือกจำนวนคำขออ้างอิง (Stage 2: Reference Requests)')
      .setDescription(
        `กลุ่มโมเดลที่เลือก: **${groupDisplayName}**\n\n` +
          `กรุณาเลือก **จำนวน Reference Requests** ที่ต้องการสั่งซื้อจากเมนูด้านล่างนี้:\n\n` +
          `• **250 Reference Requests (Starter Pack)**\n` +
          `• **500 Reference Requests**\n` +
          `• **750 Reference Requests**\n` +
          `• **1,000 Reference Requests**\n\n` +
          `*ระบบจะคำนวณยอดชำระเงินสกุล THB ตามอัตราแลกเปลี่ยนจริงพร้อมแสดง QR Code ในขั้นตอนถัดไป*`
      )
      .setColor(0x3498db);
  }

  /**
   * Welcome message for General Inquiry tickets.
   */
  public static inquiryWelcomeEmbed(username: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('❓ สอบถามข้อมูลและฝ่ายสนับสนุน (General Inquiry)')
      .setDescription(
        `ยินดีต้อนรับคุณ <@${username}> เข้าสู่ห้องสอบถามข้อมูลฝ่ายสนับสนุน\n\n` +
          `กรุณาระบุคำถาม ข้อสงสัย หรือรายละเอียดปัญหาทางเทคนิคที่ท่านพบ\n\n` +
          `เจ้าหน้าที่จะเข้ามาดูแลและให้ความช่วยเหลือท่านโดยเร็วที่สุด`
      )
      .setColor(0x3498db);
  }

  /**
   * Ticket management control buttons inside every ticket.
   */
  public static ticketControls(ticketId: string, isClaimed: boolean = false): ActionRowBuilder<ButtonBuilder> {
    const closeBtn = new ButtonBuilder()
      .setCustomId(`ticket_ctrl_close_${ticketId}`)
      .setLabel('ปิด Ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔒');

    const claimBtn = new ButtonBuilder()
      .setCustomId(`ticket_ctrl_claim_${ticketId}`)
      .setLabel(isClaimed ? 'รับเรื่องแล้ว' : 'รับเรื่อง (Claim Ticket)')
      .setStyle(isClaimed ? ButtonStyle.Success : ButtonStyle.Primary)
      .setEmoji('🙋')
      .setDisabled(isClaimed);

    const deleteBtn = new ButtonBuilder()
      .setCustomId(`ticket_ctrl_delete_${ticketId}`)
      .setLabel('ลบ Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️');

    return new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn, claimBtn, deleteBtn);
  }

  /**
   * Confirmation row for closing a ticket.
   */
  public static closeConfirmationButtons(ticketId: string): ActionRowBuilder<ButtonBuilder> {
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`ticket_confirm_close_${ticketId}`)
      .setLabel('ยืนยันการปิด Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✅');

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`ticket_cancel_close_${ticketId}`)
      .setLabel('ยกเลิก')
      .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);
  }

  /**
   * Confirmation row for deleting a ticket.
   */
  public static deleteConfirmationButtons(ticketId: string): ActionRowBuilder<ButtonBuilder> {
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`ticket_confirm_delete_${ticketId}`)
      .setLabel('ยืนยันการลบ Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⚠️');

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`ticket_cancel_delete_${ticketId}`)
      .setLabel('ยกเลิก')
      .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);
  }

  /**
   * Action row when a ticket is closed (Reopen & Delete).
   */
  public static closedTicketControls(ticketId: string): ActionRowBuilder<ButtonBuilder> {
    const reopenBtn = new ButtonBuilder()
      .setCustomId(`ticket_ctrl_reopen_${ticketId}`)
      .setLabel('เปิด Ticket อีกครั้ง (Reopen)')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔓');

    const deleteBtn = new ButtonBuilder()
      .setCustomId(`ticket_ctrl_delete_${ticketId}`)
      .setLabel('ลบห้อง Ticket (Delete)')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️');

    return new ActionRowBuilder<ButtonBuilder>().addComponents(reopenBtn, deleteBtn);
  }
}
