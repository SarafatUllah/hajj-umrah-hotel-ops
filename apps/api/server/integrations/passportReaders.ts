import Anthropic from '@anthropic-ai/sdk'
import type { PassportScanFields as ScanFields } from '@hajj/contracts/constants/pilgrimData'
import { isValidIsoDate } from '@hajj/contracts/utils/dates'
import { getEnv } from '../utils/env'

/** A passport image as stored (decrypted in memory only for the reading). */
export interface PassportImage { bytes: Buffer, mimeType: 'image/png' | 'image/jpeg' }

/** On-server OCR: the image's text, from which the MRZ lines are taken. */
export interface PassportOcr { readText(image: PassportImage): Promise<string> }

/** The external vision fallback: the data page's fields, or null when it cannot read them. Never throws. */
export interface PassportVision {
  /** Larger images are not sent (the service refuses them). */
  readonly maxImageBytes: number
  readFields(image: PassportImage): Promise<ScanFields | null>
}

export interface PassportReaders { ocr: PassportOcr | null, vision: PassportVision | null }

/** The MRZ alphabet: reading only these characters makes the OCR far more reliable on the two MRZ lines. */
const MRZ_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'
/** One image's OCR is abandoned (the worker terminated) after this long: a hostile image cannot hold the worker. */
const OCR_TIMEOUT_MS = 60_000

interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>
  recognize(image: Buffer): Promise<{ data: { text: string } }>
  terminate(): Promise<unknown>
}

/**
 * `PASSPORT_OCR=tesseract`: tesseract.js in the worker process (CPU-heavy, never in the API). The package is
 * installed in the worker image only, so it is loaded by name at run time.
 */
function tesseractOcr(): PassportOcr {
  return {
    async readText(image) {
      const moduleName = 'tesseract.js'
      const tesseract = await import(/* @vite-ignore */ moduleName) as { createWorker(lang: string): Promise<TesseractWorker> }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OCR timed out')), OCR_TIMEOUT_MS) })
      const starting = tesseract.createWorker('eng')
      try {
        const worker = await Promise.race([starting, timeout])
        try {
          await Promise.race([worker.setParameters({ tessedit_char_whitelist: MRZ_CHARACTERS }), timeout])
          return (await Promise.race([worker.recognize(image.bytes), timeout])).data.text
        }
        finally {
          await worker.terminate()
        }
      }
      catch (error) {
        // A worker that started after the timeout is still terminated.
        void starting.then(worker => worker.terminate()).catch(() => {})
        throw error
      }
      finally {
        clearTimeout(timer)
      }
    },
  }
}

const FIELD_NAMES = ['fullName', 'gender', 'nationality', 'dateOfBirth', 'passportNo', 'passportExpiry', 'placeOfBirth', 'passportIssueDate', 'issuingAuthority', 'address'] as const

/** Every field a string; an empty string when it cannot be read with certainty (never a guess). */
const PASSPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...FIELD_NAMES],
  properties: {
    fullName: { type: 'string', description: 'Full name in Latin letters exactly as printed (given names then surname)' },
    gender: { type: 'string', enum: ['MALE', 'FEMALE', ''] },
    nationality: { type: 'string', description: 'Three-letter ICAO nationality code from the passport, e.g. BGD' },
    dateOfBirth: { type: 'string', description: 'YYYY-MM-DD' },
    passportNo: { type: 'string', description: 'Passport number, letters and digits only' },
    passportExpiry: { type: 'string', description: 'Date of expiry, YYYY-MM-DD' },
    placeOfBirth: { type: 'string' },
    passportIssueDate: { type: 'string', description: 'Date of issue, YYYY-MM-DD' },
    issuingAuthority: { type: 'string' },
    address: { type: 'string', description: 'Only if printed on the data page' },
  },
}

const PROMPT = [
  'The image is the data page of a passport. Read the printed fields and the machine-readable zone at the bottom.',
  'Return each field exactly as the passport shows it: dates as YYYY-MM-DD, the nationality as the three-letter code, the gender as MALE or FEMALE, the passport number without spaces.',
  'Use an empty string for any field you cannot read with certainty. Do not guess, and do not use anything but the image.',
].join(' ')

