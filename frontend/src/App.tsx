import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AlertCircle, Loader2, Shield } from 'lucide-react';
import { adminApi, ApiError } from './api';
import { Button } from './components/ui/Button';
import { AdminLayout } from './layouts/AdminLayout';
import { Dashboard } from './pages/Dashboard';
import { GatewayKeys } from './pages/GatewayKeys';
import { RequestLogsPage } from './pages/RequestLogsPage';
import { UpstreamKeys } from './pages/UpstreamKeys';
import { BootstrapData, ModelDeployment, UpstreamKey } from './types';
import { cn } from './utils';

type ToastState = {
  type: 'success' | 'error';
  message: string;
} | null;

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.clearTimeout((showToast as any)._timer);
    (showToast as any)._timer = window.setTimeout(() => setToast(null), 3200);
  };

  const fetchBootstrap = async (initial = false) => {
    if (!initial) setIsRefreshing(true);
    try {
      const json = await adminApi.bootstrap();
      setData(json);
      setUnauthorized(false);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUnauthorized(true);
        setData(null);
      } else {
        showToast(error instanceof Error ? error.message : '加载后台数据失败', 'error');
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBootstrap(true);
  }, []);

  const handleLogin = async (username: string, password: string) => {
    try {
      await adminApi.login(username, password);
      showToast('管理员登录成功。');
      await fetchBootstrap();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '登录失败');
    }
  };

  const handleVerifyKey = async (id: number) => {
    await adminApi.verifyUpstreamKey(id);
    await fetchBootstrap();
    showToast('上游 Key 校验完成。');
  };

  const handleCreateUpstreamKey = async (payload: {
    name: string;
    project: string;
    region: string;
    api_key: string;
  }) => {
    await adminApi.createUpstreamKey(payload);
    await fetchBootstrap();
    showToast('上游 Key 已保存。');
  };

  const handleDeleteUpstreamKey = async (key: UpstreamKey) => {
    const result = await adminApi.deleteUpstreamKey(key.id);
    await fetchBootstrap();
    if (result.warnings?.length) {
      showToast(`Key 已删除，但有清理警告：${result.warnings[0]}`, 'error');
      return;
    }
    showToast('上游 Key 已删除。');
  };

  const handleUpdateUpstreamKey = async (
    keyId: number,
    payload: {
      name?: string;
      project?: string;
      region?: string;
      api_key?: string;
      enabled?: boolean;
    }
  ) => {
    await adminApi.updateUpstreamKey(keyId, payload);
    await fetchBootstrap();
    showToast('上游 Key 已更新。');
  };

  const handleCreateDeployment = async (
    upstreamKeyId: number,
    payload: {
      upstream_model: string;
    }
  ) => {
    await adminApi.createKeyDeployment(upstreamKeyId, payload);
    await fetchBootstrap();
    showToast('模型部署成功。');
  };

  const handleCreateDeploymentsBatch = async (
    upstreamKeyId: number,
    payload: {
      upstream_models: string[];
    }
  ) => {
    const result = await adminApi.createKeyDeploymentsBatch(upstreamKeyId, payload);
    await fetchBootstrap();
    showToast(
      `批量部署完成：成功 ${result.created.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
      result.failed.length ? 'error' : 'success'
    );
    return result;
  };

  const handleUpdateDeployment = async (
    upstreamKeyId: number,
    deploymentId: number,
    payload: {
      upstream_model?: string;
      enabled?: boolean;
    }
  ) => {
    await adminApi.updateKeyDeployment(upstreamKeyId, deploymentId, payload);
    await fetchBootstrap();
    showToast(payload.enabled !== undefined ? '部署状态已更新。' : '部署配置已更新。');
  };

  const handleDeleteDeployment = async (upstreamKeyId: number, deployment: ModelDeployment) => {
    const result = await adminApi.deleteKeyDeployment(upstreamKeyId, deployment.id);
    await fetchBootstrap();
    if (result.warnings?.length) {
      showToast(`部署已删除，但有清理警告：${result.warnings[0]}`, 'error');
      return;
    }
    showToast('部署已删除。');
  };

  const handleSyncDeployments = async (
    sourceUpstreamKeyId: number,
    payload: {
      target_upstream_key_ids?: number[];
      public_model_names?: string[];
    }
  ) => {
    const result = await adminApi.syncKeyDeployments(sourceUpstreamKeyId, payload);
    await fetchBootstrap();
    showToast(
      `同步完成：成功 ${result.created.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
      result.failed.length ? 'error' : 'success'
    );
    return result;
  };

  const handleDeleteAgents = async (upstreamKeyId: number, agentIds: string[]) => {
    const result = await adminApi.deleteUpstreamAgents(upstreamKeyId, agentIds);
    await fetchBootstrap();
    showToast(
      `Agent 清理完成：删除 ${result.deleted.length}，失败 ${result.failed.length}`,
      result.failed.length ? 'error' : 'success'
    );
    return result;
  };

  const handleCreateGatewayKey = async (payload: { name: string }) => {
    const result = await adminApi.createGatewayKey(payload);
    await fetchBootstrap();
    showToast('新的网关 Key 已签发。');
    return result.raw_key;
  };

  const handleDeleteGatewayKey = async (keyId: number) => {
    await adminApi.deleteGatewayKey(keyId);
    await fetchBootstrap();
    showToast('网关 Key 已删除。');
  };

  const handleLogout = async () => {
    await adminApi.logout();
    setUnauthorized(true);
    setData(null);
    showToast('已退出登录。');
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-10 w-10 animate-spin text-emerald-600" />
      </div>
    );
  }

  if (unauthorized || !data) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <BrowserRouter basename="/admin">
      <AdminLayout
        isRefreshing={isRefreshing}
        onRefresh={() => fetchBootstrap()}
        onLogout={handleLogout}
      >
        <Routes>
          <Route path="/dashboard" element={<Dashboard data={data} />} />
          <Route
            path="/upstream"
            element={
              <UpstreamKeys
                keys={data.upstream_keys}
                refreshVersion={refreshVersion}
                onVerify={handleVerifyKey}
                onCreate={handleCreateUpstreamKey}
                onUpdate={handleUpdateUpstreamKey}
                onDelete={handleDeleteUpstreamKey}
                onCreateDeployment={handleCreateDeployment}
                onCreateDeploymentsBatch={handleCreateDeploymentsBatch}
                onUpdateDeployment={handleUpdateDeployment}
                onDeleteDeployment={handleDeleteDeployment}
                onSyncDeployments={handleSyncDeployments}
                onDeleteAgents={handleDeleteAgents}
              />
            }
          />
          <Route
            path="/gateway"
            element={
              <GatewayKeys
                keys={data.gateway_keys}
                refreshVersion={refreshVersion}
                onCreate={handleCreateGatewayKey}
                onDelete={handleDeleteGatewayKey}
              />
            }
          />
          <Route path="/logs" element={<RequestLogsPage refreshVersion={refreshVersion} />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AdminLayout>

      <div className="fixed bottom-6 right-6 z-[60] space-y-3">
        {toast && (
          <div
            className={cn(
              'flex items-center gap-3 rounded-2xl px-5 py-4 shadow-2xl backdrop-blur-md',
              toast.type === 'success' ? 'bg-emerald-900/90 text-white' : 'bg-red-900/90 text-white'
            )}
          >
            {toast.type === 'success' ? (
              <Shield className="h-5 w-5 text-emerald-400" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-400" />
            )}
            <span className="text-sm font-bold tracking-tight">{toast.message}</span>
          </div>
        )}
      </div>

      <div className="fixed bottom-6 left-6 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 shadow-sm">
        当前启用上游 Key：<span className="font-bold text-slate-800">{data.upstream_keys.filter(k => k.enabled).length}</span>
      </div>
    </BrowserRouter>
  );
}

function Login({ onLogin }: { onLogin: (u: string, p: string) => Promise<void> }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-[2.5rem] border border-slate-200 bg-white p-8 shadow-2xl shadow-slate-200/50">
        <div className="mb-8 flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-600 shadow-xl shadow-emerald-200">
            <Shield className="h-8 w-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 leading-none">RGW Lab</h1>
            <p className="mt-2 text-sm text-slate-500 font-medium">管理员控制中心</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400">用户名</label>
            <input
              type="text"
              className="input w-full"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400">密码</label>
            <input
              type="password"
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="rounded-2xl bg-red-50 p-4 text-xs font-bold text-red-600">{error}</div>}

          <Button type="submit" className="w-full h-12 text-base" isLoading={loading}>
            验证并进入
          </Button>
        </form>
      </div>
    </div>
  );
}
