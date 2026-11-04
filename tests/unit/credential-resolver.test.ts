import { describe, it, expect } from 'vitest';
import {
  UpstreamCredentialResolver,
  UpstreamConfigurationError,
  ModelNotFoundError,
  ModelDisabledError,
  UnauthorizedModelGroupError,
} from '../../src/services/credential-resolver.service.js';
import { MODEL_GROUPS } from '../../src/config/constants.js';
import { STATIC_MODEL_CATALOG } from '../../src/services/catalog-data.js';

describe('UpstreamCredentialResolver Unit Tests', () => {
  const mockCredentials = {
    keyGroupA: 'bearlab-secret-key-group-a-12345',
    keyGroupE: 'bearlab-secret-key-group-e-67890',
    keyGroupClaude: 'bearlab-secret-key-group-claude-abcde',
  };

  const resolver = new UpstreamCredentialResolver(mockCredentials);

  describe('1. Explicit Group Credential Mapping', () => {
    it('NxG1 models always use Group A credentials', () => {
      const groupAModels = STATIC_MODEL_CATALOG.filter(
        (m) => m.groupId === MODEL_GROUPS.GROUP_A
      );
      expect(groupAModels.length).toBe(8);

      for (const model of groupAModels) {
        const context = resolver.resolveRequestContext(model.publicModelId, [
          MODEL_GROUPS.GROUP_A,
        ]);
        expect(context.groupId).toBe(MODEL_GROUPS.GROUP_A);
        expect(context.upstreamApiKey).toBe(mockCredentials.keyGroupA);
        expect(context.originalBearlabModelId).toBe(model.originalBearlabModelId);
      }
    });

    it('NxGE models always use Group E credentials', () => {
      const groupEModels = STATIC_MODEL_CATALOG.filter(
        (m) => m.groupId === MODEL_GROUPS.GROUP_E
      );
      expect(groupEModels.length).toBe(7);

      for (const model of groupEModels) {
        const context = resolver.resolveRequestContext(model.publicModelId, [
          MODEL_GROUPS.GROUP_E,
        ]);
        expect(context.groupId).toBe(MODEL_GROUPS.GROUP_E);
        expect(context.upstreamApiKey).toBe(mockCredentials.keyGroupE);
        expect(context.originalBearlabModelId).toBe(model.originalBearlabModelId);
      }
    });

    it('NxGC models always use Claude credentials', () => {
      const groupClaudeModels = STATIC_MODEL_CATALOG.filter(
        (m) => m.groupId === MODEL_GROUPS.GROUP_CLAUDE
      );
      expect(groupClaudeModels.length).toBe(14);

      for (const model of groupClaudeModels) {
        const context = resolver.resolveRequestContext(model.publicModelId, [
          MODEL_GROUPS.GROUP_CLAUDE,
        ]);
        expect(context.groupId).toBe(MODEL_GROUPS.GROUP_CLAUDE);
        expect(context.upstreamApiKey).toBe(mockCredentials.keyGroupClaude);
        expect(context.originalBearlabModelId).toBe(model.originalBearlabModelId);
        expect(model.originalBearlabModelId).toContain('[次]');
      }
    });
  });

  describe('2. Credential Isolation & No Accidental Sharing', () => {
    it('Group A key is never returned for Group E or Group Claude', () => {
      expect(resolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_A)).not.toBe(mockCredentials.keyGroupE);
      expect(resolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_A)).not.toBe(
        mockCredentials.keyGroupClaude
      );
    });

    it('Group E key is never returned for Group A or Group Claude', () => {
      expect(resolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_E)).not.toBe(mockCredentials.keyGroupA);
      expect(resolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_E)).not.toBe(
        mockCredentials.keyGroupClaude
      );
    });

    it('Group Claude key is never returned for Group A or Group E', () => {
      expect(resolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_CLAUDE)).not.toBe(
        mockCredentials.keyGroupA
      );
      expect(resolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_CLAUDE)).not.toBe(
        mockCredentials.keyGroupE
      );
    });
  });

  describe('3. Missing Credentials Prevent Upstream Requests (No Fallback)', () => {
    it('throws UpstreamConfigurationError if Group A key is missing', () => {
      const incompleteResolver = new UpstreamCredentialResolver({
        keyGroupE: mockCredentials.keyGroupE,
        keyGroupClaude: mockCredentials.keyGroupClaude,
      });

      expect(() =>
        incompleteResolver.resolveRequestContext('gemini-2-5-flash-nxg1', [MODEL_GROUPS.GROUP_A])
      ).toThrow(UpstreamConfigurationError);
    });

    it('throws UpstreamConfigurationError if Group E key is missing and never falls back to Group A', () => {
      const incompleteResolver = new UpstreamCredentialResolver({
        keyGroupA: mockCredentials.keyGroupA,
        keyGroupClaude: mockCredentials.keyGroupClaude,
      });

      expect(() =>
        incompleteResolver.resolveRequestContext('gemini-2-5-pro-nxge', [MODEL_GROUPS.GROUP_E])
      ).toThrow(UpstreamConfigurationError);
    });

    it('throws UpstreamConfigurationError if Group Claude key is missing and never falls back to Group A or E', () => {
      const incompleteResolver = new UpstreamCredentialResolver({
        keyGroupA: mockCredentials.keyGroupA,
        keyGroupE: mockCredentials.keyGroupE,
      });

      expect(() =>
        incompleteResolver.resolveRequestContext('claude-sonnet-4-5-nxgc', [
          MODEL_GROUPS.GROUP_CLAUDE,
        ])
      ).toThrow(UpstreamConfigurationError);
    });

    it('error message does not leak secret values', () => {
      const incompleteResolver = new UpstreamCredentialResolver({});
      try {
        incompleteResolver.resolveRequestContext('gemini-2-5-flash-nxg1', [MODEL_GROUPS.GROUP_A]);
        expect.unreachable('Should have thrown UpstreamConfigurationError');
      } catch (err) {
        expect(err).toBeInstanceOf(UpstreamConfigurationError);
        const error = err as UpstreamConfigurationError;
        expect(error.statusCode).toBe(502);
        expect(error.message).toContain("model group 'NxG1'");
        expect(error.message).not.toContain('bearlab-secret');
      }
    });
  });

  describe('4. Group Authorization & Model Validation', () => {
    it('rejects request if customer is not assigned to the model group (403 Forbidden)', () => {
      // Customer only has NxG1, tries to use NxGE model
      expect(() =>
        resolver.resolveRequestContext('gemini-2-5-pro-nxge', [MODEL_GROUPS.GROUP_A])
      ).toThrow(UnauthorizedModelGroupError);
    });

    it('rejects request for unknown public model ID (404 Not Found)', () => {
      expect(() =>
        resolver.resolveRequestContext('non-existent-model', [
          MODEL_GROUPS.GROUP_A,
          MODEL_GROUPS.GROUP_E,
          MODEL_GROUPS.GROUP_CLAUDE,
        ])
      ).toThrow(ModelNotFoundError);
    });

    it('rejects request if model is disabled (403 Forbidden)', () => {
      const customCatalog = [
        {
          publicModelId: 'disabled-model-nxg1',
          displayName: 'Disabled Model',
          originalBearlabModelId: '[A]disabled-model',
          groupId: MODEL_GROUPS.GROUP_A,
          baseCostCny: '0.01',
          markup: '2.5',
          sellingPriceCny: '0.025',
          enabled: false,
        },
      ];
      const customResolver = new UpstreamCredentialResolver(mockCredentials, customCatalog);

      expect(() =>
        customResolver.resolveRequestContext('disabled-model-nxg1', [MODEL_GROUPS.GROUP_A])
      ).toThrow(ModelDisabledError);
    });
  });

  describe('5. New API Gateway Credential Resolution & Isolation', () => {
    const newApiCredentials = {
      newApiKeyGroupA: 'newapi-token-group-a-primary',
      newApiKeyGroupE: 'newapi-token-group-e-primary',
      newApiKeyGroupClaude: 'newapi-token-group-claude-primary',
    };

    const newApiResolver = new UpstreamCredentialResolver(newApiCredentials);

    it('NxG1 routes using New API Group A key', () => {
      const context = newApiResolver.resolveRequestContext('gemini-3-1-pro-high-nxg1', [
        MODEL_GROUPS.GROUP_A,
      ]);
      expect(context.groupId).toBe(MODEL_GROUPS.GROUP_A);
      expect(context.upstreamApiKey).toBe('newapi-token-group-a-primary');
      expect(context.upstreamModelId).toBe('[A]gemini-3-1-pro-high');
    });

    it('NxGE routes using New API Group E key', () => {
      const context = newApiResolver.resolveRequestContext('gemini-2-5-pro-nxge', [
        MODEL_GROUPS.GROUP_E,
      ]);
      expect(context.groupId).toBe(MODEL_GROUPS.GROUP_E);
      expect(context.upstreamApiKey).toBe('newapi-token-group-e-primary');
      expect(context.upstreamModelId).toBe('[E]gemini-2.5-pro');
    });

    it('NxGC routes using New API Claude key', () => {
      const context = newApiResolver.resolveRequestContext('claude-sonnet-4-5-nxgc', [
        MODEL_GROUPS.GROUP_CLAUDE,
      ]);
      expect(context.groupId).toBe(MODEL_GROUPS.GROUP_CLAUDE);
      expect(context.upstreamApiKey).toBe('newapi-token-group-claude-primary');
      expect(context.upstreamModelId).toBe('claude-sonnet-4-5[次]');
    });

    it('prioritizes newApiKeyGroup* over legacy keyGroup*', () => {
      const hybridResolver = new UpstreamCredentialResolver({
        newApiKeyGroupA: 'newapi-key-a',
        keyGroupA: 'legacy-bearlab-key-a',
        newApiKeyGroupE: 'newapi-key-e',
        keyGroupE: 'legacy-bearlab-key-e',
        newApiKeyGroupClaude: 'newapi-key-claude',
        keyGroupClaude: 'legacy-bearlab-key-claude',
      });

      expect(hybridResolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_A)).toBe('newapi-key-a');
      expect(hybridResolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_E)).toBe('newapi-key-e');
      expect(hybridResolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_CLAUDE)).toBe('newapi-key-claude');
    });

    it('throws UpstreamConfigurationError if New API key is missing (no fallback to other groups)', () => {
      const partialResolver = new UpstreamCredentialResolver({
        newApiKeyGroupA: 'newapi-key-a',
        // Group E and Claude missing
      });

      expect(() => partialResolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_E)).toThrow(
        UpstreamConfigurationError
      );
      expect(() => partialResolver.getApiKeyForGroup(MODEL_GROUPS.GROUP_CLAUDE)).toThrow(
        UpstreamConfigurationError
      );
    });
  });
});
