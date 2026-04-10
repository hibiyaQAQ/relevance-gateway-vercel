import React from 'react';
import { cn } from '../../utils';

interface CardProps {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Card: React.FC<CardProps> = ({ title, subtitle, action, children, className }) => {
  return (
    <div className={cn("bg-white border border-slate-200/80 rounded-2xl shadow-sm overflow-hidden", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/30 px-5 py-4">
          <div>
            {title && <h3 className="text-base font-bold text-slate-800">{title}</h3>}
            {subtitle && <p className="text-xs text-slate-500 mt-0.5 font-medium">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="p-0">{children}</div>
    </div>
  );
};
