import { MODEL_GROUPS, ModelGroupId } from '../config/constants.js';
import { STATIC_MODEL_CATALOG } from './catalog-data.js';
import { CatalogModel } from '../types/catalog.js';

export class UpstreamConfigurationError extends Error {
  public readonly statusCode = 502;
  public readonly code = 'upstream_configuration_error';

  constructor(public readonly groupId: string) {
    super(`Upstream credentials for model group '${groupId}' are not configured.`);
    this.name = 'UpstreamConfigurationError';
  }
}

export class ModelNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = 'model_not_found';

  constructor(public readonly modelId: string) {
    super(`The model '${modelId}' does not exist.`);
    this.name = 'ModelNotFoundError';
  }
}

export class ModelDisabledError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'model_disabled';

  constructor(public readonly modelId: string) {
    super(`The model '${modelId}' is currently disabled.`);
    this.name = 'ModelDisabledError';
  }
}

export class UnauthorizedModelGroupError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'unauthorized_model_group';

  constructor(public readonly modelId: string, public readonly groupId: string) {
    super(`Access denied: Model '${modelId}' belongs to group '${groupId}', which is not assigned to your account.`);
    this.name = 'UnauthorizedModelGroupError';
  }
}

export interface UpstreamCredentialsConfig {
  // New API Group Credentials
  newApiKeyGroupA?: string;
  newApiKeyGroupE?: string;
  newApiKeyGroupClaude?: string;

  // Generic / Backwards-Compatible Group Credentials
  keyGroupA?: string;
  keyGroupE?: string;
  keyGroupClaude?: string;
}

export interface UpstreamRequestContext {
  publicModelId: string;
  originalBearlabModelId: string;
  upstreamModelId: string;
  groupId: ModelGroupId;
  upstreamApiKey: string;
}

export class UpstreamCredentialResolver {
  private readonly catalogMap: Map<string, CatalogModel>;

  constructor(
    private readonly credentials: UpstreamCredentialsConfig,
    catalog: CatalogModel[] = STATIC_MODEL_CATALOG
  ) {
    this.catalogMap = new Map();
    for (const model of catalog) {
      this.catalogMap.set(model.publicModelId, model);
    }
  }

  /**
   * Resolves the explicit Upstream/New API Key for a specific model group.
   * STRICT ENFORCEMENT:
   * - NxG1 -> Group A key
   * - NxGE -> Group E key
   * - NxGC -> Claude key
   * - Never fall back to another group's key.
   */
  public getApiKeyForGroup(groupId: ModelGroupId): string {
    let key: string | undefined;

    switch (groupId) {
      case MODEL_GROUPS.GROUP_A:
        key = this.credentials.newApiKeyGroupA ?? this.credentials.keyGroupA;
        break;
      case MODEL_GROUPS.GROUP_E:
        key = this.credentials.newApiKeyGroupE ?? this.credentials.keyGroupE;
        break;
      case MODEL_GROUPS.GROUP_CLAUDE:
        key = this.credentials.newApiKeyGroupClaude ?? this.credentials.keyGroupClaude;
        break;
      default:
        throw new UpstreamConfigurationError(groupId);
    }

    if (!key || key.trim() === '') {
      throw new UpstreamConfigurationError(groupId);
    }

    return key;
  }

  /**
   * Resolves the complete upstream forwarding context for a customer request.
   * Performs model existence check, status check, group authorization, and credential resolution.
   */
  public resolveRequestContext(
    publicModelId: string,
    customerAllowedGroups: string[]
  ): UpstreamRequestContext {
    const model = this.catalogMap.get(publicModelId);

    if (!model) {
      throw new ModelNotFoundError(publicModelId);
    }

    if (!model.enabled) {
      throw new ModelDisabledError(publicModelId);
    }

    if (!customerAllowedGroups.includes(model.groupId)) {
      throw new UnauthorizedModelGroupError(publicModelId, model.groupId);
    }

    const upstreamApiKey = this.getApiKeyForGroup(model.groupId);

    return {
      publicModelId: model.publicModelId,
      originalBearlabModelId: model.originalBearlabModelId,
      upstreamModelId: model.originalBearlabModelId,
      groupId: model.groupId,
      upstreamApiKey,
    };
  }
}
