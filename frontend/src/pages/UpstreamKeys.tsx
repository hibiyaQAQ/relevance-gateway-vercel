import React, { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Brain,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  ShieldAlert,
  Sparkles,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { adminApi } from '../api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { ModelCatalog, ModelCatalogEntry, ModelDeployment, UpstreamAgentInventoryItem, UpstreamKey } from '../types';
import { cn, formatDateTime } from '../utils';

interface Props {
  keys: UpstreamKey[];
  refreshVersion: number;
  onVerify: (id: number) => Promise<void>;
  onCreate: (payload: {
    name: string;
    project: string;
    region: string;
    api_key: string;
  }) => Promise<void>;
  onUpdate: (
    keyId: number,
    payload: {
      name?: string;
      project?: string;
      region?: string;
      api_key?: string;
      enabled?: boolean;
    }
  ) => Promise<void>;
  onDelete: (key: UpstreamKey) => Promise<void>;
  onCreateDeployment: (
    upstreamKeyId: number,
    payload: {
      upstream_model: string;
    }
  ) => Promise<void>;
  onCreateDeploymentsBatch: (
    upstreamKeyId: number,
    payload: {
      upstream_models: string[];
    }
  ) => Promise<{ created: Array<Record<string, any>>; skipped: Array<Record<string, any>>; failed: Array<Record<string, any>> }>;
  onUpdateDeployment: (
    upstreamKeyId: number,
    deploymentId: number,
    payload: {
      upstream_model?: string;
      enabled?: boolean;
    }
  ) => Promise<void>;
  onDeleteDeployment: (upstreamKeyId: number, deployment: ModelDeployment) => Promise<void>;
  onSyncDeployments: (
    sourceUpstreamKeyId: number,
    payload: {
      target_upstream_key_ids?: number[];
      public_model_names?: string[];
    }
  ) => Promise<{ created: Array<Record<string, any>>; skipped: Array<Record<string, any>>; failed: Array<Record<string, any>> }>;
  onDeleteAgents: (
    upstreamKeyId: number,
    agentIds: string[]
  ) => Promise<{ deleted: Array<Record<string, any>>; failed: Array<Record<string, any>> }>;
}

const emptyKeyForm = {
  name: '',
  project: '',
  region: '',
  api_key: '',
  enabled: true,
};

const emptyDeploymentForm = {
  upstream_model: '',
};

export const UpstreamKeys: React.FC<Props> = ({
  keys,
  refreshVersion,
  onVerify,
  onCreate,
  onUpdate,
  onDelete,
  onCreateDeployment,
  onCreateDeploymentsBatch,
  onUpdateDeployment,
  onDeleteDeployment,
  onSyncDeployments,
  onDeleteAgents,
}) => {
  const [keyModal, setKeyModal] = useState<{ mode: 'create' | 'edit'; keyId?: number } | null>(null);
  const [keyForm, setKeyForm] = useState(emptyKeyForm);
  const [keySubmitting, setKeySubmitting] = useState(false);
  const [keyFormError, setKeyFormError] = useState('');

  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [deletingKeyId, setDeletingKeyId] = useState<number | null>(null);

  const [catalogByKey, setCatalogByKey] = useState<Record<number, ModelCatalog | null>>({});
  const [catalogLoadingKeyId, setCatalogLoadingKeyId] = useState<number | null>(null);

  const [manageKeyId, setManageKeyId] = useState<number | null>(null);
  const [deploymentModal, setDeploymentModal] = useState<{ upstreamKeyId: number; deploymentId?: number | null } | null>(null);
  const [deploymentForm, setDeploymentForm] = useState(emptyDeploymentForm);
  const [deploymentQuery, setDeploymentQuery] = useState('');
  const [selectedDeploymentModels, setSelectedDeploymentModels] = useState<string[]>([]);
  const [previewModelValue, setPreviewModelValue] = useState<string | null>(null);
  const [hoverPreviewPoint, setHoverPreviewPoint] = useState<{ x: number; y: number } | null>(null);
  const [deploymentSubmitting, setDeploymentSubmitting] = useState(false);
  const [deploymentError, setDeploymentError] = useState('');

  const [syncKeyId, setSyncKeyId] = useState<number | null>(null);
  const [syncTargets, setSyncTargets] = useState<number[]>([]);
  const [syncModels, setSyncModels] = useState<string[]>([]);
  const [syncSubmitting, setSyncSubmitting] = useState(false);

  const [agentModalKeyId, setAgentModalKeyId] = useState<number | null>(null);
  const [agentInventory, setAgentInventory] = useState<UpstreamAgentInventoryItem[]>([]);
  const [agentInventoryLoading, setAgentInventoryLoading] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [agentDeleting, setAgentDeleting] = useState(false);
  const [keysPage, setKeysPage] = useState(1);
  const [deploymentsPage, setDeploymentsPage] = useState(1);
  const [agentInventoryPage, setAgentInventoryPage] = useState(1);

  const allDeployments = useMemo(() => keys.flatMap((key) => key.deployments), [keys]);
  const keyById = useMemo(() => new Map(keys.map((key) => [key.id, key])), [keys]);

  const managedKey = manageKeyId ? keyById.get(manageKeyId) || null : null;
  const syncKey = syncKeyId ? keyById.get(syncKeyId) || null : null;
  const agentModalKey = agentModalKeyId ? keyById.get(agentModalKeyId) || null : null;
  const deploymentContext = useMemo(() => {
    if (!deploymentModal) return { upstreamKey: null as UpstreamKey | null, deployment: null as ModelDeployment | null };
    const upstreamKey = keyById.get(deploymentModal.upstreamKeyId) || null;
    const deployment = upstreamKey?.deployments.find((item) => item.id === deploymentModal.deploymentId) || null;
    return { upstreamKey, deployment };
  }, [deploymentModal, keyById]);

  const stats = useMemo(
    () => ({
      total: keys.length,
      active: keys.filter((item) => item.status === 'active').length,
      deployments: allDeployments.length,
    }),
    [allDeployments.length, keys]
  );

  const ensureCatalog = async (upstreamKeyId: number) => {
    if (catalogByKey[upstreamKeyId]) return catalogByKey[upstreamKeyId];
    setCatalogLoadingKeyId(upstreamKeyId);
    try {
      const result = await adminApi.getModelCatalog(upstreamKeyId);
      setCatalogByKey((prev) => ({ ...prev, [upstreamKeyId]: result.catalog }));
      return result.catalog;
    } finally {
      setCatalogLoadingKeyId(null);
    }
  };

  const openCreateKey = () => {
    setKeyForm(emptyKeyForm);
    setKeyFormError('');
    setKeyModal({ mode: 'create' });
  };

  const openEditKey = (key: UpstreamKey) => {
    setKeyForm({
      name: key.name,
      project: key.project,
      region: key.region,
      api_key: key.api_key,
      enabled: key.enabled,
    });
    setKeyFormError('');
    setKeyModal({ mode: 'edit', keyId: key.id });
  };

  const submitKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!keyModal) return;
    setKeySubmitting(true);
    setKeyFormError('');
    try {
      if (keyModal.mode === 'create') {
        await onCreate({
          name: keyForm.name.trim(),
          project: keyForm.project.trim(),
          region: keyForm.region.trim(),
          api_key: keyForm.api_key.trim(),
        });
      } else if (keyModal.keyId) {
        await onUpdate(keyModal.keyId, {
          name: keyForm.name.trim(),
          project: keyForm.project.trim(),
          region: keyForm.region.trim(),
          api_key: keyForm.api_key.trim(),
          enabled: keyForm.enabled,
        });
      }
      setKeyModal(null);
      setKeyForm(emptyKeyForm);
    } catch (error) {
      setKeyFormError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setKeySubmitting(false);
    }
  };

  const openCreateDeployment = async (upstreamKeyId: number) => {
    await ensureCatalog(upstreamKeyId);
    setDeploymentForm(emptyDeploymentForm);
    setDeploymentQuery('');
    setSelectedDeploymentModels([]);
    setPreviewModelValue(null);
    setHoverPreviewPoint(null);
    setDeploymentError('');
    setDeploymentModal({ upstreamKeyId, deploymentId: null });
  };

  const openEditDeployment = async (upstreamKeyId: number, deployment: ModelDeployment) => {
    await ensureCatalog(upstreamKeyId);
    setDeploymentForm({
      upstream_model: deployment.upstream_model,
    });
    setDeploymentQuery('');
    setSelectedDeploymentModels([deployment.upstream_model]);
    setPreviewModelValue(deployment.upstream_model);
    setHoverPreviewPoint(null);
    setDeploymentError('');
    setDeploymentModal({ upstreamKeyId, deploymentId: deployment.id });
  };

  const submitDeployment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!deploymentContext.upstreamKey) return;
    setDeploymentSubmitting(true);
    setDeploymentError('');
    try {
      if (deploymentContext.deployment) {
        const nextModel = selectedDeploymentModels[0]?.trim() || deploymentForm.upstream_model.trim();
        await onUpdateDeployment(deploymentContext.upstreamKey.id, deploymentContext.deployment.id, {
          upstream_model: nextModel,
        });
      } else {
        const result = await onCreateDeploymentsBatch(deploymentContext.upstreamKey.id, {
          upstream_models: selectedDeploymentModels,
        });
        if (result.failed.length) {
          setDeploymentError(result.failed[0]?.reason || '部分模型部署失败');
          return;
        }
      }
      setDeploymentModal(null);
      setDeploymentForm(emptyDeploymentForm);
      setDeploymentQuery('');
      setSelectedDeploymentModels([]);
      setPreviewModelValue(null);
      setHoverPreviewPoint(null);
    } catch (error) {
      setDeploymentError(error instanceof Error ? error.message : '部署失败');
    } finally {
      setDeploymentSubmitting(false);
    }
  };

  const openSyncModal = (keyId: number) => {
    setSyncKeyId(keyId);
    setSyncTargets([]);
    setSyncModels([]);
  };

  const submitSync = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!syncKey) return;
    setSyncSubmitting(true);
    try {
      await onSyncDeployments(syncKey.id, {
        target_upstream_key_ids: syncTargets,
        public_model_names: syncModels,
      });
      setSyncKeyId(null);
      setSyncTargets([]);
      setSyncModels([]);
    } finally {
      setSyncSubmitting(false);
    }
  };

  const openAgentCleanup = async (upstreamKeyId: number) => {
    setAgentModalKeyId(upstreamKeyId);
    setAgentInventoryLoading(true);
    setSelectedAgentIds([]);
    try {
      const result = await adminApi.listUpstreamAgents(upstreamKeyId);
      setAgentInventory(result.agents);
    } finally {
      setAgentInventoryLoading(false);
    }
  };

  const submitDeleteAgents = async () => {
    if (!agentModalKey || selectedAgentIds.length === 0) return;
    setAgentDeleting(true);
    try {
      await onDeleteAgents(agentModalKey.id, selectedAgentIds);
      setAgentModalKeyId(null);
      setAgentInventory([]);
      setSelectedAgentIds([]);
    } finally {
      setAgentDeleting(false);
    }
  };

  const deploymentCatalog = useMemo(
    () => (deploymentContext.upstreamKey ? catalogByKey[deploymentContext.upstreamKey.id]?.models || [] : []),
    [catalogByKey, deploymentContext.upstreamKey]
  );

  const deployedModelSet = useMemo(
    () => new Set((deploymentContext.upstreamKey?.deployments || []).map((item) => item.upstream_model)),
    [deploymentContext.upstreamKey]
  );

  const filteredDeploymentCatalog = useMemo(() => {
    const normalized = deploymentQuery.trim().toLowerCase();
    const normalizedCompact = normalized.replace(/\s+/g, '');
    const tokens = normalized.split(/\s+/).filter(Boolean);

    if (!normalized) return deploymentCatalog;
    return deploymentCatalog.filter((item) => {
      const haystack = [item.label, item.value, item.group_name, item.description].filter(Boolean).join(' ').toLowerCase();
      const compact = haystack.replace(/\s+/g, '');
      return (
        haystack.includes(normalized) ||
        compact.includes(normalizedCompact) ||
        tokens.every((token) => haystack.includes(token) || compact.includes(token))
      );
    });
  }, [deploymentCatalog, deploymentQuery]);

  const sortedDeploymentCatalog = useMemo(
    () =>
      filteredDeploymentCatalog
        .slice()
        .sort((left, right) => {
          const leftRank = typeof left.importance === 'number' ? left.importance : 999;
          const rightRank = typeof right.importance === 'number' ? right.importance : 999;
          if (leftRank !== rightRank) return leftRank - rightRank;
          const providerCompare = String(left.group_name || '').localeCompare(String(right.group_name || ''));
          if (providerCompare !== 0) return providerCompare;
          return left.label.localeCompare(right.label);
        }),
    [filteredDeploymentCatalog]
  );

  const groupedDeploymentCatalog = useMemo(() => {
    const groups: Record<string, ModelCatalogEntry[]> = {};
    sortedDeploymentCatalog.forEach((item) => {
      const name = item.group_name || '其他厂商';
      if (!groups[name]) groups[name] = [];
      groups[name].push(item);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [sortedDeploymentCatalog]);

  const toggleDeploymentSelection = (modelValue: string) => {
    setPreviewModelValue(modelValue);
    if (deploymentContext.deployment) {
      setSelectedDeploymentModels([modelValue]);
      setDeploymentForm({ upstream_model: modelValue });
      return;
    }
    setSelectedDeploymentModels((prev) =>
      prev.includes(modelValue) ? prev.filter((item) => item !== modelValue) : [...prev, modelValue]
    );
  };

  const keysPageSize = 10;
  const deploymentsPageSize = 10;
  const agentInventoryPageSize = 12;

  const keysPagination = useMemo(() => buildPagination(keys.length, keysPage, keysPageSize), [keys.length, keysPage]);
  const pagedKeys = useMemo(
    () => keys.slice(keysPagination.start, keysPagination.end),
    [keys, keysPagination.end, keysPagination.start]
  );

  const deploymentsPagination = useMemo(
    () => buildPagination(managedKey?.deployments.length || 0, deploymentsPage, deploymentsPageSize),
    [deploymentsPage, managedKey?.deployments.length]
  );
  const pagedDeployments = useMemo(
    () =>
      (managedKey?.deployments || [])
        .slice()
        .sort((a, b) => a.display_name.localeCompare(b.display_name))
        .slice(deploymentsPagination.start, deploymentsPagination.end),
    [deploymentsPagination.end, deploymentsPagination.start, managedKey?.deployments]
  );

  const agentInventoryPagination = useMemo(
    () => buildPagination(agentInventory.length, agentInventoryPage, agentInventoryPageSize),
    [agentInventory.length, agentInventoryPage]
  );
  const pagedAgentInventory = useMemo(
    () => agentInventory.slice(agentInventoryPagination.start, agentInventoryPagination.end),
    [agentInventory, agentInventoryPagination.end, agentInventoryPagination.start]
  );

  React.useEffect(() => {
    setKeysPage(1);
  }, [refreshVersion]);

  React.useEffect(() => {
    setDeploymentsPage(1);
  }, [manageKeyId, refreshVersion]);

  React.useEffect(() => {
    setAgentInventoryPage(1);
  }, [agentModalKeyId, refreshVersion]);

  React.useEffect(() => {
    if (!deploymentContext.upstreamKey) return;
    if (previewModelValue && sortedDeploymentCatalog.some((item) => item.value === previewModelValue)) return;
    const fallback =
      selectedDeploymentModels[0] ||
      deploymentContext.deployment?.upstream_model ||
      sortedDeploymentCatalog[0]?.value ||
      null;
    setPreviewModelValue(fallback);
  }, [deploymentContext.deployment?.upstream_model, deploymentContext.upstreamKey, previewModelValue, selectedDeploymentModels, sortedDeploymentCatalog]);

  const previewItem = useMemo(
    () => sortedDeploymentCatalog.find((item) => item.value === previewModelValue) || null,
    [previewModelValue, sortedDeploymentCatalog]
  );

  const hoverPreviewStyle = useMemo(() => {
    if (!hoverPreviewPoint || typeof window === 'undefined') return null;
    const width = 340;
    return {
      left: Math.max(16, Math.min(hoverPreviewPoint.x + 18, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min(hoverPreviewPoint.y - 24, window.innerHeight - 360)),
      width,
    };
  }, [hoverPreviewPoint]);

  return (
    <div className="space-y-4 pb-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="上游 Key" value={stats.total} hint="Relevance project / API key 组合" />
        <StatCard label="已激活 Key" value={stats.active} hint="验证成功后可用于部署与转发" />
        <StatCard label="已部署模型" value={stats.deployments} hint="模型部署直接归属于对应 Key" />
      </div>

      <div className="flex items-end justify-between gap-4 pt-2">
        <div>
          <h3 className="text-base font-black text-slate-800 tracking-tight">上游 Key 管理</h3>
          <p className="mt-1 text-xs text-slate-500 font-medium">先添加并验证 Key，再进入模型管理弹窗部署模型、同步到其他 Key，或清理上游 Agent。</p>
        </div>
        <Button onClick={openCreateKey} size="sm" className="rounded-xl px-4 py-2 font-bold">
          <Plus className="h-4 w-4" />
          添加 Key
        </Button>
      </div>

      <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">名称</th>
                <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">Project / Region</th>
                <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">上游 API Key</th>
                <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">状态</th>
                <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">模型</th>
                <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">最近校验</th>
                <th className="px-4 py-2.5 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedKeys.map((key) => (
                <tr key={key.id} className="align-top hover:bg-slate-50/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="text-sm font-bold text-slate-900 leading-tight">{key.name}</div>
                    {key.last_error ? (
                      <div className="mt-1.5 max-w-xs rounded-lg bg-red-50 px-2 py-1 text-[10px] font-medium text-red-600 border border-red-100/50">{key.last_error}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-[10px] text-slate-500 font-medium">{key.project}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400 font-medium">{key.region}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <code className="block max-w-[200px] truncate rounded-lg bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500 border border-slate-100">
                      {key.api_key}
                    </code>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge
                      status={
                        key.status === 'active'
                          ? 'healthy'
                          : key.status === 'invalid'
                            ? 'error'
                            : 'unknown'
                      }
                      label={key.status}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="text-sm font-bold text-slate-800">{key.deployments.length}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400 truncate max-w-[120px] font-medium">
                      {key.deployments.length
                        ? key.deployments
                            .slice(0, 1)
                            .map((item) => item.display_name)
                            .join(' / ') + (key.deployments.length > 1 ? '...' : '')
                        : '尚未部署'}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-slate-500 font-medium">{formatDateTime(key.last_check_at)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8 rounded-lg text-xs font-bold"
                        isLoading={verifyingId === key.id}
                        onClick={async () => {
                          setVerifyingId(key.id);
                          try {
                            await onVerify(key.id);
                          } finally {
                            setVerifyingId(null);
                          }
                        }}
                      >
                        验证
                      </Button>
                      <Button variant="secondary" size="sm" className="h-8 rounded-lg text-xs font-bold" onClick={() => openEditKey(key)}>
                        编辑
                      </Button>
                      <Button variant="primary" size="sm" className="h-8 rounded-lg text-xs font-bold" onClick={() => setManageKeyId(key.id)}>
                        模型管理
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        className="h-8 rounded-lg text-xs font-bold"
                        isLoading={deletingKeyId === key.id}
                        onClick={async () => {
                          if (!window.confirm(`确认删除上游 Key「${key.name}」？这会删除该 Key 下的全部部署。`)) return;
                          setDeletingKeyId(key.id);
                          try {
                            await onDelete(key);
                          } finally {
                            setDeletingKeyId(null);
                          }
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-sm text-slate-400 font-medium">
                    还没有任何上游 Key，先添加一个有效的 Relevance API Key。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination pagination={keysPagination.meta} onPageChange={setKeysPage} />
      </div>

      <Modal
        open={!!keyModal}
        onClose={() => !keySubmitting && setKeyModal(null)}
        title={keyModal?.mode === 'edit' ? '编辑上游 Key' : '添加上游 Key'}
        subtitle="保存时会立即校验连通性；如果 Key 不可用，弹窗会直接报错且不会入库。"
      >
        <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={submitKey}>
          <Field label="名称">
            <input className="input" value={keyForm.name} onChange={(event) => setKeyForm((prev) => ({ ...prev, name: event.target.value }))} required placeholder="例如：主账号-生产" />
          </Field>
          <Field label="Region">
            <input className="input" value={keyForm.region} onChange={(event) => setKeyForm((prev) => ({ ...prev, region: event.target.value }))} required placeholder="例如：us-east-1" />
          </Field>
          <Field label="Project" className="md:col-span-2">
            <input className="input" value={keyForm.project} onChange={(event) => setKeyForm((prev) => ({ ...prev, project: event.target.value }))} required placeholder="Relevance Project ID" />
          </Field>
          <Field label="API Key" className="md:col-span-2">
            <textarea className="input min-h-[100px] resize-y font-mono text-[11px]" value={keyForm.api_key} onChange={(event) => setKeyForm((prev) => ({ ...prev, api_key: event.target.value }))} required placeholder="sk-..." />
          </Field>
          {keyModal?.mode === 'edit' && (
            <label className="md:col-span-2 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 font-bold">
              <input
                type="checkbox"
                checked={keyForm.enabled}
                onChange={(event) => setKeyForm((prev) => ({ ...prev, enabled: event.target.checked }))}
              />
              启用这个 Key
            </label>
          )}
          {keyFormError && <div className="md:col-span-2 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600 font-bold">{keyFormError}</div>}
          <div className="md:col-span-2 flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setKeyModal(null)} disabled={keySubmitting} className="rounded-xl px-6">
              取消
            </Button>
            <Button type="submit" isLoading={keySubmitting} className="rounded-xl px-6">
              保存并验证
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!managedKey}
        onClose={() => setManageKeyId(null)}
        title="模型管理"
        subtitle={managedKey ? `${managedKey.name} · ${managedKey.project} · ${managedKey.region}` : undefined}
        className="max-w-[94vw] xl:max-w-[1280px]"
      >
        {managedKey && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap gap-8 text-sm text-slate-600">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">已部署模型</div>
                  <div className="mt-0.5 text-xl font-black text-slate-900 leading-tight">{managedKey.deployments.length}</div>
                </div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">最近校验</div>
                  <div className="mt-0.5 text-xs text-slate-600 font-bold leading-tight">{formatDateTime(managedKey.last_check_at)}</div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" className="rounded-xl font-bold" onClick={() => openSyncModal(managedKey.id)}>
                  同步到其他 Key
                </Button>
                <Button variant="secondary" size="sm" className="rounded-xl font-bold" onClick={() => openAgentCleanup(managedKey.id)}>
                  清理 Agent
                </Button>
                <Button isLoading={catalogLoadingKeyId === managedKey.id} size="sm" className="rounded-xl font-bold" onClick={() => openCreateDeployment(managedKey.id)}>
                  <Plus className="h-4 w-4 mr-1" />
                  部署新模型
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left">
                  <thead className="bg-slate-50/50 border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">名称</th>
                      <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">模型 ID</th>
                      <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">资源信息</th>
                      <th className="px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">状态</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pagedDeployments
                      .map((deployment) => (
                        <tr key={deployment.id} className="align-top hover:bg-slate-50/30 transition-colors">
                          <td className="px-4 py-2.5">
                            <div className="text-sm font-bold text-slate-900 leading-tight">{deployment.display_name}</div>
                            <div className="mt-1 text-[10px] text-slate-400 font-medium">
                              {deployment.public_model_name === deployment.upstream_model
                                ? '对外模型名与 ID 一致'
                                : `对外名：${deployment.public_model_name}`}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="font-mono text-[10px] text-slate-500 font-medium">{deployment.upstream_model}</div>
                            {deployment.last_latency_ms ? (
                              <div className="mt-1 text-[10px] text-slate-400 font-bold">Latency {deployment.last_latency_ms}ms</div>
                            ) : null}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="space-y-0.5 font-mono text-[10px] text-slate-400 font-medium">
                              <div>Agent {deployment.agent_id}</div>
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge status={deployment.enabled ? 'active' : 'disabled'} label={deployment.enabled ? 'enabled' : 'disabled'} />
                            {deployment.last_error ? (
                              <div className="mt-1.5 max-w-xs rounded-lg bg-red-50 px-2 py-1 text-[10px] font-medium text-red-600 border border-red-100/50">{deployment.last_error}</div>
                            ) : null}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex justify-end gap-1.5">
                              <Button variant="secondary" size="sm" className="h-7 rounded-lg text-[11px] font-bold" onClick={() => openEditDeployment(managedKey.id, deployment)}>
                                编辑
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-7 rounded-lg text-[11px] font-bold"
                                onClick={() => onUpdateDeployment(managedKey.id, deployment.id, { enabled: !deployment.enabled })}
                              >
                                {deployment.enabled ? '禁用' : '启用'}
                              </Button>
                              <button
                                className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"
                                onClick={async () => {
                                  if (!window.confirm(`确认删除部署模型「${deployment.display_name}」？`)) return;
                                  await onDeleteDeployment(managedKey.id, deployment);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    {managedKey.deployments.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-6 py-8 text-center text-sm text-slate-400 font-medium">
                          这个 Key 还没有部署任何模型。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <Pagination pagination={deploymentsPagination.meta} onPageChange={setDeploymentsPage} compact />

            <div className="flex justify-end pt-2">
              <Button variant="secondary" onClick={() => setManageKeyId(null)} className="rounded-xl px-6 font-bold">
                关闭
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!deploymentContext.upstreamKey}
        onClose={() => !deploymentSubmitting && setDeploymentModal(null)}
        title={deploymentContext.deployment ? '编辑模型部署' : '部署模型'}
        subtitle={deploymentContext.upstreamKey ? `在 ${deploymentContext.upstreamKey.name} 下创建 Relevance agent 部署。` : undefined}
        className="max-w-[96vw] xl:max-w-[1200px] max-h-[calc(100vh-4rem)]"
        bodyClassName="min-h-0 flex flex-col p-0"
        bodyScrollable={false}
      >
        {deploymentContext.upstreamKey && (
          <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={submitDeployment}>
            <div className="border-b border-slate-100 px-4 py-3 bg-slate-50/30">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2 shadow-sm focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
                  <Search className="h-4 w-4 text-slate-400" />
                  <input
                    value={deploymentQuery}
                    onChange={(event) => setDeploymentQuery(event.target.value)}
                    placeholder="搜索模型、厂商、ID..."
                    className="w-full border-0 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400 font-medium"
                  />
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 font-bold shadow-sm">
                  {deploymentContext.deployment ? (
                    <span>编辑单选模式</span>
                  ) : (
                    <span>已选 {selectedDeploymentModels.length} 个</span>
                  )}
                </div>
              </div>

              {deploymentError && (
                <div className="mt-3 rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-xs text-red-600 font-bold">{deploymentError}</div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 bg-white">
              <div className="space-y-6">
                {groupedDeploymentCatalog.map(([group, items]) => (
                  <div key={group} className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-1 bg-indigo-500 rounded-full" />
                      <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400">{group}</h4>
                      <div className="flex-1 border-b border-slate-100 ml-1" />
                    </div>
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
                      {items.map((item) => {
                        const selected = selectedDeploymentModels.includes(item.value);
                        const previewed = previewItem?.value === item.value;
                        const deployedOnCurrentKey =
                          deployedModelSet.has(item.value) &&
                          (!deploymentContext.deployment || deploymentContext.deployment.upstream_model !== item.value);

                        return (
                          <button
                            key={item.value}
                            type="button"
                            disabled={deployedOnCurrentKey}
                            className={cn(
                              'group relative flex min-h-[70px] items-center gap-3 rounded-2xl border bg-white px-3.5 py-2.5 text-left transition-all',
                              previewed || selected ? 'border-indigo-500 bg-indigo-50/40 ring-1 ring-indigo-500 shadow-sm shadow-indigo-100' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
                              deployedOnCurrentKey && 'border-emerald-200 bg-emerald-50/40 hover:border-emerald-200 hover:bg-emerald-50/40',
                              deployedOnCurrentKey && 'cursor-not-allowed opacity-80'
                            )}
                            onClick={() => toggleDeploymentSelection(item.value)}
                            onMouseEnter={(event) => {
                              setPreviewModelValue(item.value);
                              setHoverPreviewPoint({ x: event.clientX, y: event.clientY });
                            }}
                            onMouseMove={(event) => {
                              setHoverPreviewPoint({ x: event.clientX, y: event.clientY });
                            }}
                            onMouseLeave={() => setHoverPreviewPoint(null)}
                          >
                            <div className={cn(
                              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-[10px] font-black',
                              deployedOnCurrentKey
                                ? 'border-emerald-200 bg-white text-emerald-700'
                                : previewed || selected
                                  ? 'border-indigo-300 bg-indigo-500 text-white'
                                  : 'border-slate-200 bg-slate-50 text-slate-600'
                            )}>
                              {providerMonogram(item.group_name)}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-bold text-slate-900 leading-tight">{item.label}</div>
                              <div className="mt-0.5 truncate text-[10px] text-slate-400 font-bold uppercase tracking-tight">{item.group_name || 'Generic'}</div>
                            </div>

                            <div className="shrink-0 text-right">
                              <div className="text-xs font-black text-slate-800 tracking-tight">{formatTokenValue(item.context_window)}</div>
                              <div className={cn(
                                'mt-0.5 text-[9px] font-black uppercase tracking-wider',
                                deployedOnCurrentKey ? 'text-emerald-700' : 'text-slate-400'
                              )}>
                                {deployedOnCurrentKey ? '已部署' : creditBandShortLabel(item)}
                              </div>
                            </div>

                            <div className="ml-1 shrink-0">
                              {selected ? (
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm shadow-indigo-200">
                                  <Check className="h-3 w-3" strokeWidth={3} />
                                </div>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {groupedDeploymentCatalog.length === 0 && (
                  <div className="py-20 text-center flex flex-col items-center">
                    <SearchX className="h-10 w-10 text-slate-200 mb-3" />
                    <p className="text-sm text-slate-400 font-bold">没有匹配的模型</p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3 flex justify-between items-center">
              <div className="text-xs text-slate-500 font-bold">
                {selectedDeploymentModels.length > 0 && `已选择 ${selectedDeploymentModels.length} 个模型，准备批量处理`}
              </div>
              <div className="flex gap-3">
                <Button type="button" variant="secondary" onClick={() => setDeploymentModal(null)} disabled={deploymentSubmitting} className="rounded-xl px-6 font-bold">
                  取消
                </Button>
                <Button
                  type="submit"
                  isLoading={deploymentSubmitting}
                  className="rounded-xl px-8 font-bold"
                  disabled={deploymentContext.deployment ? selectedDeploymentModels.length !== 1 : selectedDeploymentModels.length === 0}
                >
                  {deploymentContext.deployment ? '确认修改' : `部署所选 (${selectedDeploymentModels.length})`}
                </Button>
              </div>
            </div>

            {previewItem && hoverPreviewStyle ? (
              <div
                className="pointer-events-none fixed z-[120] rounded-[24px] border border-slate-200 bg-white p-4 shadow-2xl shadow-slate-900/15 ring-1 ring-slate-900/5"
                style={hoverPreviewStyle}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-xs font-black text-slate-700 shadow-sm">
                    {providerMonogram(previewItem.group_name)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-black text-slate-900 leading-none">{previewItem.label}</div>
                    <div className="mt-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400">{previewItem.group_name || 'Generic'}</div>
                  </div>
                </div>

                <div className={cn('mt-3 inline-flex rounded-lg px-2 py-0.5 text-[9px] font-black uppercase tracking-wider', creditBandClassName(previewItem))}>
                  {creditBandLabel(previewItem)}
                </div>

                <div className="mt-4 space-y-2.5">
                  <DetailRow icon={CircleDollarSign} label="Credit usage" value={formatCreditUsageMultiline(previewItem)} />
                  <DetailRow icon={MessageSquareText} label="Context window" value={formatTokenValue(previewItem.context_window)} />
                  <DetailRow icon={NotebookPen} label="Output limit" value={formatTokenValue(previewItem.max_output_tokens)} />
                  <DetailRow icon={ImageIcon} label="Input files" value={formatInputFiles(previewItem)} />
                  <DetailRow icon={Brain} label="Thinking" value={thinkingSupportLabel(previewItem)} />
                </div>

                {previewItem.description ? (
                  <div className="mt-4 text-[11px] leading-relaxed text-slate-500 italic font-medium">"{previewItem.description}"</div>
                ) : null}
              </div>
            ) : null}
          </form>
        )}
      </Modal>

      <Modal
        open={!!syncKey}
        onClose={() => !syncSubmitting && setSyncKeyId(null)}
        title="同步模型到其他 Key"
        subtitle={syncKey ? `以 ${syncKey.name} 为源，把选中的模型部署到其他 Key。` : undefined}
      >
        {syncKey && (
          <form className="space-y-4" onSubmit={submitSync}>
            <div>
              <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">目标 Key</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {keys.filter((item) => item.id !== syncKey.id).map((item) => (
                  <label key={item.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50 transition-colors cursor-pointer group">
                    <div>
                      <div className="text-sm font-bold text-slate-800">{item.name}</div>
                      <div className="text-[10px] font-mono text-slate-400 font-medium">{item.project}</div>
                    </div>
                    <input
                      type="checkbox"
                      className="rounded-lg border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                      checked={syncTargets.includes(item.id)}
                      onChange={() =>
                        setSyncTargets((prev) =>
                          prev.includes(item.id) ? prev.filter((value) => value !== item.id) : [...prev, item.id]
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-slate-400 font-medium italic">不勾选时默认同步到全部其他 Key。</p>
            </div>

            <div className="pt-2">
              <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">选择同步模型</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {syncKey.deployments.map((deployment) => (
                  <label key={deployment.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50 transition-colors cursor-pointer">
                    <div>
                      <div className="text-sm font-bold text-slate-800">{deployment.display_name}</div>
                      <div className="text-[10px] font-mono text-slate-400 font-medium">{deployment.upstream_model}</div>
                    </div>
                    <input
                      type="checkbox"
                      className="rounded-lg border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                      checked={syncModels.includes(deployment.public_model_name)}
                      onChange={() =>
                        setSyncModels((prev) =>
                          prev.includes(deployment.public_model_name)
                            ? prev.filter((value) => value !== deployment.public_model_name)
                            : [...prev, deployment.public_model_name]
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-slate-400 font-medium italic">不勾选时默认同步源 Key 的全部模型。</p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <Button type="button" variant="secondary" onClick={() => setSyncKeyId(null)} disabled={syncSubmitting} className="rounded-xl px-6 font-bold">
                取消
              </Button>
              <Button type="submit" isLoading={syncSubmitting} className="rounded-xl px-8 font-bold">
                开始同步
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={!!agentModalKey}
        onClose={() => !agentDeleting && setAgentModalKeyId(null)}
        title="清理上游 Agent"
        subtitle={agentModalKey ? `列出 ${agentModalKey.name} 在 Relevance 上可见的全部 agent。` : undefined}
        className="max-w-4xl"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-slate-50 px-4 py-2.5 rounded-xl border border-slate-100">
            <div className="text-xs font-bold text-slate-500">
              已选择 <span className="text-indigo-600">{selectedAgentIds.length}</span> / {agentInventory.length}
            </div>
            <div className="flex gap-2">
              <button className="text-[11px] font-black uppercase text-slate-400 hover:text-indigo-600 transition-colors" onClick={() => setSelectedAgentIds(agentInventory.map((item) => item.agent_id))} disabled={agentInventoryLoading || agentInventory.length === 0}>
                全选
              </button>
              <span className="text-slate-200">|</span>
              <button className="text-[11px] font-black uppercase text-slate-400 hover:text-red-500 transition-colors" onClick={() => setSelectedAgentIds([])} disabled={selectedAgentIds.length === 0}>
                清空
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            {agentInventoryLoading ? (
              <div className="px-6 py-12 text-center text-xs text-slate-400 font-bold flex flex-col items-center">
                <Loader2 className="h-6 w-6 animate-spin mb-2" />
                正在读取列表...
              </div>
            ) : agentInventory.length === 0 ? (
              <div className="px-6 py-12 text-center text-xs text-slate-400 font-medium italic">这个 Key 下暂时没有可见 agent。</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {pagedAgentInventory.map((item) => (
                  <label key={item.agent_id} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-slate-50/50 transition-colors">
                    <input
                      type="checkbox"
                      className="mt-1 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                      checked={selectedAgentIds.includes(item.agent_id)}
                      onChange={() =>
                        setSelectedAgentIds((prev) =>
                          prev.includes(item.agent_id)
                            ? prev.filter((value) => value !== item.agent_id)
                            : [...prev, item.agent_id]
                        )
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-bold text-slate-900 leading-none">{item.agent_name}</div>
                        <Badge status={item.managed_by_gateway ? 'healthy' : 'unknown'} label={item.managed_by_gateway ? 'managed' : 'unmanaged'} />
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-slate-400 font-medium italic truncate">{item.agent_id}</div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500 font-bold uppercase tracking-tight">
                        {item.display_name ? <span className="text-slate-800">{item.display_name}</span> : null}
                        {item.upstream_model ? <span className="font-mono text-indigo-600">{item.upstream_model}</span> : null}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
          <Pagination pagination={agentInventoryPagination.meta} onPageChange={setAgentInventoryPage} compact />

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAgentModalKeyId(null)} disabled={agentDeleting} className="rounded-xl px-6 font-bold">
              关闭
            </Button>
            <Button type="button" variant="danger" isLoading={agentDeleting} disabled={selectedAgentIds.length === 0} onClick={submitDeleteAgents} className="rounded-xl px-8 font-bold">
              删除选中的 Agent
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number; hint: string }> = ({ label, value, hint }) => (
  <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-200 transition-colors group">
    <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 group-hover:text-indigo-400 transition-colors">{label}</div>
    <div className="mt-1 text-2xl font-black leading-none text-slate-900">{value}</div>
    <div className="mt-1 text-[10px] text-slate-400 font-medium truncate">{hint}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({ label, children, className }) => (
  <label className={className}>
    <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    {children}
  </label>
);

const DetailRow: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | string[];
}> = ({ icon: Icon, label, value }) => {
  const values = Array.isArray(value) ? value : [value];
  return (
    <div className="flex items-start gap-3 text-xs">
      <div className="flex w-[100px] shrink-0 items-center gap-2 text-slate-400 font-bold uppercase tracking-tighter">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <div className="space-y-0.5 text-slate-800 font-bold">
        {values.map((item) => (
          <div key={item}>{item}</div>
        ))}
      </div>
    </div>
  );
};

const MiniSpecRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-start justify-between gap-3 text-xs">
    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <span className="text-right text-slate-700 font-bold">{value}</span>
  </div>
);

function providerMonogram(provider?: string) {
  const cleaned = String(provider || '?').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

function creditBandShortLabel(entry: ModelCatalogEntry) {
  const pricing = entry.credits?.[0];
  const input = Number(pricing?.credits_per_input_token || 0) * 1000;
  const output = Number(pricing?.credits_per_output_token || 0) * 1000;
  const combined = input + output;
  if (combined >= 8) return 'High Tier';
  if (combined >= 3) return 'Mid Tier';
  if (combined > 0) return 'Low Tier';
  return 'N/A';
}

function creditBandLabel(entry: ModelCatalogEntry) {
  const pricing = entry.credits?.[0];
  const input = Number(pricing?.credits_per_input_token || 0) * 1000;
  const output = Number(pricing?.credits_per_output_token || 0) * 1000;
  const combined = input + output;
  if (combined >= 8) return 'High credit consumption';
  if (combined >= 3) return 'Moderate credit consumption';
  if (combined > 0) return 'Low credit consumption';
  return 'Credit usage unavailable';
}

function creditBandClassName(entry: ModelCatalogEntry) {
  const label = creditBandLabel(entry);
  if (label.startsWith('High')) return 'bg-amber-100 text-amber-700';
  if (label.startsWith('Moderate')) return 'bg-sky-100 text-sky-700';
  if (label.startsWith('Low')) return 'bg-emerald-100 text-emerald-700';
  return 'bg-slate-100 text-slate-600';
}

function formatCreditUsage(entry: ModelCatalogEntry) {
  const pricing = entry.credits?.[0];
  if (!pricing) return '未提供';
  const input = formatCreditPer1k(pricing.credits_per_input_token);
  const output = formatCreditPer1k(pricing.credits_per_output_token);
  return `${input} input / ${output} output`;
}

function formatCreditUsageMultiline(entry: ModelCatalogEntry) {
  const pricing = entry.credits?.[0];
  if (!pricing) return ['未提供'];
  return [
    `${formatCreditPer1k(pricing.credits_per_input_token)} input tokens`,
    `${formatCreditPer1k(pricing.credits_per_output_token)} output tokens`,
  ];
}

function formatCreditPer1k(value?: number) {
  if (typeof value !== 'number') return '-';
  const amount = value * 1000;
  return `${trimTrailingZero(amount)} credits / 1k`;
}

function trimTrailingZero(value: number) {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatTokenValue(value?: number) {
  if (!value) return '未提供';
  return `${value.toLocaleString()} tokens`;
}

function formatInputFiles(entry: ModelCatalogEntry) {
  const files = entry.supported_input_media?.files || [];
  if (files.length === 0) return '未提供';
  return files.join(', ');
}

function thinkingSupportLabel(entry: ModelCatalogEntry) {
  const capability = entry.reasoning_capability;
  if (!capability) return 'Not specified';
  if (capability.supported_efforts?.length) return 'Supported';
  if (capability.supported_thinking_types?.length) return 'Supported';
  if (capability.type) return 'Supported';
  return 'Not specified';
}

function buildPagination(total: number, requestedPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    start,
    end,
    meta: {
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
    },
  };
}
