<script setup lang="ts">
import { BOOKING_TYPES, CHILD_SIDES } from '@hajj/contracts/constants/booking'
import { choiceItems } from '../utils/choices'
import type { StayForm } from '../utils/stay'

/**
 * The stay a booker asks for (v7 §9.1): the hotel, the nights, who is coming — a family's total, a group's men, women
 * and children (and the children's side), infants apart. For a `UForm` that validates the request it becomes.
 * `fixed`: the hotel, the nights and the type come from elsewhere (an offered quote) and cannot change here.
 */
const form = defineModel<StayForm>({ required: true })
defineProps<{ hotels: Array<{ value: string, label: string }>, fixed?: boolean }>()
const { t } = useI18n()
const types = computed(() => choiceItems(BOOKING_TYPES, value => t(`booking.type.${value}`)))
const childSides = computed(() => choiceItems(CHILD_SIDES, value => t(`booking.childSide.${value}`)))

/** One field of the form: read from it, written as a new value of the whole (never changed in place). */
function field<K extends keyof StayForm>(key: K) {
  return computed({
    get: () => form.value[key],
    set: (value: StayForm[K]) => { form.value = { ...form.value, [key]: value } },
  })
}
const hotelId = field('hotelId')
const checkIn = field('checkIn')
const checkOut = field('checkOut')
const bookingType = field('bookingType')
const totalCount = field('totalCount')
const maleCount = field('maleCount')
const femaleCount = field('femaleCount')
const childCount = field('childCount')
const infantCount = field('infantCount')
const childSide = field('childSide')
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField :label="t('stay.hotel')" name="hotelId" required>
      <USelect v-model="hotelId" :items="hotels" :disabled="fixed" class="w-full" />
    </UFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField :label="t('stay.checkIn')" name="checkIn" required>
        <UInput v-model="checkIn" type="date" dir="ltr" :disabled="fixed" class="w-full" />
      </UFormField>
      <UFormField :label="t('stay.checkOut')" name="checkOut" required>
        <UInput v-model="checkOut" type="date" dir="ltr" :min="checkIn || undefined" :disabled="fixed" class="w-full" />
      </UFormField>
    </div>
    <UFormField :label="t('stay.type')" :help="t('stay.typeHelp')" name="bookingType">
      <URadioGroup v-model="bookingType" :items="types" orientation="horizontal" :disabled="fixed" />
    </UFormField>
    <div v-if="bookingType === 'FAMILY'" class="grid gap-4 sm:grid-cols-2">
      <UFormField :label="t('stay.total')" name="totalCount" required>
        <UInputNumber v-model="totalCount" :min="1" :max="600" class="w-full" />
      </UFormField>
    </div>
    <div v-else class="grid gap-4 sm:grid-cols-3">
      <UFormField :label="t('stay.men')" name="maleCount">
        <UInputNumber v-model="maleCount" :min="0" :max="600" class="w-full" />
      </UFormField>
      <UFormField :label="t('stay.women')" name="femaleCount">
        <UInputNumber v-model="femaleCount" :min="0" :max="600" class="w-full" />
      </UFormField>
      <UFormField :label="t('stay.children')" name="childCount">
        <UInputNumber v-model="childCount" :min="0" :max="600" class="w-full" />
      </UFormField>
      <UFormField v-if="childCount > 0" :label="t('stay.childSide')" name="childSide" class="sm:col-span-3">
        <URadioGroup v-model="childSide" :items="childSides" />
      </UFormField>
    </div>
    <UFormField :label="t('stay.infants')" :help="t('stay.infantsHelp')" name="infantCount" class="sm:max-w-xs">
      <UInputNumber v-model="infantCount" :min="0" :max="100" class="w-full" />
    </UFormField>
  </div>
</template>
