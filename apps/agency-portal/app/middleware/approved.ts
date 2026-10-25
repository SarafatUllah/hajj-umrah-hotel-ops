/**
 * Booking pages need an approved agency (v7 §15): a pending, suspended or rejected one sees where it stands. A
 * remembered "not approved" is asked again first — the hotel may have approved the agency since.
 */
export default defineNuxtRouteMiddleware(async () => {
  const session = useAgencySession()
  let me = await session.ensure().catch(() => undefined)
  if (me && me.agency.status !== 'APPROVED') me = await session.refresh().catch(() => me)
  if (me && me.agency.status !== 'APPROVED') return navigateTo('/pending')
})
