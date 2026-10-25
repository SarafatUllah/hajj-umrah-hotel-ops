/** One page of a list as every list endpoint answers (`page` from 1, at most `pageSize` items, `total` across all pages). */
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
