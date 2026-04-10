import React, { useMemo } from 'react';
import {
  Activity,
  ArrowUpRight,
  Clock3,
  Database,
  LineChart as LineChartIcon,
  Send,
  ServerCog,
  TrendingUp,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BootstrapData, RequestLog } from '../types';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { ActivityLogs } from './ActivityLogs';
import { cn, formatTime } from '../utils';

export const Dashboard: React.FC<{ data: BootstrapData }> = ({ data }) => {
  const avgLatency = data.request_logs.length
    ? Math.round(data.request_logs.reduce((acc, log) => acc + log.latency_ms, 0) / data.request_logs.length)
    : 0;

  const totalTokens = useMemo(
    () => data.request_logs.reduce((acc, log) => acc + (log.total_tokens || 0), 0),
    [data.request_logs]
  );

  const requestTrend = useMemo(() => aggregateTrend(data.request_logs, 'count'), [data.request_logs]);
  const tokenTrend = useMemo(() => aggregateTrend(data.request_logs, 'tokens'), [data.request_logs]);

  return (
    <div className="space-y-4 pb-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Send} color="bg-indigo-50 text-indigo-600" label="请求总数" value={data.request_logs.length.toString()} trend="最近 50 条" />
        <StatCard icon={Clock3} color="bg-sky-50 text-sky-600" label="平均延迟" value={`${avgLatency}ms`} trend="按最近请求计算" />
        <StatCard icon={Database} color="bg-emerald-50 text-emerald-600" label="上游 Key" value={data.upstream_keys.length.toString()} trend={`${data.upstream_keys.filter((key) => key.enabled).length} 个启用`} />
        <StatCard icon={ServerCog} color="bg-amber-50 text-amber-600" label="累计 Token" value={totalTokens.toLocaleString()} trend="最近请求总量" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TrendCard
          title="调用趋势"
          subtitle="按最近请求分桶，观察调用密度变化"
          icon={LineChartIcon}
          color="#4f46e5"
          data={requestTrend}
          valueFormatter={(value) => `${value} 次`}
        />
        <TrendCard
          title="Token 趋势"
          subtitle="按最近请求分桶，观察 token 消耗变化"
          icon={Activity}
          color="#0ea5e9"
          data={tokenTrend}
          valueFormatter={(value) => `${value.toLocaleString()} tok`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="rounded-[24px] border border-slate-200 bg-white overflow-hidden shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 bg-slate-50/30">
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">最近请求日志</h3>
              <p className="mt-0.5 text-[10px] text-slate-400 font-bold uppercase tracking-widest">REAL-TIME ACTIVITY FEED</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-400">
              <Activity className="h-4 w-4" />
            </div>
          </div>
          <ActivityLogs logs={data.request_logs} isMini />
        </div>

        <div className="space-y-4">
          <div className="rounded-[24px] border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 bg-slate-50/30">
              <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Key 运行状态</h3>
              <TrendingUp className="h-3.5 w-3.5 text-slate-300" />
            </div>
            <div className="divide-y divide-slate-50 px-5 py-2">
              {data.upstream_keys.slice(0, 5).map((key) => (
                <div key={key.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800 leading-none">{key.name}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <p className="text-[10px] font-mono text-slate-400 font-medium">{key.project}</p>
                      <span className="h-1 w-1 rounded-full bg-slate-200" />
                      <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">{key.deployments.length} Models</p>
                    </div>
                  </div>
                  <Badge
                    status={
                      key.status === 'active'
                        ? 'healthy'
                        : key.status === 'invalid'
                          ? 'error'
                          : 'unknown'
                    }
                    dotOnly
                  />
                </div>
              ))}
              {data.upstream_keys.length === 0 && (
                <div className="py-8 text-center text-xs text-slate-400 font-bold italic">
                  NO UPSTREAM KEYS FOUND
                </div>
              )}
            </div>
          </div>

          <div className="relative overflow-hidden rounded-[24px] border border-indigo-200 bg-gradient-to-br from-indigo-600 to-violet-700 p-5 shadow-lg shadow-indigo-100">
            <div className="absolute -right-4 -top-4 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
            <div className="relative">
              <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-white backdrop-blur-md">
                <ArrowUpRight className="h-3 w-3" />
                Quick Start
              </div>
              <h4 className="text-lg font-black text-white leading-tight">快速部署指南</h4>
              <ul className="mt-4 space-y-2.5 text-[13px] font-bold text-indigo-50/80 leading-snug">
                <li className="flex items-start gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-white/20 text-[10px] text-white">1</span>
                  <span>添加并验证上游 Key 连通性</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-white/20 text-[10px] text-white">2</span>
                  <span>在模型管理中部署需要的官方模型</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-white/20 text-[10px] text-white">3</span>
                  <span>生成网关 API Key 即可开始使用</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="rounded-[24px] border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 bg-slate-50/30">
              <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-widest">请求健康概览</h3>
              <Activity className="h-3.5 w-3.5 text-slate-300" />
            </div>
            <div className="grid grid-cols-3 gap-2 px-4 py-4">
              {[
                { label: 'COMPLETED', value: data.request_logs.filter((item) => item.status === 'completed').length, tone: 'text-emerald-600', bg: 'bg-emerald-50' },
                { label: 'STREAMING', value: data.request_logs.filter((item) => item.status === 'streaming').length, tone: 'text-amber-600', bg: 'bg-amber-50' },
                { label: 'FAILED', value: data.request_logs.filter((item) => item.status === 'failed').length, tone: 'text-red-600', bg: 'bg-red-50' },
              ].map((item) => (
                <div key={item.label} className={cn('flex flex-col items-center justify-center rounded-2xl p-3 border border-transparent hover:border-slate-100 transition-all', item.bg)}>
                  <span className={cn('text-[9px] font-black tracking-widest mb-1', item.tone)}>{item.label}</span>
                  <span className={cn('text-xl font-black leading-none', item.tone)}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function StatCard({ icon: Icon, color, label, value, trend }: any) {
  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm transition-all hover:border-indigo-200 group">
      <div className="mb-3 flex items-center justify-between">
        <div className={cn('rounded-xl p-2 transition-transform group-hover:scale-110 duration-300', color)}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <span className="rounded-full bg-slate-50 border border-slate-100 px-2 py-0.5 text-[9px] font-black text-slate-400 uppercase tracking-tight">{trend}</span>
      </div>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <h3 className="mt-1 text-2xl font-black leading-none text-slate-900">{value}</h3>
    </div>
  );
}

const TrendCard: React.FC<{
  title: string;
  subtitle: string;
  icon: React.ComponentType<any>;
  color: string;
  data: TrendPoint[];
  valueFormatter: (value: number) => string;
}> = ({ title, subtitle, icon: Icon, color, data, valueFormatter }) => {
  const latest = data[data.length - 1];
  const previous = data[Math.max(0, data.length - 2)];
  const delta = (latest?.value || 0) - (previous?.value || 0);
  const positive = delta >= 0;
  const gradientId = `trend-fill-${title.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm hover:border-slate-300 transition-colors">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/20 px-5 py-3.5">
        <div>
          <h3 className="text-[11px] font-black text-slate-800 uppercase tracking-widest">{title}</h3>
          <p className="mt-0.5 text-[9px] text-slate-400 font-bold uppercase tracking-tight">{subtitle}</p>
        </div>
        <div className="rounded-xl bg-slate-50 border border-slate-100 p-2" style={{ color }}>
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">最新分桶数据</div>
            <div className="mt-1 text-2xl font-black text-slate-900 leading-none">{valueFormatter(latest?.value || 0)}</div>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-tight" style={{ backgroundColor: `${color}10`, color }}>
            <span>{positive ? '↑' : '↓'}</span>
            <span>{valueFormatter(Math.abs(delta))}</span>
          </div>
        </div>

        <div className="rounded-[20px] border border-slate-100 bg-slate-50/30 p-2">
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.15} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#f1f5f9" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#94a3b8', fontSize: 9, fontWeight: 700 }}
                  dy={8}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#94a3b8', fontSize: 9, fontWeight: 700 }}
                  width={40}
                  tickFormatter={(value) => shortNumber(value)}
                />
                <Tooltip
                  cursor={{ stroke: color, strokeOpacity: 0.1, strokeWidth: 1 }}
                  contentStyle={{
                    borderRadius: 12,
                    border: '1px solid #f1f5f9',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.05)',
                    padding: '8px 10px',
                    fontSize: 11,
                  }}
                  labelStyle={{ color: '#64748b', fontWeight: 800, marginBottom: 4, textTransform: 'uppercase' }}
                  formatter={(value: number) => [valueFormatter(value), title]}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2.5}
                  fill={`url(#${gradientId})`}
                  dot={{ r: 0 }}
                  activeDot={{ r: 4, strokeWidth: 2, fill: '#ffffff', stroke: color }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

type TrendPoint = {
  label: string;
  value: number;
};

function aggregateTrend(logs: RequestLog[], mode: 'count' | 'tokens'): TrendPoint[] {
  const source = logs.slice().reverse();
  if (source.length === 0) {
    return Array.from({ length: 6 }, (_, index) => ({ label: `#${index + 1}`, value: 0 }));
  }

  const bucketCount = 8;
  const bucketSize = Math.ceil(source.length / bucketCount);
  const points: TrendPoint[] = [];

  for (let index = 0; index < source.length; index += bucketSize) {
    const chunk = source.slice(index, index + bucketSize);
    const last = chunk[chunk.length - 1];
    points.push({
      label: formatTime(last.created_at),
      value:
        mode === 'count'
          ? chunk.length
          : chunk.reduce((acc, item) => acc + (item.total_tokens || 0), 0),
    });
  }

  return points;
}

function shortNumber(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
}
