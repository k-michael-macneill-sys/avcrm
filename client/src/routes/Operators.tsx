import { Link } from 'react-router-dom';
import type { PublicUser } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Loading, ErrorNotice } from '@/components/Misc';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';

export function Operators(): JSX.Element {
  const { data: operators, loading, error } = useQuery(() => api.get<PublicUser[]>('/operators'), []);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!operators) return <Loading />;

  return (
    <>
      <PageHeader title="Crew" subtitle={`${operators.length} operators`} />
      <DataTable
        rowKey={(row) => row.id}
        rows={operators}
        emptyMessage="No operators in scope."
        columns={[
          {
            header: 'Name',
            cell: (row) => (
              <Link className="text-primary hover:underline" to={`/operators/${row.id}`}>
                {row.first_name} {row.last_name}
              </Link>
            ),
          },
          { header: 'Email', cell: (row) => row.email },
          { header: 'Phone', cell: (row) => row.phone ?? '—' },
          { header: 'Onboarding', cell: (row) => <StatusPill status={row.onboarding_status} /> },
          {
            header: 'Assignable',
            cell: (row) => (row.is_active && row.onboarding_status === 'approved' ? 'Yes' : 'No'),
          },
        ]}
      />
    </>
  );
}
