export interface ModelDeployment {
  id: number;
  upstream_key_id: number;
  public_model_name: string;
  display_name: string;
  upstream_model: string;
  agent_id: string;
  agent_name: string;
  enabled: boolean;
  status: 'active' | 'failed' | 'deploying' | string;
  last_error?: string | null;
  last_used_at?: string | null;
  last_latency_ms?: number | null;
  consecutive_failures?: number;
  cooldown_until?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface UpstreamKey {
  id: number;
  name: string;
  project: string;
  region: string;
  api_key: string;
  enabled: boolean;
  status: 'active' | 'invalid' | 'unknown' | string;
  last_error?: string | null;
  last_check_at: string | null;
  created_at?: string;
  updated_at?: string;
  deployments: ModelDeployment[];
}

export interface UpstreamAgentInventoryItem {
  agent_id: string;
  agent_name: string;
  upstream_model?: string | null;
  managed_by_gateway: boolean;
  deployment_id?: number | null;
  public_model_name?: string | null;
  display_name?: string | null;
  enabled?: boolean | null;
  owner_upstream_key_id?: number | null;
  owner_upstream_key_name?: string | null;
}

export interface GatewayApiKey {
  id: number;
  name: string;
  raw_key: string;
  enabled: boolean;
  created_at?: string;
}

export interface RequestLog {
  id: number;
  request_id: string;
  model: string;
  stream: boolean;
  status: 'started' | 'streaming' | 'completed' | 'failed' | string;
  status_code: number;
  latency_ms: number;
  created_at: string;
  gateway_key_name: string;
  error_message?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cost?: number | null;
  credits_used?: Array<Record<string, any>> | null;
  transport?: string | null;
  upstream_conversation_id?: string | null;
  request_preview?: string | null;
  response_preview?: string | null;
  thinking_preview?: string | null;
  first_token_ms?: number | null;
  emitted_content_chars?: number | null;
  emitted_thinking_chars?: number | null;
}

export interface BootstrapData {
  settings: {
    app_name: string;
    buffered_stream_enabled: boolean;
    runtime?: string;
  };
  upstream_keys: UpstreamKey[];
  gateway_keys: GatewayApiKey[];
  request_logs: RequestLog[];
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: PaginationMeta;
}

export type TabType = 'dashboard' | 'upstream' | 'gateway' | 'logs';

export interface ModelCatalogEntry {
  value: string;
  label: string;
  description?: string;
  group_name?: string;
  context_window?: number;
  max_output_tokens?: number;
  requires_user_key?: boolean;
  has_user_key?: boolean;
  credits?: Array<{
    label?: string;
    credits_per_token?: number;
    credits_per_input_token?: number;
    credits_per_output_token?: number;
    credits_per_cache_read_input_token?: number;
    credits_per_cache_write_input_token?: number;
  }>;
  release_date?: string;
  importance?: number;
  reasoning_capability?: {
    type?: string;
    help_text?: string;
    supported_efforts?: string[];
    default_effort?: string;
    supported_thinking_types?: string[];
    default_thinking_type?: string;
    provider?: string;
    min_tokens?: number;
    max_tokens?: number;
    default_tokens?: number;
    disable_thinking_token_budget?: number;
  };
  supported_input_media?: {
    images?: boolean;
    files?: string[];
  };
}

export interface ModelCatalog {
  id: number;
  project: string;
  region: string;
  model_subset: string;
  source_upstream_key_id: number | null;
  source_upstream_key_name: string | null;
  model_count: number;
  models: ModelCatalogEntry[];
  last_error: string | null;
  last_refreshed_at: string | null;
  is_stale: boolean;
}
