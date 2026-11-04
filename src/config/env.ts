import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const DEV_PLACEHOLDER_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HEX_SECRET_REGEX = /^[0-9a-fA-F]{64}$/;

function normalizeUrl(fallback: string) {
  return z.preprocess((val) => {
    if (typeof val !== 'string' || val.trim() === '') return fallback;
    let clean = val.trim().replace(/^["']|["']$/g, '');
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = `https://${clean}`;
    }
    return clean;
  }, z.string().url().default(fallback));
}

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(10000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_BASE_URL: normalizeUrl('http://localhost:12345/v1'),
  UPSTREAM_BASE_URL: normalizeUrl('http://127.0.0.1:3000/v1'),
  NEWAPI_BASE_URL: normalizeUrl('http://127.0.0.1:3000/v1'),
  NEWAPI_PUBLIC_ENDPOINT: z.preprocess((val) => {
    if (typeof val !== 'string' || val.trim() === '') return 'http://127.0.0.1:3000/v1';
    let clean = val.trim().replace(/^["']|["']$/g, '');
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = `https://${clean}`;
    }
    return clean;
  }, z.string().default('http://127.0.0.1:3000/v1')),
  NEWAPI_ADMIN_ACCESS_TOKEN: z.string().optional(),
  NEWAPI_USD_EXCHANGE_RATE: z.coerce.number().positive().default(6.7),

  // NextAI Proxy deprecation flag: When false, Node.js proxy routing is disabled (directing to New API)
  ENABLE_LEGACY_PROXY: z.coerce.boolean().default(false),

  ENCRYPTION_SECRET: z.string().optional(),

  // Group-Specific New API Keys (Strict 1:1 Group Association for Local New API Gateway)
  NEWAPI_API_KEY_GROUP_A: z.string().optional(),
  NEWAPI_API_KEY_GROUP_E: z.string().optional(),
  NEWAPI_API_KEY_GROUP_CLAUDE: z.string().optional(),

  // Deprecated/Legacy Bearlab API Keys (Retained for schema compatibility, excluded from New API request path)
  BEARLAB_API_KEY_GROUP_A: z.string().optional(),
  BEARLAB_API_KEY_GROUP_E: z.string().optional(),
  BEARLAB_API_KEY_GROUP_CLAUDE: z.string().optional(),

  DATABASE_URL: z.string().default('file:./dev.db'),

  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_TICKET_CATEGORY_ID: z.string().optional(),
  DISCORD_ADMIN_REVIEW_CHANNEL_ID: z.string().optional(),
  DISCORD_ADMIN_USER_IDS: z.string().default(''),

  // Discord Ticket Management System Channels
  TICKET_PANEL_CHANNEL_ID: z.string().default('1566827188534378617'),
  TICKET_LOG_CHANNEL_ID: z.string().default('1566804177848369286'),
  SUPPORT_ROLE_ID: z.string().optional(),

  // PromptPay Configuration
  PROMPTPAY_ID: z.string().default('0926671327'),

  FRANKFURTER_API_BASE: z.string().url().default('https://api.frankfurter.dev/v2'),
  EXCHANGE_RATE_CACHE_TTL_MINUTES: z.coerce
    .number()
    .positive('EXCHANGE_RATE_CACHE_TTL_MINUTES must be greater than 0')
    .default(60),
  EXCHANGE_RATE_MAX_STALE_HOURS: z.coerce
    .number()
    .positive('EXCHANGE_RATE_MAX_STALE_HOURS must be greater than 0')
    .default(24),
  FX_SPREAD_PERCENT: z.coerce
    .number()
    .finite('FX_SPREAD_PERCENT must be a valid finite number')
    .min(0, 'FX_SPREAD_PERCENT cannot be negative')
    .default(0.0),

  SLIP_STORAGE_DIR: z.string().default('./storage/slips'),
  MAX_SLIP_SIZE_MB: z.coerce.number().default(10),
});

export const envSchema = baseEnvSchema
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';
    const secret = data.ENCRYPTION_SECRET;

    if (isProduction) {
      if (!secret || secret.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENCRYPTION_SECRET'],
          message: 'ENCRYPTION_SECRET is required in production environment.',
        });
        return;
      }

      if (secret === DEV_PLACEHOLDER_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENCRYPTION_SECRET'],
          message: 'Known development placeholder ENCRYPTION_SECRET cannot be used in production.',
        });
        return;
      }
    }

    const effectiveSecret = secret || DEV_PLACEHOLDER_SECRET;
    if (!HEX_SECRET_REGEX.test(effectiveSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_SECRET'],
        message: 'ENCRYPTION_SECRET must be a 64-character hexadecimal string (32 bytes).',
      });
    }
  })
  .transform((data) => {
    const effectiveUpstream = data.NEWAPI_BASE_URL || data.UPSTREAM_BASE_URL || 'http://127.0.0.1:3000/v1';
    return {
      ...data,
      NEWAPI_BASE_URL: effectiveUpstream,
      UPSTREAM_BASE_URL: effectiveUpstream,
      ENCRYPTION_SECRET: data.ENCRYPTION_SECRET || DEV_PLACEHOLDER_SECRET,
    };
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(customEnv?: Record<string, string | undefined>): Env {
  return envSchema.parse(customEnv ?? process.env);
}

export const env = loadEnv();
