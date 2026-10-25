<script setup lang="ts">
import type { AgencyUserValues } from '../utils/agency'

/**
 * An agency user's sign-in fields: name, email, a first password. `prefix` names them in the form (`user.`); `own`
 * when the person typing is that user (registering), so the browser may fill in their own name and email — never
 * when staff create someone else's account.
 */
const model = defineModel<AgencyUserValues>({ required: true })
withDefaults(defineProps<{ prefix?: string, own?: boolean }>(), { prefix: '', own: false })
const { t } = useI18n()
const field = useModelFields(model)
const fullName = field('fullName')
const email = field('email')
const password = field('password')
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <UFormField :label="t('agencyForm.fullName')" :name="`${prefix}fullName`" required><UInput v-model="fullName" :autocomplete="own ? 'name' : 'off'" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.email')" :name="`${prefix}email`" required><UInput v-model="email" type="email" :autocomplete="own ? 'username' : 'off'" dir="ltr" class="w-full" /></UFormField>
    <UFormField :label="t('agencyForm.password')" :help="t('agencyForm.passwordHelp')" :name="`${prefix}password`" required><UInput v-model="password" type="password" autocomplete="new-password" class="w-full" /></UFormField>
  </div>
</template>
