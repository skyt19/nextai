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
    .setDescription('ออก API Key ให้ลูกค้าใน IG หรือผู้ใช้งานทั่วไปตามสูตรคำนวณโควต้า NewAPI')
    .addStringOption((opt) =>
      opt
        .setName('username')
        .setDescription('ชื่อบัญชีผู้ใช้งาน / ลูกค้า (พิมพ์เอง เช่น ชื่อลูกค้าจาก IG)')
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('requests')
        .setDescription('จำนวน Request (Starter Pack เริ่มต้น 250 Requests)')
        .setRequired(true)
        .addChoices(
          { name: 'Starter Pack — 250 Requests (99฿)', value: 250 },
          { name: 'Standard Pack — 500 Requests', value: 500 },
          { name: 'Pro Pack — 750 Requests', value: 750 },
          { name: 'Max Pack — 1,000 Requests', value: 1000 }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('group')
        .setDescription('กลุ่มโมเดล AI (SxCGL, SxGC, SxG1, SxGE)')
        .setRequired(true)
        .addChoices(
          { name: 'Group Claude LM [SxCGL] - Claude LLM Hub (99฿ / 250 req)', value: 'SxCGL' },
          { name: 'Group Claude [SxGC] - Claude Haiku ถึง Opus 5.5', value: 'SxGC' },
          { name: 'Group A [SxG1] - Gemini Flash & Fast', value: 'SxG1' },
          { name: 'Group E [SxGE] - Gemini Pro & Search', value: 'SxGE' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('custom_name')
        .setDescription('กำหนดชื่อ Token Name เอง (ถ้าไม่ระบุจะเป็น [Group] - [username])')
        .setRequired(false)
    )
    .addNumberOption((opt) =>
      opt
        .setName('markup')
        .setDescription('ตัวคูณ Markup (ค่าเริ่มต้น: 2.5 หรือ 3.0 ตามกลุ่ม)')
        .setRequired(false)
        .setMinValue(1.0)
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('เลือกแท็กผู้ใช้งาน Discord ในเซิร์ฟเวอร์ (ถ้ามี)')
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('dm_customer')
        .setDescription('ส่ง API Key และวิธีใช้งานเข้า DM ของลูกค้าทันทีหรือไม่ (ค่าเริ่มต้น: True)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('set-balance')
    .setDescription('ปรับยอดโควต้า Token ใน NewAPI ตามจำนวน Request และสูตรคำนวณ')
    .addStringOption((opt) =>
      opt
        .setName('token')
        .setDescription('เลือกหรือค้นหา Token / ผู้ใช้งานใน NewAPI (โหลดจากระบบ)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addNumberOption((opt) =>
      opt
        .setName('requests')
        .setDescription('จำนวน Request ที่ต้องการกำหนด (ใส่เลขไม่กลมได้ ระบบจะปัดเศษให้อัตโนมัติ)')
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption((opt) =>
      opt
        .setName('note')
        .setDescription('บันทึกโน๊ตเพิ่มเติมหากมี (เช่น เติมเงิน IG, ปรับยอดตามสลิป)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('รูปแบบการปรับยอด (ตั้งค่ายอดใหม่ หรือ บวกเพิ่มจากยอดเดิม)')
        .setRequired(false)
        .addChoices(
          { name: 'ตั้งค่ายอดใหม่ตามที่ระบุ (Set / Replace)', value: 'set' },
          { name: 'บวกเพิ่มจากยอดคงเหลือเดิม (Add / Top-up)', value: 'add' }
        )
    ),
];
