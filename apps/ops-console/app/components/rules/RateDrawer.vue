<script setup lang="ts">
import { PRICE_TYPES, PRICE_UNITS } from '@hajj/contracts/constants/pricing'
import { rateSchema } from '@hajj/contracts/schemas/bookingRules'
import type { RateDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { rateFormOf, rateRequestOf } from '../../utils/bookingRules'

/**
 * A rate (v7 §8, §15): a room type's public price, or the default price for every approved agency (when no quote
 * applies), per person or per room and night, over an inclusive season, VAT included or not. `rate` edits one.
 */
const props = defineProps<{ hotel: HotelSummary, rate: RateDto | null, roomTypes: Array<{ value: string, label: string }>, pending: boolean, error: unknown }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [body: Record<string, unknown>] }>()
const { t } = useI18n()
const form = ref(rateFormOf(null, props.hotel.today))
watch(open, (isOpen) => { if (isOpen) form.value = rateFormOf(props.rate, props.hotel.today) })
const validate = validateWith(rateSchema, key => t(key), rateRequestOf)
const types = computed(() => PRICE_TYPES.map(value => ({ value, label: t(`rules.priceType.${value}`), description: t(`rules.priceTypeHelp.${value}`) })))
const units = computed(() => PRICE_UNITS.map(value => ({ value, label: t(`booking.priceUnit.${value}`) })))
</script>

<template>
  <RuleDrawer
    v-model:open="open"
    kind="rates"
    :hotel="hotel"
    :title="rate ? t('rules.rates.edit') : t('rules.rates.add')"
    :state="form"
    :validate="validate"
    :save-label="rate ? t('rules.save') : t('rules.rates.add')"
    :pending="pending"
    :error="error"
    @submit="emit('submit', rateRequestOf(form))"
  >
    <UFormField :label="t('rules.roomType')" name="roomTypeId" required><USelect v-model="form.roomTypeId" :items="roomTypes" class="w-full" /></UFormField>
    <UFormField name="priceType"><URadioGroup v-model="form.priceType" :items="types" :legend="t('rules.priceTypeLabel')" variant="card" /></UFormField>
    <UFormField name="unit"><URadioGroup v-model="form.unit" :items="units" :legend="t('quotes.unit')" orientation="horizontal" /></UFormField>
    <div class="grid grid-cols-2 gap-4">
      <UFormField :label="t('rules.firstNight')" name="startDate" required><UInput v-model="form.startDate" type="date" dir="ltr" class="w-full" /></UFormField>
      <UFormField :label="t('rules.lastNight')" name="endDate" required><UInput v-model="form.endDate" type="date" :min="form.startDate || undefined" dir="ltr" class="w-full" /></UFormField>
    </div>
    <UFormField :label="t('quotes.amount')" name="amountHalalas" required>
      <UInputNumber v-model="form.riyals" :min="0" :step="0.01" :format-options="{ minimumFractionDigits: 2, maximumFractionDigits: 2 }" class="w-full sm:w-48" />
    </UFormField>
    <USwitch v-model="form.vatIncluded" :label="t('quotes.vatIncluded')" />
  </RuleDrawer>
</template>
