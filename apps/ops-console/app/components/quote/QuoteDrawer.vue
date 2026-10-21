<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { PRICE_UNITS } from '@hajj/contracts/constants/pricing'
import { quoteDeclineSchema, quoteOfferSchema } from '@hajj/contracts/schemas/quote'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { OfferedQuote, QuoteDto } from '@hajj/contracts/types/quote'
import { heldWhile } from '../../utils/forms'

/**
 * One WhatsApp quote (v7 §8): who asked, for which hotel, stay and head count, and where it stands. With
 * `quote.manage`, while it is open (requested or offered): set the agreed price — per person or per room and night,
 * VAT included or not, valid for some hours (the booking setting when left empty) — or decline it with a reason (kept
 * in the audit, not shown to the agency). A price above the hotel's highest public rate is accepted, with a warning.
 * `quote` is the one to show (the page keeps the last one while the drawer closes); `open` says whether it is shown.
 */
const props = defineProps<{ quote: QuoteDto | null, open: boolean, hotel: HotelSummary | undefined, canManage: boolean }>()
const emit = defineEmits<{ close: [], changed: [message: string] }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const toast = useToast()
const errorMessage = useErrorMessage()

const decidable = computed(() => props.quote !== null && ['REQUESTED', 'OFFERED'].includes(props.quote.status))
const offerForm = ref({ riyals: undefined as number | undefined, unit: 'PER_PERSON_NIGHT' as typeof PRICE_UNITS[number], vatIncluded: true, validHours: undefined as number | undefined })
const declineForm = ref({ reason: '' })
// An empty amount stays empty (required), never an offer of nothing.
const offerBody = (state: typeof offerForm.value) => ({
  amountHalalas: typeof state.riyals === 'number' && Number.isFinite(state.riyals) ? toHalalas(state.riyals) : undefined,
  unit: state.unit,
  vatIncluded: state.vatIncluded,
  validHours: state.validHours || undefined,
})
const validateOffer = validateWith(quoteOfferSchema, key => t(key), offerBody)
const validateDecline = validateWith(quoteDeclineSchema, key => t(key))
const offer = useMutation({
  mutationFn: () => api<OfferedQuote>(`/quotes/${props.quote!.id}/offer`, { method: 'POST', body: offerBody(offerForm.value) }),
  onSuccess: (offered) => {
    if (offered.aboveHighestPublicRate) toast.add({ title: t('quotes.aboveRate'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    emit('changed', t('quotes.offered', { ref: offered.quote.refNo }))
  },
})
const decline = useMutation({
  mutationFn: () => api<QuoteDto>(`/quotes/${props.quote!.id}/decline`, { method: 'POST', body: quoteDeclineSchema.parse(declineForm.value) }),
  onSuccess: declined => emit('changed', t('quotes.declined', { ref: declined.refNo })),
})
const pending = computed(() => offer.isPending.value || decline.isPending.value)
// Each time a quote opens, its forms start again (its price so far, or empty; no reason). The same quote refreshed
// in the background while it is open keeps what is being typed.
watch([() => props.open, () => props.quote?.id], ([isOpen]) => {
  const quote = props.quote
  if (!isOpen || !quote) return
  offerForm.value = { riyals: quote.amountHalalas === null ? undefined : toRiyals(quote.amountHalalas), unit: quote.unit ?? 'PER_PERSON_NIGHT', vatIncluded: quote.vatIncluded ?? true, validHours: undefined }
  declineForm.value = { reason: '' }
  offer.reset()
  decline.reset()
}, { immediate: true })
const units = computed(() => PRICE_UNITS.map(value => ({ value, label: t(`booking.priceUnit.${value}`) })))
const people = (quote: QuoteDto) => (quote.bookingType === 'GROUP'
  ? `${t('stay.men')} ${quote.maleCount} · ${t('stay.women')} ${quote.femaleCount}`
  : t('quotes.familyOf', { count: quote.totalCount }, quote.totalCount))
</script>

<template>
  <USlideover v-bind="heldWhile(pending)" :open="open" :title="quote ? t('quotes.number', { ref: quote.refNo }) : ''" :description="quote ? (quote.agencyName ?? t('bookings.agency')) : ''" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <div v-if="quote" class="flex flex-col gap-5">
        <HotelStamp v-if="hotel" :hotel="hotel" />
        <dl class="grid grid-cols-2 gap-3 text-small">
          <div><dt class="text-caption text-(--fg-muted)">{{ t('bookings.stay') }}</dt><dd><StayDates :check-in="quote.checkIn" :check-out="quote.checkOut" /></dd></div>
          <div><dt class="text-caption text-(--fg-muted)">{{ t('bookings.pilgrims') }}</dt><dd>{{ quote.totalCount }} · {{ t(`booking.type.${quote.bookingType}`) }}<span class="block text-(--fg-muted)">{{ people(quote) }}</span></dd></div>
          <div><dt class="text-caption text-(--fg-muted)">{{ t('bookings.status') }}</dt><dd><StatusBadge domain="quote" :value="quote.status" /></dd></div>
          <div v-if="quote.amountHalalas !== null">
            <dt class="text-caption text-(--fg-muted)">{{ t('quotes.price') }}</dt>
            <dd><MoneyText :halalas="quote.amountHalalas" /> {{ quote.unit ? t(`booking.priceUnit.${quote.unit}`) : '' }}<span v-if="quote.validUntil" class="block text-(--fg-muted)">{{ t('quotes.validUntil', { time: format.dateTime(quote.validUntil, hotel?.timezone) }) }}</span></dd>
          </div>
          <div v-if="quote.notes" class="col-span-2"><dt class="text-caption text-(--fg-muted)">{{ t('bookings.notes') }}</dt><dd><bdi>{{ quote.notes }}</bdi></dd></div>
        </dl>

        <template v-if="canManage && decidable">
          <UForm :state="offerForm" :validate="validateOffer" class="surface-panel flex flex-col gap-4 p-4" @submit="offer.mutate()">
            <h3 class="text-subsection">{{ quote.status === 'OFFERED' ? t('quotes.reoffer') : t('quotes.offer') }}</h3>
            <div class="grid grid-cols-2 gap-4">
              <UFormField :label="t('quotes.amount')" name="amountHalalas" required>
                <UInputNumber v-model="offerForm.riyals" :min="0" :step="0.01" :format-options="{ minimumFractionDigits: 2, maximumFractionDigits: 2 }" class="w-full" />
              </UFormField>
              <UFormField :label="t('quotes.validHours')" :help="t('quotes.validHoursHelp')" name="validHours">
                <UInputNumber v-model="offerForm.validHours" :min="1" :max="720" class="w-full" />
              </UFormField>
            </div>
            <URadioGroup v-model="offerForm.unit" :items="units" :legend="t('quotes.unit')" />
            <USwitch v-model="offerForm.vatIncluded" :label="t('quotes.vatIncluded')" />
            <UAlert v-if="offer.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(offer.error.value)" role="alert" />
            <UButton type="submit" :loading="offer.isPending.value" :disabled="decline.isPending.value" class="self-start">{{ t('quotes.sendOffer') }}</UButton>
          </UForm>
          <UForm :state="declineForm" :validate="validateDecline" class="flex flex-col gap-3" @submit="decline.mutate()">
            <UFormField :label="t('quotes.declineReason')" :help="t('quotes.declineHelp')" name="reason">
              <UTextarea v-model="declineForm.reason" :rows="2" :maxlength="500" class="w-full" />
            </UFormField>
            <UAlert v-if="decline.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(decline.error.value)" role="alert" />
            <UButton type="submit" color="error" variant="outline" :loading="decline.isPending.value" :disabled="offer.isPending.value" class="self-start">{{ t('quotes.decline') }}</UButton>
          </UForm>
        </template>
      </div>
    </template>
  </USlideover>
</template>
