<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { twoFactorCodeSchema } from '@hajj/contracts/schemas/auth'
import type { TwoFactorSetup, TwoFactorStatus } from '@hajj/contracts/types/staff'
import { accessOf } from '../../utils/access'
import { homeOf } from '../../utils/nav'

/**
 * Two-factor authentication for one's own account: set it up (scan the code, or type the secret, then confirm with a
 * code — every other session of the account ends) or, unless a role requires it, turn it off with a current code.
 * A staff member whose role requires it lands here first and goes on to their work once it is set up.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const session = useStaffSession()
useSeoMeta({ title: () => t('twoFactor.title') })

const status = useApiQuery(['two-factor'], () => api<TwoFactorStatus>('/auth/2fa'))
const setup = ref<TwoFactorSetup | null>(null)
const form = ref({ code: '' })
const validate = validateWith(twoFactorCodeSchema, key => t(key))
const done = () => queryClient.invalidateQueries({ queryKey: ['two-factor'] })

const codeField = ref<{ inputRef?: HTMLInputElement } | null>(null)
const start = useMutation({
  mutationFn: () => api<TwoFactorSetup>('/auth/2fa/setup', { method: 'POST' }),
  onSuccess: async (started) => {
    setup.value = started
    form.value = { code: '' }
    await nextTick()
    codeField.value?.inputRef?.focus()
  },
})
const enable = useMutation({
  mutationFn: () => api('/auth/2fa/enable', { method: 'POST', body: form.value }),
  onSuccess: async () => {
    setup.value = null
    toast.add({ title: t('twoFactor.enabled'), color: 'success', icon: 'i-lucide-shield-check' })
    await done()
    const me = await session.refresh()
    if (me) await navigateTo(homeOf(accessOf(me)))
  },
})
const disable = useMutation({
  mutationFn: () => api('/auth/2fa/disable', { method: 'POST', body: form.value }),
  onSuccess: async () => {
    form.value = { code: '' }
    toast.add({ title: t('twoFactor.disabled'), color: 'success', icon: 'i-lucide-shield-off' })
    await done()
  },
})
const required = computed(() => session.me.value?.twoFactorEnrollmentRequired ?? false)
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-6">
    <PageHeader :title="t('twoFactor.title')" :description="t('twoFactor.text')" />
    <UAlert v-if="required" color="warning" variant="soft" icon="i-lucide-shield-alert" :title="t('twoFactor.required')" />
    <ErrorState v-if="status.error.value" :error="status.error.value" @retry="status.refetch()" />
    <USkeleton v-else-if="status.isPending.value" class="h-40" />

    <section v-else-if="status.data.value?.enabled" class="surface-panel flex flex-col gap-4 p-6">
      <p class="flex items-center gap-2"><UIcon name="i-lucide-shield-check" class="size-5 text-(--success)" />{{ t('twoFactor.on') }}</p>
      <template v-if="!status.data.value.requiredByRole">
        <p class="text-(--fg-muted)">{{ t('twoFactor.disableHelp') }}</p>
        <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="disable.mutate()">
          <UFormField :label="t('login.code')" name="code" required>
            <UInput v-model="form.code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" class="w-40" />
          </UFormField>
          <UAlert v-if="disable.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(disable.error.value)" role="alert" />
          <UButton type="submit" color="error" variant="outline" :loading="disable.isPending.value" class="self-start">{{ t('twoFactor.disable') }}</UButton>
        </UForm>
      </template>
      <p v-else class="text-(--fg-muted)">{{ t('twoFactor.keptByRole') }}</p>
    </section>

    <section v-else class="surface-panel flex flex-col gap-4 p-6">
      <template v-if="!setup">
        <p>{{ t('twoFactor.off') }}</p>
        <UAlert v-if="start.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(start.error.value)" role="alert" />
        <UButton icon="i-lucide-shield-plus" :loading="start.isPending.value" class="self-start" @click="start.mutate()">{{ t('twoFactor.start') }}</UButton>
      </template>
      <template v-else>
        <ol class="flex list-decimal flex-col gap-4 ps-5">
          <li class="flex flex-col gap-3">
            <span>{{ t('twoFactor.scan') }}</span>
            <QrCode :value="setup.otpauthUri" :alt="t('twoFactor.qrAlt')" :size="200" />
            <details>
              <summary class="cursor-pointer text-small text-(--fg-muted)">{{ t('twoFactor.manual') }}</summary>
              <p class="mt-2 break-all tabular" dir="ltr">{{ setup.secret }}</p>
            </details>
          </li>
          <li class="flex flex-col gap-3">
            <span>{{ t('twoFactor.confirm') }}</span>
            <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="enable.mutate()">
              <UFormField :label="t('login.code')" name="code" required>
                <UInput ref="codeField" v-model="form.code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" class="w-40" />
              </UFormField>
              <UAlert v-if="enable.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(enable.error.value)" role="alert" />
              <UButton type="submit" :loading="enable.isPending.value" class="self-start">{{ t('twoFactor.turnOn') }}</UButton>
            </UForm>
          </li>
        </ol>
      </template>
    </section>
  </div>
</template>
