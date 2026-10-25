<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { staffLoginSchema } from '@hajj/contracts/schemas/auth'
import type { DemoSignInPayload, DemoSignInPersona, StaffMe } from '@hajj/contracts/types/staff'
import { accessOf } from '../utils/access'
import { homeOf } from '../utils/nav'

/**
 * Staff sign-in (§35.1): organization ID (remembered on this device), email, password — then, for an account with
 * two-factor authentication, the code. Any wrong combination reads the same. Where the demo is enabled (the API
 * answers its demo sign-in), the organization is filled in and a persona can be picked; elsewhere nothing of it shows.
 */
definePageMeta({ layout: 'bare', middleware: 'guest' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const errorMessage = useErrorMessage()
const session = useStaffSession()
useSeoMeta({ title: () => t('login.title') })

const rememberedOrganization = useCookie<string | null>('ops-organization', { default: () => null, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 })
const form = ref({ organizationSlug: rememberedOrganization.value ?? '', email: '', password: '', totpCode: '' })
const askCode = ref(false)
const codeField = ref<{ inputRef?: HTMLInputElement } | null>(null)
const request = (state: typeof form.value) => ({ ...state, totpCode: askCode.value ? state.totpCode : undefined })
const validate = validateWith(staffLoginSchema, key => t(key), request)

const signIn = useMutation({
  mutationFn: async () => {
    await api('/auth/login', { method: 'POST', body: request(form.value) })
    return session.refresh()
  },
  onSuccess: async (me) => {
    rememberedOrganization.value = form.value.organizationSlug
    if (!me) return
    session.signedIn(me)
    await navigateTo(destinationOf(me))
  },
  onError: async (error) => {
    // The account has two-factor authentication: the same sign-in again, with the code.
    if (toApiError(error).code !== 'TWO_FACTOR_REQUIRED') return
    askCode.value = true
    signIn.reset()
    await nextTick()
    codeField.value?.inputRef?.focus()
  },
})
function destinationOf(me: StaffMe): string {
  if (me.twoFactorEnrollmentRequired) return '/settings/two-factor'
  return safeRedirect(route.query.redirect, homeOf(accessOf(me)))
}

// The demo's personas (D9): asked from the browser only; a production API answers 404 and nothing shows.
const demo = ref<DemoSignInPayload | null>(null)
onMounted(async () => {
  try {
    demo.value = await api<DemoSignInPayload>('/public/demo-sign-in')
    if (!form.value.organizationSlug) form.value = { ...form.value, organizationSlug: demo.value.organizationSlug }
  }
  catch {
    demo.value = null
  }
})
function usePersona(persona: DemoSignInPersona): void {
  if (!demo.value) return
  askCode.value = false
  form.value = { organizationSlug: demo.value.organizationSlug, email: persona.email, password: demo.value.password, totpCode: '' }
  signIn.mutate()
}
</script>

<template>
  <div class="flex w-full max-w-3xl flex-col gap-8">
    <div class="mx-auto flex w-full max-w-md flex-col gap-6">
      <PageHeader :title="t('login.title')" :description="t('console.name')" />
      <UForm :state="form" :validate="validate" class="surface-panel flex flex-col gap-4 p-6" @submit="signIn.mutate()">
        <UFormField :label="t('login.organization')" :help="t('login.organizationHelp')" name="organizationSlug" required>
          <UInput v-model="form.organizationSlug" autocomplete="organization" dir="ltr" class="w-full" />
        </UFormField>
        <UFormField :label="t('login.email')" name="email" required>
          <UInput v-model="form.email" type="email" autocomplete="username" dir="ltr" class="w-full" />
        </UFormField>
        <UFormField :label="t('login.password')" name="password" required>
          <UInput v-model="form.password" type="password" autocomplete="current-password" class="w-full" />
        </UFormField>
        <UFormField v-if="askCode" :label="t('login.code')" :help="t('login.codeHelp')" name="totpCode" required>
          <UInput ref="codeField" v-model="form.totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" class="w-40" />
        </UFormField>
        <UAlert v-if="signIn.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(signIn.error.value)" role="alert" />
        <UButton type="submit" :loading="signIn.isPending.value" class="self-start">{{ t('common.signIn') }}</UButton>
      </UForm>
    </div>

    <section v-if="demo" aria-labelledby="personas-heading" class="flex flex-col gap-3">
      <h2 id="personas-heading" class="text-section">{{ t('login.personas') }}</h2>
      <p class="text-(--fg-muted)">{{ t('login.personasHelp') }}</p>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="persona in demo.personas" :key="persona.email">
          <button
            type="button"
            class="surface-panel flex h-full w-full flex-col items-start gap-1 p-4 text-start hover:bg-(--surface-2) disabled:opacity-60"
            :disabled="signIn.isPending.value"
            @click="usePersona(persona)"
          >
            <span class="font-medium"><bdi>{{ persona.fullName }}</bdi></span>
            <span class="text-small text-(--fg-muted)">{{ persona.roleName }}</span>
            <span class="text-small text-(--fg-muted)">{{ persona.hotels.length ? persona.hotels.map(h => h.name).join(', ') : t('login.allHotels') }}</span>
            <UBadge v-if="!persona.phase1Available" color="neutral" variant="outline" size="sm">{{ t('login.laterPhases') }}</UBadge>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
