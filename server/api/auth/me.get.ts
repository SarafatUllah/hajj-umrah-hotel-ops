export default defineEventHandler(async (event) => {
  return requireUserSession(event)
})
