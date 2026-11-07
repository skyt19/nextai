import { env } from '../config/env.js';

export class NewApiError extends Error {
  public readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    // Sanitize any accidental secrets from error messages
    const sanitized = message.replace(/sk-[a-zA-Z0-9_\-]{8,}/g, 'sk-****');
    super(sanitized);
    this.name = 'NewApiError';
    this.statusCode = statusCode;
  }
}

export class NewApiAuthError extends NewApiError {
  constructor(message: string = 'New API PAT authentication failed or token is missing/invalid.') {
    super(message, 401);
    this.name = 'NewApiAuthError';
  }
}

export class NewApiTimeoutError extends NewApiError {
  constructor(message: string = 'New API Management API request timed out.') {
    super(message, 408);
    this.name = 'NewApiTimeoutError';
  }
}

export class NewApiUnavailableError extends NewApiError {
  constructor(message: string = 'New API service is unavailable or unreachable.') {
    super(message, 503);
    this.name = 'NewApiUnavailableError';
  }
}

export interface NewApiTokenItem {
  id: number;
  user_id?: number;
  key: string;
  status: number; // 1 = active, 2 = disabled
  name: string;
  created_time?: number;
  accessed_time?: number;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: boolean;
  used_quota?: number;
  group?: string;
  models?: string;
  model_limits?: string;
  model_limits_enabled?: boolean;
  subnet?: string;
}

export interface CreateNewApiTokenInput {
  name: string;
  remain_quota: number;
  expired_time?: number;
  unlimited_quota?: boolean;
  model_limits_enabled?: boolean;
  models?: string;
  group?: string;
  allow_ips?: string;
}

export interface CreateNewApiTokenResult {
  id?: number;
  key: string;
  name: string;
  group?: string;
  remain_quota: number;
}

