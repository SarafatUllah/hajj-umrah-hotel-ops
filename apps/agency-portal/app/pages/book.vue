<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { staySearchSchema } from '@hajj/contracts/schemas/booking'
import type { HeldBooking, StaySearchResult } from '@hajj/contracts/types/booking'
import type { QuoteDto, QuotePage } from '@hajj/contracts/types/quote'

definePageMeta({ middleware: ['auth', 'approved'] })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const format = useFormat()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const hotels = useHotels()
useSeoMeta({ title: () => t('book.title') })

const form = ref<StayForm>({ hotelId: '', checkIn: '', checkOut: '', bookingType: 'GROUP', totalCount: 2, maleCount: 1, femaleCount: 1, childCount: 0, infantCount: 0, childSide: 'MOTHER' })

// v7 §8: an offered quote prices exactly its hotel, stay, type and head count — choosing one fills the form with them
// and fixes its hotel, nights and type (a group may still split its sides between adults and children). One page of
// the API's largest size: an agency has far fewer open offers.
const { data: offered } = useApiQuery(['agency-quotes', 'OFFERED'], () => api<QuotePage>('/agency/quotes', { query: { status: 'OFFERED', pageSize: 100 } }))
const quoteId = ref<string>(typeof route.query.quote === 'string' ? route.query.quote : 'NONE')
const quoteItems = computed(() => [
  { value: 'NONE', label: t('book.agencyPrice') },
  ...(offered.value?.items ?? []).map(q => ({ value: q.id, label: t('book.quoteOption', { ref: q.refNo, amount: format.money(q.amountHalalas ?? 0), unit: q.unit ? t(`booking.priceUnit.${q.unit}`) : '' }) })),
])
const quote = computed<QuoteDto | undefined>(() => offered.value?.items.find(q => q.id === quoteId.value))
watch(quote, (chosen) => {
  if (!chosen) return
  const bookingType = chosen.bookingType as StayForm['bookingType']
  form.value = { ...form.value, hotelId: chosen.hotelId, checkIn: chosen.checkIn, checkOut: chosen.checkOut, bookingType, totalCount: chosen.totalCount, maleCount: chosen.maleCount, femaleCount: chosen.femaleCount, childCount: 0 }
}, { immediate: true })

const request = () => ({ ...searchRequestOf(form.value), ...(quote.value ? { quoteId: quote.value.id } : {}) })
const validate = validateWith(staySearchSchema, key => t(key), () => request())

const { result, chosen, option, found, failed, question } = useStayOptions([form, quoteId])
const search = useMutation({
  mutationFn: (_asked: number) => api<StaySearchResult>('/agency/stays/search', { method: 'POST', body: request() }),
  onSuccess: (answer, asked) => {
    hold.reset()
    found(answer, null, asked)
  },
})
const hold = useMutation({
  mutationFn: () => api<HeldBooking>('/agency/bookings', { method: 'POST', body: { ...request(), rooms: chosenRoomsOf(option.value!) } }),
  onSuccess: async (held) => {
    await queryClient.invalidateQueries({ queryKey: ['agency-bookings'] })
    await navigateTo(`/bookings/${held.id}`)
  },
  onError: failed,
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader :title="t('book.title')" />
    <ErrorState v-if="hotels.error.value" :error="hotels.error.value" @retry="hotels.refetch()" />

    <UForm :state="form" :validate="validate" class="surface-panel flex flex-col gap-4 p-6" @submit="search.mutate(question())">
      <UFormField :label="t('book.quote')" :help="t('book.quoteHelp')" name="quoteId">
        <USelect v-model="quoteId" :items="quoteItems" class="w-full" />
      </UFormField>
      <StayFormFields v-model="form" :hotels="hotels.items.value" :fixed="!!quote" />
      <UAlert v-if="search.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(search.error.value)" role="alert" />
      <!-- A hold refused because its rooms went meanwhile forgets the options: shown here, above the new search. -->
      <UAlert v-if="hold.error.value && !result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(hold.error.value)" role="alert" />
      <UButton type="submit" :loading="search.isPending.value" icon="i-lucide-search" class="self-start">{{ t('stay.search') }}</UButton>
    </UForm>

    <section v-if="result" aria-labelledby="options-heading" class="flex flex-col gap-4">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="options-heading" class="text-section">{{ t('stay.options') }}</h2>
        <span v-if="result.quotaHeadroom !== null" class="text-(--fg-muted)">{{ t('book.quota', { count: result.quotaHeadroom }) }}</span>
      </div>
      <EmptyState v-if="!result.options.length" :title="t('stay.noOptions')" icon="i-lucide-bed-double" />
      <template v-for="(candidate, index) in result.options" :key="index">
        <OptionCard v-if="chosen === null || chosen === index" :option="candidate" :index="index" :selected="chosen === index" @choose="chosen = index" />
      </template>
      <template v-if="chosen !== null">
        <p class="text-small text-(--fg-muted)">{{ t('book.holdNote') }}</p>
        <UAlert v-if="hold.error.value && result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(hold.error.value)" role="alert" />
        <div class="flex flex-wrap gap-2">
          <UButton :loading="hold.isPending.value" icon="i-lucide-lock" @click="hold.mutate()">{{ t('book.hold') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="chosen = null">{{ t('stay.changeOption') }}</UButton>
        </div>
      </template>
    </section>
  </div>
</template>
