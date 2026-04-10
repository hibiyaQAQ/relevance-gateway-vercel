import React from 'react';
import { RequestLog } from '../types';
import { cn, formatTime } from '../utils';

export const ActivityLogs: React.FC<{ logs: RequestLog[], isMini?: boolean; loading?: boolean }> = ({ logs, isMini = false, loading = false }) => {
  const statusTone = (log: RequestLog) => {
    if (log.status === 'started' || log.status === 'streaming') {
      return 'bg-amber-50 text-amber-700';
    }
    if (log.status_code < 300) {
      return 'bg-green-50 text-green-600';
    }
    return 'bg-red-50 text-red-600';
  };

  return (
    <div className={cn("overflow-x-auto", isMini ? "" : "rounded-2xl border border-slate-200 bg-white")}>
      <table className="w-full text-left">
        <thead className="bg-slate-50/50 border-b border-slate-100">
          <tr>
            <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">时间</th>
            <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">请求</th>
            <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-slate-400">状态</th>
            <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400">延迟</th>
            {!isMini && <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400">Cost</th>}
            {!isMini && <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">API Key</th>}
            {!isMini && <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">诊断</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading && (
            <tr>
              <td colSpan={isMini ? 4 : 7} className="px-6 py-10 text-center text-sm text-slate-400">
                正在加载请求日志…
              </td>
            </tr>
          )}
          {!loading && logs.map(log => (
            <tr key={log.id} className="hover:bg-slate-50/30 transition-colors">
              <td className="px-4 py-3 text-xs font-medium text-slate-500">{formatTime(log.created_at)}</td>
              <td className="px-4 py-3">
                <div className="space-y-1">
                  <div className="text-xs font-bold text-slate-800">{log.model}</div>
                  <div className="text-[10px] font-mono text-slate-400">{log.request_id}</div>
                  {!isMini && (
                    <div className="text-[10px] text-slate-500">
                      {log.stream ? 'stream' : 'non-stream'}
                    </div>
                  )}
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col items-center gap-1">
                  <span className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-bold",
                    statusTone(log)
                  )}>{log.status_code}</span>
                  {!isMini && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{log.status}</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-right">
                <span className="text-xs font-mono text-slate-400">{log.latency_ms}ms</span>
              </td>
              {!isMini && (
                <td className="px-4 py-3 text-right">
                  <span className="text-xs font-mono text-slate-500">{log.cost != null ? log.cost.toFixed(2) : '-'}</span>
                </td>
              )}
              {!isMini && <td className="px-4 py-3 text-xs font-medium text-slate-500">{log.gateway_key_name}</td>}
              {!isMini && (
                <td className="px-4 py-3">
                  <div className="space-y-1 text-xs text-slate-500">
                    {log.error_message ? (
                      <div className="max-w-md break-words text-red-600">{log.error_message}</div>
                    ) : (
                      <div className="text-slate-400">无错误</div>
                    )}
                    {log.transport ? (
                      <div className="font-mono text-[10px] text-slate-400">transport {log.transport}</div>
                    ) : null}
                    {log.upstream_conversation_id ? (
                      <div className="font-mono text-[10px] text-slate-400">conv {log.upstream_conversation_id}</div>
                    ) : null}
                    <div className="font-mono text-[10px] text-slate-400">
                      in {log.prompt_tokens ?? 0} / out {log.completion_tokens ?? 0} / total {log.total_tokens ?? 0}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400">
                      first {log.first_token_ms ?? 0}ms / text {log.emitted_content_chars ?? 0} / think {log.emitted_thinking_chars ?? 0}
                    </div>
                    {log.credits_used?.length ? (
                      <div className="space-y-1">
                        {log.credits_used.slice(0, 2).map((item, index) => (
                          <div key={index} className="font-mono text-[10px] text-slate-400">
                            {item.model || item.name || 'usage'} · in {item.input_tokens ?? 0} / out {item.output_tokens ?? 0} / credits {item.credits ?? '-'}
                          </div>
                        ))}
                        {log.credits_used.length > 2 ? (
                          <div className="text-[10px] text-slate-400">还有 {log.credits_used.length - 2} 条 credits 明细</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </td>
              )}
            </tr>
          ))}
          {!loading && logs.length === 0 && (
            <tr>
              <td colSpan={isMini ? 4 : 7} className="px-6 py-10 text-center text-sm italic text-slate-400">暂无请求记录</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
