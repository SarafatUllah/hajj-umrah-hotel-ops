<script setup lang="ts">
import { agencyQuotaSchema } from '@hajj/contracts/schemas/bookingRules'
import type { AgencyQuotaDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { quotaFormOf, quotaRequestOf } from '../../utils/bookingRules'

/**
 * An agency quota (v7 §10, §15): how many pilgrims a night one agency — or every agency, the default — may hold in
 * the hotel over a season. An agency's own quota wins over the default; a night without one has no limit.
 */
const props = defineProps<{ hotel: HotelSummary, quota: AgencyQuotaDto | null, agencies: Array<{ value: string, label: string }>, pending: boolean, error: unknown }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [body: Record<string, unknown>] }>()
const { t } = useI18n()
const form = ref(quotaFormOf(null, props.hotel.today))
watch(open, (isOpen) => { if (isOpen) form.value = quotaFormOf(props.quota, props.hotel.today) })
const validate = validateWith(agencyQuotaSchema, key => t(key), quotaRequestOf)
</script>

<template>
  <RuleDrawer
    v-model:open="open"
    kind="agency-quotas"
    :hotel="hotel"
    :title="quota ? t('rules.quotas.edit') : t('rules.quotas.add')"
    :state="form"
    :validate="validate"
    :save-label="quota ? t('rules.save') : t('rules.quotas.add')"
    :pending="pending"
    :error="error"
    @submit="emit('submit', quotaRequestOf(form))"
  >
    <UFormField :label="t('rules.quotas.agency')" name="agencyId" required>
      <USelectMenu v-model="form.agency" :items="agencies" value-key="value" class="w-full" />
    </UFormField>
    <div class="grid grid-cols-2 gap-4">
      <UFormField :label="t('rules.firstNight')" name="startDate" required><UInput v-model="form.startDate" type="date" dir="ltr" class="w-full" /></UFormField>
      <UFormField :label="t('rules.lastNight')" name="endDate" required><UInput v-model="form.endDate" type="date" :min="form.startDate || undefined" dir="ltr" class="w-full" /></UFormField>
    </div>
    <UFormField :label="t('rules.quotas.maxPersons')" :help="t('rules.quotas.maxPersonsHelp')" name="maxPersons" required>
      <UInputNumber v-model="form.maxPersons" :min="0" :max="100000" class="w-full sm:w-48" />
    </UFormField>
  </RuleDrawer>
</template>
