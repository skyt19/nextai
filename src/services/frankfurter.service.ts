import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { getPrismaClient } from '../db/client.js';
import { env } from '../config/env.js';

const frankfurterObjectSchema = z.object({
  amount: z.number().optional(),
  base: z.string(),
  date: z.string(),
  rates: z.record(z.number()),
});

const frankfurterArrayItemSchema = z.object({
  date: z.string(),
  base: z.string(),
  quote: z.string(),
  rate: z.number(),
});
const frankfurterArraySchema = z.array(frankfurterArrayItemSchema);

const frankfurterResponseSchema = z.union([frankfurterObjectSchema, frankfurterArraySchema]);

export interface ExchangeRates {
  baseCurrency: string;
  rateDate: string;
  retrievedAt: Date;
  rates: {
    THB: Decimal;
    USD: Decimal;
  };
  isStale: boolean;
  source: string;
}

export class ExchangeRateError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ExchangeRateError';
  }
}

export class ExchangeRateUnavailableError extends ExchangeRateError {
  constructor(message: string = 'Exchange rates are unavailable and no valid cached rate exists.') {
    super(message, 'EXCHANGE_RATES_UNAVAILABLE');
  }
}

export class ExchangeRateStaleError extends ExchangeRateError {
  constructor(lastUpdated: Date) {
    super(
      `Exchange rates are older than the allowed stale threshold (last retrieved at: ${lastUpdated.toISOString()}). Payment calculations are blocked.`,
      'EXCHANGE_RATES_STALE'
    );
  }
}

export class ExchangeRatesNotInitializedError extends ExchangeRateError {
  constructor() {
    super(
      'Exchange rates have not been initialized. Call getRates() before performing conversions.',
      'EXCHANGE_RATES_NOT_INITIALIZED'
    );
  }
}

export class InvalidExchangeRateError extends ExchangeRateError {
  constructor(message: string) {
    super(message, 'INVALID_EXCHANGE_RATE');
  }
}

export interface FrankfurterServiceOptions {
  apiBaseUrl?: string;
  cacheTtlMinutes?: number;
  maxStaleHours?: number;
  fxSpreadPercent?: Decimal | string | number;
}

export class FrankfurterService {
  private readonly apiBaseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly fxSpreadPercent: Decimal;

  private memoryCache: ExchangeRates | null = null;

  constructor(options: FrankfurterServiceOptions = {}) {
    // 1. Resolve configuration with environment fallback
    const resolvedApiBase = options.apiBaseUrl ?? env.FRANKFURTER_API_BASE ?? 'https://api.frankfurter.dev/v2';
    const resolvedCacheTtl = options.cacheTtlMinutes ?? env.EXCHANGE_RATE_CACHE_TTL_MINUTES ?? 60;
    const resolvedMaxStale = options.maxStaleHours ?? env.EXCHANGE_RATE_MAX_STALE_HOURS ?? 24;
    const resolvedFxSpread = options.fxSpreadPercent ?? env.FX_SPREAD_PERCENT ?? 0;

    // 2. Validate configuration
    try {
      new URL(resolvedApiBase);
    } catch {
      throw new Error(`Invalid Frankfurter API base URL: '${resolvedApiBase}'`);
    }

    if (typeof resolvedCacheTtl !== 'number' || !Number.isFinite(resolvedCacheTtl) || resolvedCacheTtl <= 0) {
      throw new Error(`cacheTtlMinutes must be a positive number. Received: ${resolvedCacheTtl}`);
    }

    if (typeof resolvedMaxStale !== 'number' || !Number.isFinite(resolvedMaxStale) || resolvedMaxStale <= 0) {
      throw new Error(`maxStaleHours must be a positive number. Received: ${resolvedMaxStale}`);
    }

    let parsedSpread: Decimal;
    try {
      parsedSpread = new Decimal(resolvedFxSpread);
      if (!parsedSpread.isFinite() || parsedSpread.isNegative()) {
        throw new Error();
      }
    } catch {
      throw new Error(`fxSpreadPercent must be a valid non-negative finite number. Received: ${resolvedFxSpread}`);
    }

    this.apiBaseUrl = resolvedApiBase.replace(/\/+$/, '');
    this.cacheTtlMs = resolvedCacheTtl * 60 * 1000;
    this.maxStaleMs = resolvedMaxStale * 60 * 60 * 1000;
    this.fxSpreadPercent = parsedSpread;
  }

  public getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  public getCacheTtlMs(): number {
    return this.cacheTtlMs;
  }

