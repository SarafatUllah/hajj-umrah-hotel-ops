import { describe, expect, it } from 'vitest'
import { pageNumber } from '../app/composables/useUrlQuery'

describe("a list's page in the URL", () => {
  it('is a whole number from 1; anything else is the first page', () => {
    expect([pageNumber('3'), pageNumber('2.7'), pageNumber(undefined)]).toEqual([3, 2, 1])
    expect([pageNumber('0'), pageNumber('-4'), pageNumber('abc'), pageNumber('')]).toEqual([1, 1, 1, 1])
  })
})
