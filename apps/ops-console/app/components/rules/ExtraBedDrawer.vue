<script setup lang="ts">
import { extraBedPolicySchema } from '@hajj/contracts/schemas/bookingRules'
import type { ExtraBedPolicyDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { extraBedFormOf, extraBedRequestOf } from '../../utils/bookingRules'

/**
 * A room type's extra beds (v7 §11, §15): how many one room and one booking may get, the price of a bed a night,
 * and whether a room whose seats are changed for a season may get one. One policy per room type.
 */
const props = defineProps<{ hotel: HotelSummary, policy: ExtraBedPolicyDto | null, roomTypes: Array<{ value: string, label: string }>, pending: boolean, error: unknown }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [body: Record<string, unknown>] }>()
const { t } = useI18n()
const form = ref(extraBedFormOf(null))
watch(open, (isOpen) => { if (isOpen) form.value = extraBedFormOf(props.policy) })
const validate = validateWith(extraBedPolicySchema, key => t(key), extraBedRequestOf)
</script>

<template>
  <RuleDrawer
    v-model:open="open"
    kind="extra-bed-policies"
    :hotel="hotel"
    :title="policy ? t('rules.extraBeds.edit') : t('rules.extraBeds.add')"
    :state="form"
    :validate="validate"
    :save-label="policy ? t('rules.save') : t('rules.extraBeds.add')"
    :pending="pending"
    :error="error"
    @submit="emit('submit', extraBedRequestOf(form))"
  >
    <UFormField :label="t('rules.roomType')" name="roomTypeId" required><USelect v-model="form.roomTypeId" :items="roomTypes" class="w-full" /></UFormField>
    <div class="grid grid-cols-2 gap-4">
      <UFormField :label="t('rules.extraBeds.maxPerRoom')" name="maxPerRoom" required><UInputNumber v-model="form.maxPerRoom" :min="0" :max="5" class="w-full" /></UFormField>
      <UFormField :label="t('rules.extraBeds.maxPerBooking')" name="maxPerBooking" required><UInputNumber v-model="form.maxPerBooking" :min="0" :max="1000" class="w-full" /></UFormField>
    </div>
    <UFormField :label="t('rules.extraBeds.price')" name="amountHalalas" required>
      <UInputNumber v-model="form.riyals" :min="0" :step="0.01" :format-options="{ minimumFractionDigits: 2, maximumFractionDigits: 2 }" class="w-full sm:w-48" />
    </UFormField>
    <USwitch v-model="form.vatIncluded" :label="t('quotes.vatIncluded')" />
    <UFormField name="allowInOverrideSeason" :help="t('rules.extraBeds.overrideHelp')">
      <USwitch v-model="form.allowInOverrideSeason" :label="t('rules.extraBeds.override')" />
    </UFormField>
  </RuleDrawer>
</template>
