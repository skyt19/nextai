export const MODEL_GROUPS = {
  GROUP_A: 'NxG1',
  GROUP_E: 'NxGE',
  GROUP_CLAUDE: 'NxGC',
} as const;

export type ModelGroupId = (typeof MODEL_GROUPS)[keyof typeof MODEL_GROUPS];

export const GROUP_MARKUPS: Record<ModelGroupId, string> = {
  [MODEL_GROUPS.GROUP_A]: '2.5',
  [MODEL_GROUPS.GROUP_E]: '3.0',
  [MODEL_GROUPS.GROUP_CLAUDE]: '2.5',
};

export const KEY_STATUS = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  SUSPENDED: 'SUSPENDED',
} as const;

export type KeyStatus = (typeof KEY_STATUS)[keyof typeof KEY_STATUS];

export const PAYMENT_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  SLIP_SUBMITTED: 'SLIP_SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  COMPLETED: 'COMPLETED',
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const TICKET_CATEGORY = {
  PURCHASE_MODEL: 'PURCHASE_MODEL',
  GENERAL_INQUIRY: 'GENERAL_INQUIRY',
} as const;

export type TicketCategory = (typeof TICKET_CATEGORY)[keyof typeof TICKET_CATEGORY];

export const TICKET_STATUS = {
  OPEN: 'OPEN',
  CLAIMED: 'CLAIMED',
  CLOSED: 'CLOSED',
  DELETED: 'DELETED',
} as const;

export type TicketStatus = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS];

// ==========================================
// NEW API GATEWAY & PROVISIONING CONSTANTS
// ==========================================

export const NEWAPI_GROUP_MAP: Record<ModelGroupId, string> = {
  [MODEL_GROUPS.GROUP_A]: 'nextgroupA',
  [MODEL_GROUPS.GROUP_E]: 'nextgroupE',
  [MODEL_GROUPS.GROUP_CLAUDE]: 'claudegroup',
};

export const NEWAPI_REVERSE_GROUP_MAP: Record<string, ModelGroupId> = {
  nextgroupA: MODEL_GROUPS.GROUP_A,
  nextgroupE: MODEL_GROUPS.GROUP_E,
  claudegroup: MODEL_GROUPS.GROUP_CLAUDE,
};

export const PROVISIONING_STATUS = {
  PENDING: 'PENDING',
  PROVISIONING: 'PROVISIONING',
  PROVISIONED: 'PROVISIONED',
  DELIVERED: 'DELIVERED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ProvisioningStatus = (typeof PROVISIONING_STATUS)[keyof typeof PROVISIONING_STATUS];

// New API Quota Standards:
// New API uses 500,000 units per $1 USD.
// When New API display currency is CNY, it converts: (units / 500,000) * USDExchangeRate
export const NEWAPI_QUOTA_PER_USD = 500_000;
export const DEFAULT_NEWAPI_USD_EXCHANGE_RATE = 6.7;

// Actual Enabled Model IDs configured in New API Groups/Channels
export const NEWAPI_GROUP_MODELS: Record<ModelGroupId, string[]> = {
  [MODEL_GROUPS.GROUP_A]: [
    '[A]gemini-2-5-flash',
    '[A]gemini-2-5-flash-lite',
    '[A]gemini-3-1-flash-lite',
    '[A]gemini-3-1-pro-high',
    '[A]gemini-3-8-flash-high',
    '[A]gemini-3-flash',
    '[A]gemini-4-argon',
    '[A]gemini-4-argon-build',
  ],
  [MODEL_GROUPS.GROUP_E]: [
    '[E]gemini-2.5-pro',
    '[E]gemini-2.5-pro-search',
    '[E]gemini-3.1-pro-preview',
    '[E]gemini-3.1-pro-preview-search',
    '[E]gemini-3.8-flash',
    '[E]gemini-3.8-flash-search',
    '[E]gemini-4-argon',
  ],
  [MODEL_GROUPS.GROUP_CLAUDE]: [
    'claude-fable-5-1[次]',
    'claude-fable-5[次]',
    'claude-opus-4-5[次]',
    'claude-opus-4-6[次]',
    'claude-opus-4-7[次]',
    'claude-opus-4-8[次]',
    'claude-opus-5-5[次]',
    'claude-opus-5[次]',
    'claude-sonnet-4-5[次]',
    'claude-sonnet-4-6[次]',
  ],
};

