<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { staffStaySearchSchema } from '@hajj/contracts/schemas/booking'
import type { HeldBooking, StaySearchResult } from '@hajj/contracts/types/booking'
import type { QuoteDto, QuotePage } from '@hajj/contracts/types/quote'

/**
 * A booking on an agency's behalf (v7 §6): the agency (approved only), then the same search an agency makes — its
 * price or one of its offered quotes (a quote fixes its hotel, nights, type and head count, v7 §8) — the options, and
 * a hold. The booking opens on its page, to confirm there. Needs `booking.create` and `agency.view` (to choose the agency).
 */
definePageMeta({ middleware: 'auth', scope: 'portfolio' })
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const errorMessage = useErrorMessage()
const access = useAccess()
const queryClient = useQueryClient()
const { hotels, current } = useHotelScope()
useSeoMeta({ title: () => t('newBooking.title') })
const NONE = 'NONE'
const QUOTE_PAGE = 100

const allowed = computed(() => access.value.can('booking.create') && access.value.can('agency.view'))
const agencies = useAgencies(allowed)
const agencyId = ref('')
/** The hotels this user may book at: active ones they can access with `booking.create`. */
const hotelItems = computed(() => hotels.items.value
  .filter(h => h.status === 'ACTIVE' && access.value.canInHotel('booking.create', h.id))
  .map(h => ({ value: h.id, label: h.name })))
const form = ref<StayForm>({ hotelId: '', checkIn: '', checkOut: '', bookingType: 'GROUP', totalCount: 2, maleCount: 1, femaleCount: 1, childCount: 0, infantCount: 0, childSide: 'MOTHER' })
// The switcher's hotel comes first — when this user may book there (else the field stays to choose).
watch([current, hotelItems], ([hotel, items]) => {
  if (hotel && !form.value.hotelId && items.some(item => item.value === hotel.id)) form.value = { ...form.value, hotelId: hotel.id }
}, { immediate: true })
const notes = ref('')

const offered = useApiQuery(
  () => ['quotes', 'OFFERED', agencyId.value],
  () => api<QuotePage>('/quotes', { query: { status: 'OFFERED', agencyId: agencyId.value, pageSize: QUOTE_PAGE } }),
  { enabled: computed(() => !!agencyId.value) },
)
const quoteId = ref<string>(NONE)
watch(agencyId, () => { quoteId.value = NONE })
const quoteItems = computed(() => [
  { value: NONE, label: t('newBooking.agencyPrice') },
  ...(offered.data.value?.items ?? []).map(q => ({ value: q.id, label: t('newBooking.quoteOption', { ref: q.refNo, amount: format.money(q.amountHalalas ?? 0), unit: q.unit ? t(`booking.priceUnit.${q.unit}`) : '' }) })),
])
const quote = computed<QuoteDto | undefined>(() => offered.data.value?.items.find(q => q.id === quoteId.value))
watch(quote, (chosen) => {
  if (!chosen) return
  form.value = { ...form.value, hotelId: chosen.hotelId, checkIn: chosen.checkIn, checkOut: chosen.checkOut, bookingType: chosen.bookingType as StayForm['bookingType'], totalCount: chosen.totalCount, maleCount: chosen.maleCount, femaleCount: chosen.femaleCount, childCount: 0 }
})

const request = () => ({ ...searchRequestOf(form.value), agencyId: agencyId.value, ...(quote.value ? { quoteId: quote.value.id } : {}) })
const validate = validateWith(staffStaySearchSchema, key => t(key), () => request())
const { result, chosen, option, found, failed, question } = useStayOptions([form, quoteId, agencyId])
const search = useMutation({
  mutationFn: (_asked: number) => api<StaySearchResult>('/stays/search', { method: 'POST', body: request() }),
  onSuccess: (answer, asked) => {
    hold.reset()
    found(answer, null, asked)
  },
})
const hold = useMutation({
  mutationFn: () => api<HeldBooking>('/bookings', { method: 'POST', body: { ...request(), rooms: chosenRoomsOf(option.value!), notes: notes.value.trim() || undefined } }),
  onSuccess: async (held) => {
    notify.done(t('newBooking.held', { no: held.bookingNo }))
    await queryClient.invalidateQueries({ queryKey: ['bookings'] })
    await navigateTo(`/bookings/${held.id}`)
  },
  onError: failed,
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <UButton to="/bookings" color="neutral" variant="link" icon="i-lucide-arrow-left" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" class="self-start">{{ t('bookings.back') }}</UButton>
    <PageHeader :title="t('newBooking.title')" :description="t('newBooking.help')" />
    <EmptyState v-if="!allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <ErrorState v-if="agencies.error.value" :error="agencies.error.value" @retry="agencies.refetch()" />
      <UForm :state="form" :validate="validate" class="surface-panel flex flex-col gap-4 p-6" @submit="search.mutate(question())">
        <UFormField :label="t('newBooking.agency')" name="agencyId" required>
          <USelectMenu v-model="agencyId" :items="agencies.approved.value" value-key="value" :placeholder="t('newBooking.chooseAgency')" :loading="agencies.isPending.value" class="w-full sm:w-96" />
        </UFormField>
        <p v-if="agencies.data.value && !agencies.approved.value.length" class="text-(--fg-muted)">{{ t('newBooking.noAgencies') }}</p>
        <UFormField v-if="agencyId" :label="t('newBooking.quote')" name="quoteId">
          <USelect v-model="quoteId" :items="quoteItems" :loading="offered.isPending.value" class="w-full sm:w-96" />
        </UFormField>
        <StayFormFields v-model="form" :hotels="hotelItems" :fixed="!!quote" />
        <UAlert v-if="search.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(search.error.value)" role="alert" />
        <!-- A hold refused because its rooms went meanwhile forgets the options: shown here, above the new search. -->
        <UAlert v-if="hold.error.value && !result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(hold.error.value)" role="alert" />
        <UButton type="submit" :loading="search.isPending.value" :disabled="!agencyId" icon="i-lucide-search" class="self-start">{{ t('stay.search') }}</UButton>
      </UForm>

      <section v-if="result" aria-labelledby="options-heading" class="flex flex-col gap-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="options-heading" class="text-section">{{ t('stay.options') }}</h2>
          <span v-if="result.quotaHeadroom !== null" class="text-(--fg-muted)">{{ t('newBooking.quota', { count: result.quotaHeadroom }) }}</span>
        </div>
        <EmptyState v-if="!result.options.length" :title="t('stay.noOptions')" icon="i-lucide-bed-double" />
        <template v-for="(candidate, index) in result.options" :key="index">
          <OptionCard v-if="chosen === null || chosen === index" :option="candidate" :index="index" :selected="chosen === index" @choose="chosen = index" />
        </template>
        <template v-if="chosen !== null">
          <UFormField :label="t('newBooking.notes')" :hint="t('common.optional')">
            <UTextarea v-model="notes" :rows="2" :maxlength="1000" class="w-full" />
          </UFormField>
          <p class="text-small text-(--fg-muted)">{{ t('newBooking.holdNote') }}</p>
          <UAlert v-if="hold.error.value && result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(hold.error.value)" role="alert" />
          <div class="flex flex-wrap gap-2">
            <UButton :loading="hold.isPending.value" icon="i-lucide-lock" @click="hold.mutate()">{{ t('newBooking.hold') }}</UButton>
            <UButton color="neutral" variant="ghost" @click="chosen = null">{{ t('stay.changeOption') }}</UButton>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
