import { describe, it, expect } from 'vitest';
import { PromptPayService } from '../../src/services/promptpay.service.js';

/**
 * Independent EMVCo TLV (Tag-Length-Value) Parser.
 * Parses the raw QR payload according to the EMVCo standard without any third-party library.
 */
function parseEmvCoTlv(payload: string): Map<string, string> {
  const tags = new Map<string, string>();
  let i = 0;
  while (i < payload.length) {
    const tag = payload.slice(i, i + 2);
    const length = parseInt(payload.slice(i + 2, i + 4), 10);
    if (isNaN(length)) break;
    const value = payload.slice(i + 4, i + 4 + length);
    tags.set(tag, value);
    i += 4 + length;
  }
  return tags;
}

describe('PromptPayService', () => {
  it('generates a valid EMVCo payload and PNG buffer for a phone number', async () => {
    const result = await PromptPayService.generatePromptPayQr({
      recipient: '0812345678',
      amount: '51.00',
    });

    expect(result.payload).toContain('000201'); // Standard EMVCo header
    expect(result.payload).toContain('5303764'); // Currency THB (764)
    expect(result.payload).toContain('540551.00'); // Amount 51.00
    expect(result.formattedAmount).toBe('51.00');
    expect(Buffer.isBuffer(result.qrBuffer)).toBe(true);
    expect(result.qrBuffer.length).toBeGreaterThan(500);

    // Independent EMVCo TLV parse verification
    const tlvMap = parseEmvCoTlv(result.payload);
    expect(tlvMap.get('00')).toBe('01'); // Payload format indicator
    expect(tlvMap.get('53')).toBe('764'); // ISO 4217 Currency THB
    expect(tlvMap.get('54')).toBe('51.00'); // Explicit transaction amount: exactly 51.00 THB!
    expect(tlvMap.get('58')).toBe('TH'); // Country code Thailand
    expect(tlvMap.has('63')).toBe(true); // CRC-16 Checksum tag exists
  });

  it('generates valid payload for 13-digit National ID / Tax ID recipient', async () => {
    const result = await PromptPayService.generatePromptPayQr({
      recipient: '1234567890123',
      amount: '51.00',
    });

    const tlvMap = parseEmvCoTlv(result.payload);
    expect(tlvMap.get('54')).toBe('51.00');
    expect(result.formattedAmount).toBe('51.00');
  });

  it('rejects invalid or non-positive amounts', async () => {
    await expect(
      PromptPayService.generatePromptPayQr({
        recipient: '0812345678',
        amount: '-10',
      })
    ).rejects.toThrow('Amount must be a positive number');

    await expect(
      PromptPayService.generatePromptPayQr({
        recipient: '0812345678',
        amount: 'invalid',
      })
    ).rejects.toThrow('Amount must be a positive number');
  });

  it('strictly validates recipient format (must be 10, 13, or 15 digits)', async () => {
    // 8 digits (too short)
    await expect(
      PromptPayService.generatePromptPayQr({
        recipient: '08123456',
        amount: '51.00',
      })
    ).rejects.toThrow('Invalid PromptPay recipient');

    // 11 digits (invalid length)
    await expect(
      PromptPayService.generatePromptPayQr({
        recipient: '08123456789',
        amount: '51.00',
      })
    ).rejects.toThrow('Invalid PromptPay recipient');

    // letters
    await expect(
      PromptPayService.generatePromptPayQr({
        recipient: 'not-a-number',
        amount: '51.00',
      })
    ).rejects.toThrow('Invalid PromptPay recipient');
  });
});
