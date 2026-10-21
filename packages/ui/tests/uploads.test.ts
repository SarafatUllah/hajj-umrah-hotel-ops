import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'
import { formatBytes, uploadRefusal } from '../app/utils/uploads'

describe('uploads', () => {
  it('names why the API would refuse a file before it is sent: its type, then its size', () => {
    const types = ['image/png', 'image/jpeg']
    expect(uploadRefusal({ type: 'image/png', size: 1000 }, types)).toBeNull()
    expect(uploadRefusal({ type: 'text/plain', size: 10 }, types)).toBe('TYPE_NOT_ALLOWED')
    expect(uploadRefusal({ type: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 }, types)).toBe('FILE_TOO_LARGE')
    expect(uploadRefusal({ type: 'image/jpeg', size: 0 }, types)).toBe('EMPTY_FILE')
  })

  it('a size reads in bytes, KB or MB', () => {
    expect(formatBytes(512, 'en')).toBe('512 B')
    expect(formatBytes(2048, 'en')).toBe('2 KB')
    expect(formatBytes(3.5 * 1024 * 1024, 'en')).toBe('3.5 MB')
  })
})
