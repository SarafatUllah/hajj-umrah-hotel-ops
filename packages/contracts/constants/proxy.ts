/**
 * The header in which the frontends' `/api` proxy hands the API the visitor's address (packages/ui/server/api/[...path].ts).
 * The proxy always sets it, replacing anything the visitor sent. The API reads it only with TRUST_VISITOR_HEADER=true —
 * when it is reachable solely through that proxy, as with Vercel service bindings, whose hop may rewrite X-Forwarded-For.
 */
export const VISITOR_ADDRESS_HEADER = 'x-hajj-visitor-ip'
