import { describe, it, expect } from 'vitest';
import { CryptoService } from '../../src/services/crypto.service.js';

describe('Phase 8: Application Security Hardening Tests', () => {
  const validSecretHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('1. Masking: API key is properly masked and never exposes full token', () => {
    const rawKey = 'nx-live-11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
    const masked = CryptoService.maskApiKey(rawKey);

    expect(masked).toBe('nx-live-1122...eeff');
    expect(masked).not.toContain('3344556677889900aabbccdd');
    expect(CryptoService.maskApiKey('short')).toBe('****');
  });

  it('2. Cryptographic encryption: AES-256-GCM encrypts and decrypts with authentication tag verification', () => {
    const sensitiveData = 'bearlab-secret-production-token-12345';
    const encrypted = CryptoService.encryptSecret(sensitiveData, validSecretHex);

    expect(encrypted.encrypted).toBeDefined();
    expect(encrypted.iv.length).toBe(24); // 12 bytes = 24 hex
    expect(encrypted.authTag.length).toBe(32); // 16 bytes = 32 hex

    const decrypted = CryptoService.decryptSecret(
      encrypted.encrypted,
      encrypted.iv,
      encrypted.authTag,
      validSecretHex
    );

    expect(decrypted).toBe(sensitiveData);
  });

  it('3. Tamper detection: AES-256-GCM throws on modified ciphertext or invalid auth tag', () => {
    const sensitiveData = 'critical-financial-payload';
    const encrypted = CryptoService.encryptSecret(sensitiveData, validSecretHex);

    // Tampered ciphertext
    const lastByte = encrypted.encrypted.slice(-2);
    const tamperedCiphertext = encrypted.encrypted.slice(0, -2) + (lastByte === '00' ? 'ff' : '00');
    expect(() =>
      CryptoService.decryptSecret(
        tamperedCiphertext,
        encrypted.iv,
        encrypted.authTag,
        validSecretHex
      )
    ).toThrow();

    // Tampered auth tag
    const tamperedAuthTag = '00000000000000000000000000000000';
    expect(() =>
      CryptoService.decryptSecret(
        encrypted.encrypted,
        encrypted.iv,
        tamperedAuthTag,
        validSecretHex
      )
    ).toThrow();
  });

  it('4. Rejects invalid encryption secret lengths', () => {
    expect(() => CryptoService.encryptSecret('data', 'too-short')).toThrow(
      'Encryption secret must be a 32-byte (64 hex characters) key.'
    );
  });
});
