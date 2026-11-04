import { describe, it, expect } from 'vitest';
import { CryptoService } from '../../src/services/crypto.service.js';

describe('CryptoService Unit Tests', () => {
  const secretKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('generates secure API keys with nx-live- prefix and 64-char random hex', () => {
    const key1 = CryptoService.generateApiKey();
    const key2 = CryptoService.generateApiKey();

    expect(key1).not.toBe(key2);
    expect(key1.startsWith('nx-live-')).toBe(true);
    expect(key1.length).toBe(8 + 64); // 'nx-live-' (8) + 64 hex characters
  });

  it('consistently hashes API keys with SHA-256', () => {
    const key = 'nx-live-test-sample-key-12345';
    const hash1 = CryptoService.hashApiKey(key);
    const hash2 = CryptoService.hashApiKey(key);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 is 32 bytes = 64 hex chars
    expect(hash1).not.toBe(key);
  });

  it('masks API keys for safe logging and display', () => {
    const key = 'nx-live-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const masked = CryptoService.maskApiKey(key);

    expect(masked).toBe('nx-live-1234...cdef');
    expect(masked.length).toBe(19);
    expect(masked).not.toBe(key);
  });

  it('encrypts and decrypts secrets using AES-256-GCM', () => {
    const originalText = 'sk-bearlab-secret-production-key-xyz987';
    const { encrypted, iv, authTag } = CryptoService.encryptSecret(originalText, secretKey);

    expect(encrypted).not.toBe(originalText);
    expect(iv.length).toBe(24); // 12 bytes = 24 hex chars
    expect(authTag.length).toBe(32); // 16 bytes = 32 hex chars

    const decrypted = CryptoService.decryptSecret(encrypted, iv, authTag, secretKey);
    expect(decrypted).toBe(originalText);
  });

  it('fails decryption if ciphertext or auth tag is tampered with', () => {
    const originalText = 'sensitive-token';
    const { encrypted, iv, authTag } = CryptoService.encryptSecret(originalText, secretKey);

    // Tamper with auth tag
    const tamperedTag = authTag.replace(/[0-9a-f]/, '0');
    expect(() =>
      CryptoService.decryptSecret(encrypted, iv, tamperedTag, secretKey)
    ).toThrow();
  });
});
