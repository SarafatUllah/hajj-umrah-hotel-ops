<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { CHILD_SIDES } from '@hajj/contracts/constants/booking'
import { customerStaySearchSchema } from '@hajj/contracts/schemas/booking'
import { leadPilgrimSchema } from '@hajj/contracts/schemas/guest'
import type { BookingDetailDto, StaySearchResult } from '@hajj/contracts/types/booking'
import type { PublicHotel } from '@hajj/contracts/types/hotel'
import type { GuestFieldValues } from '~/utils/guest'

definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const organization = useRuntimeConfig().public.organizationSlug
useSeoMeta({ title: () => t('book.title'), robots: 'noindex' })

const { data: hotels, error: hotelsError, refetch: refetchHotels } = useApiQuery(['public-hotels', organization], () => api<PublicHotel[]>('/public/hotels', { query: { organization } }))
const hotelItems = computed(() => (hotels.value ?? []).map(h => ({ value: h.id, label: `${h.name} · ${h.city}` })))

const form = reactive<StayForm>({
  hotelId: typeof route.query.hotel === 'string' ? route.query.hotel : '',
  checkIn: '',
  checkOut: '',
  bookingType: 'FAMILY',
  totalCount: 2,
  maleCount: 1,
  femaleCount: 1,
  childCount: 0,
  infantCount: 0,
  childSide: 'MOTHER',
})
// A hotel named in the link that is not (or no longer) on sale is not pre-chosen.
watch(hotels, (list) => {
  if (list && form.hotelId && !list.some(h => h.id === form.hotelId)) form.hotelId = ''
}, { immediate: true })
const types = computed(() => (['FAMILY', 'GROUP'] as const).map(value => ({ value, label: t(`booking.type.${value}`) })))
const childSides = computed(() => CHILD_SIDES.map(value => ({ value, label: t(`booking.childSide.${value}`) })))
const validateStay = validateWith(customerStaySearchSchema, key => t(key), searchRequestOf)

// Step 2: the options for exactly this form; any change of the form asks again.
const result = ref<StaySearchResult | null>(null)
const chosen = ref<number | null>(null)
watch(form, () => {
  result.value = null
  chosen.value = null
})
const search = useMutation({
  mutationFn: () => api<StaySearchResult>('/customer/stays/search', { method: 'POST', body: searchRequestOf(form) }),
  onSuccess: (found) => {
    result.value = found
    chosen.value = null
  },
})

// Step 3: the lead pilgrim's passport, and the request.
const lead = ref<GuestFieldValues>({ fullName: '' })
const validateLead = validateWith(leadPilgrimSchema, key => t(key))
const request = useMutation({
  mutationFn: () => api<BookingDetailDto>('/customer/bookings', {
    method: 'POST',
    body: { ...searchRequestOf(form), rooms: chosenRoomsOf(result.value!.options[chosen.value!]!), lead: leadPilgrimSchema.parse(lead.value) },
  }),
  onSuccess: async (booking) => {
    await queryClient.invalidateQueries({ queryKey: ['customer-bookings'] })
    await navigateTo(`/bookings/${booking.id}`)
  },
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader :title="t('book.title')" />
    <ErrorState v-if="hotelsError" :error="hotelsError" @retry="refetchHotels()" />

    <UForm :state="form" :validate="validateStay" class="surface-panel flex flex-col gap-4 p-6" @submit="search.mutate()">
      <UFormField :label="t('book.hotel')" name="hotelId" required>
        <USelect v-model="form.hotelId" :items="hotelItems" class="w-full" />
      </UFormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="t('book.checkIn')" name="checkIn" required>
          <UInput v-model="form.checkIn" type="date" dir="ltr" class="w-full" />
        </UFormField>
        <UFormField :label="t('book.checkOut')" name="checkOut" required>
          <UInput v-model="form.checkOut" type="date" dir="ltr" :min="form.checkIn || undefined" class="w-full" />
        </UFormField>
      </div>
      <UFormField :label="t('book.type')" :help="t('book.typeHelp')" name="bookingType">
        <URadioGroup v-model="form.bookingType" :items="types" orientation="horizontal" />
      </UFormField>
      <div v-if="form.bookingType === 'FAMILY'" class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="t('book.total')" name="totalCount" required>
          <UInputNumber v-model="form.totalCount" :min="1" :max="50" class="w-full" />
        </UFormField>
      </div>
      <div v-else class="grid gap-4 sm:grid-cols-3">
        <UFormField :label="t('book.men')" name="maleCount">
          <UInputNumber v-model="form.maleCount" :min="0" :max="600" class="w-full" />
        </UFormField>
        <UFormField :label="t('book.women')" name="femaleCount">
          <UInputNumber v-model="form.femaleCount" :min="0" :max="600" class="w-full" />
        </UFormField>
        <UFormField :label="t('book.children')" name="childCount">
          <UInputNumber v-model="form.childCount" :min="0" :max="600" class="w-full" />
        </UFormField>
        <UFormField v-if="form.childCount > 0" :label="t('book.childSide')" name="childSide" class="sm:col-span-3">
          <URadioGroup v-model="form.childSide" :items="childSides" />
        </UFormField>
      </div>
      <UFormField :label="t('book.infants')" :help="t('book.infantsHelp')" name="infantCount" class="sm:max-w-xs">
        <UInputNumber v-model="form.infantCount" :min="0" :max="100" class="w-full" />
      </UFormField>
      <UAlert v-if="search.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(search.error.value)" role="alert" />
      <UButton type="submit" :loading="search.isPending.value" icon="i-lucide-search" class="self-start">{{ t('book.search') }}</UButton>
    </UForm>

    <section v-if="result" aria-labelledby="options-heading" class="flex flex-col gap-4">
      <h2 id="options-heading" class="text-section">{{ t('book.options') }}</h2>
      <EmptyState v-if="!result.options.length" :title="t('book.noOptions')" icon="i-lucide-bed-double" />
      <template v-for="(option, index) in result.options" :key="index">
        <OptionCard v-if="chosen === null || chosen === index" :option="option" :index="index" :selected="chosen === index" @choose="chosen = index" />
      </template>
      <UButton v-if="chosen !== null" color="neutral" variant="ghost" class="self-start" @click="chosen = null">{{ t('book.changeOption') }}</UButton>
    </section>

    <section v-if="result && chosen !== null" aria-labelledby="lead-heading" class="flex flex-col gap-4">
      <h2 id="lead-heading" class="text-section">{{ t('book.lead') }}</h2>
      <p class="text-(--fg-muted)">{{ t('book.leadHelp') }}</p>
      <UForm :state="lead" :validate="validateLead" class="surface-panel flex flex-col gap-4 p-6" @submit="request.mutate()">
        <GuestFields v-model="lead" required />
        <p class="text-small text-(--fg-muted)">{{ t('book.requestNote') }}</p>
        <UAlert v-if="request.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(request.error.value)" role="alert" />
        <UButton type="submit" :loading="request.isPending.value" icon="i-lucide-send" class="self-start">{{ t('book.request') }}</UButton>
      </UForm>
    </section>
  </div>
</template>
