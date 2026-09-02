import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function offsetOf(pagination: Pagination): number {
  return (pagination.page - 1) * pagination.page_size;
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

export function paginated<T>(
  rows: T[],
  total: number,
  pagination: Pagination,
): Paginated<T> {
  return {
    data: rows,
    meta: {
      page: pagination.page,
      page_size: pagination.page_size,
      total,
      total_pages: total === 0 ? 0 : Math.ceil(total / pagination.page_size),
    },
  };
}
