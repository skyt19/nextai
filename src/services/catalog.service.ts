import { STATIC_MODEL_CATALOG } from './catalog-data.js';
import { CatalogModel } from '../types/catalog.js';
import { ModelGroupId } from '../config/constants.js';
import {
  ModelNotFoundError,
  ModelDisabledError,
  UnauthorizedModelGroupError,
} from './credential-resolver.service.js';

export interface OpenAIModelItem {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  display_name: string;
  description: string;
  group: string;
}

export interface OpenAIModelListResponse {
  object: 'list';
  data: OpenAIModelItem[];
}

export class ModelCatalogService {
  private readonly modelsByPublicId: Map<string, CatalogModel>;
  private readonly upstreamIdSet: Set<string>;

  constructor(customCatalog: CatalogModel[] = STATIC_MODEL_CATALOG) {
    this.modelsByPublicId = new Map();
    this.upstreamIdSet = new Set();

    for (const model of customCatalog) {
      this.modelsByPublicId.set(model.publicModelId, model);
      this.upstreamIdSet.add(model.originalBearlabModelId);
    }
  }

  /**
   * Returns all catalog models.
   */
  public getAllModels(): CatalogModel[] {
    return Array.from(this.modelsByPublicId.values());
  }

  /**
   * Retrieves a model by its public ID.
   */
  public getModelByPublicId(publicModelId: string): CatalogModel | undefined {
    return this.modelsByPublicId.get(publicModelId);
  }

  /**
   * Filters models belonging to specific allowed model groups.
   */
  public getModelsForGroups(allowedGroups: (ModelGroupId | string)[], includeDisabled: boolean = false): CatalogModel[] {
    const groupSet = new Set(allowedGroups);
    return Array.from(this.modelsByPublicId.values()).filter((model) => {
      if (!groupSet.has(model.groupId)) return false;
      if (!includeDisabled && !model.enabled) return false;
      return true;
    });
  }

  /**
   * Formats models into an OpenAI-compatible GET /v1/models response.
   * STRICT SECURITY: Never exposes original Bearlab model IDs or upstream secrets.
   */
  public formatOpenAIModelList(allowedGroups: (ModelGroupId | string)[]): OpenAIModelListResponse {
    const authorizedModels = this.getModelsForGroups(allowedGroups, false);
    const fixedTimestamp = 1762084800; // Deterministic model creation timestamp

    const data: OpenAIModelItem[] = authorizedModels.map((m) => {
      // Extract clean model name and price description
      const nameParts = m.displayName.split(' — ');
      const cleanName = nameParts[0] || m.publicModelId;
      const description = nameParts[1] || `¥${m.sellingPriceCny}/request [${m.groupId}]`;

      return {
        id: m.publicModelId,
        object: 'model',
        created: fixedTimestamp,
        owned_by: 'next-ai-proxy-hub',
        display_name: cleanName,
        description: description,
        group: m.groupId,
      };
    });

    return {
      object: 'list',
      data,
    };
  }

  /**
   * Translates a public model ID into the original Bearlab model ID.
   * Enforces model existence, enabled status, group authorization,
   * and blocks bypass attempts with raw upstream identifiers.
   */
  public translateModel(publicModelId: string, customerAllowedGroups: (ModelGroupId | string)[]): {
    originalBearlabModelId: string;
    groupId: ModelGroupId;
    catalogEntry: CatalogModel;
  } {
    // Prevent bypass: Reject raw Bearlab IDs if a customer tries to pass them directly
    if (this.upstreamIdSet.has(publicModelId)) {
      throw new ModelNotFoundError(
        `Direct upstream model identifiers cannot be used directly. Please use the public model ID.`
      );
    }

    const model = this.modelsByPublicId.get(publicModelId);
    if (!model) {
      throw new ModelNotFoundError(publicModelId);
    }

    if (!model.enabled) {
      throw new ModelDisabledError(publicModelId);
    }

    const isGroupAllowed = customerAllowedGroups.includes(model.groupId);
    if (!isGroupAllowed) {
      throw new UnauthorizedModelGroupError(publicModelId, model.groupId);
    }

    return {
      originalBearlabModelId: model.originalBearlabModelId,
      groupId: model.groupId,
      catalogEntry: model,
    };
  }
}
