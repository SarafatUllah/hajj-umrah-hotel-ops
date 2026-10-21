import { describe, expect, it } from 'vitest'
import { toHalalas, toRiyals } from '@hajj/contracts/utils/money'

describe('money in riyals and halalas', () => {
  it('riyals become whole halalas, rounded to the nearest one, and back', () => {
    expect([toHalalas(350), toHalalas(350.5), toHalalas(0.015), toHalalas(12.345)]).toEqual([35000, 35050, 2, 1235])
    expect([toRiyals(35000), toRiyals(35050), toRiyals(1)]).toEqual([350, 350.5, 0.01])
  })
})
