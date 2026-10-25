<script setup lang="ts">
import type { AgencyQuotaDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { EVERY_AGENCY, sortedQuotas } from '../../utils/bookingRules'
import { withSaved } from '../../utils/forms'

/**
 * A hotel's agency quotas (v7 §10, §15; `booking.view`): pilgrims a night per agency (named by the API), or the
 * default for every agency, by season. With `booking.settings` on an active hotel — and `agency.view`, to choose the
 * agency — add, edit, delete.
 */
const props = defineProps<{ hotel: HotelSummary, canManage: boolean }>()
const { t } = useI18n()
const access = useAccess()
const seesAgencies = computed(() => access.value.can('agency.view'))
const canEdit = computed(() => props.canManage && seesAgencies.value)
const agencies = useAgencies(() => canEdit.value)
const rules = useBookingRules('agency-quotas', () => props.hotel.id, true)
const { list, drawerOpen, editing, deleting, asked } = rules
const agencyName = (quota: Pick<AgencyQuotaDto, 'agencyId' | 'agencyName'>) => (quota.agencyId === null ? t('rules.quotas.everyAgency') : quota.agencyName ?? t('bookings.agency'))
const quotas = computed(() => sortedQuotas(list.data.value ?? [], agencyName))
const agencyChoices = computed(() => withSaved(
  [{ value: EVERY_AGENCY, label: t('rules.quotas.everyAgency') }, ...agencies.items.value],
  editing.value?.agencyId ? { value: editing.value.agencyId, label: agencyName(editing.value) } : null,
))
const describe = (quota: AgencyQuotaDto) => t('rules.quotas.describe', { agency: agencyName(quota) })
</script>

<template>
  <RulePanel
    id="quotas"
    :title="t('rules.quotas.title')"
    :help="t('rules.quotas.help')"
    :add-label="canEdit ? t('rules.quotas.add') : undefined"
    :error="list.error.value"
    :loading="list.isPending.value"
    :empty="!quotas.length"
    :empty-text="t('rules.quotas.none')"
    @add="rules.edit(null)"
    @retry="list.refetch()"
  >
    <table class="w-full">
      <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
        <tr>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.quotas.agency') }}</th>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.season') }}</th>
          <th scope="col" class="px-3 py-2 text-end">{{ t('rules.quotas.maxPersons') }}</th>
          <th v-if="canEdit" scope="col" class="px-3 py-2"><span class="sr-only">{{ t('rules.actions') }}</span></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-(--border)">
        <tr v-for="quota in quotas" :key="quota.id">
          <td class="px-3 py-2" :class="{ 'font-medium': quota.agencyId === null }"><bdi>{{ agencyName(quota) }}</bdi></td>
          <td class="whitespace-nowrap px-3 py-2"><NightsRange :from="quota.startDate" :to="quota.endDate" :count="false" /></td>
          <td class="px-3 py-2 text-end tabular">{{ t('rules.quotas.perNight', { count: quota.maxPersons }, quota.maxPersons) }}</td>
          <td v-if="canEdit" class="whitespace-nowrap px-3 py-2"><RuleActions :name="describe(quota)" @edit="rules.edit(quota)" @delete="deleting = quota" /></td>
        </tr>
      </tbody>
    </table>
  </RulePanel>
  <QuotaDrawer v-model:open="drawerOpen" :hotel="hotel" :quota="editing" :agencies="agencyChoices" :pending="rules.save.isPending.value" :error="rules.save.error.value" @submit="rules.submit" />
  <ConfirmDialog
    :open="!!deleting"
    destructive
    :title="t('rules.deleteTitle', { name: asked ? describe(asked) : '' })"
    :description="t('rules.quotas.deleteText')"
    :confirm-label="t('rules.delete')"
    :pending="rules.remove.isPending.value"
    @update:open="value => { if (!value) deleting = null }"
    @confirm="rules.confirmDelete"
  />
</template>
