<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { addGuestsSchema, guestAdditionSearchSchema } from '@hajj/contracts/schemas/booking'
import type { BookingDetailDto, StaySearchResult } from '@hajj/contracts/types/booking'

/**
 * v7 §12 "add a pilgrim" (the agency itself, or the hotel's staff): who joins, then where they sleep — the booking's
 * own free places first, at its price — then add them. Infants alone join the booking's rooms. `base` is the booking's
 * path in the API as the caller reaches it (`/agency/bookings/:id` or `/bookings/:id`).
 */
const props = defineProps<{ base: string, bookingType: string }>()
const emit = defineEmits<{ added: [] }>()
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const errorMessage = useErrorMessage()

const counts = ref({ maleCount: 0, femaleCount: 0, childCount: 0, infantCount: 0, totalCount: 0 })
const isGroup = computed(() => props.bookingType === 'GROUP')
/** The request: a group's total is its men, women and children. */
const request = () => (isGroup.value ? { ...counts.value, totalCount: counts.value.maleCount + counts.value.femaleCount + counts.value.childCount } : { infantCount: counts.value.infantCount, totalCount: counts.value.totalCount })
const validate = validateWith(guestAdditionSearchSchema, key => t(key), () => request())

const { result, chosen, option, found, failed, question } = useStayOptions(counts)
const search = useMutation({
  mutationFn: (_asked: number) => api<StaySearchResult>(`${props.base}/guests/search`, { method: 'POST', body: request() }),
  onSuccess: (answer, asked) => {
    add.reset()
    // Infants alone have one answer, the booking's own rooms: chosen already.
    found(answer, answer.options.length === 1 && answer.options[0]!.rooms.length === 0 ? 0 : null, asked)
  },
})
const add = useMutation({
  mutationFn: () => api<BookingDetailDto>(`${props.base}/guests`, { method: 'POST', body: addGuestsSchema.parse({ ...request(), rooms: chosenRoomsOf(option.value!) }) }),
  onSuccess: () => {
    toast.add({ title: t('additions.added'), color: 'success', icon: 'i-lucide-circle-check' })
    counts.value = { maleCount: 0, femaleCount: 0, childCount: 0, infantCount: 0, totalCount: 0 }
    emit('added')
  },
  onError: failed,
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-(--fg-muted)">{{ t('additions.help') }}</p>
    <UForm :state="counts" :validate="validate" class="flex flex-col gap-4" @submit="search.mutate(question())">
      <div class="grid gap-4 sm:grid-cols-4">
        <template v-if="isGroup">
          <UFormField :label="t('stay.men')" name="maleCount"><UInputNumber v-model="counts.maleCount" :min="0" :max="600" class="w-full" /></UFormField>
          <UFormField :label="t('stay.women')" name="femaleCount"><UInputNumber v-model="counts.femaleCount" :min="0" :max="600" class="w-full" /></UFormField>
          <UFormField :label="t('stay.children')" name="childCount"><UInputNumber v-model="counts.childCount" :min="0" :max="600" class="w-full" /></UFormField>
        </template>
        <UFormField v-else :label="t('stay.total')" name="totalCount"><UInputNumber v-model="counts.totalCount" :min="0" :max="600" class="w-full" /></UFormField>
        <UFormField :label="t('stay.infants')" name="infantCount"><UInputNumber v-model="counts.infantCount" :min="0" :max="100" class="w-full" /></UFormField>
      </div>
      <UAlert v-if="search.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(search.error.value)" role="alert" />
      <UAlert v-if="add.error.value && !result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(add.error.value)" role="alert" />
      <UButton type="submit" color="neutral" variant="outline" icon="i-lucide-search" :loading="search.isPending.value" class="self-start">{{ t('additions.search') }}</UButton>
    </UForm>
    <template v-if="result">
      <EmptyState v-if="!result.options.length" :title="t('stay.noOptions')" icon="i-lucide-bed-double" />
      <template v-for="(candidate, index) in result.options" :key="index">
        <OptionCard v-if="candidate.rooms.length && (chosen === null || chosen === index)" :option="candidate" :index="index" :selected="chosen === index" @choose="chosen = index" />
      </template>
      <UAlert v-if="add.error.value && result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(add.error.value)" role="alert" />
      <UButton v-if="chosen !== null" :loading="add.isPending.value" icon="i-lucide-user-plus" class="self-start" @click="add.mutate()">{{ t('additions.add') }}</UButton>
    </template>
  </div>
</template>
