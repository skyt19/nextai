import { describe, it, expect } from 'vitest';
import { QuotaCalculator } from '../../src/services/calculator.service.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { Decimal } from 'decimal.js';

describe('Phase 1: Pricing and Package Configuration Audit', () => {
  const fxRate = '5.0764';
  const fxDate = '2026-11-03';

  it('1. NxG1 configuration matches specification exactly', () => {
    const result = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.020',
      referenceRequests: 100,
      packageSellingPriceThb: '51.00',
      cnyToThbRate: fxRate,
      exchangeRateDate: fxDate,
      bufferCny: '0.00',
    });

    expect(result.referenceModelBpCny.toFixed(3)).toBe('0.020');
    expect(result.groupMarkup.toFixed(1)).toBe('2.5');
    expect(result.displayPricePerRequestCny.toFixed(3)).toBe('0.050');
    expect(result.displayReferenceValueCny.toFixed(2)).toBe('5.00');
    expect(result.providerCostBudgetCny.toFixed(2)).toBe('2.00');
    expect(result.assignedUpstreamQuotaCny.toFixed(2)).toBe('2.00');
    expect(result.packageSellingPriceThb.toFixed(2)).toBe('51.00');
    expect(result.finalPaymentAmountThb.toFixed(2)).toBe('51.00');
  });

  it('2. NxGE configuration matches specification exactly', () => {
    const result = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_E,
      referenceModelCostCny: '0.030',
      referenceRequests: 100,
      packageSellingPriceThb: '90.00',
      cnyToThbRate: fxRate,
      exchangeRateDate: fxDate,
      bufferCny: '0.00',
    });

    expect(result.referenceModelBpCny.toFixed(3)).toBe('0.030');
    expect(result.groupMarkup.toFixed(1)).toBe('3.0');
    expect(result.displayPricePerRequestCny.toFixed(3)).toBe('0.090');
    expect(result.displayReferenceValueCny.toFixed(2)).toBe('9.00');
    expect(result.providerCostBudgetCny.toFixed(2)).toBe('3.00');
    expect(result.assignedUpstreamQuotaCny.toFixed(2)).toBe('3.00');
    expect(result.packageSellingPriceThb.toFixed(2)).toBe('90.00');
    expect(result.finalPaymentAmountThb.toFixed(2)).toBe('90.00');
  });

  it('3. NxGC configuration matches specification exactly', () => {
    const result = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_CLAUDE,
      referenceModelCostCny: '0.030',
      referenceRequests: 100,
      packageSellingPriceThb: '75.00',
      cnyToThbRate: fxRate,
      exchangeRateDate: fxDate,
      bufferCny: '0.00',
    });

    expect(result.referenceModelBpCny.toFixed(3)).toBe('0.030');
    expect(result.groupMarkup.toFixed(1)).toBe('2.5');
    expect(result.displayPricePerRequestCny.toFixed(3)).toBe('0.075');
    expect(result.displayReferenceValueCny.toFixed(2)).toBe('7.50');
    expect(result.providerCostBudgetCny.toFixed(2)).toBe('3.00');
    expect(result.assignedUpstreamQuotaCny.toFixed(2)).toBe('3.00');
    expect(result.packageSellingPriceThb.toFixed(2)).toBe('75.00');
    expect(result.finalPaymentAmountThb.toFixed(2)).toBe('75.00');
  });

  it('4. Display pricing never determines actual selling price', () => {
    // Arbitrary BP and markup variations
    const calcA = QuotaCalculator.calculate({
      groupId: MODEL_GROUPS.GROUP_A,
      referenceModelCostCny: '0.050', // Higher BP
      referenceRequests: 100,
      packageSellingPriceThb: '51.00',
      cnyToThbRate: fxRate,
      exchangeRateDate: fxDate,
    });
    expect(calcA.displayReferenceValueCny.toFixed(2)).toBe('12.50'); // 0.050 * 2.5 * 100
    expect(calcA.finalPaymentAmountThb.toFixed(2)).toBe('51.00'); // Still strictly 51.00 THB!
  });

  it('5. FX changes never modify package selling prices', () => {
    const rates = ['4.5000', '5.0764', '6.0000', '10.0000'];
    for (const rate of rates) {
      const calc = QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '51.00',
        cnyToThbRate: rate,
        exchangeRateDate: fxDate,
      });
      expect(calc.finalPaymentAmountThb.toFixed(2)).toBe('51.00');
    }
  });

  it('6. Missing, zero, or negative selling prices fail validation', () => {
    expect(() =>
      QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        cnyToThbRate: fxRate,
        exchangeRateDate: fxDate,
      } as any)
    ).toThrow('Package selling price in THB must be explicitly provided.');

    expect(() =>
      QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '0.00',
        cnyToThbRate: fxRate,
        exchangeRateDate: fxDate,
      })
    ).toThrow('Package selling price in THB must be a positive number.');

    expect(() =>
      QuotaCalculator.calculate({
        groupId: MODEL_GROUPS.GROUP_A,
        referenceModelCostCny: '0.020',
        referenceRequests: 100,
        packageSellingPriceThb: '-51.00',
        cnyToThbRate: fxRate,
        exchangeRateDate: fxDate,
      })
    ).toThrow('Package selling price in THB must be a positive number.');
  });
});
