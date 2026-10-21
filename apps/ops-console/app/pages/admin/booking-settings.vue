<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { CHILD_SIDES } from '@hajj/contracts/constants/booking'
import { bookingSettingsPatchSchema } from '@hajj/contracts/schemas/bookingRules'
import type { BookingSettingsDto } from '@hajj/contracts/types/bookingRules'
import { type BookingSettingsForm, ageLimitsAgree, bookingSettingsFormOf, bookingSettingsPatchOf, bookingSettingsRequestOf } from '../../utils/bookingSettings'

/**
 * The organization's booking settings (v7 §15; read with `booking.view`): how long a hold, a customer's request and a
 * quote last, what one customer may ask, the children's ages, the pilgrims' details and passports (and how long they
 * are kept), the desk's no-show rule, and the WhatsApp number and message. Organization-wide, so changed only with
 * `booking.settings` over every hotel; only what changed is sent. Each hotel's own rules are linked below.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const format = useFormat()
const access = useAccess()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const { hotels } = useHotelScope()
useSeoMeta({ title: () => t('nav.bookingSettings') })

const allowed = computed(() => access.value.can('booking.view'))
const canManage = computed(() => access.value.can('booking.settings') && access.value.hasAllHotels)
const settings = useApiQuery(['booking-settings'], () => api<BookingSettingsDto>('/booking-settings'), { enabled: allowed })
// A refetch refreshes the form only while nothing is being edited; only this person's changes are sent.
const { form, changes, load } = useEditForm(() => settings.data.value, bookingSettingsFormOf, bookingSettingsPatchOf)
const validateFields = validateWith(bookingSettingsPatchSchema, key => t(key), bookingSettingsRequestOf)
const validate = (state: BookingSettingsForm) => [
  ...validateFields(state),
  ...(ageLimitsAgree(state) ? [] : [{ name: 'infantAgeLimit', message: t('bookingSettings.infantAboveChild') }]),
]
const save = useMutation({
  mutationFn: () => api<BookingSettingsDto>('/booking-settings', { method: 'PATCH', body: changes.value }),
  onSuccess: (saved) => {
    load(saved)
    queryClient.setQueryData(['booking-settings'], saved)
    notify.done(t('bookingSettings.saved'))
  },
})
const sides = computed(() => CHILD_SIDES.map(value => ({ value, label: t(`bookingSettings.side.${value}`) })))
const hotelLinks = computed(() => hotels.items.value.filter(h => access.value.canInHotel('booking.view', h.id)))
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader :title="t('nav.bookingSettings')" :description="t('bookingSettings.help')" />
    <EmptyState v-if="!allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <p v-if="!canManage" class="flex items-center gap-2 text-(--fg-muted)"><UIcon name="i-lucide-lock" class="size-4" />{{ t('bookingSettings.readOnly') }}</p>
      <ErrorState v-if="settings.error.value" :error="settings.error.value" @retry="settings.refetch()" />
      <USkeleton v-else-if="!form" class="h-96 max-w-3xl" />
      <UForm v-else :state="form" :validate="validate" :disabled="!canManage || save.isPending.value" class="flex max-w-3xl flex-col gap-6" @submit="save.mutate()">
        <section aria-labelledby="holds-heading" class="surface-panel flex flex-col gap-4 p-6">
          <h2 id="holds-heading" class="text-section">{{ t('bookingSettings.holds') }}</h2>
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField :label="t('bookingSettings.holdMinutes')" :help="t('bookingSettings.holdMinutesHelp')" name="holdMinutes" required><UInputNumber v-model="form.holdMinutes" :min="1" :max="120" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.requestHours')" :help="t('bookingSettings.requestHoursHelp')" name="requestHours" required><UInputNumber v-model="form.requestHours" :min="1" :max="168" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.quoteValidityHours')" :help="t('bookingSettings.quoteValidityHoursHelp')" name="quoteValidityHours" required><UInputNumber v-model="form.quoteValidityHours" :min="1" :max="720" class="w-full" /></UFormField>
          </div>
        </section>

        <section aria-labelledby="customers-heading" class="surface-panel flex flex-col gap-4 p-6">
          <h2 id="customers-heading" class="text-section">{{ t('bookingSettings.customers') }}</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="t('bookingSettings.individualMaxRooms')" name="individualMaxRooms" required><UInputNumber v-model="form.individualMaxRooms" :min="1" :max="50" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.individualMaxOpenRequests')" name="individualMaxOpenRequests" required><UInputNumber v-model="form.individualMaxOpenRequests" :min="1" :max="10" class="w-full" /></UFormField>
          </div>
        </section>

        <section aria-labelledby="children-heading" class="surface-panel flex flex-col gap-4 p-6">
          <h2 id="children-heading" class="text-section">{{ t('bookingSettings.children') }}</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="t('bookingSettings.childAgeLimit')" :help="t('bookingSettings.childAgeLimitHelp')" name="childAgeLimit" required><UInputNumber v-model="form.childAgeLimit" :min="1" :max="18" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.infantAgeLimit')" :help="t('bookingSettings.infantAgeLimitHelp')" name="infantAgeLimit" required><UInputNumber v-model="form.infantAgeLimit" :min="1" :max="5" class="w-full" /></UFormField>
          </div>
          <UFormField name="childDefaultSide"><URadioGroup v-model="form.childDefaultSide" :items="sides" :legend="t('bookingSettings.childDefaultSide')" orientation="horizontal" /></UFormField>
        </section>

        <section aria-labelledby="details-heading" class="surface-panel flex flex-col gap-4 p-6">
          <h2 id="details-heading" class="text-section">{{ t('bookingSettings.details') }}</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="t('bookingSettings.detailsReminderDays')" :help="t('bookingSettings.detailsReminderDaysHelp')" name="detailsReminderDays" required><UInputNumber v-model="form.detailsReminderDays" :min="0" :max="60" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.passportMinValidityMonths')" :help="t('bookingSettings.passportMinValidityMonthsHelp')" name="passportMinValidityMonths" required><UInputNumber v-model="form.passportMinValidityMonths" :min="0" :max="24" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.passportImageRetentionMonths')" :help="t('bookingSettings.passportImageRetentionMonthsHelp')" name="passportImageRetentionMonths" required><UInputNumber v-model="form.passportImageRetentionMonths" :min="1" :max="120" class="w-full" /></UFormField>
            <UFormField :label="t('bookingSettings.guestDataRetentionMonths')" :help="t('bookingSettings.guestDataRetentionMonthsHelp')" name="guestDataRetentionMonths" required><UInputNumber v-model="form.guestDataRetentionMonths" :min="1" :max="120" class="w-full" /></UFormField>
          </div>
          <UFormField name="passportAiAllowed" :help="t('bookingSettings.passportAiAllowedHelp')"><USwitch v-model="form.passportAiAllowed" :label="t('bookingSettings.passportAiAllowed')" /></UFormField>
        </section>

        <section aria-labelledby="desk-heading" class="surface-panel flex flex-col gap-4 p-6">
          <h2 id="desk-heading" class="text-section">{{ t('bookingSettings.desk') }}</h2>
          <UFormField name="noShowReleasesSeats" :help="t('bookingSettings.noShowReleasesSeatsHelp')"><USwitch v-model="form.noShowReleasesSeats" :label="t('bookingSettings.noShowReleasesSeats')" /></UFormField>
        </section>

        <section aria-labelledby="whatsapp-heading" class="surface-panel flex flex-col gap-4 p-6">
          <h2 id="whatsapp-heading" class="text-section">{{ t('bookingSettings.whatsapp') }}</h2>
          <UFormField :label="t('bookingSettings.whatsappNumber')" :help="t('bookingSettings.whatsappNumberHelp')" :hint="t('common.optional')" name="whatsappNumber"><UInput v-model="form.whatsappNumber" inputmode="numeric" dir="ltr" class="w-full sm:w-64" /></UFormField>
          <UFormField :label="t('bookingSettings.whatsappTemplate')" :help="t('bookingSettings.whatsappTemplateHelp')" :hint="t('common.optional')" name="whatsappTemplate"><UTextarea v-model="form.whatsappTemplate" :rows="3" :maxlength="1000" class="w-full" /></UFormField>
        </section>

        <UAlert v-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div v-if="canManage" class="flex flex-wrap items-center gap-3">
          <UButton type="submit" :loading="save.isPending.value" :disabled="!Object.keys(changes).length">{{ t('bookingSettings.save') }}</UButton>
          <span v-if="settings.data.value" class="text-small text-(--fg-muted)">{{ t('bookingSettings.updatedAt', { time: format.dateTime(settings.data.value.updatedAt) }) }}</span>
        </div>
      </UForm>

      <section v-if="hotelLinks.length" aria-labelledby="hotels-heading" class="flex max-w-3xl flex-col gap-3">
        <h2 id="hotels-heading" class="text-section">{{ t('bookingSettings.hotelRules') }}</h2>
        <p class="text-(--fg-muted)">{{ t('bookingSettings.hotelRulesHelp') }}</p>
        <ul class="flex flex-wrap gap-2">
          <li v-for="hotel in hotelLinks" :key="hotel.id">
            <UButton :to="`/hotels/${encodeURIComponent(hotel.code)}/booking-rules`" color="neutral" variant="outline" icon="i-lucide-scale"><bdi>{{ hotel.name }}</bdi></UButton>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