  public getMaxStaleMs(): number {
    return this.maxStaleMs;
  }

  public getFxSpreadPercent(): Decimal {
    return this.fxSpreadPercent;
  }

  /**
   * Returns true if in-memory exchange rates have been initialized and are ready for conversions.
   */
  public isInitialized(): boolean {
    return this.memoryCache !== null;
  }

  /**
   * Fetches latest rates from cache, API, or DB snapshot with strict stale-rate policy.
   */
  public async getRates(forceRefresh: boolean = false): Promise<ExchangeRates> {
    const now = Date.now();

    // 1. Check in-memory cache
    if (!forceRefresh && this.memoryCache && !this.memoryCache.isStale) {
      const age = now - this.memoryCache.retrievedAt.getTime();
      if (age < this.cacheTtlMs) {
        return this.memoryCache;
      }
    }

    // 2. Attempt fetching fresh rates from Frankfurter API
    try {
      const freshRates = await this.fetchFromApi();
      this.memoryCache = freshRates;
      await this.persistSnapshots(freshRates);
      return freshRates;
    } catch (apiError) {
      // 3. Fallback to DB snapshot under explicit stale rate policy
      const fallbackSnapshot = await this.loadLatestDbSnapshot();
      if (!fallbackSnapshot) {
        throw new ExchangeRateUnavailableError(
          `Unable to retrieve rates from Frankfurter API and no cached fallback exists. (${(apiError as Error).message})`
        );
      }

      const age = now - fallbackSnapshot.retrievedAt.getTime();
      if (age > this.maxStaleMs) {
        throw new ExchangeRateStaleError(fallbackSnapshot.retrievedAt);
      }

      fallbackSnapshot.isStale = true;
      this.memoryCache = fallbackSnapshot;
      return fallbackSnapshot;
    }
  }

  /**
   * Directly fetches rates from Frankfurter HTTP API.
   */
  private async fetchFromApi(): Promise<ExchangeRates> {
    const url = `${this.apiBaseUrl}/rates?base=CNY&quotes=THB,USD`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Frankfurter API returned HTTP ${response.status}: ${response.statusText}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('Frankfurter API returned malformed or non-JSON response');
    }

    const parsed = frankfurterResponseSchema.parse(json);

    let baseCurrency = 'CNY';
    let rateDate = '';
    let thbRaw: number | undefined;
    let usdRaw: number | undefined;

    if (Array.isArray(parsed)) {
      // Frankfurter v2 array format: [{ date, base, quote, rate }]
      for (const item of parsed) {
        if (item.quote === 'THB') {
          thbRaw = item.rate;
          if (!rateDate || item.date > rateDate) rateDate = item.date;
        } else if (item.quote === 'USD') {
          usdRaw = item.rate;
          if (!rateDate || item.date > rateDate) rateDate = item.date;
        }
        if (item.base) {
          baseCurrency = item.base;
        }
      }
    } else {
      // Frankfurter v1 / object format: { base, date, rates: { THB, USD } }
      baseCurrency = parsed.base;
      rateDate = parsed.date;
      thbRaw = parsed.rates['THB'];
      usdRaw = parsed.rates['USD'];
    }

    if (thbRaw === undefined || usdRaw === undefined) {
      throw new Error("Frankfurter response missing required 'THB' or 'USD' quotes");
    }

    const thbDec = new Decimal(thbRaw);
    const usdDec = new Decimal(usdRaw);

    if (!thbDec.isFinite() || !thbDec.isPositive() || thbDec.isZero()) {
      throw new Error("Frankfurter response contains invalid non-positive 'THB' rate");
    }
    if (!usdDec.isFinite() || !usdDec.isPositive() || usdDec.isZero()) {
      throw new Error("Frankfurter response contains invalid non-positive 'USD' rate");
    }

