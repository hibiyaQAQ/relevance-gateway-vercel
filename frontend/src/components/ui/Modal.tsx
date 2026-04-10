import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../utils';

interface ModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  bodyScrollable?: boolean;
  align?: 'center' | 'top';
}

export const Modal: React.FC<ModalProps> = ({
  open,
  title,
  subtitle,
  onClose,
  children,
  className,
  bodyClassName,
  bodyScrollable = true,
  align = 'center',
}) => {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col items-center">
      <button
        className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="关闭弹窗"
      />
      <div
        className={cn(
          'relative flex min-h-full w-full justify-center overflow-y-auto p-4 md:p-6',
          align === 'top' ? 'items-start pt-12 md:pt-16' : 'items-center'
        )}
      >
        <div
          className={cn(
            'relative z-10 flex w-full max-w-2xl max-h-[calc(100vh-3rem)] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/10',
            className
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div>
              <h3 className="text-lg font-black text-slate-900 leading-tight">{title}</h3>
              {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col px-5 py-5',
              bodyScrollable ? 'overflow-y-auto' : 'overflow-hidden',
              bodyClassName
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
