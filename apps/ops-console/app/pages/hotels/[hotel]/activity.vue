<script setup lang="ts">
import { useInfiniteQuery } from '@tanstack/vue-query'
import { AUDIT_ACTIONS } from '@hajj/contracts/constants/audit'
import type { AuditPageDto } from '@hajj/contracts/types/hotel'

/**
 * A hotel's history (§23 Activity, S3): who did what and when (hotel time), newest first, with what changed; filter
 * by action; older entries on demand. Only with `audit.view` in this hotel.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const access = useAccess()
const { hotel, hotelId, ready } = useCurrentHotel()
const PAGE_LIMIT = 50
const action = ref<string>('ALL')
const allowed = computed(() => ready.value && access.value.canInHotel('audit.view', hotelId.value))
const actions = computed(() => [{ value: 'ALL', label: t('activity.allActions') }, ...AUDIT_ACTIONS.map(value => ({ value, label: t(`activity.action.${value}`) }))])

const history = useInfiniteQuery({
  queryKey: computed(() => ['audit', hotelId.value, action.value]),
  queryFn: ({ pageParam }) => api<AuditPageDto>(`/hotels/${hotelId.value}/audit-log`, {
    query: { limit: PAGE_LIMIT, action: action.value === 'ALL' ? undefined : action.value, cursor: pageParam ?? undefined },
  }),
  initialPageParam: null as string | null,
  getNextPageParam: last => last.nextCursor,
  enabled: allowed,
})
const entries = computed(() => history.data.value?.pages.flatMap(p => p.items) ?? [])
/** The before/after of an entry, readable: one value per line. */
const shown = (value: unknown) => JSON.stringify(value, null, 2)
</script>

<template>
  <HotelFrame tab="activity" :title="t('hotel.tab.activity')">
    <EmptyState v-if="ready && !allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <USelect v-model="action" :items="actions" :aria-label="t('activity.filter')" class="w-72" />
      <ErrorState v-if="history.error.value" :error="history.error.value" @retry="history.refetch()" />
      <div v-else-if="history.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 5" :key="n" class="h-14" /></div>
      <EmptyState v-else-if="!entries.length" :title="t('activity.none')" icon="i-lucide-history" />
      <ol v-else class="surface-panel divide-y divide-(--border)">
        <li v-for="entry in entries" :key="entry.id" class="flex flex-col gap-1 p-4">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <span class="font-medium">{{ t(`activity.action.${entry.action}`) }}</span>
            <time :datetime="entry.createdAt" class="text-small tabular text-(--fg-muted)">{{ format.dateTime(entry.createdAt, hotel?.timezone) }}</time>
          </div>
          <span class="text-small text-(--fg-muted)"><bdi>{{ entry.actor?.fullName ?? t('activity.system') }}</bdi></span>
          <p v-if="entry.reason" class="text-small">{{ t('activity.reason', { reason: entry.reason }) }}</p>
          <details v-if="entry.before !== null || entry.after !== null" class="text-small">
            <summary class="cursor-pointer text-(--fg-muted)">{{ t('activity.changes') }}</summary>
            <div class="mt-2 grid gap-2 md:grid-cols-2">
              <div><p class="text-caption text-(--fg-muted)">{{ t('activity.before') }}</p><pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-(--surface-2) p-2 font-sans tabular" dir="ltr">{{ shown(entry.before) }}</pre></div>
              <div><p class="text-caption text-(--fg-muted)">{{ t('activity.after') }}</p><pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-(--surface-2) p-2 font-sans tabular" dir="ltr">{{ shown(entry.after) }}</pre></div>
            </div>
          </details>
        </li>
      </ol>
      <UButton v-if="history.hasNextPage.value" color="neutral" variant="outline" :loading="history.isFetchingNextPage.value" class="self-center" @click="history.fetchNextPage()">{{ t('activity.older') }}</UButton>
    </template>
  </HotelFrame>
</template>
