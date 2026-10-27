<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { CustomerSignIn, OtpChallengeIssued } from '@hajj/contracts/types/customer'
import { codeRequestBody, isEmailAddress, SIGN_IN_METHODS, type SignInDestination, type SignInMethod } from '../utils/signIn'

/**
 * Sign in with a one-time code (v7 §21, D-P2-68): the customer chooses e-mail or a text message, gives the address or
 * the number, then the code (and the name, the first time). `fixed`: the step-up of a signed-in customer (D-P2-27b) —
 * the same flow on their own phone or address.
 */
const props = defineProps<{ fixed?: SignInDestination, submitLabel?: string }>()
const emit = defineEmits<{ signedIn: [CustomerSignIn] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const config = useRuntimeConfig().public
const organizationSlug = config.organizationSlug
// The bot check, when the site has a key: each code sent needs a fresh token.
const needsCheck = !!config.turnstileSiteKey
const captchaToken = ref<string | null>(null)
const check = ref<{ reset: () => void } | null>(null)
const checkPassed = computed(() => !needsCheck || !!captchaToken.value)

const method = ref<SignInMethod>('email')
const methods = computed(() => SIGN_IN_METHODS.map(value => ({ value, label: value === 'email' ? t('signIn.byEmail') : t('signIn.byPhone') })))
// Each method keeps its own value, so switching back and forth loses nothing typed.
const email = ref('')
const phone = ref('')
watch(() => props.fixed, (fixed) => {
  if (!fixed) return
  method.value = fixed.method
  if (fixed.method === 'email') email.value = fixed.value
  else phone.value = fixed.value
}, { immediate: true })
const destination = computed<SignInDestination>(() => ({ method: method.value, value: method.value === 'email' ? email.value : phone.value }))
// An address is checked with the API's own schema once the field is left (or the form sent), not while typing.
const emailTouched = ref(false)
const emailError = computed(() => (emailTouched.value && !isEmailAddress(email.value) ? t('signIn.emailInvalid') : undefined))

const challenge = ref<OtpChallengeIssued | null>(null)
const sentTo = ref<SignInDestination | null>(null)
const code = ref('')
const fullName = ref('')
const needsName = ref(false)

const sendCode = useMutation({
  mutationFn: (to: SignInDestination) => api<OtpChallengeIssued>('/customer/auth/otp/request', { method: 'POST', body: codeRequestBody(organizationSlug, to, captchaToken.value) }),
  onSuccess: (issued, to) => {
    challenge.value = issued
    sentTo.value = to
    code.value = ''
  },
  onSettled: () => check.value?.reset(),
})

function send() {
  if (method.value === 'email') {
    emailTouched.value = true
    if (emailError.value) return
  }
  sendCode.mutate(destination.value)
}

// A new method starts clean: the other method's refusal no longer applies.
watch(method, () => sendCode.reset())

/** No provider for this method right now (503): the other one may work — unless the destination is fixed. */
const switchActions = computed(() => {
  if (props.fixed || !['EMAIL_UNAVAILABLE', 'SMS_UNAVAILABLE'].includes(toApiError(sendCode.error.value).code)) return undefined
  const other: SignInMethod = method.value === 'email' ? 'phone' : 'email'
  return [{ label: other === 'email' ? t('signIn.useEmail') : t('signIn.usePhone'), color: 'neutral' as const, variant: 'outline' as const, onClick: () => { method.value = other } }]
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

function chooseAnotherDestination() {
  challenge.value = null
  needsName.value = false
  sendCode.reset()
  verify.reset()
}
</script>

<template>
  <form v-if="!challenge" class="flex flex-col gap-4" novalidate @submit.prevent="send()">
    <URadioGroup v-if="!fixed" v-model="method" :items="methods" :legend="t('signIn.method')" orientation="horizontal" variant="table" />
    <UFormField v-if="method === 'email'" :label="t('signIn.email')" :help="emailError ? undefined : t('signIn.emailHelp')" :error="emailError" name="email" required>
      <UInput v-model="email" type="email" autocomplete="email" inputmode="email" dir="ltr" :disabled="!!fixed" class="w-full" @blur="emailTouched = true" />
    </UFormField>
    <UFormField v-else :label="t('signIn.phone')" :help="t('signIn.phoneHelp')" name="phone" required>
      <UInput v-model="phone" type="tel" autocomplete="tel" dir="ltr" :disabled="!!fixed" class="w-full" />
    </UFormField>
    <UAlert v-if="sendCode.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(sendCode.error.value)" :actions="switchActions" role="alert" />
    <UButton type="submit" :loading="sendCode.isPending.value" :disabled="!destination.value.trim() || !checkPassed" class="self-start">
      {{ method === 'email' ? t('signIn.sendEmailCode') : t('signIn.sendCode') }}
    </UButton>
  </form>

  <form v-else class="flex flex-col gap-4" novalidate @submit.prevent="verify.mutate()">
    <UFormField :label="t('signIn.code')" :help="sentTo?.method === 'email' ? t('signIn.codeHelpEmail', { email: sentTo.value }) : t('signIn.codeHelp', { phone: sentTo?.value })" name="code" required>
      <UInput v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" autofocus class="w-40 tabular" />
    </UFormField>
    <UFormField v-if="needsName" :label="t('signIn.fullName')" :help="t('signIn.fullNameHelp')" name="fullName" required>
      <UInput v-model="fullName" autocomplete="name" autofocus class="w-full" />
    </UFormField>
    <UAlert v-if="verify.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(verify.error.value)" role="alert" />
    <UAlert v-if="sendCode.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(sendCode.error.value)" role="alert" />
    <div class="flex flex-wrap items-center gap-2">
      <UButton type="submit" :loading="verify.isPending.value" :disabled="code.length !== 6">{{ submitLabel ?? t('signIn.verify') }}</UButton>
      <UButton color="neutral" variant="ghost" :loading="sendCode.isPending.value" :disabled="!checkPassed" @click="sendCode.mutate(sentTo!)">{{ t('signIn.resend') }}</UButton>
      <UButton v-if="!fixed" color="neutral" variant="ghost" @click="chooseAnotherDestination">{{ sentTo?.method === 'email' ? t('signIn.otherEmail') : t('signIn.otherPhone') }}</UButton>
    </div>
  </form>
  <!-- One check for both steps: sending the code, and sending it again. -->
  <TurnstileCheck v-if="needsCheck" ref="check" v-model="captchaToken" class="mt-4" />
</template>
