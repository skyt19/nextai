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
    .setDescription('แสดงคู่มือและวิธีใช้งานคำสั่ง SealAPI Hub'),
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
    .setDescription('จัดการ SealAPI API Key ของลูกค้า (สร้างใหม่, หมุนเวียน หรือระงับการใช้งาน)')
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

  new SlashCommandBuilder()
    .setName('issue-key')
    .setDescription('ออก API Key ให้ผู้ใช้ NewAPI กำหนด Request เองตามสูตรต้นทุน x มาร์กอัป')
    .addStringOption((opt) =>
      opt
        .setName('group')
        .setDescription('กลุ่มโมเดล AI (NxG1, NxGE, NxGC)')
        .setRequired(true)
        .addChoices(
          { name: 'Group A [NxG1] - Gemini Flash (ต้นทุน ¥0.02, Markup 2.5)', value: 'NxG1' },
          { name: 'Group E [NxGE] - Gemini Pro (ต้นทุน ¥0.03, Markup 3.0)', value: 'NxGE' },
          { name: 'Group Claude [NxGC] - Claude 3.5/3.7/Opus (ต้นทุน ¥0.03, Markup 2.5)', value: 'NxGC' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('requests')
        .setDescription('จำนวน Request ที่ต้องการ (เช่น 100, 200, 500, 1000)')
        .setRequired(true)
        .setMinValue(1)
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('เลือกผู้ใช้งาน Discord ในเซิร์ฟเวอร์ที่ต้องการออกคีย์ให้')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('user_id')
        .setDescription('Discord User ID ของผู้ใช้ (กรณีพิมพ์เลข ID เอง)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('username')
        .setDescription('ชื่อบัญชีผู้ใช้หรือระบุชื่อลูกค้า (Username)')
        .setRequired(false)
    )
    .addNumberOption((opt) =>
      opt
        .setName('markup')
        .setDescription('ตัวคูณ Markup (ค่าเริ่มต้น: 2.5 หรือ 3.0 ตามกลุ่ม)')
        .setRequired(false)
        .setMinValue(1.0)
    )
    .addStringOption((opt) =>
      opt
        .setName('custom_name')
        .setDescription('กำหนดชื่อ Token เองแบบระบุเฉพาะเจาะจง (ถ้าไม่ระบุจะตั้งอัตโนมัติตามรูปแบบมาตรฐาน)')
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('dm_customer')
        .setDescription('ส่ง API Key และวิธีใช้งานเข้า DM ของลูกค้าทันทีหรือไม่ (ค่าเริ่มต้น: True)')
        .setRequired(false)
    ),
];
