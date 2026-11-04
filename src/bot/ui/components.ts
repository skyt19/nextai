import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { MODEL_GROUPS } from '../../config/constants.js';

export interface PackageOption {
  id: string;
  name: string;
  groupId: string;
  referenceRequests: number;
}

export class BotComponents {
  /**
   * Stage 1: Select Model Group (in Thai)
   * Options:
   * - NxG1 — Gemini Group A
   * - NxGE — Gemini Group E
   * - NxGC — Claude Group
   */
  public static modelGroupSelectMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('purchase_select_group')
      .setPlaceholder('เลือกกลุ่มโมเดลที่ต้องการใช้งาน...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('NxG1 — Gemini Group A')
          .setDescription('โมเดลตระกูล Gemini รุ่น Fast & High (ความเร็วและงานทั่วไป)')
          .setValue(MODEL_GROUPS.GROUP_A)
          .setEmoji('⚡'),
        new StringSelectMenuOptionBuilder()
          .setLabel('NxGE — Gemini Group E')
          .setDescription('โมเดลตระกูล Gemini รุ่น Pro & Search (งานคิดวิเคราะห์ระดับสูง)')
          .setValue(MODEL_GROUPS.GROUP_E)
          .setEmoji('🧠'),
        new StringSelectMenuOptionBuilder()
          .setLabel('NxGC — Claude Group')
          .setDescription('โมเดลตระกูล Claude 4.5/5 (Sonnet, Opus & Haiku)')
          .setValue(MODEL_GROUPS.GROUP_CLAUDE)
          .setEmoji('🎭')
      );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  /**
   * Stage 2: Select Reference Request Quantity (in Thai)
   * Suggested quantities: 100, 500, 1,000 Reference Requests
   */
  public static referenceRequestsSelectMenu(
    groupId: string,
    quantities: number[] = [100, 500, 1000]
  ): ActionRowBuilder<StringSelectMenuBuilder> {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`purchase_select_requests_${groupId}`)
      .setPlaceholder('เลือกจำนวน Reference Requests...')
      .addOptions(
        quantities.map((q) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${q.toLocaleString('en-US')} Reference Requests`)
            .setDescription(`แพ็กเกจ ${q.toLocaleString('en-US')} คำขออ้างอิงสำหรับกลุ่ม [${groupId}]`)
            .setValue(q.toString())
            .setEmoji('📦')
        )
      );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  /**
   * Package selection menu for custom/legacy package selection.
   */
  public static packageSelectMenu(packages: PackageOption[]): ActionRowBuilder<StringSelectMenuBuilder> {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket_select_package')
      .setPlaceholder('เลือกแพ็กเกจโมเดล AI...')
      .addOptions(
        packages.map((pkg) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${pkg.name} [${pkg.groupId}]`)
            .setDescription(`${pkg.referenceRequests} Reference Requests`)
            .setValue(pkg.id)
        )
      );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  /**
   * Admin review buttons (Approve / Reject)
   */
  public static adminReviewButtons(paymentId: string): ActionRowBuilder<ButtonBuilder> {
    const approveBtn = new ButtonBuilder()
      .setCustomId(`admin_approve_${paymentId}`)
      .setLabel('อนุมัติการชำระเงิน')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅');

    const rejectBtn = new ButtonBuilder()
      .setCustomId(`admin_reject_${paymentId}`)
      .setLabel('ปฏิเสธการชำระเงิน')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌');

    return new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, rejectBtn);
  }

  /**
   * Ticket close button
   */
  public static ticketCloseButton(ticketId: string): ActionRowBuilder<ButtonBuilder> {
    const closeBtn = new ButtonBuilder()
      .setCustomId(`ticket_ctrl_close_${ticketId}`)
      .setLabel('ปิด Ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔒');

    return new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn);
  }
}
