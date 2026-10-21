/** What the page uses of Cloudflare Turnstile's browser API (rendered explicitly, one widget per form). */
export interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileOptions) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}
export interface TurnstileOptions {
  'sitekey': string
  'language'?: string
  'callback': (token: string) => void
  'expired-callback': () => void
  'error-callback': () => void
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=hajjTurnstileReady'

let loading: Promise<TurnstileApi> | null = null

/** Turnstile's script, loaded once in the browser (a failed load can be tried again). */
export function loadTurnstile(): Promise<TurnstileApi> {
  const host = window as unknown as { turnstile?: TurnstileApi, hajjTurnstileReady?: () => void }
  if (host.turnstile) return Promise.resolve(host.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    host.hajjTurnstileReady = () => resolve(host.turnstile!)
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onerror = () => {
      loading = null
      script.remove()
      reject(new Error('The bot check could not be loaded'))
    }
    document.head.appendChild(script)
  })
  return loading
}
