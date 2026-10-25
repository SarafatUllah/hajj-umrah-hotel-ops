<script setup lang="ts">
import type { AgencyProfileValues } from '../utils/agency'

/** An agency's profile fields (v7 §6): the agency portal's registration and the console's new agency. `prefix` names them in the form (`agency.`). */
const model = defineModel<AgencyProfileValues>({ required: true })
withDefaults(defineProps<{ prefix?: string }>(), { prefix: '' })
const { t } = useI18n()
const field = useModelFields(model)
const name = field('name')
const licenseNo = field('licenseNo')
const contactName = field('contactName')
const phone = field('phone')
const email = field('email')
const whatsappNumber = field('whatsappNumber')
const address = field('address')
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <UFormField :label="t('agencyForm.name')" :name="`${prefix}name`" required><UInput v-model="name" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.licenseNo')" :name="`${prefix}licenseNo`" required><UInput v-model="licenseNo" dir="ltr" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.contactName')" :name="`${prefix}contactName`" required><UInput v-model="contactName" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.phone')" :name="`${prefix}phone`" required><UInput v-model="phone" type="tel" dir="ltr" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.agencyEmail')" :name="`${prefix}email`" required><UInput v-model="email" type="email" dir="ltr" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.whatsapp')" :name="`${prefix}whatsappNumber`"><UInput v-model="whatsappNumber" type="tel" dir="ltr" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.address')" :name="`${prefix}address`" class="sm:col-span-2"><UInput v-model="address" class="w-full" /></UFormField>
  </div>
</template>
