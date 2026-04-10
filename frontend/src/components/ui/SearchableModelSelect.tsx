import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { ModelCatalogEntry } from '../../types';
import { cn } from '../../utils';

interface Props {
  options: ModelCatalogEntry[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const SearchableModelSelect: React.FC<Props> = ({
  options,
  value,
  onChange,
  placeholder = '搜索并选择模型',
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(
    () => options.find((item) => item.value === value) || null,
    [options, value]
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    const normalizedQueryCompact = normalized.replace(/\s+/g, '');
    const tokens = normalized.split(/\s+/).filter(Boolean);
    return options.filter((item) => {
      const haystack = [
        item.label,
        item.value,
        item.group_name,
        item.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const haystackCompact = haystack.replace(/\s+/g, '');
      return (
        haystack.includes(normalized) ||
        haystackCompact.includes(normalizedQueryCompact) ||
        tokens.every((token) => haystack.includes(token) || haystackCompact.includes(token))
      );
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const handleClickAway = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'input flex items-center justify-between text-left',
          disabled && 'cursor-not-allowed opacity-60',
          open && 'border-indigo-300 ring-4 ring-indigo-100'
        )}
      >
        <div className="min-w-0">
          {selected ? (
            <>
              <div className="truncate text-sm font-semibold text-slate-800">{selected.label}</div>
              <div className="truncate text-[11px] font-mono text-slate-400">{selected.value}</div>
            </>
          ) : (
            <span className="text-sm text-slate-400">{placeholder}</span>
          )}
        </div>
        <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/10">
          <div className="border-b border-slate-100 px-4 py-3">
            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入模型名、ID 或 provider"
                className="w-full border-0 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
              />
            </label>
          </div>

          <div className="max-h-[360px] overflow-y-auto p-2">
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-slate-400">没有匹配的模型</div>
            )}

            {filtered.map((item) => {
              const active = item.value === value;
              return (
                <button
                  type="button"
                  key={item.value}
                  className={cn(
                    'mb-1 w-full rounded-2xl border px-3 py-2.5 text-left transition-colors',
                    active
                      ? 'border-indigo-200 bg-indigo-50'
                      : 'border-transparent hover:border-slate-200 hover:bg-slate-50'
                  )}
                  onClick={() => {
                    onChange(item.value);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white">
                      {active && <Check className="h-3.5 w-3.5 text-indigo-600" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-semibold text-slate-800">{item.label}</div>
                        {item.group_name && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                            {item.group_name}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-slate-400">{item.value}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                        {item.context_window ? <span>上下文 {item.context_window.toLocaleString()}</span> : null}
                        {item.max_output_tokens ? <span>输出 {item.max_output_tokens.toLocaleString()}</span> : null}
                      </div>
                      {item.description && (
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{item.description}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
