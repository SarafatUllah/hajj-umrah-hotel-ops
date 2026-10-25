/** Where the last hotel used is remembered, per staff member (§6.1: navigation links resolve with it). */
const lastHotelKey = (userId: string) => `ops.lastHotel.${userId}`

/** The last hotel this staff member used on this browser (none when storage is refused, e.g. private mode). */
function storedLast(userId: string): string | null {
  if (!import.meta.client) return null
  try {
    return localStorage.getItem(lastHotelKey(userId))
  }
  catch {
    return null
  }
}

/**
 * The hotel context (§6): the URL is its only source — `/hotels/:hotel/...` on a hotel's page, `?hotel=` on a
 * portfolio page, none on an organization page. The switcher navigates; this follows the route. The last hotel used
 * is kept in the browser for links to hotel pages.
 */
export function useHotelScope() {
  const route = useRoute()
  const hotels = useHotels()
  const { me } = useStaffSession()
  // Whose last hotel it is: someone else signing in on this browser starts from their own.
  const last = useState<{ userId: string, code: string | null } | null>('ops-last-hotel', () => null)
  const lastHotelCode = computed(() => (last.value && last.value.userId === me.value?.user.userId ? last.value.code : null))

  const routeCode = computed(() => {
    const fromPath = route.params.hotel
    if (typeof fromPath === 'string') return fromPath
    return typeof route.query.hotel === 'string' ? route.query.hotel : null
  })
  /** The page's hotel: `undefined` while the list loads or when the code matches no hotel this user can see. */
  const current = computed(() => hotels.byCode(routeCode.value))
  const isHotelPage = computed(() => typeof route.params.hotel === 'string')

  function readLast(userId: string): void {
    last.value = { userId, code: storedLast(userId) }
  }
  function remember(code: string | null): void {
    const userId = me.value?.user.userId
    if (!userId) return
    last.value = { userId, code }
    if (!import.meta.client) return
    try {
      if (code) localStorage.setItem(lastHotelKey(userId), code)
      else localStorage.removeItem(lastHotelKey(userId))
    }
    catch {
      // Storage refused (private mode): the choice lasts for this visit only.
    }
  }
  // A hotel page the user opened is the last hotel used; a remembered hotel no longer visible is forgotten.
  watch([current, () => me.value?.user.userId, () => hotels.data.value], () => {
    const userId = me.value?.user.userId
    if (userId && last.value?.userId !== userId) readLast(userId)
    if (current.value) remember(current.value.code)
    else if (lastHotelCode.value && hotels.data.value && !hotels.byCode(lastHotelCode.value)) remember(null)
  }, { immediate: true })

  return { hotels, current, routeCode, isHotelPage, lastHotelCode, remember }
}
