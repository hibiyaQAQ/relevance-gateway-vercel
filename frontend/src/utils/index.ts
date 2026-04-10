import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(isoString: string) {
  return new Date(isoString).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function formatDateTime(isoString?: string | null) {
  if (!isoString) return '未记录';
  return new Date(isoString).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function truncate(text: string, max = 120) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
