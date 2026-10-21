<script setup lang="ts">
import { OWNERSHIP_TYPES } from '@hajj/contracts/constants/inventory'
import type { HotelForm } from '../../utils/hotelForm'

/**
 * The hotel's details in three titled sections (§24): the hotel, its location and time, its operations. On edit the
 * code is shown locked (codes never change). For a `UForm` validating the request it becomes.
 */
const form = defineModel<HotelForm>({ required: true })
const props = defineProps<{ mode: 'create' | 'edit', disabled?: boolean }>()
const { t } = useI18n()
const ownership = computed(() => choiceItems(OWNERSHIP_TYPES, value => t(`hotel.ownership.${value}`)))
const timezones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  }
  catch {
    return ['Asia/Riyadh']
  }
})()

const field = useModelFields(form)
const code = field('code', value => value.toUpperCase())
const name = field('name')
const ownershipType = field('ownershipType')
const licenseReference = field('licenseReference')
const city = field('city')
const country = field('country', value => value.toUpperCase())
const address = field('address')
const timezone = field('timezone')
const currency = field('currency', value => value.toUpperCase())
const checkInTime = field('checkInTime')
const checkOutTime = field('checkOutTime')
const phone = field('phone')
const email = field('email')
const notes = field('notes')
const editing = computed(() => props.mode === 'edit')
</script>

<template>
  <div class="flex flex-col gap-6">
    <fieldset class="flex flex-col gap-4" :disabled="disabled">
      <legend class="text-subsection mb-2">{{ t('hotel.section.hotel') }}</legend>
      <UFormField :label="t('hotel.field.name')" name="name" required>
        <UInput v-model="name" class="w-full" />
      </UFormField>
      <UFormField :label="t('hotel.field.code')" :help="editing ? t('hotel.codeLocked') : t('hotel.codeHelp')" name="code" :required="!editing">
        <UInput v-model="code" dir="ltr" :disabled="editing" :trailing-icon="editing ? 'i-lucide-lock' : undefined" class="w-full sm:w-64" />
      </UFormField>
      <UFormField :label="t('hotel.field.ownership')" name="ownershipType">
        <URadioGroup v-model="ownershipType" :items="ownership" orientation="horizontal" />
      </UFormField>
      <UFormField :label="t('hotel.field.license')" name="licenseReference" :hint="t('common.optional')">
        <UInput v-model="licenseReference" dir="ltr" class="w-full sm:w-80" />
      </UFormField>
    </fieldset>
    <fieldset class="flex flex-col gap-4" :disabled="disabled">
      <legend class="text-subsection mb-2">{{ t('hotel.section.location') }}</legend>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="t('hotel.field.city')" name="city" required><UInput v-model="city" class="w-full" /></UFormField>
        <UFormField :label="t('hotel.field.country')" :help="t('hotel.countryHelp')" name="country"><UInput v-model="country" dir="ltr" maxlength="2" class="w-24" /></UFormField>
      </div>
      <UFormField :label="t('hotel.field.address')" name="address" :hint="t('common.optional')"><UInput v-model="address" class="w-full" /></UFormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="t('hotel.field.timezone')" name="timezone" required>
          <USelectMenu v-model="timezone" :items="timezones" :search-input="{ placeholder: t('hotel.timezoneSearch') }" class="w-full" />
        </UFormField>
        <UFormField :label="t('hotel.field.currency')" name="currency"><UInput v-model="currency" dir="ltr" maxlength="3" class="w-24" /></UFormField>
      </div>
    </fieldset>
    <fieldset class="flex flex-col gap-4" :disabled="disabled">
      <legend class="text-subsection mb-2">{{ t('hotel.section.operations') }}</legend>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="t('hotel.field.checkIn')" name="checkInTime"><UInput v-model="checkInTime" type="time" dir="ltr" class="w-36" /></UFormField>
        <UFormField :label="t('hotel.field.checkOut')" name="checkOutTime"><UInput v-model="checkOutTime" type="time" dir="ltr" class="w-36" /></UFormField>
        <UFormField :label="t('hotel.field.phone')" name="phone" :hint="t('common.optional')"><UInput v-model="phone" type="tel" dir="ltr" class="w-full" /></UFormField>
        <UFormField :label="t('hotel.field.email')" name="email" :hint="t('common.optional')"><UInput v-model="email" type="email" dir="ltr" class="w-full" /></UFormField>
      </div>
      <UFormField :label="t('hotel.field.notes')" name="notes" :hint="t('common.optional')"><UTextarea v-model="notes" :rows="3" class="w-full" /></UFormField>
    </fieldset>
  </div>
</template>
