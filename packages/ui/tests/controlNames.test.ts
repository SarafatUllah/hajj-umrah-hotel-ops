// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renameLabelledControls } from '../app/utils/controlNames'

describe('the names of labelled controls after a language switch', () => {
  it('take the label text again, and leave controls named on purpose alone', () => {
    // Arrange: named once in English; the labels now read in Arabic
    document.body.innerHTML = `
      <button id="a" role="checkbox" aria-label="Select all 5 matching"></button><label for="a">حدد كل المطابقة (5)</label>
      <button id="b:X" role="radio" aria-label="Set exact numbers"></button><label for="b:X">حدد أرقامًا دقيقة</label>
      <button id="c" role="switch" aria-label="A whole floor"></button><label for="c">طابق كامل</label>
      <button id="d" role="checkbox" aria-label="حدد الغرفة 101"></button>`

    // Act
    renameLabelledControls(document)

    // Assert
    const name = (id: string) => document.getElementById(id)!.getAttribute('aria-label')
    expect([name('a'), name('b:X'), name('c'), name('d')]).toEqual(['حدد كل المطابقة (5)', 'حدد أرقامًا دقيقة', 'طابق كامل', 'حدد الغرفة 101'])
  })
})
