<script setup lang="ts">
import { keepPreviousData, useQueryClient } from '@tanstack/vue-query'
import { QUOTE_STATUSES, type QuoteStatus } from '@hajj/contracts/constants/pricing'
import type { QuoteDto, QuotePage } from '@hajj/contracts/types/quote'

/**
 * WhatsApp quotes (v7 §8): the agencies' price requests of the hotels this user sees (or the switcher's hotel), the
 * open ones first by default — reference, agency, hotel, stay, head count, status and price. One opens in a drawer to
 * set its price or decline it (`quote.manage`); a new one can be opened on an agency's behalf.
 */
definePageMeta({ middleware: 'auth', scope: 'portfolio' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const access = useAccess()
const queryClient = useQueryClient()
const { queryOf, setQuery, pageOf } = useUrlQuery()
const { hotels, current } = useHotelScope()
useSeoMeta({ title: () => t('nav.quotes') })
const PAGE_SIZE = 25
const ALL = 'ALL'

const status = computed<QuoteStatus | typeof ALL>({
  get: () => {
    const asked = queryOf('status')
    if (asked === ALL) return ALL
    return QUOTE_STATUSES.find(s => s === asked) ?? 'REQUESTED'
  },
  set: value => setQuery({ status: value === 'REQUESTED' ? undefined : value, page: undefined }),
})
const seesAgencies = computed(() => access.value.can('agency.view'))
const agencies = useAgencies(seesAgencies)
const agency = computed({ get: () => queryOf('agency') ?? ALL, set: (value: string) => setQuery({ agency: value === ALL ? undefined : value, page: undefined }) })
const page = pageOf()
const quotes = useApiQuery(
  () => ['quotes', current.value?.id ?? ALL, status.value, agency.value, page.value],
  () => api<QuotePage>('/quotes', { query: { hotelId: current.value?.id, status: status.value === ALL ? undefined : status.value, agencyId: agency.value === ALL ? undefined : agency.value, page: page.value, pageSize: PAGE_SIZE } }),
  { enabled: computed(() => !!hotels.data.value), placeholderData: keepPreviousData },
)
const statusItems = computed(() => [...QUOTE_STATUSES.map(value => ({ value, label: t(`status.quote.${value}`) })), { value: ALL, label: t('quotes.allStatuses') }])
const agencyItems = computed(() => [{ value: ALL, label: t('bookings.allAgencies') }, ...agencies.items.value])
const showHotel = computed(() => !current.value && hotels.items.value.length > 1)
const canCreate = computed(() => seesAgencies.value && hotels.items.value.some(h => h.status === 'ACTIVE' && access.value.canInHotel('quote.manage', h.id)))
const quoteHotels = computed(() => hotels.items.value.filter(h => h.status === 'ACTIVE' && access.value.canInHotel('quote.manage', h.id)).map(h => ({ value: h.id, label: h.name })))

// The open quote: its id in the URL (shareable), the quote itself from the list or asked on its own.
const openId = computed(() => queryOf('quote') ?? null)
const fromList = computed(() => quotes.data.value?.items.find(q => q.id === openId.value))
const single = useApiQuery(() => ['quote', openId.value ?? ''], () => api<QuoteDto>(`/quotes/${openId.value}`), { enabled: computed(() => !!openId.value && !quotes.isPending.value && !fromList.value) })
const opened = computed(() => fromList.value ?? single.data.value ?? null)
/** The quote in the drawer: the last one opened stays while it closes, so it does not empty itself mid-animation. */
const shown = ref<QuoteDto | null>(null)
watch(opened, (quote) => { if (quote) shown.value = quote }, { immediate: true })
// A link to a quote that cannot be shown (gone, or of a hotel this user does not see) says why and leaves the URL.
watch(() => single.error.value, (error) => {
  if (!error) return
  notify.failed(error)
  closeQuote()
})
const openQuote = (quote: QuoteDto) => setQuery({ quote: quote.id })
const closeQuote = () => setQuery({ quote: undefined })
const canManage = (quote: QuoteDto) => {
  const hotel = hotels.byId(quote.hotelId)
  return !!hotel && hotel.status === 'ACTIVE' && access.value.canInHotel('quote.manage', hotel.id)
}
async function changed(message: string): Promise<void> {
  notify.done(message)
  closeQuote()
  await Promise.all([queryClient.invalidateQueries({ queryKey: ['quotes'] }), queryClient.invalidateQueries({ queryKey: ['quote'] })])
}
const creating = ref(false)
async function created(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['quotes'] })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('nav.quotes')" :description="current?.name">
      <template #actions>
        <UButton v-if="canCreate" icon="i-lucide-plus" @click="creating = true">{{ t('quotes.new') }}</UButton>
      </template>
    </PageHeader>
    <div class="flex flex-wrap gap-2">
      <USelect v-model="status" :items="statusItems" :aria-label="t('bookings.statusLabel')" class="w-44" />
      <USelect v-if="seesAgencies" v-model="agency" :items="agencyItems" :aria-label="t('bookings.agency')" class="w-56" />
    </div>
    <ErrorState v-if="quotes.error.value" :error="quotes.error.value" @retry="quotes.refetch()" />
    <div v-else-if="quotes.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 6" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!quotes.data.value?.items.length" :title="status === 'REQUESTED' ? t('quotes.noneOpen') : t('quotes.none')" icon="i-lucide-message-square-quote" />
    <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': quotes.isPlaceholderData.value }">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('quotes.reference') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('newBooking.agency') }}</th>
            <th v-if="showHotel" scope="col" class="px-4 py-2 text-start">{{ t('bookings.hotel') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.stay') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('bookings.pilgrims') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.status') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('quotes.price') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="quote in quotes.data.value.items" :key="quote.id">
            <td class="px-4 py-2">
              <button type="button" class="font-semibold tabular text-(--primary) hover:underline" dir="ltr" @click="openQuote(quote)">{{ quote.refNo }}</button>
            </td>
            <td class="px-4 py-2"><bdi>{{ quote.agencyName ?? t('bookings.agency') }}</bdi></td>
            <td v-if="showHotel" class="px-4 py-2"><bdi>{{ hotels.byId(quote.hotelId)?.name ?? '' }}</bdi></td>
            <td class="whitespace-nowrap px-4 py-2"><StayDates :check-in="quote.checkIn" :check-out="quote.checkOut" /></td>
            <td class="px-4 py-2 text-end tabular">{{ quote.totalCount }}<span class="block text-caption text-(--fg-muted)">{{ t(`booking.type.${quote.bookingType}`) }}</span></td>
            <td class="px-4 py-2"><StatusBadge domain="quote" :value="quote.status" /></td>
            <td class="px-4 py-2 text-end">
              <template v-if="quote.amountHalalas !== null"><MoneyText :halalas="quote.amountHalalas" /><span class="block text-caption text-(--fg-muted)">{{ quote.unit ? t(`booking.priceUnit.${quote.unit}`) : '' }}</span></template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <UPagination v-if="(quotes.data.value?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="quotes.data.value!.total" :items-per-page="PAGE_SIZE" class="self-center" />
    <QuoteDrawer :open="!!opened" :quote="shown" :hotel="shown ? hotels.byId(shown.hotelId) : undefined" :can-manage="!!shown && canManage(shown)" @close="closeQuote" @changed="changed" />
    <NewQuoteDrawer v-model:open="creating" :hotels="quoteHotels" :agencies="agencies.approved.value" :hotel-id="current?.id" @created="created" />
  </div>
</template>
