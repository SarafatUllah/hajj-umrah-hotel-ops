<script setup lang="ts">
import { keepPreviousData, useMutation, useQueryClient } from '@tanstack/vue-query'
import { HOTEL_TASK_STATUSES, type HotelTaskStatus } from '@hajj/contracts/constants/booking'
import type { HotelTaskDto } from '@hajj/contracts/types/frontDesk'

/**
 * Housekeeping (v7 §11): the extra beds to set up before an arrival and to take away after a departure — the soonest
 * due first, what is overdue marked — done at the desk (`booking.checkIn`). Open work by default; done and cancelled
 * tasks on request.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const access = useAccess()
const queryClient = useQueryClient()
const { queryOf, setQuery } = useUrlQuery()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const allowed = computed(() => ready.value && access.value.canInHotel('booking.view', hotelId.value))
const canDo = computed(() => ready.value && access.value.canInHotel('booking.checkIn', hotelId.value) && !isInactive.value)

const status = computed<HotelTaskStatus>({
  get: () => HOTEL_TASK_STATUSES.find(s => s === queryOf('status')) ?? 'OPEN',
  set: value => setQuery({ status: value === 'OPEN' ? undefined : value }),
})
const statusItems = computed(() => HOTEL_TASK_STATUSES.map(value => ({ value, label: t(`status.task.${value}`) })))
const tasks = useApiQuery(
  () => ['tasks', hotelId.value, status.value],
  () => api<HotelTaskDto[]>(`/hotels/${hotelId.value}/tasks`, { query: { status: status.value } }),
  { enabled: allowed, placeholderData: keepPreviousData },
)
const done = useMutation({
  mutationFn: (task: HotelTaskDto) => api<HotelTaskDto>(`/hotels/${hotelId.value}/tasks/${task.id}/done`, { method: 'POST' }),
  onSuccess: async (task) => {
    notify.done(t('tasks.doneNamed', { room: task.roomNumber }))
    await queryClient.invalidateQueries({ queryKey: ['tasks', hotelId.value] })
  },
  onError: notify.failed,
})
const overdue = (task: HotelTaskDto) => task.status === 'OPEN' && !!hotel.value && task.dueDate < hotel.value.today
const roomLink = (task: HotelTaskDto) => `/hotels/${encodeURIComponent(hotel.value?.code ?? '')}/rooms/${task.roomId}`
</script>

<template>
  <HotelFrame :title="t('nav.tasks')">
    <EmptyState v-if="ready && !allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <USelect v-model="status" :items="statusItems" :aria-label="t('tasks.statusLabel')" class="w-44" />
      <ErrorState v-if="tasks.error.value" :error="tasks.error.value" @retry="tasks.refetch()" />
      <div v-else-if="tasks.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 5" :key="n" class="h-12" /></div>
      <EmptyState v-else-if="!tasks.data.value?.length" :title="status === 'OPEN' ? t('tasks.noneOpen') : t('tasks.none')" icon="i-lucide-list-checks" />
      <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': tasks.isPlaceholderData.value }">
        <table class="w-full">
          <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
            <tr>
              <th scope="col" class="px-4 py-2 text-start">{{ t('tasks.due') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('tasks.task') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.room') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.column') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.status') }}</th>
              <th scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--border)">
            <tr v-for="task in tasks.data.value" :key="task.id">
              <td class="whitespace-nowrap px-4 py-2 tabular">
                {{ format.date(task.dueDate, 'long') }}
                <UBadge v-if="overdue(task)" color="error" variant="soft" size="sm" class="ms-1">{{ t('tasks.overdue') }}</UBadge>
              </td>
              <td class="px-4 py-2">{{ t(`tasks.kind.${task.kind}`, { count: task.quantity }, task.quantity) }}</td>
              <td class="px-4 py-2 font-semibold tabular"><NuxtLink :to="roomLink(task)" class="hover:underline" dir="ltr">{{ task.roomNumber }}</NuxtLink></td>
              <td class="px-4 py-2"><NuxtLink v-if="task.bookingId" :to="`/bookings/${task.bookingId}`" class="text-(--primary) hover:underline">{{ t('occupancy.openBooking') }}</NuxtLink></td>
              <td class="px-4 py-2">
                <StatusBadge domain="task" :value="task.status" />
                <span v-if="task.doneAt" class="block text-caption text-(--fg-muted)">{{ format.dateTime(task.doneAt, hotel?.timezone) }}</span>
              </td>
              <td class="px-4 py-2 text-end">
                <UButton v-if="canDo && task.status === 'OPEN'" size="sm" icon="i-lucide-check" :loading="done.isPending.value && done.variables.value?.id === task.id" :disabled="done.isPending.value" :aria-label="t('tasks.markDoneNamed', { room: task.roomNumber })" @click="done.mutate(task)">{{ t('tasks.markDone') }}</UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </HotelFrame>
</template>
