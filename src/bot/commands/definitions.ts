import { SlashCommandBuilder } from 'discord.js';

export const customerSlashCommands = [
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('แนะนำขั้นตอนการเปิด Ticket เพื่อสั่งซื้อแพ็กเกจโมเดล AI'),

  new SlashCommandBuilder()
    .setName('models')
    .setDescription('แสดงรายชื่อโมเดล AI ที่พร้อมใช้งานตามกลุ่มที่ได้รับสิทธิ์'),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('ตรวจสอบยอดคงเหลือและสถานะบัญชีของคุณ'),

  new SlashCommandBuilder()
    .setName('account')
    .setDescription('ตรวจสอบข้อมูลบัญชีและสถานะ API Key ของคุณ'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('แสดงคู่มือและวิธีใช้งานคำสั่ง Next AI Proxy Hub'),
];

export const adminSlashCommands = [
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('เข้าถึงแดชบอร์ดจัดการระบบสำหรับผู้ดูแล (Admin Dashboard)'),

  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('ติดตั้งหรือรีเฟรชพาเนลศูนย์บริการลูกค้า (Support Center)')
    .addSubcommand((sub) =>
      sub
        .setName('deploy')
        .setDescription('ติดตั้งพาเนลศูนย์บริการลูกค้าในห้องที่กำหนด')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('ห้องเป้าหมายที่ต้องการติดตั้ง (ค่าเริ่มต้น: TICKET_PANEL_CHANNEL_ID)')
            .setRequired(false)
        )
    ),

  new SlashCommandBuilder()
    .setName('payment-review')
    .setDescription('ตรวจสอบรายการสลิปการชำระเงินที่รอการอนุมัติ'),

  new SlashCommandBuilder()
    .setName('customer')
    .setDescription('ค้นหาบัญชีลูกค้าด้วย Discord ID หรือ Username')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Discord User ID หรือ Username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('customer-key')
    .setDescription('จัดการ Next AI API Key ของลูกค้า (สร้างใหม่, หมุนเวียน หรือระงับการใช้งาน)')
    .addStringOption((opt) =>
      opt.setName('user_id').setDescription('Discord User ID ของลูกค้า').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('การดำเนินการที่ต้องการ')
        .setRequired(true)
        .addChoices(
          { name: 'สร้าง / หมุนเวียนคีย์ใหม่ (Rotate)', value: 'rotate' },
          { name: 'ระงับการใช้งานคีย์ (Disable)', value: 'disable' },
          { name: 'เปิดใช้งานคีย์ (Activate)', value: 'activate' }
        )
    ),

  new SlashCommandBuilder()
    .setName('rates')
    .setDescription('ตรวจสอบอัตราแลกเปลี่ยนล่าสุดจาก Frankfurter API หรือสั่งดึงข้อมูลใหม่')
    .addBooleanOption((opt) =>
      opt.setName('refresh').setDescription('บังคับดึงข้อมูลล่าสุดจาก Frankfurter API ทันที')
    ),
];
