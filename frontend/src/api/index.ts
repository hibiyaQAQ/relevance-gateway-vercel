import { BootstrapData, ModelCatalog, PaginatedResponse, RequestLog, UpstreamAgentInventoryItem } from '../types';

export class ApiError extends Error {
  status: number;
  payload: any;

  constructor(message: string, status: number, payload: any = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  let payload: any = null;
  try {
    payload = await res.json();
  } catch (_) {
    payload = null;
  }

  if (!res.ok) {
    const message =
      payload?.detail ||
      payload?.error?.message ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, payload);
  }

  return payload as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    ...init,
  });
  return parseResponse<T>(res);
}

export const adminApi = {
  bootstrap(): Promise<BootstrapData> {
    return request<BootstrapData>('/admin-api/bootstrap');
  },

  listRequestLogs(page = 1, pageSize = 20) {
    return request<PaginatedResponse<RequestLog>>(
      `/admin-api/request-logs?page=${page}&page_size=${pageSize}`
    );
  },

  login(username: string, password: string) {
    return request<{ ok: true }>('/admin-api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout() {
    return request<{ ok: true }>('/admin-api/logout', { method: 'POST' });
  },

  createUpstreamKey(payload: {
    name: string;
    project: string;
    region: string;
    api_key: string;
  }) {
    return request('/admin-api/upstream-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  deleteUpstreamKey(id: number) {
    return request<{ deleted: boolean; warnings?: string[] }>(`/admin-api/upstream-keys/${id}`, {
      method: 'DELETE',
    });
  },

  updateUpstreamKey(
    id: number,
    payload: {
      name?: string;
      project?: string;
      region?: string;
      api_key?: string;
      enabled?: boolean;
    }
  ) {
    return request(`/admin-api/upstream-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  verifyUpstreamKey(id: number) {
    return request(`/admin-api/upstream-keys/${id}/verify`, {
      method: 'POST',
    });
  },

  getModelCatalog(upstreamKeyId?: number) {
    const query = upstreamKeyId ? `?upstream_key_id=${upstreamKeyId}` : '';
    return request<{ catalog: ModelCatalog; source_upstream_key: any }>(`/admin-api/model-catalog${query}`);
  },

  refreshModelCatalog(upstreamKeyId?: number) {
    const query = upstreamKeyId ? `?upstream_key_id=${upstreamKeyId}` : '';
    return request<{ catalog: ModelCatalog; source_upstream_key: any; warning?: string }>(
      `/admin-api/model-catalog/refresh${query}`,
      { method: 'POST' }
    );
  },

  createKeyDeployment(
    upstreamKeyId: number,
    payload: {
      upstream_model: string;
    }
  ) {
    return request(`/admin-api/upstream-keys/${upstreamKeyId}/deployments`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  createKeyDeploymentsBatch(
    upstreamKeyId: number,
    payload: {
      upstream_models: string[];
    }
  ) {
    return request<{
      created: Array<Record<string, any>>;
      skipped: Array<Record<string, any>>;
      failed: Array<Record<string, any>>;
    }>(`/admin-api/upstream-keys/${upstreamKeyId}/deployments/batch`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateKeyDeployment(
    upstreamKeyId: number,
    deploymentId: number,
    payload: {
      upstream_model?: string;
      enabled?: boolean;
    }
  ) {
    return request(`/admin-api/upstream-keys/${upstreamKeyId}/deployments/${deploymentId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  deleteKeyDeployment(upstreamKeyId: number, deploymentId: number) {
    return request<{ deleted: boolean; warnings?: string[] }>(
      `/admin-api/upstream-keys/${upstreamKeyId}/deployments/${deploymentId}`,
      {
        method: 'DELETE',
      }
    );
  },

  syncKeyDeployments(
    sourceUpstreamKeyId: number,
    payload: {
      target_upstream_key_ids?: number[];
      public_model_names?: string[];
    }
  ) {
    return request<{
      created: Array<Record<string, any>>;
      skipped: Array<Record<string, any>>;
      failed: Array<Record<string, any>>;
    }>(`/admin-api/upstream-keys/${sourceUpstreamKeyId}/deployments/sync`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  listUpstreamAgents(upstreamKeyId: number) {
    return request<{ agents: UpstreamAgentInventoryItem[] }>(`/admin-api/upstream-keys/${upstreamKeyId}/agents`);
  },

  deleteUpstreamAgents(upstreamKeyId: number, agentIds: string[]) {
    return request<{ deleted: Array<Record<string, any>>; failed: Array<Record<string, any>> }>(
      `/admin-api/upstream-keys/${upstreamKeyId}/agents/delete`,
      {
        method: 'POST',
        body: JSON.stringify({ agent_ids: agentIds }),
      }
    );
  },

  createGatewayKey(payload: { name: string }) {
    return request<{ gateway_key: any; raw_key: string }>('/admin-api/gateway-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  deleteGatewayKey(id: number) {
    return request<{ deleted: boolean }>(`/admin-api/gateway-keys/${id}`, {
      method: 'DELETE',
    });
  },
};
