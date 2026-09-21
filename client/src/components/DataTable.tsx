import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface Column<T> {
  header: string;
  numeric?: boolean;
  cell: (row: T) => React.ReactNode;
}

/**
 * A table, or a sentence explaining why there isn't one. An empty state that
 * says nothing is the most common way a dashboard lies about having no data.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'Nothing here yet.',
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
}): JSX.Element {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((column) => (
            <TableHead key={column.header} className={column.numeric ? 'text-right' : undefined}>
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(onRowClick && 'cursor-pointer')}
          >
            {columns.map((column) => (
              <TableCell
                key={column.header}
                className={cn(column.numeric && 'text-right tabular-nums')}
              >
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
