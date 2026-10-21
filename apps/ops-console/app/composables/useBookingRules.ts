import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { BookingRuleKind } from '@hajj/contracts/schemas/bookingRules'
import type { BookingRuleDtos } from '@hajj/contracts/types/bookingRules'
import { useLastShown } from './useLastShown'

/**
 * One kind of a hotel's booking rules on its page (v7 §15): the list (`enabled` with the kind's read permission),
 * the drawer that adds one or edits one (`edit(null)` / `edit(rule)`, `submit(body)` sends it), and the delete
 * confirmation (`deleting`, kept as `asked` while it closes). A save or delete asks the hotel's rules of that kind again.
 */
export function useBookingRules<K extends BookingRuleKind>(kind: K, hotelId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  type Rule = BookingRuleDtos[K]
  const api = useApi()
  const { t } = useI18n()
  const notify = useNotify()
  const queryClient = useQueryClient()
  const id = computed(() => toValue(hotelId))
  const base = () => `/hotels/${id.value}/booking-rules/${kind}`
  const list = useApiQuery(() => ['booking-rules', id.value, kind], () => api<Rule[]>(base()), { enabled: computed(() => !!id.value && toValue(enabled)) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['booking-rules', id.value, kind] })

  const drawerOpen = ref(false)
  const editing = shallowRef<Rule | null>(null)
  const save = useMutation({
    mutationFn: ({ ruleId, body }: { ruleId?: string, body: Record<string, unknown> }) => api<Rule>(ruleId ? `${base()}/${ruleId}` : base(), { method: ruleId ? 'PATCH' : 'POST', body }),
    onSuccess: async (_saved, { ruleId }) => {
      drawerOpen.value = false
      notify.done(ruleId ? t('rules.saved') : t('rules.added'))
      await refresh()
    },
    // The drawer says why; a rule deleted elsewhere meanwhile also leaves the list.
    onError: async (error) => {
      if (toApiError(error).code === 'BOOKING_RULE_NOT_FOUND') await refresh()
    },
  })
  function edit(rule: Rule | null): void {
    editing.value = rule
    save.reset()
    drawerOpen.value = true
  }
  const submit = (body: Record<string, unknown>) => save.mutate({ ruleId: editing.value?.id, body })

  const deleting = shallowRef<Rule | null>(null)
  const asked = useLastShown(() => deleting.value)
  const remove = useMutation({
    mutationFn: (rule: Rule) => api<{ id: string }>(`${base()}/${rule.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      deleting.value = null
      notify.done(t('rules.deleted'))
      await refresh()
    },
    onError: notify.failed,
  })
  const confirmDelete = () => { if (deleting.value) remove.mutate(deleting.value) }
  return { list, drawerOpen, editing, edit, submit, save, deleting, asked, remove, confirmDelete }
}
