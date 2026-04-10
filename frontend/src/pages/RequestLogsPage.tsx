import React, { useEffect, useState } from 'react';
import { adminApi } from '../api';
import { PaginationMeta, RequestLog } from '../types';
import { ActivityLogs } from './ActivityLogs';
import { Pagination } from '../components/ui/Pagination';

interface Props {
  refreshVersion: number;
}

const emptyPagination: PaginationMeta = {
  page: 1,
  page_size: 20,
  total: 0,
  total_pages: 1,
};

export const RequestLogsPage: React.FC<Props> = ({ refreshVersion }) => {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>(emptyPagination);
  const [loading, setLoading] = useState(true);

  const loadPage = async (page: number) => {
    setLoading(true);
    try {
      const result = await adminApi.listRequestLogs(page, pagination.page_size || 20);
      setLogs(result.items);
      setPagination(result.pagination);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshVersion]);

  return (
    <div className="space-y-4">
      <ActivityLogs logs={logs} loading={loading} />
      <div className="rounded-2xl border border-slate-200 bg-white">
        <Pagination pagination={pagination} onPageChange={(page) => void loadPage(page)} />
      </div>
    </div>
  );
};