/** The vision service's own limit per image. */
const VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** A passport name in Latin letters (the data page's own transliteration); anything else is left for the reviewer. */
const LATIN_NAME = /^[A-Za-z][A-Za-z .'-]*$/

/**
 * The model's answer, kept only where it has the expected shape. The answer is untrusted (the image may carry text
 * meant for the model): dates must be real calendar dates, names Latin letters; the reviewer confirms all of it.
 */
export function visionAnswerFields(raw: Record<string, unknown>): ScanFields {
  const text = (key: string, max: number) => {
    const field = raw[key]
    const value = typeof field === 'string' ? field.trim() : ''
    return value && value.length <= max ? value : undefined
  }
  const date = (key: string) => { const v = text(key, 10); return v && isValidIsoDate(v) ? v : undefined }
  const fullName = text('fullName', 120)
  const gender = text('gender', 6)
  const nationality = text('nationality', 3)?.toUpperCase()
  const passportNo = text('passportNo', 20)?.replace(/[\s-]/g, '').toUpperCase()
  const fields: ScanFields = {
    fullName: fullName && LATIN_NAME.test(fullName) ? fullName : undefined,
    gender: gender === 'MALE' || gender === 'FEMALE' ? gender : undefined,
    nationality: nationality && /^[A-Z]{3}$/.test(nationality) ? nationality : undefined,
    dateOfBirth: date('dateOfBirth'),
    passportNo: passportNo && /^[A-Z0-9]{5,20}$/.test(passportNo) ? passportNo : undefined,
    passportExpiry: date('passportExpiry'),
    placeOfBirth: text('placeOfBirth', 120),
    passportIssueDate: date('passportIssueDate'),
    issuingAuthority: text('issuingAuthority', 120),
    address: text('address', 300),
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as ScanFields
}

/**
 * `PASSPORT_AI=anthropic`: Claude vision as the fallback when the MRZ cannot be read (v7 §13). Structured output
 * fixes the answer's shape; server-side fallbacks re-run a declined request on another model. Any failure — API
 * error, refusal, unusable answer — is logged without content and returns null (the scan goes to manual review).
 */
function claudeVision(apiKey: string, model: string): PassportVision {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 })
  return {
    maxImageBytes: VISION_MAX_IMAGE_BYTES,
    async readFields(image) {
      try {
        const response = await client.beta.messages.create({
          model,
          max_tokens: 2000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // Reading a page is simple work: low effort keeps it quick and cheap.
          output_config: { effort: 'low', format: { type: 'json_schema', schema: PASSPORT_SCHEMA } },
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.bytes.toString('base64') } },
              { type: 'text', text: PROMPT },
            ],
          }],
        })
        if (response.stop_reason === 'refusal') {
          console.error('[passport] vision reading declined:', response.stop_details?.category ?? 'unknown')
          return null
        }
        const answer = response.content.find(block => block.type === 'text')
        return answer?.type === 'text' ? visionAnswerFields(JSON.parse(answer.text) as Record<string, unknown>) : null
      }
      catch (error) {
        if (error instanceof Anthropic.APIError) console.error(`[passport] vision reading failed: ${error.status ?? 'network'} ${error.name}`)
        else console.error('[passport] vision reading failed:', error instanceof Error ? error.name : 'unknown')
        return null
      }
    },
  }
}

let override: PassportReaders | null = null
let configured: PassportReaders | null = null

/** The readers this process uses, from PASSPORT_OCR / PASSPORT_AI (both off by default: manual review). */
export function getPassportReaders(): PassportReaders {
  if (override) return override
  if (!configured) {
    const env = getEnv()
    configured = {
      ocr: env.PASSPORT_OCR === 'tesseract' ? tesseractOcr() : null,
      vision: env.PASSPORT_AI === 'anthropic' && env.ANTHROPIC_API_KEY ? claudeVision(env.ANTHROPIC_API_KEY, env.PASSPORT_AI_MODEL) : null,
    }
  }
  return configured
}

/** Test hook: fixed readers (null = back to the configured ones). */
export function setPassportReadersForTests(readers: PassportReaders | null): void {
  override = readers
}
