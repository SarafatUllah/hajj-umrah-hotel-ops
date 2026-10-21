<script setup lang="ts">
import { keepPreviousData, useMutation, useQueryClient } from '@tanstack/vue-query'
import { BOOKING_TYPES } from '@hajj/contracts/constants/booking'
import { quoteRequestSchema } from '@hajj/contracts/schemas/quote'
import type { QuotePage, RequestedQuote } from '@hajj/contracts/types/quote'

definePageMeta({ middleware: ['auth', 'approved'] })
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const hotels = usePublicHotels()
const PAGE_SIZE = 20
const page = ref(1)
useSeoMeta({ title: () => t('quotes.title') })
// Another page keeps the rows shown (dimmed) until it arrives.
const { data, error, isPending, isPlaceholderData, refetch } = useApiQuery(() => ['agency-quotes', 'ALL', page.value], () => api<QuotePage>('/agency/quotes', { query: { page: page.value, pageSize: PAGE_SIZE } }), { placeholderData: keepPreviousData })

// Ask for a price (v7 §8): a group's men and women (children counted on their side), a family's total.
const asking = ref(false)
const form = ref({ hotelId: '', bookingType: 'GROUP' as 'GROUP' | 'FAMILY', checkIn: '', checkOut: '', maleCount: 0, femaleCount: 0, totalCount: 1, notes: '' })
const toRequest = (state: typeof form.value) => (state.bookingType === 'GROUP'
  ? { ...state, totalCount: state.maleCount + state.femaleCount, notes: state.notes || undefined }
  : { ...state, maleCount: 0, femaleCount: 0, notes: state.notes || undefined })
const validate = validateWith(quoteRequestSchema, key => t(key), toRequest)
const types = computed(() => choiceItems(BOOKING_TYPES, value => t(`booking.type.${value}`)))
const sent = ref<RequestedQuote | null>(null)
const ask = useMutation({
  mutationFn: () => api<RequestedQuote>('/agency/quotes', { method: 'POST', body: toRequest(form.value) }),
  onSuccess: async (requested) => {
    sent.value = requested
    await queryClient.invalidateQueries({ queryKey: ['agency-quotes'] })
  },
})
function openAsk() {
  sent.value = null
  ask.reset()
  asking.value = true
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('quotes.title')">
      <template #actions>
        <UButton icon="i-lucide-message-circle" @click="openAsk">{{ t('quotes.ask') }}</UButton>
      </template>
    </PageHeader>
    <ErrorState v-if="error" :error="error" @retry="refetch()" />
    <div v-else-if="isPending" class="flex flex-col gap-3"><USkeleton v-for="n in 3" :key="n" class="h-16" /></div>
    <EmptyState v-else-if="!data?.items.length" :title="t('quotes.none')" icon="i-lucide-tag" />
    <ul v-else class="surface-panel divide-y divide-(--border)" :class="{ 'opacity-60': isPlaceholderData }" :aria-busy="isPlaceholderData">
      <li v-for="quote in data.items" :key="quote.id">
        <NuxtLink :to="`/quotes/${quote.id}`" class="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-(--surface-2)">
          <div class="flex flex-col gap-1">
            <span class="tabular font-medium" dir="ltr">{{ quote.refNo }}</span>
            <span class="text-(--fg-muted)"><bdi>{{ hotels.nameOf(quote.hotelId) }}</bdi> · <StayDates :check-in="quote.checkIn" :check-out="quote.checkOut" /> · {{ $t('common.pilgrims', quote.totalCount) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="quote.amountHalalas !== null"><MoneyText :halalas="quote.amountHalalas" /> <span class="text-small text-(--fg-muted)">{{ quote.unit ? t(`booking.priceUnit.${quote.unit}`) : '' }}</span></span>
            <StatusBadge domain="quote" :value="quote.status" />
          </div>
        </NuxtLink>
      </li>
    </ul>
    <UPagination v-if="(data?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="data!.total" :items-per-page="PAGE_SIZE" class="self-center" />

    <USlideover v-model:open="asking" :title="t('quotes.ask')" :description="t('quotes.askHelp')">
      <template #body>
        <div v-if="sent" class="flex flex-col gap-4" role="status">
          <p>{{ t('quotes.sent') }}</p>
          <p class="tabular" dir="ltr">{{ sent.quote.refNo }}</p>
          <UButton v-if="sent.whatsappLink" :to="sent.whatsappLink" target="_blank" rel="noopener noreferrer" icon="i-lucide-message-circle" class="self-start">{{ t('quotes.whatsapp') }}</UButton>
        </div>
        <UForm v-else :state="form" :validate="validate" class="flex flex-col gap-4" @submit="ask.mutate()">
          <UFormField :label="t('stay.hotel')" name="hotelId" required><USelect v-model="form.hotelId" :items="hotels.items.value" class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="t('stay.checkIn')" name="checkIn" required><UInput v-model="form.checkIn" type="date" dir="ltr" class="w-full" /></UFormField>
            <UFormField :label="t('stay.checkOut')" name="checkOut" required><UInput v-model="form.checkOut" type="date" dir="ltr" class="w-full" /></UFormField>
          </div>
          <UFormField :label="t('stay.type')" name="bookingType"><URadioGroup v-model="form.bookingType" :items="types" orientation="horizontal" /></UFormField>
          <div v-if="form.bookingType === 'GROUP'" class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="t('stay.men')" name="maleCount"><UInputNumber v-model="form.maleCount" :min="0" :max="10000" class="w-full" /></UFormField>
            <UFormField :label="t('stay.women')" name="femaleCount"><UInputNumber v-model="form.femaleCount" :min="0" :max="10000" class="w-full" /></UFormField>
          </div>
          <UFormField v-else :label="t('stay.total')" name="totalCount"><UInputNumber v-model="form.totalCount" :min="1" :max="10000" class="w-full" /></UFormField>
          <UFormField :label="t('quotes.notes')" name="notes"><UTextarea v-model="form.notes" :rows="3" class="w-full" /></UFormField>
          <UAlert v-if="ask.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(ask.error.value)" role="alert" />
          <UButton type="submit" :loading="ask.isPending.value" class="self-start">{{ t('quotes.send') }}</UButton>
        </UForm>
      </template>
    </USlideover>
  </div>
</template>
