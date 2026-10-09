import * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ListColumn<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
  /** Makes the column sortable. */
  sortValue?: (row: T) => string | number;
  /** What the search box matches; defaults to the sort value. */
  searchValue?: (row: T) => string;
  numeric?: boolean;
  className?: string;
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * A table with the controls a list of records needs: "Display N records", a
 * search box, sortable columns, pagination and "Showing X to Y of Z entries".
 * Everything happens in the browser, over the rows it is handed.
 */
export function ListTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'Nothing here yet.',
  initialSort,
  onRowClick,
  searchPlaceholder = 'Search…',
}: {
  columns: ListColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  initialSort?: { column: number; direction: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  searchPlaceholder?: string;
}): JSX.Element {
  const [pageSize, setPageSize] = React.useState(10);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState(initialSort ?? null);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) =>
      columns.some((column) => {
        const value = column.searchValue?.(row) ?? column.sortValue?.(row);
        return value !== undefined && String(value).toLowerCase().includes(term);
      }),
    );
  }, [rows, columns, search]);

  const sorted = React.useMemo(() => {
    const column = sort ? columns[sort.column] : undefined;
    if (!sort || !column?.sortValue) return filtered;
    const value = column.sortValue;
    return [...filtered].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.direction === 'asc' ? order : -order;
    });
  }, [filtered, columns, sort]);

  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  const visible = sorted.slice(start, start + pageSize);

  const toggleSort = (index: number): void => {
    setSort((s) =>
      s?.column === index ? { column: index, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { column: index, direction: 'asc' },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <label className="flex items-center gap-2">
          Display
          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              setPageSize(Number(v));
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[76px]" aria-label="Records per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          records
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={searchPlaceholder}
            aria-label="Search"
            className="h-8 w-48 pl-8"
          />
        </div>
      </div>

      {total === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{search ? 'No matching records.' : emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((column, index) => {
                  const active = sort?.column === index;
                  const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                  return (
                    <TableHead
                      key={column.header || index}
                      className={cn(column.numeric && 'text-right', column.className)}
                      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {column.sortValue ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort(index)}
                        >
                          {column.header}
                          <Icon className={cn('size-3', !active && 'opacity-40')} />
                        </button>
                      ) : (
                        column.header
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(onRowClick && 'cursor-pointer')}
                >
                  {columns.map((column, index) => (
                    <TableCell
                      key={column.header || index}
                      className={cn(column.numeric && 'text-right tabular-nums', column.className)}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Showing {total === 0 ? 0 : start + 1} to {Math.min(start + pageSize, total)} of {total} entries
          {search && total !== rows.length ? ` (filtered from ${rows.length})` : ''}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" /> Previous
          </Button>
          <span className="px-2 tabular-nums">
            {current} / {pages}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
            aria-label="Next page"
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
