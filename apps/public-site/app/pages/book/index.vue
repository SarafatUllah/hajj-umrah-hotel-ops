<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { customerStaySearchSchema } from '@hajj/contracts/schemas/booking'
import { leadPilgrimSchema } from '@hajj/contracts/schemas/guest'
import type { BookingDetailDto, StaySearchResult } from '@hajj/contracts/types/booking'

definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
useSeoMeta({ title: () => t('book.title'), robots: 'noindex' })

const { data: hotels, error: hotelsError, refetch: refetchHotels } = usePublicHotels()
const hotelItems = computed(() => (hotels.value ?? []).map(h => ({ value: h.id, label: `${h.name} · ${h.city}` })))

const form = ref<StayForm>({
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
  if (list && form.value.hotelId && !list.some(h => h.id === form.value.hotelId)) form.value = { ...form.value, hotelId: '' }
}, { immediate: true })
const validateStay = validateWith(customerStaySearchSchema, key => t(key), searchRequestOf)

// Step 2: the options for exactly this form; any change of the form asks again.
const { result, chosen, option, found, failed, question } = useStayOptions(form)
const search = useMutation({
  mutationFn: (_asked: number) => api<StaySearchResult>('/customer/stays/search', { method: 'POST', body: searchRequestOf(form.value) }),
  onSuccess: (answer, asked) => {
    request.reset()
    found(answer, null, asked)
  },
})

// Step 3: the lead pilgrim's passport, and the request.
const lead = ref<GuestFieldValues>({ fullName: '' })
const validateLead = validateWith(leadPilgrimSchema, key => t(key))
const request = useMutation({
  mutationFn: () => api<BookingDetailDto>('/customer/bookings', {
    method: 'POST',
    body: { ...searchRequestOf(form.value), rooms: chosenRoomsOf(option.value!), lead: leadPilgrimSchema.parse(lead.value) },
  }),
  onSuccess: async (booking) => {
    await queryClient.invalidateQueries({ queryKey: ['customer-bookings'] })
    await navigateTo(`/bookings/${booking.id}`)
  },
  // The rooms went meanwhile: the options are forgotten (the passport entered stays) and the reason shown above.
  onError: failed,
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader :title="t('book.title')" />
    <ErrorState v-if="hotelsError" :error="hotelsError" @retry="refetchHotels()" />

    <UForm :state="form" :validate="validateStay" class="surface-panel flex flex-col gap-4 p-6" @submit="search.mutate(question())">
      <StayFormFields v-model="form" :hotels="hotelItems" />
      <UAlert v-if="search.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(search.error.value)" role="alert" />
      <UAlert v-if="request.error.value && !result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(request.error.value)" role="alert" />
      <UButton type="submit" :loading="search.isPending.value" icon="i-lucide-search" class="self-start">{{ t('stay.search') }}</UButton>
    </UForm>

    <section v-if="result" aria-labelledby="options-heading" class="flex flex-col gap-4">
      <h2 id="options-heading" class="text-section">{{ t('stay.options') }}</h2>
      <EmptyState v-if="!result.options.length" :title="t('stay.noOptions')" icon="i-lucide-bed-double" />
      <template v-for="(candidate, index) in result.options" :key="index">
        <OptionCard v-if="chosen === null || chosen === index" :option="candidate" :index="index" :selected="chosen === index" @choose="chosen = index" />
      </template>
      <UButton v-if="chosen !== null" color="neutral" variant="ghost" class="self-start" @click="chosen = null">{{ t('stay.changeOption') }}</UButton>
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
