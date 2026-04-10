import React from 'react';
import { cn } from '../../utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ 
  className, 
  variant = 'primary', 
  size = 'md', 
  isLoading,
  children,
  ...props 
}) => {
  const variants = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-indigo-100 active:scale-95",
    secondary: "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50",
    danger: "bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:bg-red-50",
    ghost: "text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
  };

  const sizes = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2.5 text-sm font-bold",
    lg: "px-6 py-3 text-base font-bold",
    icon: "p-2"
  };

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className
      )}
      disabled={isLoading || props.disabled}
      {...props}
    >
      {isLoading && <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />}
      {children}
    </button>
  );
};
