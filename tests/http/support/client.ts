export interface ApiRequestInit {
  method?: string
  body?: unknown
  cookie?: string
}

export interface ApiResponse {
  status: number
  // The Task 8 brief's verified interface types this `any` (the response body shape varies per
  // route — tests assert on specific fields after the fact); a real JSON type would just be
  // re-narrowed with `as` at every call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  setCookie: string[]
}

export interface LoginResult {
  cookie: string
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ApiResponse.json above.
  json: any
}

/**
 * A genuinely black-box HTTP client: plain `fetch` against the built server's base URL, no
 * knowledge of h3/Nitro internals. `request()`/`login()` match the interface verified in the Task 8
 * brief exactly.
 */
export function apiClient(baseUrl: string): {
  request: (path: string, init?: ApiRequestInit) => Promise<ApiResponse>
  login: (orgSlug: string, email: string, password: string) => Promise<LoginResult>
} {
  async function request(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.cookie) headers.cookie = init.cookie

    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'manual',
    })

    const setCookie = res.headers.getSetCookie()
    const text = await res.text()
    let json: unknown = null
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      }
      catch {
        json = text
      }
    }

    return { status: res.status, json, setCookie }
  }

  async function login(orgSlug: string, email: string, password: string): Promise<LoginResult> {
    const res = await request('/api/auth/login', {
      method: 'POST',
      body: { organizationSlug: orgSlug, email, password },
    })
    return { cookie: cookieHeaderFromSetCookie(res.setCookie), status: res.status, json: res.json }
  }

  return { request, login }
}

/** Turns one or more `Set-Cookie` response headers into a single `Cookie` request header value. */
function cookieHeaderFromSetCookie(setCookie: string[]): string {
  return setCookie.map(entry => entry.split(';')[0]).join('; ')
}