export interface NewApiManagementConfig {
  baseUrl?: string;
  adminAccessToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class NewApiManagementService {
  private readonly baseUrl: string;
  private readonly adminAccessToken?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: NewApiManagementConfig = {}) {
    const rawBaseUrl = config.baseUrl ?? env.NEWAPI_BASE_URL;
    this.baseUrl = this.normalizeBaseUrl(rawBaseUrl);
    this.adminAccessToken = config.adminAccessToken ?? env.NEWAPI_ADMIN_ACCESS_TOKEN;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  /**
   * Normalizes New API base URL by stripping trailing slashes and /v1 suffix.
   */
  public normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  /**
   * Returns authorization headers for New API Management PAT authentication.
   */
  private getHeaders(): Record<string, string> {
    if (!this.adminAccessToken || this.adminAccessToken.trim() === '') {
      throw new NewApiAuthError('NEWAPI_ADMIN_ACCESS_TOKEN is missing or not configured.');
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.adminAccessToken.trim()}`,
    };
  }

  /**
   * Generic HTTP request with timeout, error translation, and bounded retries.
   * For non-idempotent POST operations, retries are disabled by default to prevent duplication.
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    allowRetry: boolean = true
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      ...this.getHeaders(),
      ...(options.headers as Record<string, string>),
    };

    let attempt = 0;
    const maxAttempts = allowRetry ? this.maxRetries + 1 : 1;

    while (attempt < maxAttempts) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 401 || response.status === 403) {
          throw new NewApiAuthError(`New API authentication failed with status ${response.status}. Check PAT token.`);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          if (response.status >= 500 && attempt < maxAttempts) {
            // Transient server error, wait before retry
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
            continue;
          }
          throw new NewApiError(
            `New API HTTP request failed with status ${response.status}: ${errorText}`,
            response.status
          );
        }

        const data = (await response.json()) as { success: boolean; message?: string; data?: any };
        if (data.success === false) {
          throw new NewApiError(data.message || 'New API operation reported failure.');
        }

        return data as T;
      } catch (err: any) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          throw new NewApiTimeoutError(`New API request to ${endpoint} timed out after ${this.timeoutMs}ms.`);
        }
        if (err instanceof NewApiAuthError) {
          throw err;
        }
        if (err instanceof NewApiError) {
          throw err;
        }

        // Network or connection errors (ECONNREFUSED, FetchError, etc.)
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
          continue;
        }

        throw new NewApiUnavailableError(
          `Failed to connect to New API at ${this.baseUrl}: ${err.message || 'Connection refused or network error'}`
        );
      }
    }

    throw new NewApiUnavailableError(`Request failed after ${maxAttempts} attempts.`);
  }

  /**
   * Creates a new token in New API.
   * Note: POST is non-idempotent; allowRetry is false to prevent creating duplicate tokens on ambiguous network timeouts.
   * Parses both string format ({ success: true, data: "sk-..." }) and object format ({ success: true, data: { ... } }).
   */
  public async createToken(input: CreateNewApiTokenInput): Promise<CreateNewApiTokenResult> {
    const payload = {
      name: input.name,
      remain_quota: input.remain_quota,
      expired_time: input.expired_time ?? -1,
      unlimited_quota: input.unlimited_quota ?? false,
      model_limits_enabled: input.model_limits_enabled ?? false,
      model_limits: input.models ?? '', // New API struct field
      models: input.models ?? '',       // alias
      group: input.group ?? '',
      allow_ips: input.allow_ips ?? '',
    };

    const response = await this.request<{ success: boolean; message?: string; data: any }>(
      '/api/token/',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      false // do not blind retry POST create
    );

    let key: string | undefined;
    let id: number | undefined;

    if (typeof response.data === 'string') {
      key = response.data;
    } else if (typeof response.data === 'object' && response.data !== null) {
      key = response.data.key || response.data.token || response.data.access_token;
      id = response.data.id;
    }

    if (!key && typeof (response as any).key === 'string') {
      key = (response as any).key;
    }

    // In New API v1.0.0-rc.47, POST /api/token/ returns { success: true, message: "" } without data payload.
    // When New API returns success without key in payload, retrieve the newly created token in read-only mode from DB (PostgreSQL / SQLite).
    if ((!key || key.trim() === '') && response.success === true) {
      try {
        const { getPrismaClient } = await import('../db/client.js');
        const prisma = getPrismaClient();
        const rows = await prisma.$queryRawUnsafe<any[]>(
          `SELECT id, key, name, "group", remain_quota FROM tokens WHERE name = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
          input.name
        );
        if (rows && rows.length > 0 && rows[0]?.key) {
          const row = rows[0];
          key = row.key.startsWith('sk-') ? row.key : `sk-${row.key}`;
          id = typeof row.id === 'bigint' ? Number(row.id) : Number(row.id);
        }
      } catch {
        // Fallback for local sqlite if configured
        try {
          const { DatabaseSync } = await import('node:sqlite');
          const oneApiDbPath = 'C:\\Users\\ctarv\\Documents\\new-api\\data\\one-api.db';
          const db = new DatabaseSync(oneApiDbPath, { readOnly: true });
          const row = db
            .prepare(
              `SELECT id, key, name, \`group\`, remain_quota FROM tokens WHERE name = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
            )
            .all(input.name)[0] as any;

          if (row && row.key) {
            key = row.key.startsWith('sk-') ? row.key : `sk-${row.key}`;
            id = row.id;
          }
        } catch {
          // Fallback for isolated unit test environments
        }
      }
    }

    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new NewApiError('Unexpected response payload structure from New API create token endpoint.');
    }

    return {
      id,
      key: key.trim(),
      name: (typeof response.data === 'object' && response.data?.name) || input.name,
      group: (typeof response.data === 'object' && response.data?.group) || input.group,
      remain_quota: (typeof response.data === 'object' && response.data?.remain_quota) ?? input.remain_quota,
    };
  }

  /**
   * Searches tokens by name / keyword.
   * Endpoint: GET /api/token/search?keyword={keyword}
   * Supports both Array data and paginated { total, items } data structures.
   */
  public async searchTokens(keyword: string): Promise<NewApiTokenItem[]> {
    const query = encodeURIComponent(keyword.trim());
    const response = await this.request<{ success: boolean; data: any }>(
      `/api/token/search?keyword=${query}`,
      { method: 'GET' },
      true
    );

    if (Array.isArray(response.data)) {
      return response.data;
    }
    if (response.data && Array.isArray(response.data.items)) {
      return response.data.items;
    }

    return [];
  }

  /**
   * Lists tokens with pagination.
   * Endpoint: GET /api/token/?p={p}&size={size}
   * Supports both Array data and paginated { total, items } data structures.
   */
  public async listTokens(page: number = 0, size: number = 20): Promise<NewApiTokenItem[]> {
    const response = await this.request<{ success: boolean; data: any }>(
      `/api/token/?p=${page}&size=${size}`,
      { method: 'GET' },
      true
    );

    if (Array.isArray(response.data)) {
      return response.data;
    }
    if (response.data && Array.isArray(response.data.items)) {
      return response.data.items;
    }

    return [];
  }

  /**
   * Gets token details by numeric ID.
   * Endpoint: GET /api/token/{id}
   */
  public async getToken(id: number): Promise<NewApiTokenItem> {
    const response = await this.request<{ success: boolean; data: NewApiTokenItem }>(
      `/api/token/${id}`,
      { method: 'GET' },
      true
    );

    return response.data;
  }

  /**
   * Updates an existing token.
   * Endpoint: PUT /api/token/
   */
  public async updateToken(tokenData: Partial<NewApiTokenItem> & { id: number }): Promise<void> {
    await this.request<{ success: boolean; message?: string }>(
      '/api/token/',
      {
        method: 'PUT',
        body: JSON.stringify(tokenData),
      },
      true
    );
  }

  /**
   * Disables a token in New API (sets status = 2).
   */
  public async disableToken(id: number): Promise<void> {
    await this.updateToken({ id, status: 2 });
  }

  /**
   * Enables a token in New API (sets status = 1).
   */
  public async enableToken(id: number): Promise<void> {
    await this.updateToken({ id, status: 1 });
  }

  /**
   * Deletes a token in New API by ID.
   * Endpoint: DELETE /api/token/{id}
   */
  public async deleteToken(id: number): Promise<void> {
    await this.request<{ success: boolean; message?: string }>(
      `/api/token/${id}`,
      { method: 'DELETE' },
      true
    );
  }
}
