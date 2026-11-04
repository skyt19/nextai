import { ModelGroupId } from '../config/constants.js';

export interface CatalogModel {
  publicModelId: string;
  displayName: string;
  originalBearlabModelId: string;
  groupId: ModelGroupId;
  baseCostCny: string;
  markup: string;
  sellingPriceCny: string;
  enabled: boolean;
}
