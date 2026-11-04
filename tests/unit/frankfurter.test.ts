import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FrankfurterService,
  ExchangeRateUnavailableError,
  ExchangeRateStaleError,
  ExchangeRatesNotInitializedError,
  InvalidExchangeRateError,
} from '../../src/services/frankfurter.service.js';
import { getPrismaClient } from '../../src/db/client.js';
import { loadEnv } from '../../src/config/env.js';
import { Decimal } from 'decimal.js';

describe('FrankfurterService & FX Integration Tests (Finalized Step 6)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    try {
      const prisma = getPrismaClient();
      await prisma.exchangeRateSnapshot.deleteMany();
    } catch {
      // Ignore
    }
  });

  describe('Task 1: Configuration from Environment', () => {
    it('initializes configuration with environment defaults', () => {
      const service = new FrankfurterService();
      expect(service.getApiBaseUrl()).toBe('https://api.frankfurter.dev/v2');
      expect(service.getCacheTtlMs()).toBe(60 * 60 * 1000);
      expect(service.getMaxStaleMs()).toBe(24 * 60 * 60 * 1000);
      expect(service.getFxSpreadPercent().toString()).toBe('0');
    });

    it('rejects invalid or non-positive configuration values', () => {
      expect(() => new FrankfurterService({ cacheTtlMinutes: 0 })).toThrow(
        /cacheTtlMinutes must be a positive number/
      );
      expect(() => new FrankfurterService({ cacheTtlMinutes: -5 })).toThrow(
        /cacheTtlMinutes must be a positive number/
      );
      expect(() => new FrankfurterService({ maxStaleHours: 0 })).toThrow(
        /maxStaleHours must be a positive number/
      );
      expect(() => new FrankfurterService({ fxSpreadPercent: -1 })).toThrow(
        /fxSpreadPercent must be a valid non-negative finite number/
      );
      expect(() => new FrankfurterService({ apiBaseUrl: 'not-a-valid-url' })).toThrow(
        /Invalid Frankfurter API base URL/
      );
    });
  });

  describe('Task 7 Checklist 1-5: API Handling, Errors & Timeouts', () => {
    it('1. handles successful Frankfurter API response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          base: 'CNY',
          date: '2026-11-02',
          rates: { THB: 5.1245, USD: 0.1412 },
        }),
      });

      const service = new FrankfurterService();
      const rates = await service.getRates();

      expect(rates.baseCurrency).toBe('CNY');
      expect(rates.rateDate).toBe('2026-11-02');
      expect(rates.rates.THB.toString()).toBe('5.1245');
      expect(rates.rates.USD.toString()).toBe('0.1412');
      expect(rates.isStale).toBe(false);
      expect(service.isInitialized()).toBe(true);
    });

    it('1b. handles Frankfurter v2 array response format', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { date: '2026-11-02', base: 'CNY', quote: 'THB', rate: 5.0764 },
          { date: '2026-11-03', base: 'CNY', quote: 'USD', rate: 0.15038 },
        ],
      });

      const service = new FrankfurterService();
      const rates = await service.getRates();

      expect(rates.baseCurrency).toBe('CNY');
      expect(rates.rateDate).toBe('2026-11-03');
      expect(rates.rates.THB.toString()).toBe('5.0764');
      expect(rates.rates.USD.toString()).toBe('0.15038');
      expect(rates.isStale).toBe(false);
      expect(service.isInitialized()).toBe(true);
    });

    it('2. rejects invalid or malformed non-JSON API response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Unexpected token < in JSON');
        },
      });

      const service = new FrankfurterService();
      vi.spyOn(service as any, 'loadLatestDbSnapshot').mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow(ExchangeRateUnavailableError);
    });

    it('3. rejects response with missing or non-positive THB/USD rates', async () => {
      // Missing USD
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          base: 'CNY',
          date: '2026-11-02',
          rates: { THB: 5.12 },
        }),
      });

      const service = new FrankfurterService();
      vi.spyOn(service as any, 'loadLatestDbSnapshot').mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow(ExchangeRateUnavailableError);

      // Non-positive THB
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          base: 'CNY',
          date: '2026-11-02',
          rates: { THB: -5.12, USD: 0.14 },
        }),
      });

      await expect(service.getRates()).rejects.toThrow(ExchangeRateUnavailableError);
    });

    it('4. handles API HTTP error (status 500, 404)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const service = new FrankfurterService();
      vi.spyOn(service as any, 'loadLatestDbSnapshot').mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow(ExchangeRateUnavailableError);
    });

    it('5. handles API network timeout or fetch failure', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      global.fetch = vi.fn().mockRejectedValue(abortError);

      const service = new FrankfurterService();
      vi.spyOn(service as any, 'loadLatestDbSnapshot').mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow(ExchangeRateUnavailableError);
    });
  });

  describe('Task 7 Checklist 6: In-Memory Cache TTL', () => {
    it('reuses in-memory cached rate within TTL and refreshes on forceRefresh', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          base: 'CNY',
          date: '2026-11-02',
          rates: { THB: 5.12, USD: 0.14 },
        }),
      });
      global.fetch = fetchMock;

      const service = new FrankfurterService({ cacheTtlMinutes: 30 });
      await service.getRates();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Sub-TTL call uses cache
      const cached = await service.getRates(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cached.rates.THB.toString()).toBe('5.12');

      // forceRefresh bypasses cache
      await service.getRates(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Task 2 & Task 7 Checklist 7-10: Snapshot Consistency & Stale Policy', () => {
    it('8. ensures THB and USD in DB snapshot always share identical retrievedAt timestamp', async () => {
      const prisma = getPrismaClient();

      // Simulate historical snapshots in DB:
      // Pair 1 (older, 2 hours ago): THB = 5.10, USD = 0.140
      const timestamp1 = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await prisma.exchangeRateSnapshot.createMany({
        data: [
          {
            baseCurrency: 'CNY',
            quoteCurrency: 'THB',
            rate: '5.10',
            rateDate: '2026-11-02',
            retrievedAt: timestamp1,
            source: 'Frankfurter API',
          },
          {
            baseCurrency: 'CNY',
            quoteCurrency: 'USD',
            rate: '0.140',
            rateDate: '2026-11-02',
            retrievedAt: timestamp1,
            source: 'Frankfurter API',
          },
        ],
      });

      // An incomplete snapshot written at a newer timestamp (only USD written, THB missing)
      const timestamp2 = new Date(Date.now() - 1 * 60 * 60 * 1000);
      await prisma.exchangeRateSnapshot.create({
        data: {
          baseCurrency: 'CNY',
          quoteCurrency: 'USD',
          rate: '0.999',
          rateDate: '2026-11-02',
          retrievedAt: timestamp2,
          source: 'Incomplete Run',
        },
      });

      // Make API fail so service falls back to DB
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const service = new FrankfurterService();
      const fallback = await service.getRates();

      // Must NOT combine timestamp2 USD (0.999) with timestamp1 THB (5.10)!
      // It must consistently return Pair 1 where BOTH quotes share the exact same timestamp!
      expect(fallback.isStale).toBe(true);
      expect(fallback.rates.THB.toString()).toBe('5.1');
      expect(fallback.rates.USD.toString()).toBe('0.14');
      expect(fallback.retrievedAt.getTime()).toBe(timestamp1.getTime());
    });

    it('9. marks snapshot as stale within max stale threshold', async () => {
      const prisma = getPrismaClient();
      const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours old (allowed by 24h threshold)

      await prisma.exchangeRateSnapshot.createMany({
        data: [
          {
            baseCurrency: 'CNY',
            quoteCurrency: 'THB',
            rate: '5.11',
            rateDate: '2026-11-02',
            retrievedAt: pastTime,
            source: 'Frankfurter API',
          },
          {
            baseCurrency: 'CNY',
            quoteCurrency: 'USD',
            rate: '0.141',
            rateDate: '2026-11-02',
            retrievedAt: pastTime,
            source: 'Frankfurter API',
          },
        ],
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('API Down'));

      const service = new FrankfurterService({ maxStaleHours: 24 });
      const rates = await service.getRates();

      expect(rates.isStale).toBe(true);
      expect(rates.rates.THB.toString()).toBe('5.11');
    });

    it('10. throws ExchangeRateStaleError when DB snapshot exceeds max stale threshold', async () => {
      const prisma = getPrismaClient();
      const veryOldTime = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30 hours old (> 24h)

      await prisma.exchangeRateSnapshot.createMany({
        data: [
          {
            baseCurrency: 'CNY',
            quoteCurrency: 'THB',
            rate: '5.00',
            rateDate: '2026-11-01',
            retrievedAt: veryOldTime,
            source: 'Frankfurter API',
          },
          {
            baseCurrency: 'CNY',
            quoteCurrency: 'USD',
            rate: '0.138',
            rateDate: '2026-11-01',
            retrievedAt: veryOldTime,
            source: 'Frankfurter API',
          },
        ],
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('API Down'));

      const service = new FrankfurterService({ maxStaleHours: 24 });
      await expect(service.getRates()).rejects.toThrow(ExchangeRateStaleError);
    });

    it('11. throws ExchangeRateUnavailableError when API fails and no snapshot exists', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('DNS Failure'));

      const service = new FrankfurterService();
      vi.spyOn(service as any, 'loadLatestDbSnapshot').mockResolvedValue(null);

      await expect(service.getRates()).rejects.toThrow(ExchangeRateUnavailableError);
    });
  });

  describe('Task 3 & Task 7 Checklist 12-13: Currency Conversions & Initialization', () => {
    it('13. synchronous conversions throw ExchangeRatesNotInitializedError before rates are loaded', () => {
      const service = new FrankfurterService();
      expect(service.isInitialized()).toBe(false);

      expect(() => service.convertCnyToThb(100)).toThrow(ExchangeRatesNotInitializedError);
      expect(() => service.convertCnyToUsd(100)).toThrow(ExchangeRatesNotInitializedError);
      expect(() => service.convertThbToUsd(500)).toThrow(ExchangeRatesNotInitializedError);
      expect(() => service.convertThbToCny(500)).toThrow(ExchangeRatesNotInitializedError);
      expect(() => service.convertUsdToCny(14)).toThrow(ExchangeRatesNotInitializedError);
    });

    it('13. asynchronous conversions automatically initialize rates if uninitialized', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          base: 'CNY',
          date: '2026-11-02',
          rates: { THB: 5.0, USD: 0.14 },
        }),
      });

      const service = new FrankfurterService();
      expect(service.isInitialized()).toBe(false);

      const thb = await service.convertCnyToThbAsync('100');
      expect(thb.toString()).toBe('500');
      expect(service.isInitialized()).toBe(true);

      const usd = await service.convertCnyToUsdAsync('100');
      expect(usd.toString()).toBe('14');
    });

    it('12. calculates Decimal conversion accurately with and without FX spread', async () => {
      const service = new FrankfurterService();
      await service.setAdminFallbackRate('5.1234', '0.1420', '2026-11-02');

      // 100 CNY * 5.1234 = 512.34
      const thb = service.convertCnyToThb('100');
      expect(thb.toString()).toBe('512.34');

      // 100 CNY with 1.5% spread: 100 * (5.1234 * 1.015) = 520.0251
      const thbSpread = service.convertCnyToThb('100', '1.5');
      expect(thbSpread.toFixed(4)).toBe('520.0251');

      // 512.34 THB -> USD = (512.34 / 5.1234) * 0.1420 = 100 * 0.1420 = 14.2
      const usdFromThb = service.convertThbToUsd('512.34');
      expect(usdFromThb.toString()).toBe('14.2');

      // Reverse conversions
      const cnyFromThb = service.convertThbToCny('512.34');
      expect(cnyFromThb.toString()).toBe('100');

      const cnyFromUsd = service.convertUsdToCny('14.2');
      expect(cnyFromUsd.toString()).toBe('100');
    });
  });

  describe('Task 4 & Task 7 Checklist 14-15: Validate Admin Fallback Rates', () => {
    it('14. rejects invalid, zero, or negative admin fallback rates', async () => {
      const service = new FrankfurterService();

      await expect(service.setAdminFallbackRate('0', '0.14')).rejects.toThrow(
        InvalidExchangeRateError
      );
      await expect(service.setAdminFallbackRate('-5.12', '0.14')).rejects.toThrow(
        InvalidExchangeRateError
      );
      await expect(service.setAdminFallbackRate('not-a-number', '0.14')).rejects.toThrow(
        InvalidExchangeRateError
      );
      await expect(service.setAdminFallbackRate('5.12', '-0.14')).rejects.toThrow(
        InvalidExchangeRateError
      );
      await expect(service.setAdminFallbackRate('5.12', '0')).rejects.toThrow(
        InvalidExchangeRateError
      );
      await expect(service.setAdminFallbackRate('5.12', 'NaN')).rejects.toThrow(
        InvalidExchangeRateError
      );
    });

    it('15. rejects invalid admin fallback rate dates (format or non-existent calendar date)', async () => {
      const service = new FrankfurterService();

      // Format violation
      await expect(service.setAdminFallbackRate('5.12', '0.14', '02-11-2026')).rejects.toThrow(
        InvalidExchangeRateError
      );
      await expect(service.setAdminFallbackRate('5.12', '0.14', '2026/11/02')).rejects.toThrow(
        InvalidExchangeRateError
      );

      // Calendar violation (Feb 31 does not exist)
      await expect(service.setAdminFallbackRate('5.12', '0.14', '2026-02-31')).rejects.toThrow(
        InvalidExchangeRateError
      );

      // Valid rate and date succeeds
      const valid = await service.setAdminFallbackRate('5.15', '0.145', '2026-11-02');
      expect(valid.rates.THB.toString()).toBe('5.15');
      expect(valid.rateDate).toBe('2026-11-02');
    });
  });

  describe('Task 5 & Task 7 Checklist 16: Snapshot DB Error Handling', () => {
    it('16. logs structured error when DB snapshot persistence fails without crashing in-memory rates', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          base: 'CNY',
          date: '2026-11-02',
          rates: { THB: 5.12, USD: 0.14 },
        }),
      });

      const service = new FrankfurterService();
      // Force persistSnapshots to encounter DB error
      const prisma = getPrismaClient();
      vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('DB Disk Full'));

      // Fetch rates should still succeed in-memory
      const rates = await service.getRates();
      expect(rates.rates.THB.toString()).toBe('5.12');
      expect(service.isInitialized()).toBe(true);

      // Verify structured error was logged without exposing credentials
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FrankfurterService] Failed to persist exchange rate snapshot')
      );
    });
  });

  describe('Task 6 & Task 7 Checklist 17: Production Encryption Secret Validation', () => {
    const valid64Hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const devPlaceholder = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('rejects missing or empty secret in production', () => {
      expect(() =>
        loadEnv({
          NODE_ENV: 'production',
          ENCRYPTION_SECRET: '',
        })
      ).toThrow(/ENCRYPTION_SECRET is required in production environment/);
    });

    it('rejects known development placeholder secret in production', () => {
      expect(() =>
        loadEnv({
          NODE_ENV: 'production',
          ENCRYPTION_SECRET: devPlaceholder,
        })
      ).toThrow(/Known development placeholder ENCRYPTION_SECRET cannot be used in production/);
    });

    it('rejects invalid hex or non-64-char secret in any environment', () => {
      expect(() =>
        loadEnv({
          NODE_ENV: 'development',
          ENCRYPTION_SECRET: 'not-a-hex-key',
        })
      ).toThrow(/ENCRYPTION_SECRET must be a 64-character hexadecimal string/);

      expect(() =>
        loadEnv({
          NODE_ENV: 'production',
          ENCRYPTION_SECRET: '123456', // Too short
        })
      ).toThrow(/ENCRYPTION_SECRET must be a 64-character hexadecimal string/);
    });

    it('accepts explicitly configured valid 64-char hex secret in production', () => {
      const prodEnv = loadEnv({
        NODE_ENV: 'production',
        ENCRYPTION_SECRET: valid64Hex,
      });
      expect(prodEnv.ENCRYPTION_SECRET).toBe(valid64Hex);
    });

    it('defaults to dev placeholder in development/test when unspecified', () => {
      const devEnv = loadEnv({
        NODE_ENV: 'development',
        ENCRYPTION_SECRET: undefined,
      });
      expect(devEnv.ENCRYPTION_SECRET).toBe(devPlaceholder);
    });
  });
});
