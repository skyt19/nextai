import { describe, it, expect } from 'vitest';
import { ModelCatalogService } from '../../src/services/catalog.service.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { STATIC_MODEL_CATALOG } from '../../src/services/catalog-data.js';
import {
  ModelNotFoundError,
  ModelDisabledError,
  UnauthorizedModelGroupError,
} from '../../src/services/credential-resolver.service.js';
import { Decimal } from 'decimal.js';

describe('ModelCatalogService Unit Tests', () => {
  const service = new ModelCatalogService();

  describe('1. Model Catalog Integrity & Completeness', () => {
    it('contains exactly 29 models matching the master specification', () => {
      const allModels = service.getAllModels();
      expect(allModels.length).toBe(29);

      const groupA = allModels.filter((m) => m.groupId === MODEL_GROUPS.GROUP_A);
      const groupE = allModels.filter((m) => m.groupId === MODEL_GROUPS.GROUP_E);
      const groupClaude = allModels.filter((m) => m.groupId === MODEL_GROUPS.GROUP_CLAUDE);

      expect(groupA.length).toBe(8);
      expect(groupE.length).toBe(7);
      expect(groupClaude.length).toBe(14);
    });

    it('every public model ID is unique and safe for URL/JSON usage', () => {
      const allModels = service.getAllModels();
      const idSet = new Set<string>();

      for (const model of allModels) {
        expect(idSet.has(model.publicModelId)).toBe(false);
        idSet.add(model.publicModelId);
        // Free from spaces, uppercase, and special bracket characters
        expect(model.publicModelId).toMatch(/^[a-z0-9\-]+$/);
      }
    });

    it('preserves all original Bearlab model IDs exactly with [A], [E], and [次]', () => {
      const allModels = service.getAllModels();

      const groupA = allModels.filter((m) => m.groupId === MODEL_GROUPS.GROUP_A);
      for (const m of groupA) {
        expect(m.originalBearlabModelId.startsWith('[A]')).toBe(true);
      }

      const groupE = allModels.filter((m) => m.groupId === MODEL_GROUPS.GROUP_E);
      for (const m of groupE) {
        expect(m.originalBearlabModelId.startsWith('[E]')).toBe(true);
      }

      const groupClaude = allModels.filter((m) => m.groupId === MODEL_GROUPS.GROUP_CLAUDE);
      for (const m of groupClaude) {
        expect(m.originalBearlabModelId.endsWith('[次]')).toBe(true);
      }
    });

    it('applies correct markup and selling price for every model', () => {
      const allModels = service.getAllModels();

      for (const model of allModels) {
        const baseCost = new Decimal(model.baseCostCny);
        const markup = new Decimal(model.markup);
        const expectedSelling = baseCost.times(markup);
        const actualSelling = new Decimal(model.sellingPriceCny);

        expect(actualSelling.toString()).toBe(expectedSelling.toString());

        if (model.groupId === MODEL_GROUPS.GROUP_A) {
          expect(model.markup).toBe('2.5');
        } else if (model.groupId === MODEL_GROUPS.GROUP_E) {
          expect(model.markup).toBe('3.0');
        } else if (model.groupId === MODEL_GROUPS.GROUP_CLAUDE) {
          expect(model.markup).toBe('2.5');
          expect(model.baseCostCny).toBe('0.030');
          expect(model.sellingPriceCny).toBe('0.075');
        }
      }
    });
  });

  describe('2. Group Filtering & Model Listing (GET /v1/models)', () => {
    it('returns only Group A models for a customer with only NxG1 access', () => {
      const models = service.getModelsForGroups([MODEL_GROUPS.GROUP_A]);
      expect(models.length).toBe(8);
      expect(models.every((m) => m.groupId === MODEL_GROUPS.GROUP_A)).toBe(true);
    });

    it('returns only Group E models for a customer with only NxGE access', () => {
      const models = service.getModelsForGroups([MODEL_GROUPS.GROUP_E]);
      expect(models.length).toBe(7);
      expect(models.every((m) => m.groupId === MODEL_GROUPS.GROUP_E)).toBe(true);
    });

    it('returns both Group A and Claude models when customer is assigned to both', () => {
      const models = service.getModelsForGroups([MODEL_GROUPS.GROUP_A, MODEL_GROUPS.GROUP_CLAUDE]);
      expect(models.length).toBe(8 + 14);
    });

    it('OpenAI-compatible listing never reveals original Bearlab model IDs', () => {
      const openAiList = service.formatOpenAIModelList([
        MODEL_GROUPS.GROUP_A,
        MODEL_GROUPS.GROUP_E,
        MODEL_GROUPS.GROUP_CLAUDE,
      ]);

      expect(openAiList.object).toBe('list');
      expect(openAiList.data.length).toBe(29);

      for (const item of openAiList.data) {
        expect(item.id).not.toContain('[A]');
        expect(item.id).not.toContain('[E]');
        expect(item.id).not.toContain('[次]');
        expect(item.owned_by).toBe('next-ai-proxy-hub');
        expect(item.display_name).toBeDefined();
        expect(item.description).toBeDefined();
      }
    });
  });

  describe('3. Model Translation & Validation', () => {
    it('translates public model ID to exact Bearlab upstream ID', () => {
      const translation = service.translateModel('gemini-3-1-pro-high-nxg1', [MODEL_GROUPS.GROUP_A]);
      expect(translation.originalBearlabModelId).toBe('[A]gemini-3-1-pro-high');
      expect(translation.groupId).toBe(MODEL_GROUPS.GROUP_A);

      const claudeTranslation = service.translateModel('claude-sonnet-4-5-nxgc', [
        MODEL_GROUPS.GROUP_CLAUDE,
      ]);
      expect(claudeTranslation.originalBearlabModelId).toBe('claude-sonnet-4-5[次]');
      expect(claudeTranslation.groupId).toBe(MODEL_GROUPS.GROUP_CLAUDE);
    });

    it('rejects attempt to use raw upstream Bearlab IDs directly (anti-bypass)', () => {
      expect(() =>
        service.translateModel('[A]gemini-3-1-pro-high', [MODEL_GROUPS.GROUP_A])
      ).toThrow(ModelNotFoundError);

      expect(() =>
        service.translateModel('claude-sonnet-4-5[次]', [MODEL_GROUPS.GROUP_CLAUDE])
      ).toThrow(ModelNotFoundError);
    });

    it('rejects unknown public model ID with ModelNotFoundError', () => {
      expect(() =>
        service.translateModel('gpt-4o', [
          MODEL_GROUPS.GROUP_A,
          MODEL_GROUPS.GROUP_E,
          MODEL_GROUPS.GROUP_CLAUDE,
        ])
      ).toThrow(ModelNotFoundError);
    });

    it('rejects model outside customer assigned groups with UnauthorizedModelGroupError', () => {
      // Customer has only Group A, requests Group E model
      expect(() =>
        service.translateModel('gemini-2-5-pro-nxge', [MODEL_GROUPS.GROUP_A])
      ).toThrow(UnauthorizedModelGroupError);
    });

    it('rejects disabled models with ModelDisabledError', () => {
      const customCatalog = [
        {
          publicModelId: 'disabled-gemini-nxg1',
          displayName: 'Disabled Gemini',
          originalBearlabModelId: '[A]disabled-gemini',
          groupId: MODEL_GROUPS.GROUP_A,
          baseCostCny: '0.01',
          markup: '2.5',
          sellingPriceCny: '0.025',
          enabled: false,
        },
      ];
      const customService = new ModelCatalogService(customCatalog);

      expect(() =>
        customService.translateModel('disabled-gemini-nxg1', [MODEL_GROUPS.GROUP_A])
      ).toThrow(ModelDisabledError);
    });
  });
});
