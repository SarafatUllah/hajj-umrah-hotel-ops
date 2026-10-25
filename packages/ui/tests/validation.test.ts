import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validateWith } from '../app/utils/validation'

const schema = z.object({ name: z.string().min(1), age: z.number().int().min(18), when: z.string().refine(v => /^\d{4}-\d{2}-\d{2}$/.test(v), 'bad date') }).strict()

describe('validateWith (§17: shared schemas, localized messages)', () => {
  it('maps each issue to its field and a localized key, never the schema\'s own text', () => {
    const errors = validateWith(schema, key => `t:${key}`)({ name: '', age: 12, when: 'soon' })
    expect(errors).toEqual([
      { name: 'name', message: 't:validation.required' },
      { name: 'age', message: 't:validation.tooSmall' },
      { name: 'when', message: 't:validation.invalid' },
    ])
  })

  it('an empty value is "required", whatever rule caught it (a refine or a custom check included)', () => {
    const lead = z.object({ name: z.string().refine(v => v.length >= 2), passport: z.string().optional() }).superRefine((body, ctx) => {
      if (!body.passport) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passport'], message: 'Required for the lead' })
    })
    expect(validateWith(lead, key => key)({ name: '', passport: undefined })).toEqual([
      { name: 'name', message: 'validation.required' },
      { name: 'passport', message: 'validation.required' },
    ])
    expect(validateWith(lead, key => key)({ name: 'X', passport: 'P1' })).toEqual([{ name: 'name', message: 'validation.invalid' }])
  })

  it('validates the request the form becomes', () => {
    const toRequest = (state: { name: string }) => ({ name: state.name.trim(), age: 30, when: '2027-06-01' })
    expect(validateWith(schema, key => key, toRequest)({ name: 'Yusuf' })).toEqual([])
    expect(validateWith(schema, key => key, toRequest)({ name: '' })).toEqual([{ name: 'name', message: 'validation.required' }])
  })
})
