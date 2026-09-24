import { resetDemoData } from '../../../services/demo.service'

export default defineEventHandler(async (event) => {
  const session = await requirePermission(event, 'organization.resetDemo')
  return resetDemoData(session.user!.id)
})
