import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  User,
  Zap,
} from 'lucide-react';
import { TabType } from '../types';
import { cn } from '../utils';

interface Props {
  isRefreshing: boolean;
  onRefresh: () => void;
  onLogout: () => void;
  children: React.ReactNode;
}

const tabMeta: Record<string, { label: string; icon: any; path: string }> = {
  dashboard: { label: '控制面板', icon: LayoutDashboard, path: '/dashboard' },
  upstream: { label: '上游 Key 管理', icon: KeyRound, path: '/upstream' },
  gateway: { label: '网关 API Keys', icon: ShieldCheck, path: '/gateway' },
  logs: { label: '请求日志', icon: Activity, path: '/logs' },
};

export const AdminLayout: React.FC<Props> = ({
  isRefreshing,
  onRefresh,
  onLogout,
  children,
}) => {
  const location = useLocation();
  const currentTab = Object.keys(tabMeta).find(key => location.pathname.startsWith(tabMeta[key].path)) || 'dashboard';

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="flex w-64 flex-col border-r border-slate-200 bg-white shadow-[1px_0_0_0_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-emerald-600 shadow-lg shadow-emerald-200">
            <Zap className="h-4.5 w-4.5 fill-current text-white" />
          </div>
          <div>
            <div className="text-base font-black tracking-tight text-slate-900 leading-none">RGW Lab</div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold">Admin Console</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 mt-2">
          {Object.entries(tabMeta).map(([key, meta]) => {
            const Icon = meta.icon;
            return (
              <NavLink
                key={key}
                to={meta.path}
                className={({ isActive }) => cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-all duration-200',
                  isActive
                    ? 'bg-emerald-50 text-emerald-700 shadow-sm shadow-emerald-100/50'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                )}
              >
                {({ isActive }) => (
                  <>
                    <Icon className={cn('h-[18px] w-[18px]', isActive ? 'text-emerald-700' : 'text-slate-400')} />
                    <span>{meta.label}</span>
                    {isActive && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-600" />}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-100 bg-slate-50/50 p-4">
          <div className="flex items-center gap-3 rounded-2xl px-2 py-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200">
              <User className="h-4 w-4 text-slate-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-slate-900">Administrator</p>
              <p className="truncate text-[10px] text-slate-400 font-medium">admin@rgw.lab</p>
            </div>
            <button onClick={onLogout} title="退出登录" className="text-slate-400 transition-colors hover:text-red-500 p-1.5">
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/80 px-6 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <h2 className="text-base font-bold text-slate-800">{tabMeta[currentTab]?.label || 'RGW Lab'}</h2>
            {isRefreshing && <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />}
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50/50 px-3 py-1 text-[10px] font-bold text-emerald-700 sm:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Connected
            </div>
            <button onClick={onRefresh} className="p-1.5 text-slate-400 transition-colors hover:text-emerald-600">
              <RefreshCw className={cn('h-4.5 w-4.5', isRefreshing && 'animate-spin')} />
            </button>
          </div>
        </header>

        <div className="w-full animate-in fade-in px-6 py-5 duration-500 xl:px-8 xl:py-6">{children}</div>
      </main>
    </div>
  );
};
