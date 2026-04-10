import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PaginationMeta } from '../../types';
import { Button } from './Button';

interface Props {
  pagination: PaginationMeta;
  onPageChange: (page: number) => void;
  compact?: boolean;
}

export const Pagination: React.FC<Props> = ({ pagination, onPageChange, compact = false }) => {
  if (pagination.total_pages <= 1) return null;

  return (
    <div className={`flex items-center justify-between gap-3 ${compact ? 'pt-3' : 'border-t border-slate-100 px-4 py-4'}`}>
      <div className="text-xs text-slate-500">
        第 <span className="font-semibold text-slate-800">{pagination.page}</span> / {pagination.total_pages} 页
        <span className="ml-2">共 {pagination.total} 条</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
          上一页
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pagination.page >= pagination.total_pages}
          onClick={() => onPageChange(pagination.page + 1)}
        >
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};
