import { KeyStatus } from '../config/constants.js';

export interface PaymentSummary {
  id: string;
  packageId: string;
  expectedAmountThb: string;
  verifiedAmountThb: string | null;
  paymentStatus: string;
  approvedAt: string | null;
  createdAt: string;
}

export interface CustomerTokenSummary {
  id: string;
  groupId: string;
  tokenIdentifier: string;
  quotaCny: string;
  status: string;
  createdAt: string;
}

/**
 * Strict Customer Profile DTO containing the core business fields
 * mandated by the Master Development Specification, extended with New API Token records.
 */
export interface CustomerProfile {
  username: string; // 1. Username
  userId: string; // 2. UserID (Discord User ID)
  apiKey: string; // 3. API Key (status/masked)
  balance: string; // 4. Balance (reference/recorded balance with explicit currency, e.g. "¥0.00 CNY")
  keyStatus: KeyStatus; // 5. Key Status (ACTIVE, DISABLED, SUSPENDED)
  paymentHistory: PaymentSummary[]; // 6. Payment History
  tokens?: CustomerTokenSummary[]; // 7. New API Token Identifiers
}
