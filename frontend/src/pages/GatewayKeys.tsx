import React, { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { GatewayApiKey } from '../types';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Badge } from '../components/ui/Badge';
import { Pagination } from '../components/ui/Pagination';
import { cn, formatDateTime } from '../utils';

interface Props {
  keys: GatewayApiKey[];
  refreshVersion: number;
  onCreate: (payload: { name: string }) => Promise<string>;
  onDelete: (keyId: number) => Promise<void>;
}

export const GatewayKeys: React.FC<Props> = ({ keys, refreshVersion, onCreate, onDelete }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const pageSize = 12;
  const totalPages = Math.max(1, Math.ceil(keys.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const pagedKeys = keys.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  React.useEffect(() => {
    setPage(1);
  }, [refreshVersion]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const raw = await onCreate({ name: name.trim() });
      setNewRawKey(raw);
      setName('');
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-end justify-between gap-4 pt-2">
        <div>
          <h3 className="text-base font-black text-slate-800 tracking-tight uppercase">网关 API Keys</h3>
          <p className="mt-1 text-xs text-slate-500 font-medium">每把网关 Key 都可以调用当前所有已部署模型，适合个人环境直接发放使用。</p>
        </div>
        <Button onClick={() => setOpen(true)} size="sm" className="rounded-xl px-4 py-2 font-bold">
          <Plus className="h-4 w-4 mr-1" />
          签发网关 Key
        </Button>
      </div>

      {newRawKey && (
        <div className="rounded-[24px] border border-indigo-200 bg-indigo-50/50 px-5 py-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-500">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-black uppercase tracking-widest text-indigo-500">已成功签发新 Key</div>
              <div className="mt-1 text-sm text-slate-600 font-medium italic leading-relaxed">请务必妥善保存，离开或刷新页面后将无法再次查看明文：</div>
              <code className="mt-3 block break-all rounded-xl border border-indigo-100 bg-white px-4 py-3 font-mono text-sm text-indigo-700 shadow-sm">
                {newRawKey}
              </code>
            </div>
            <Button
              variant="secondary"
              className="mt-6 rounded-xl font-bold bg-white"
              onClick={async () => {
                await navigator.clipboard.writeText(newRawKey);
              }}
            >
              <Copy className="h-4 w-4 mr-1" />
              复制明文
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/50 border-b border-slate-100">
              <tr>
                <th className="px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">名称</th>
                <th className="px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">Key 预览 (明文)</th>
                <th className="px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">状态</th>
                <th className="px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">创建时间</th>
                <th className="px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">已部署模型</th>
                <th className="px-5 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedKeys.map((key) => (
                <tr key={key.id} className="align-middle hover:bg-slate-50/30 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="text-sm font-bold text-slate-900 leading-tight">{key.name}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <code className="block max-w-[280px] truncate rounded-lg bg-slate-50 border border-slate-100 px-2 py-1 font-mono text-[10px] text-slate-500">
                      {key.raw_key}
                    </code>
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge status={key.enabled ? 'active' : 'disabled'} label={key.enabled ? 'enabled' : 'disabled'} />
                  </td>
                  <td className="px-5 py-3.5 text-[11px] text-slate-500 font-medium italic">{formatDateTime(key.created_at)}</td>
                  <td className="px-5 py-3.5">
                    <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">AUTO SYNC</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8 rounded-lg text-[11px] font-bold"
                        onClick={async () => {
                          await navigator.clipboard.writeText(key.raw_key);
                        }}
                      >
                        复制
                      </Button>
                      <button
                        className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                        onClick={async () => {
                          if (!window.confirm(`确认删除网关 Key「${key.name}」？`)) return;
                          setDeletingId(key.id);
                          try {
                            await onDelete(key.id);
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-xs text-slate-400 font-bold uppercase tracking-widest italic">
                    NO GATEWAY KEYS ISSUED
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          pagination={{
            page: currentPage,
            page_size: pageSize,
            total: keys.length,
            total_pages: totalPages,
          }}
          onPageChange={setPage}
        />
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="签发网关 API Key"
        subtitle="生成的 Key 将拥有调用当前所有已部署模型的完整权限。"
      >
        <form className="space-y-5" onSubmit={submit}>
          <label className="block">
            <span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-slate-400">Key 备注名称</span>
            <input
              className="input h-11"
              placeholder="例如：Production / Developer-PC"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>

          <div className="rounded-[20px] border border-slate-100 bg-slate-50/50 px-5 py-4 text-xs text-slate-500 font-medium leading-relaxed">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">权限说明</div>
            该 Key 为全域权限，不需要手动配置模型。系统检测到新的模型部署后，该 Key 会自动获得调用权限。
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={submitting} className="rounded-xl px-6 font-bold">
              取消
            </Button>
            <Button type="submit" isLoading={submitting} className="rounded-xl px-8 font-bold">
              生成并签发
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
