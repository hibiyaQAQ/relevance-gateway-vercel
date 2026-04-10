import React from 'react';
import { cn } from '../../utils';

export type BadgeStatus = 'healthy' | 'error' | 'unknown' | 'deploying' | 'active' | 'failed' | 'disabled';

interface BadgeProps {
  status: BadgeStatus;
  label?: string;
  dotOnly?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({ status, label, dotOnly }) => {
  const configs: Record<BadgeStatus, any> = {
    healthy: { bg: 'bg-green-500', text: 'text-green-600', light: 'bg-green-50', label: label || '正常' },
    active: { bg: 'bg-green-500', text: 'text-green-600', light: 'bg-green-50', label: label || '活跃' },
    error: { bg: 'bg-red-500', text: 'text-red-600', light: 'bg-red-50', label: label || '失效' },
    failed: { bg: 'bg-red-500', text: 'text-red-600', light: 'bg-red-50', label: label || '失败' },
    unknown: { bg: 'bg-slate-300', text: 'text-slate-400', light: 'bg-slate-50', label: label || '未知' },
    deploying: { bg: 'bg-amber-500', text: 'text-amber-600', light: 'bg-amber-50', label: label || '部署中' },
    disabled: { bg: 'bg-slate-200', text: 'text-slate-400', light: 'bg-slate-50', label: label || '已禁用' }
  };

  const config = configs[status] || configs.unknown;

  if (dotOnly) return (
    <div className={cn("h-2 w-2 rounded-full", config.bg)} />
  );

  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border", config.light, config.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", config.bg)} />
      {config.label}
    </span>
  );
};
