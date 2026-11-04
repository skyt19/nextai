import { describe, it, expect } from 'vitest';
import { QuotaCalculator } from '../../src/services/calculator.service.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('QuotaCalculator Unit Tests', () => {
  const defaultRate = '5.1200';
  const rateDate = '2026-11-02';

  describe('1. Group Markups', () => {
    it('Group A applies 2.5x markup', () => {
      // e.g. base cost 0.020 CNY -> selling price 0.050 CNY
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
      });

      expect(result.groupMarkup.toString()).toBe('2.5');
      expect(result.sellingPricePerRequestCny.toString()).toBe('0.05');
      expect(result.providerCostBudgetCny.toString()).toBe('2');
      expect(result.packageSellingPriceCny.toString()).toBe('5');
    });

    it('Group E applies 3.0x markup', () => {
      // e.g. base cost 0.030 CNY -> selling price 0.090 CNY
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_E,
        referenceModelCostCny: '0.030',
        referenceRequests: 100,
        packageSellingPriceThb: '90.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
      });

      expect(result.groupMarkup.toString()).toBe('3');
      expect(result.sellingPricePerRequestCny.toString()).toBe('0.09');
      expect(result.providerCostBudgetCny.toString()).toBe('3');
      expect(result.packageSellingPriceCny.toString()).toBe('9');
    });

    it('Group Claude applies 2.5x markup', () => {
      // e.g. base cost 0.030 CNY -> selling price 0.075 CNY
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_CLAUDE,
        referenceModelCostCny: '0.030',
        referenceRequests: 100,
        packageSellingPriceThb: '75.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
      });

      expect(result.groupMarkup.toString()).toBe('2.5');
      expect(result.sellingPricePerRequestCny.toString()).toBe('0.075');
      expect(result.providerCostBudgetCny.toString()).toBe('3');
      expect(result.packageSellingPriceCny.toString()).toBe('7.5');
    });
  });

  describe('2. Request Quantity Variations', () => {
    it('calculates 100 reference requests for Group A', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
      });

      expect(result.displayPricePerRequestCny.toString()).toBe('0.05');
      expect(result.displayReferenceValueCny.toString()).toBe('5');
      expect(result.providerCostBudgetCny.toString()).toBe('2');
      expect(result.assignedUpstreamQuotaCny.toString()).toBe('2');
      expect(result.packageSellingPriceCny.toString()).toBe('5');
      expect(result.packageSellingPriceThb.toString()).toBe('51');
      expect(result.finalPaymentAmountThb.toString()).toBe('51');
    });

    it('calculates 200 reference requests for Group A', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 200,
        packageSellingPriceThb: '100.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
      });

      expect(result.displayPricePerRequestCny.toString()).toBe('0.05');
      expect(result.displayReferenceValueCny.toString()).toBe('10');
      expect(result.providerCostBudgetCny.toString()).toBe('4');
      expect(result.assignedUpstreamQuotaCny.toString()).toBe('4');
      expect(result.packageSellingPriceCny.toString()).toBe('10');
      expect(result.packageSellingPriceThb.toString()).toBe('100');
      expect(result.finalPaymentAmountThb.toString()).toBe('100');
    });

    it('calculates 300 reference requests for Group Claude', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_CLAUDE,
        referenceModelCostCny: '0.030',
        referenceRequests: 300,
        packageSellingPriceThb: '150.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
      });

      expect(result.displayPricePerRequestCny.toString()).toBe('0.075');
      expect(result.displayReferenceValueCny.toString()).toBe('22.5');
      expect(result.providerCostBudgetCny.toString()).toBe('9'); // 300 * 0.030
      expect(result.packageSellingPriceCny.toString()).toBe('22.5'); // 9 * 2.5
      expect(result.packageSellingPriceThb.toString()).toBe('150');
      expect(result.finalPaymentAmountThb.toString()).toBe('150');
    });

    it('calculates custom arbitrary request quantities (e.g. 777 requests)', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_E,
        referenceModelCostCny: '0.030',
        referenceRequests: 777,
        packageSellingPriceThb: '350.00',
        cnyToThbRate: '5.1432',
        exchangeRateDate: rateDate,
      });

      const expectedProviderBudget = new Decimal(777).times('0.030'); // 23.31
      const expectedSellingCny = expectedProviderBudget.times('3.0'); // 69.93

      expect(result.providerCostBudgetCny.toString()).toBe('23.31');
      expect(result.packageSellingPriceCny.toString()).toBe('69.93');
      expect(result.displayReferenceValueCny.toString()).toBe(expectedSellingCny.toString());
      expect(result.packageSellingPriceThb.toString()).toBe('350');
      expect(result.finalPaymentAmountThb.toString()).toBe('350');
    });
  });

  describe('3. Buffer Policy (Added Once per Package)', () => {
    it('adds buffer once to assigned quota and NEVER multiplies by requests', () => {
      const buffer = '2.500';
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 200,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
        bufferCny: buffer,
      });

      // Provider budget = 200 * 0.02 = 4.0 CNY
      // Assigned quota = 4.0 + 2.5 = 6.5 CNY (NOT 200 * 2.5!)
      expect(result.providerCostBudgetCny.toString()).toBe('4');
      expect(result.assignedQuotaCny.toString()).toBe('6.5');
      // Buffer is NOT included in selling price by default
      expect(result.packageSellingPriceCny.toString()).toBe('10');
    });

    it('optionally includes buffer in customer selling price if explicitly configured', () => {
      const buffer = '2.0';
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
        bufferCny: buffer,
        includeBufferInSellingPrice: true,
      });

      // Provider budget = 100 * 0.02 = 2.0
      // Base selling = 2.0 * 2.5 = 5.0
      // Buffer selling = 2.0 * 2.5 = 5.0
      // Total package selling price = 10.0
      expect(result.packageSellingPriceCny.toString()).toBe('10');
      expect(result.assignedQuotaCny.toString()).toBe('4'); // 2 + 2
    });
  });

  describe('4. Currency Conversion & Rounding', () => {
    it('applies FX spread adjustment properly to reference cost, while customer price remains fixed', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: '5.0000',
        exchangeRateDate: rateDate,
        fxSpreadPercent: '2.0', // 2% spread: 5.0 * 1.02 = 5.10
      });

      // Effective rate: 5.10
      // Provider cost budget: 2.0 CNY -> 2.0 * 5.10 = 10.20 THB
      // Customer payment: 51.00 THB (Never changed by FX!)
      // Estimated gross profit: 51.00 - 10.20 = 40.80 THB
      expect(result.cnyToThbRate.toString()).toBe('5.1');
      expect(result.finalPaymentAmountThb.toString()).toBe('51');
      expect(result.estimatedProviderCostThb.toString()).toBe('10.2');
      expect(result.estimatedGrossProfitThb.toString()).toBe('40.8');
    });

    it('rounds THB correctly to 2 decimal places using half-up', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.0123',
        referenceRequests: 17,
        packageSellingPriceThb: '51.255',
        cnyToThbRate: '5.1234',
        exchangeRateDate: rateDate,
      });

      // Selling THB rounded half-up: 51.255 -> 51.26
      expect(result.finalPaymentAmountThb.toString()).toBe('51.26');
      expect(result.packageSellingPriceThb.toString()).toBe('51.26');
      // Provider budget = 17 * 0.0123 = 0.2091 CNY
      // Estimated cost THB = 0.2091 * 5.1234 = 1.07130... -> 1.07
      expect(result.estimatedProviderCostThb.toFixed(2)).toBe('1.07');
    });
  });

  describe('5. Immutable Calculation Snapshot', () => {
    it('produces complete immutable snapshot with all required financial fields', () => {
      const result = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 200,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: defaultRate,
        exchangeRateDate: rateDate,
        bufferCny: '1.0',
      });

      const snap = result.snapshot;
      expect(snap.reference_model_bp_cny).toBe('0.0200');
      expect(snap.group_markup).toBe('2.50');
      expect(snap.display_price_per_request_cny).toBe('0.0500');
      expect(snap.display_reference_value_cny).toBe('10.0000');
      expect(snap.reference_requests).toBe(200);
      expect(snap.provider_cost_budget_cny).toBe('4.0000');
      expect(snap.configured_buffer_cny).toBe('1.0000');
      expect(snap.assigned_upstream_quota_cny).toBe('5.0000');
      expect(snap.package_selling_price_thb).toBe('51.00');
      expect(snap.final_payment_amount_thb).toBe('51.00');
      expect(snap.cny_to_thb_rate).toBe('5.1200');
      expect(snap.exchange_rate_date).toBe(rateDate);
      expect(snap.estimated_provider_cost_thb).toBe('20.48'); // 4.00 * 5.12
      expect(snap.estimated_gross_profit_thb).toBe('30.52'); // 51.00 - 20.48
      expect(snap.estimated_gross_margin_percent).toBe('59.84'); // (30.52 / 51.00) * 100
      expect(snap.calculation_timestamp).toBeDefined();

      // Legacy aliases
      expect(snap.provider_base_price_cny).toBe('0.0200');
      expect(snap.selling_price_per_request_cny).toBe('0.0500');
      expect(snap.package_selling_price_cny).toBe('10.0000');
      expect(snap.buffer_cny).toBe('1.0000');
      expect(snap.assigned_quota_cny).toBe('5.0000');
    });
  });

  describe('6. Input Validation & Error Handling', () => {
    it('throws error for non-positive or non-integer reference requests', () => {
      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '0.020',
          referenceRequests: 0,
          packageSellingPriceThb: '51.00',
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
        })
      ).toThrow('Reference requests must be a positive integer.');

      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '0.020',
          referenceRequests: 10.5,
          packageSellingPriceThb: '51.00',
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
        })
      ).toThrow('Reference requests must be a positive integer.');
    });

    it('throws error for negative cost or buffer', () => {
      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '-0.020',
          referenceRequests: 100,
          packageSellingPriceThb: '51.00',
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
        })
      ).toThrow('Reference model cost cannot be negative.');

      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '0.020',
          referenceRequests: 100,
          packageSellingPriceThb: '51.00',
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
          bufferCny: '-1.0',
        })
      ).toThrow('Buffer amount cannot be negative.');
    });

    it('strictly enforces explicit packageSellingPriceThb and rejects missing or non-positive values', () => {
      // Missing packageSellingPriceThb
      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '0.020',
          referenceRequests: 100,
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
        } as any)
      ).toThrow('Package selling price in THB must be explicitly provided.');

      // Zero or negative packageSellingPriceThb
      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '0.020',
          referenceRequests: 100,
          packageSellingPriceThb: '0',
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
        })
      ).toThrow('Package selling price in THB must be a positive number.');

      expect(() =>
        QuotaCalculator.calculate({
          groupId: MODEL_GROUPS.GROUP_A,
          referenceModelCostCny: '0.020',
          referenceRequests: 100,
          packageSellingPriceThb: '-51.00',
          cnyToThbRate: defaultRate,
          exchangeRateDate: rateDate,
        })
      ).toThrow('Package selling price in THB must be a positive number.');
    });
  });

  describe('7. Standalone Pricing Separation Methods', () => {
    it('calculateDisplayPrice: calculates display price per request CNY', () => {
      const price = QuotaCalculator.calculateDisplayPrice('0.020', '2.5');
      expect(price.toFixed(3)).toBe('0.050');
    });

    it('calculateDisplayReferenceValue: calculates theoretical display reference value CNY', () => {
      const refVal = QuotaCalculator.calculateDisplayReferenceValue('0.050', 100);
      expect(refVal.toFixed(2)).toBe('5.00');
    });

    it('calculateProviderCostBudget: calculates provider cost budget CNY', () => {
      const budget = QuotaCalculator.calculateProviderCostBudget('0.020', 100);
      expect(budget.toFixed(2)).toBe('2.00');
    });

    it('calculateUpstreamAllocation: calculates upstream allocation quota CNY (with buffer default 0)', () => {
      const allocDefault = QuotaCalculator.calculateUpstreamAllocation('2.00');
      expect(allocDefault.toFixed(2)).toBe('2.00');

      const allocBuffered = QuotaCalculator.calculateUpstreamAllocation('2.00', '0.50');
      expect(allocBuffered.toFixed(2)).toBe('2.50');
    });

    it('calculateEstimatedGrossProfit: calculates profit THB and margin % from admin price', () => {
      // Selling: 51.00 THB, Provider Budget: 2.00 CNY, FX: 5.0764
      // Provider cost THB: 2.00 * 5.0764 = 10.1528 THB
      // Gross profit THB: 51.00 - 10.1528 = 40.8472 THB
      // Margin: (40.8472 / 51.00) * 100 = 80.0925%
      const profit = QuotaCalculator.calculateEstimatedGrossProfit('51.00', '2.00', '5.0764');
      expect(profit.estimatedProviderCostThb.toFixed(4)).toBe('10.1528');
      expect(profit.estimatedGrossProfitThb.toFixed(4)).toBe('40.8472');
      expect(profit.estimatedGrossMarginPercent.toFixed(2)).toBe('80.09');
    });
  });
});
