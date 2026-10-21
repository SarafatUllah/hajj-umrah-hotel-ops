import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import type { StaySearchResult } from '@hajj/contracts/types/booking'
import { ApiError } from '../app/utils/apiError'
import { useStayOptions } from '../app/composables/useStayOptions'

const option = { rooms: [], newRooms: 1, emptySeats: 0, extraBeds: 0, totalHalalas: 100, priceSource: 'AGENCY' } as unknown as StaySearchResult['options'][number]
const found = { options: [option, { ...option, totalHalalas: 200 }], quotaHeadroom: null } as unknown as StaySearchResult

describe('the options of a stay search', () => {
  it('holds the result and the chosen option; asking something else forgets both', async () => {
    const asked = ref({ totalCount: 2 })
    const options = useStayOptions(asked)
    options.found(found)
    options.chosen.value = 1
    expect(options.option.value).toMatchObject({ totalHalalas: 200 })

    asked.value = { totalCount: 3 }
    await nextTick()
    expect(options.result.value).toBeNull()
    expect(options.chosen.value).toBeNull()
    expect(options.option.value).toBeUndefined()
  })

  it('an answer to an earlier question (the form changed while it was asked) is dropped', async () => {
    const asked = ref({ totalCount: 2 })
    const options = useStayOptions(asked)
    const question = options.question()
    asked.value = { totalCount: 3 }
    await nextTick()
    options.found(found, null, question)
    expect(options.result.value).toBeNull()
    options.found(found, null, options.question())
    expect(options.result.value).toEqual(found)
  })

  it('a conflict when acting on the option (the rooms went meanwhile) forgets it; any other failure keeps it', () => {
    const options = useStayOptions(ref(0))
    options.found(found, 0)
    options.failed(new ApiError(422, 'VALIDATION_FAILED', 'x'))
    expect(options.option.value).toEqual(option)
    options.failed(new ApiError(409, 'OPTION_UNAVAILABLE', 'x'))
    expect(options.result.value).toBeNull()
  })
})
