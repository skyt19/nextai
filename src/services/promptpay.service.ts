import { payloadFor } from 'thai-qr-payment';
import QRCode from 'qrcode';

export interface PromptPayQrOptions {
  recipient: string;
  amount: number | string;
  size?: number;
}

export interface PromptPayQrResult {
  payload: string;
  qrBuffer: Buffer;
  formattedAmount: string;
}

export class PromptPayService {
  /**
   * Generates a fully compliant PromptPay EMVCo payload string and PNG QR code buffer.
   * Uses Decimal/number-compatible rounding for the exact amount.
   */
  public static async generatePromptPayQr(options: PromptPayQrOptions): Promise<PromptPayQrResult> {
    const rawAmount = typeof options.amount === 'string' ? parseFloat(options.amount) : options.amount;
    if (isNaN(rawAmount) || rawAmount <= 0) {
      throw new Error(`Invalid PromptPay amount: ${options.amount}. Amount must be a positive number.`);
    }

    const formattedAmount = rawAmount.toFixed(2);
    const sanitizedRecipient = options.recipient.replace(/[^0-9]/g, '');
    if (sanitizedRecipient.length !== 10 && sanitizedRecipient.length !== 13 && sanitizedRecipient.length !== 15) {
      throw new Error(
        `Invalid PromptPay recipient: '${options.recipient}'. Recipient must be a 10-digit mobile number, 13-digit citizen/tax ID, or 15-digit e-Wallet ID.`
      );
    }

    // 1. Generate EMVCo standard PromptPay payload string
    const payload = payloadFor({
      recipient: sanitizedRecipient,
      amount: rawAmount,
    });

    // 2. Render into high-quality PNG Buffer
    const qrBuffer = await QRCode.toBuffer(payload, {
      type: 'png',
      width: options.size ?? 300,
      margin: 2,
      errorCorrectionLevel: 'M',
    });

    return {
      payload,
      qrBuffer,
      formattedAmount,
    };
  }
}