    return {
      baseCurrency,
      rateDate: rateDate || new Date().toISOString().split('T')[0] || '2026-11-03',
      retrievedAt: new Date(),
      rates: {
        THB: thbDec,
        USD: usdDec,
      },
      isStale: false,
      source: 'Frankfurter API',
    };
  }

  /**
   * Persists snapshots into database table exchange_rate_snapshots.
   * Uses an atomic transaction so both quotes share the exact same retrievedAt timestamp.
   * Temporary DB errors are logged without breaking in-memory availability.
   */
  private async persistSnapshots(rates: ExchangeRates): Promise<void> {
    try {
      const prisma = getPrismaClient();
      await prisma.$transaction([
        prisma.exchangeRateSnapshot.create({
          data: {
            baseCurrency: rates.baseCurrency,
            quoteCurrency: 'THB',
            rate: rates.rates.THB.toString(),
            rateDate: rates.rateDate,
            retrievedAt: rates.retrievedAt,
            source: rates.source,
            isStale: rates.isStale,
          },
        }),
        prisma.exchangeRateSnapshot.create({
          data: {
            baseCurrency: rates.baseCurrency,
            quoteCurrency: 'USD',
            rate: rates.rates.USD.toString(),
            rateDate: rates.rateDate,
            retrievedAt: rates.retrievedAt,
            source: rates.source,
            isStale: rates.isStale,
          },
        }),
      ]);
    } catch (dbError: any) {
      const errorMsg = dbError instanceof Error ? dbError.message : String(dbError);
      console.error(
        `[FrankfurterService] Failed to persist exchange rate snapshot to database: ${errorMsg}. Continuing with in-memory rates.`
      );
    }
  }

  /**
   * Loads the latest snapshot from database.
   * Ensures that THB and USD rates always belong to the same logical snapshot (identical retrievedAt).
   */
  private async loadLatestDbSnapshot(): Promise<ExchangeRates | null> {
    try {
      const prisma = getPrismaClient();

      const recentSnapshots = await prisma.exchangeRateSnapshot.findMany({
        where: { baseCurrency: 'CNY' },
        orderBy: { retrievedAt: 'desc' },
        take: 50,
      });

      if (recentSnapshots.length === 0) {
        return null;
      }

      // Group entries by exact timestamp (epoch ms) to ensure snapshot consistency
      const groupedByTimestamp = new Map<
        number,
        { thb?: (typeof recentSnapshots)[0]; usd?: (typeof recentSnapshots)[0] }
      >();

      for (const entry of recentSnapshots) {
        const timeKey = entry.retrievedAt.getTime();
        const group = groupedByTimestamp.get(timeKey) || {};
        if (entry.quoteCurrency === 'THB') {
          group.thb = entry;
        } else if (entry.quoteCurrency === 'USD') {
          group.usd = entry;
        }
        groupedByTimestamp.set(timeKey, group);
      }

      // Find the latest timestamp that contains BOTH THB and USD from the same fetch
      for (const [_, group] of groupedByTimestamp) {
        if (group.thb && group.usd) {
          return {
            baseCurrency: 'CNY',
            rateDate: group.thb.rateDate,
            retrievedAt: group.thb.retrievedAt,
            rates: {
              THB: new Decimal(group.thb.rate.toString()),
              USD: new Decimal(group.usd.rate.toString()),
            },
            isStale: true,
            source: `${group.thb.source} (Cached Fallback)`,
          };
        }
      }

      return null;
    } catch (err: any) {
      console.error(
        `[FrankfurterService] Failed to load latest exchange rate snapshot from database: ${err?.message || err}`
      );
      return null;
    }
  }

  /**
   * Allows an administrator to manually record or approve a fallback exchange rate.
   * Thoroughly validates rates and date before modifying memory cache or database.
   */
  public async setAdminFallbackRate(
    rateThb: Decimal | string | number,
    rateUsd: Decimal | string | number,
    rateDate: string = new Date().toISOString().split('T')[0]
  ): Promise<ExchangeRates> {
    let thbDec: Decimal;
    try {
      thbDec = new Decimal(rateThb);
      if (!thbDec.isFinite() || !thbDec.isPositive() || thbDec.isZero()) {
        throw new Error();
      }
    } catch {
      throw new InvalidExchangeRateError(
        `THB rate must be a valid finite number greater than zero. Received: ${rateThb}`
      );
    }

    let usdDec: Decimal;
    try {
      usdDec = new Decimal(rateUsd);
      if (!usdDec.isFinite() || !usdDec.isPositive() || usdDec.isZero()) {
        throw new Error();
      }
    } catch {
      throw new InvalidExchangeRateError(
        `USD rate must be a valid finite number greater than zero. Received: ${rateUsd}`
      );
    }

    if (typeof rateDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) {
      throw new InvalidExchangeRateError(
        `Invalid rate date format: '${rateDate}'. Expected YYYY-MM-DD.`
      );
    }

    const [yStr, mStr, dStr] = rateDate.split('-');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    const day = parseInt(dStr, 10);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    if (
      isNaN(parsedDate.getTime()) ||
      parsedDate.getUTCFullYear() !== year ||
      parsedDate.getUTCMonth() !== month - 1 ||
      parsedDate.getUTCDate() !== day
    ) {
      throw new InvalidExchangeRateError(
        `Invalid rate date calendar value: '${rateDate}'. The specified date does not exist.`
      );
    }

    const rates: ExchangeRates = {
      baseCurrency: 'CNY',
      rateDate,
      retrievedAt: new Date(),
      rates: {
        THB: thbDec,
        USD: usdDec,
      },
      isStale: false,
      source: 'Admin Manual Fallback',
    };

    this.memoryCache = rates;
    await this.persistSnapshots(rates);
    return rates;
  }

  private parseAmount(amount: Decimal | string | number, paramName: string): Decimal {
    try {
      const dec = new Decimal(amount);
      if (!dec.isFinite()) {
        throw new Error();
      }
      return dec;
    } catch {
      throw new Error(`${paramName} must be a valid finite number.`);
    }
  }

  /**
   * Synchronous Currency Conversion Utilities (requires initialized rates).
   */
  public convertCnyToThb(cnyAmount: Decimal | string | number, spreadPercent?: Decimal | string | number): Decimal {
    if (!this.memoryCache) {
      throw new ExchangeRatesNotInitializedError();
    }
    const cny = this.parseAmount(cnyAmount, 'cnyAmount');
    const spread = spreadPercent !== undefined ? this.parseAmount(spreadPercent, 'spreadPercent') : this.fxSpreadPercent;
    if (spread.isNegative()) {
      throw new Error('spreadPercent cannot be negative.');
    }
    const baseRate = this.memoryCache.rates.THB;
    const adjustedRate = baseRate.times(new Decimal(1).plus(spread.dividedBy(100)));
    return cny.times(adjustedRate);
  }

  public convertCnyToUsd(cnyAmount: Decimal | string | number, spreadPercent?: Decimal | string | number): Decimal {
    if (!this.memoryCache) {
      throw new ExchangeRatesNotInitializedError();
    }
    const cny = this.parseAmount(cnyAmount, 'cnyAmount');
    const spread = spreadPercent !== undefined ? this.parseAmount(spreadPercent, 'spreadPercent') : this.fxSpreadPercent;
    if (spread.isNegative()) {
      throw new Error('spreadPercent cannot be negative.');
    }
    const baseRate = this.memoryCache.rates.USD;
    const adjustedRate = baseRate.times(new Decimal(1).plus(spread.dividedBy(100)));
    return cny.times(adjustedRate);
  }

  public convertThbToUsd(thbAmount: Decimal | string | number): Decimal {
    if (!this.memoryCache) {
      throw new ExchangeRatesNotInitializedError();
    }
    const thb = this.parseAmount(thbAmount, 'thbAmount');
    return thb.dividedBy(this.memoryCache.rates.THB).times(this.memoryCache.rates.USD);
  }

  public convertThbToCny(thbAmount: Decimal | string | number): Decimal {
    if (!this.memoryCache) {
      throw new ExchangeRatesNotInitializedError();
    }
    const thb = this.parseAmount(thbAmount, 'thbAmount');
    return thb.dividedBy(this.memoryCache.rates.THB);
  }

  public convertUsdToCny(usdAmount: Decimal | string | number): Decimal {
    if (!this.memoryCache) {
      throw new ExchangeRatesNotInitializedError();
    }
    const usd = this.parseAmount(usdAmount, 'usdAmount');
    return usd.dividedBy(this.memoryCache.rates.USD);
  }

  /**
   * Asynchronous Currency Conversion Utilities (automatically loads rates if uninitialized).
   */
  public async convertCnyToThbAsync(
    cnyAmount: Decimal | string | number,
    spreadPercent?: Decimal | string | number
  ): Promise<Decimal> {
    await this.getRates();
    return this.convertCnyToThb(cnyAmount, spreadPercent);
  }

  public async convertCnyToUsdAsync(
    cnyAmount: Decimal | string | number,
    spreadPercent?: Decimal | string | number
  ): Promise<Decimal> {
    await this.getRates();
    return this.convertCnyToUsd(cnyAmount, spreadPercent);
  }

  public async convertThbToUsdAsync(thbAmount: Decimal | string | number): Promise<Decimal> {
    await this.getRates();
    return this.convertThbToUsd(thbAmount);
  }

  public async convertThbToCnyAsync(thbAmount: Decimal | string | number): Promise<Decimal> {
    await this.getRates();
    return this.convertThbToCny(thbAmount);
  }

  public async convertUsdToCnyAsync(usdAmount: Decimal | string | number): Promise<Decimal> {
    await this.getRates();
    return this.convertUsdToCny(usdAmount);
  }
}
