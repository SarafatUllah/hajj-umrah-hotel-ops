<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { CustomerSignIn, OtpChallengeIssued } from '@hajj/contracts/types/customer'

/**
 * Sign in with a texted code (v7 §21): the phone, then the code (and the name, the first time). `fixedPhone`: the
 * step-up of a signed-in customer (D-P2-27b) — the same flow on their own number.
 */
const props = defineProps<{ fixedPhone?: string, submitLabel?: string }>()
const emit = defineEmits<{ signedIn: [CustomerSignIn] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const config = useRuntimeConfig().public
const organizationSlug = config.organizationSlug
// The bot check, when the site has a key: each texted code needs a fresh token.
const needsCheck = !!config.turnstileSiteKey
const captchaToken = ref<string | null>(null)
const check = ref<{ reset: () => void } | null>(null)
const checkPassed = computed(() => !needsCheck || !!captchaToken.value)

const phone = ref(props.fixedPhone ?? '')
watch(() => props.fixedPhone, (fixed) => { if (fixed) phone.value = fixed })
const challenge = ref<OtpChallengeIssued | null>(null)
const code = ref('')
const fullName = ref('')
const needsName = ref(false)

const sendCode = useMutation({
  mutationFn: () => api<OtpChallengeIssued>('/customer/auth/otp/request', { method: 'POST', body: { organizationSlug, phone: phone.value, ...(captchaToken.value ? { captchaToken: captchaToken.value } : {}) } }),
  onSuccess: (issued) => {
    challenge.value = issued
    code.value = ''
  },
  onSettled: () => check.value?.reset(),
})

const verify = useMutation({
  mutationFn: () => api<CustomerSignIn>('/customer/auth/otp/verify', {
    method: 'POST',
    body: { organizationSlug, challengeId: challenge.value!.challengeId, code: code.value, ...(fullName.value.trim() ? { fullName: fullName.value.trim() } : {}) },
  }),
  onSuccess: signedIn => emit('signedIn', signedIn),
  onError: (error) => {
    if (toApiError(error).code === 'FULL_NAME_REQUIRED') needsName.value = true
  },
})

function chooseAnotherPhone() {
  challenge.value = null
  needsName.value = false
  sendCode.reset()
  verify.reset()
}
</script>

<template>
  <form v-if="!challenge" class="flex flex-col gap-4" novalidate @submit.prevent="sendCode.mutate()">
    <UFormField :label="t('signIn.phone')" :help="t('signIn.phoneHelp')" name="phone" required>
      <UInput v-model="phone" type="tel" autocomplete="tel" dir="ltr" :disabled="!!fixedPhone" class="w-full" />
    </UFormField>
    <UAlert v-if="sendCode.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(sendCode.error.value)" role="alert" />
    <UButton type="submit" :loading="sendCode.isPending.value" :disabled="!phone.trim() || !checkPassed" class="self-start">
      {{ t('signIn.sendCode') }}
    </UButton>
  </form>

  <form v-else class="flex flex-col gap-4" novalidate @submit.prevent="verify.mutate()">
    <UFormField :label="t('signIn.code')" :help="t('signIn.codeHelp', { phone })" name="code" required>
      <UInput v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" autofocus class="w-40 tabular" />
    </UFormField>
    <UFormField v-if="needsName" :label="t('signIn.fullName')" :help="t('signIn.fullNameHelp')" name="fullName" required>
      <UInput v-model="fullName" autocomplete="name" autofocus class="w-full" />
    </UFormField>
    <UAlert v-if="verify.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(verify.error.value)" role="alert" />
    <UAlert v-if="sendCode.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(sendCode.error.value)" role="alert" />
    <div class="flex flex-wrap items-center gap-2">
      <UButton type="submit" :loading="verify.isPending.value" :disabled="code.length !== 6">{{ submitLabel ?? t('signIn.verify') }}</UButton>
      <UButton color="neutral" variant="ghost" :loading="sendCode.isPending.value" :disabled="!checkPassed" @click="sendCode.mutate()">{{ t('signIn.resend') }}</UButton>
      <UButton v-if="!fixedPhone" color="neutral" variant="ghost" @click="chooseAnotherPhone">{{ t('signIn.otherPhone') }}</UButton>
    </div>
  </form>
  <!-- One check for both steps: sending the code, and sending it again. -->
  <TurnstileCheck v-if="needsCheck" ref="check" v-model="captchaToken" class="mt-4" />
</template>
