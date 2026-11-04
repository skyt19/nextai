import crypto from 'node:crypto';

export class CryptoService {
  /**
   * Generates a high-entropy, secure Next AI API Key.
   * Format: nx-live-<64-char-hex>
   */
  public static generateApiKey(): string {
    const randomBytes = crypto.randomBytes(32).toString('hex');
    return `nx-live-${randomBytes}`;
  }

  /**
   * Hashes an API key using SHA-256 for secure database storage.
   */
  public static hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
  }

  /**
   * Returns a masked version of an API key for safe display (e.g. in /account or logs).
   * Example: nx-live-a1b2...9z8y
   */
  public static maskApiKey(apiKey: string): string {
    const trimmed = apiKey.trim();
    if (trimmed.length <= 16) {
      return '****';
    }
    const prefix = trimmed.slice(0, 12);
    const suffix = trimmed.slice(-4);
    return `${prefix}...${suffix}`;
  }

  /**
   * Encrypts sensitive secrets (e.g. Bearlab API keys) using AES-256-GCM.
   */
  public static encryptSecret(
    plainText: string,
    secretHex: string
  ): { encrypted: string; iv: string; authTag: string } {
    const key = Buffer.from(secretHex, 'hex');
    if (key.length !== 32) {
      throw new Error('Encryption secret must be a 32-byte (64 hex characters) key.');
    }

    const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypts AES-256-GCM encrypted secrets.
   */
  public static decryptSecret(
    encrypted: string,
    ivHex: string,
    authTagHex: string,
    secretHex: string
  ): string {
    const key = Buffer.from(secretHex, 'hex');
    if (key.length !== 32) {
      throw new Error('Encryption secret must be a 32-byte (64 hex characters) key.');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
