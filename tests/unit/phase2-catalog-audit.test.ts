import { describe, it, expect } from 'vitest';
import { STATIC_MODEL_CATALOG } from '../../src/services/catalog-data.js';
import { ModelCatalogService } from '../../src/services/catalog.service.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';

describe('Phase 2: Reference Model and Catalog Mapping Audit', () => {
  const catalogService = new ModelCatalogService();

  it('1. Audits all 29 models: exactly 29 models with 0 duplicates and valid fields', () => {
    expect(STATIC_MODEL_CATALOG.length).toBe(29);

    const publicIds = new Set<string>();
    const providerIds = new Set<string>();

    for (const model of STATIC_MODEL_CATALOG) {
      // Check duplicate public IDs
      expect(publicIds.has(model.publicModelId)).toBe(false);
      publicIds.add(model.publicModelId);

      // Check duplicate provider mappings
      expect(providerIds.has(model.originalBearlabModelId)).toBe(false);
      providerIds.add(model.originalBearlabModelId);

      // Check group assignment
      expect([MODEL_GROUPS.GROUP_A, MODEL_GROUPS.GROUP_E, MODEL_GROUPS.GROUP_CLAUDE]).toContain(model.groupId);

      // Check financial fields
      expect(parseFloat(model.baseCostCny)).toBeGreaterThan(0);
      expect(parseFloat(model.markup)).toBeGreaterThan(0);
      expect(parseFloat(model.sellingPriceCny)).toBeGreaterThan(0);

      // Check enabled status
      expect(model.enabled).toBe(true);
    }
  });

  it('2. Specifically audits gemini-3-1-pro-high-nxg1', () => {
    const entry = STATIC_MODEL_CATALOG.find((m) => m.publicModelId === 'gemini-3-1-pro-high-nxg1');
    expect(entry).toBeDefined();
    expect(entry?.originalBearlabModelId).toBe('[A]gemini-3-1-pro-high');
    expect(entry?.groupId).toBe(MODEL_GROUPS.GROUP_A);
    expect(entry?.baseCostCny).toBe('0.020');
    expect(entry?.markup).toBe('2.5');
    expect(entry?.sellingPriceCny).toBe('0.050');
  });

  it('3. Verifies ModelCatalogService translations for gemini-3-1-pro-high-nxg1', () => {
    const resolved = catalogService.translateModel('gemini-3-1-pro-high-nxg1', [MODEL_GROUPS.GROUP_A]);
    expect(resolved.originalBearlabModelId).toBe('[A]gemini-3-1-pro-high');
    expect(resolved.groupId).toBe(MODEL_GROUPS.GROUP_A);

    const modelEntry = catalogService.getModelByPublicId('gemini-3-1-pro-high-nxg1');
    expect(modelEntry).toBeDefined();
    expect(modelEntry?.originalBearlabModelId).toBe('[A]gemini-3-1-pro-high');
  });

  it('4. Group A models: 8 models, all [A] prefix and -nxg1 suffix', () => {
    const groupA = STATIC_MODEL_CATALOG.filter((m) => m.groupId === MODEL_GROUPS.GROUP_A);
    expect(groupA.length).toBe(8);
    for (const m of groupA) {
      expect(m.publicModelId.endsWith('-nxg1')).toBe(true);
      expect(m.originalBearlabModelId.startsWith('[A]')).toBe(true);
      expect(m.markup).toBe('2.5');
    }
  });

  it('5. Group E models: 7 models, all [E] prefix and -nxge suffix', () => {
    const groupE = STATIC_MODEL_CATALOG.filter((m) => m.groupId === MODEL_GROUPS.GROUP_E);
    expect(groupE.length).toBe(7);
    for (const m of groupE) {
      expect(m.publicModelId.endsWith('-nxge')).toBe(true);
      expect(m.originalBearlabModelId.startsWith('[E]')).toBe(true);
      expect(m.markup).toBe('3.0');
    }
  });

  it('6. Group Claude models: 14 models, all [次] suffix and -nxgc suffix', () => {
    const groupClaude = STATIC_MODEL_CATALOG.filter((m) => m.groupId === MODEL_GROUPS.GROUP_CLAUDE);
    expect(groupClaude.length).toBe(14);
    for (const m of groupClaude) {
      expect(m.publicModelId.endsWith('-nxgc')).toBe(true);
      expect(m.originalBearlabModelId.endsWith('[次]')).toBe(true);
      expect(m.markup).toBe('2.5');
      expect(m.baseCostCny).toBe('0.030');
    }
  });

  it('7. Unknown model IDs fail safely and direct upstream identifier bypass is blocked', () => {
    expect(() => catalogService.translateModel('unknown-model-xyz', [MODEL_GROUPS.GROUP_A])).toThrow();
    // Direct upstream identifier bypass must be rejected
    expect(() => catalogService.translateModel('[A]gemini-3-1-pro-high', [MODEL_GROUPS.GROUP_A])).toThrow(
      'Direct upstream model identifiers cannot be used directly'
    );
  });
});
