<script setup lang="ts">
import { GENDERS } from '@hajj/contracts/constants/booking'
import type { GuestFieldValues } from '../utils/guest'

/** A pilgrim's passport fields (v7 §7), for a `UForm` whose schema decides which are required. */
const model = defineModel<GuestFieldValues>({ required: true })
defineProps<{ required?: boolean }>()
const { t } = useI18n()
const genders = computed(() => GENDERS.map(value => ({ value, label: t(`booking.gender.${value}`) })))

/** One field of the model: read from it, written as a new value of the whole (never changed in place). */
function field<K extends keyof GuestFieldValues>(key: K, normalize: (value: GuestFieldValues[K]) => GuestFieldValues[K] = value => value) {
  return computed({
    get: () => model.value[key],
    set: (value) => { model.value = { ...model.value, [key]: normalize(value) } },
  })
}
const fullName = field('fullName')
const gender = field('gender')
// The passport's three letters, as printed: upper case whatever was typed.
const nationality = field('nationality', value => value?.toUpperCase())
const dateOfBirth = field('dateOfBirth')
const passportNo = field('passportNo')
const passportExpiry = field('passportExpiry')
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <UFormField :label="t('guest.fullName')" name="fullName" required class="sm:col-span-2">
      <UInput v-model="fullName" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField :label="t('guest.gender')" name="gender" :required="required">
      <USelect v-model="gender" :items="genders" class="w-full" />
    </UFormField>
    <UFormField :label="t('guest.nationality')" name="nationality" :required="required">
      <UInput v-model="nationality" maxlength="3" dir="ltr" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField :label="t('guest.dateOfBirth')" name="dateOfBirth" :required="required">
      <UInput v-model="dateOfBirth" type="date" dir="ltr" class="w-full" />
    </UFormField>
    <UFormField :label="t('guest.passportNo')" name="passportNo" :required="required">
      <UInput v-model="passportNo" dir="ltr" autocomplete="off" class="w-full tabular" />
    </UFormField>
    <UFormField :label="t('guest.passportExpiry')" name="passportExpiry" :required="required">
      <UInput v-model="passportExpiry" type="date" dir="ltr" class="w-full" />
    </UFormField>
  </div>
</template>
