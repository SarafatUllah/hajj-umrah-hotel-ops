<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import { MAX_OVERRIDE_SELECTOR_ROOMS, MAX_ROOMS_PER_PAGE } from '@hajj/contracts/constants/inventory'
import type { CapacityPeriodDto, OverridePreview } from '@hajj/contracts/types/inventory'
import type { RoomListItem, RoomListPage } from '@hajj/contracts/types/rooms'
import { signed } from '../../../../../utils/inventory'

/**
 * Apply seasonal capacity (§30.3): 1. choose rooms (filters; "select all matching" means every room the filters
 * match), 2. set the capacity (exact numbers, or more than each room's normal capacity), 3. see the impact on the
 * first night — from the server's preview only, never estimated here — then apply, skipping (and naming) the rooms
 * that cannot take it. The rooms go as explicit ids, and Apply sends the very request that was previewed: while the
 * choice on screen differs from the preview's, there is no preview and no Apply.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const notify = useNotify()
const access = useAccess()
const hotelRefresh = useHotelRefresh()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const canManage = computed(() => ready.value && access.value.canInHotel('capacity.manage', hotelId.value))
const floors = useFloors(hotelId)
const types = useRoomTypes()
const periodId = computed(() => String(route.params.periodId))
const PREVIEW_DELAY_MS = 400
const MAX_PAGES = 10
const ALL = 'ALL'
const SHOWN_CHANGES = 50

const season = useApiQuery(() => ['season', hotelId.value, periodId.value], () => api<CapacityPeriodDto>(`/hotels/${hotelId.value}/capacity-periods/${periodId.value}`), { enabled: canManage })
/** The rooms in inventory on the season's first night, page by page, up to `MAX_PAGES` pages (and how many there are). */
const rooms = useApiQuery(
  () => ['rooms', hotelId.value, 'season-builder', season.data.value?.startDate ?? ''],
  async () => {
    let items: RoomListItem[] = []
    let total = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await api<RoomListPage>(`/hotels/${hotelId.value}/rooms`, { query: { asOf: season.data.value!.startDate, inventory: 'IN', page, pageSize: MAX_ROOMS_PER_PAGE } })
      items = [...items, ...result.items]
      total = result.total
      if (items.length >= total) break
    }
    return { items, total }
  },
  { enabled: computed(() => canManage.value && !!season.data.value) },
)

// 1. Choose rooms.
const filters = ref({ floor: ALL, type: ALL, prefix: '', minHaji: 0, maxHaji: 30 })
const truncated = computed(() => !!rooms.data.value && rooms.data.value.items.length < rooms.data.value.total)
const matching = computed(() => (rooms.data.value?.items ?? []).filter(room => (filters.value.floor === ALL || room.floor.id === filters.value.floor)
  && (filters.value.type === ALL || room.roomType.id === filters.value.type)
  && (!filters.value.prefix || room.roomNumber.startsWith(filters.value.prefix.toUpperCase()))
  && (room.effective?.sellableCapacity ?? 0) >= filters.value.minHaji && (room.effective?.sellableCapacity ?? 0) <= filters.value.maxHaji))
const selected = ref<Set<string>>(new Set())
const toggle = (id: string, on: boolean) => {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
const allMatchingSelected = computed(() => matching.value.length > 0 && matching.value.every(r => selected.value.has(r.id)))
function selectMatching(on: boolean): void {
  const next = new Set(selected.value)
  for (const room of matching.value) {
    if (on) next.add(room.id)
    else next.delete(room.id)
  }
  selected.value = next
}
const floorItems = computed(() => [{ value: ALL, label: t('rooms.allFloors') }, ...floors.items.value])
const typeItems = computed(() => [{ value: ALL, label: t('rooms.allTypes') }, ...types.items.value])

// 2. Set capacity.
const spec = ref({ mode: 'DELTA' as 'ABSOLUTE' | 'DELTA', physicalBeds: 6, sellableCapacity: 6, deltaBeds: 2, deltaSellable: 2, reason: '' })
const modes = computed(() => [
  { value: 'ABSOLUTE', label: t('seasons.absolute') },
  { value: 'DELTA', label: t('seasons.delta'), description: t('seasons.deltaHelp') },
])
const specBody = () => (spec.value.mode === 'ABSOLUTE'
  ? { mode: 'ABSOLUTE' as const, physicalBeds: spec.value.physicalBeds, sellableCapacity: spec.value.sellableCapacity }
  : { mode: 'DELTA' as const, deltaBeds: spec.value.deltaBeds, deltaSellable: spec.value.deltaSellable })

// 3. Impact: the server's preview of the choice on screen, asked a moment after it stops changing — once there is one
// to ask about: rooms (no more than one application takes) and every number filled in.
const overLimit = computed(() => selected.value.size > MAX_OVERRIDE_SELECTOR_ROOMS)
const numbersSet = computed(() => Object.values(specBody()).every(value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))))
const currentInput = computed(() => (numbersSet.value ? JSON.stringify({ selector: { roomIds: [...selected.value].sort() }, spec: specBody() }) : ''))
const previewInput = useDebounced(currentInput, PREVIEW_DELAY_MS)
const isPreviewCurrent = computed(() => selected.value.size > 0 && !overLimit.value && !!currentInput.value && previewInput.value === currentInput.value)
const preview = useQuery({
  queryKey: computed(() => ['season-preview', hotelId.value, periodId.value, previewInput.value]),
  queryFn: () => api<OverridePreview>(`/hotels/${hotelId.value}/capacity-periods/${periodId.value}/overrides/preview`, { method: 'POST', body: JSON.parse(previewInput.value) }),
  enabled: computed(() => canManage.value && isPreviewCurrent.value),
  retry: false,
})
/** Only ever the preview of what is on screen now: while another is being asked, none. */
const shownPreview = computed(() => (isPreviewCurrent.value && !preview.isFetching.value ? preview.data.value : undefined))
const previewError = computed(() => (isPreviewCurrent.value ? preview.error.value : null))
/** What Apply sends: the previewed request itself, and whether that preview skipped rooms. */
interface ApplyRequest { input: string, skipping: boolean }
const apply = useMutation({
  mutationFn: ({ input, skipping }: ApplyRequest) => api<{ applied: number }>(`/hotels/${hotelId.value}/capacity-periods/${periodId.value}/overrides`, {
    method: 'POST',
    body: { ...JSON.parse(input), onConflict: skipping ? 'SKIP' : 'FAIL', reason: spec.value.reason.trim() || undefined },
  }),
  onSuccess: async (result) => {
    notify.done(t('seasons.applied', { count: result.applied }, result.applied))
    await hotelRefresh(hotelId.value)
    await navigateTo(`/hotels/${encodeURIComponent(hotel.value!.code)}/seasons/${periodId.value}`)
  },
  onError: notify.failed,
})
const applyLabel = computed(() => {
  const plan = shownPreview.value
  if (!plan) return t('seasons.applyRooms', { count: selected.value.size }, selected.value.size)
  return plan.skipped.length
    ? t('seasons.applySkipping', { count: plan.applied.length, skipped: plan.skipped.length }, plan.applied.length)
    : t('seasons.applyRooms', { count: plan.applied.length }, plan.applied.length)
})
function applyShown(): void {
  if (!shownPreview.value) return
  apply.mutate({ input: previewInput.value, skipping: shownPreview.value.skipped.length > 0 })
}
</script>

<template>
  <HotelFrame :title="season.data.value ? t('seasons.applyTitle', { name: season.data.value.name }) : t('seasons.apply')">
    <EmptyState v-if="ready && !canManage" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <USkeleton v-else-if="!season.data.value" class="h-24" />
    <UAlert v-else-if="season.data.value.phase !== 'FUTURE'" color="info" variant="soft" icon="i-lucide-lock" :title="t('seasons.runningBanner')" />
    <template v-else>
      <p class="text-(--fg-muted)"><NightsRange :from="season.data.value.startDate" :to="season.data.value.endDate" /></p>
      <div class="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <section aria-labelledby="choose-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="choose-heading" class="text-section">{{ t('seasons.step1') }}</h2>
          <div class="flex flex-wrap gap-2">
            <USelect v-model="filters.floor" :items="floorItems" :aria-label="t('rooms.floor')" class="w-36" />
            <USelect v-model="filters.type" :items="typeItems" :aria-label="t('rooms.type')" class="w-40" />
            <UInput v-model="filters.prefix" :placeholder="t('rooms.search')" :aria-label="t('rooms.search')" dir="ltr" class="w-28" />
            <span class="flex items-center gap-1 text-small">{{ t('seasons.hajiNow') }} <UInputNumber v-model="filters.minHaji" :min="0" :max="30" class="w-24" :aria-label="t('seasons.minHaji')" />–<UInputNumber v-model="filters.maxHaji" :min="0" :max="30" class="w-24" :aria-label="t('seasons.maxHaji')" /></span>
          </div>
          <UAlert v-if="truncated" color="warning" variant="soft" icon="i-lucide-info" :title="t('seasons.roomsCapped', { shown: rooms.data.value!.items.length, total: rooms.data.value!.total })" />
          <ErrorState v-if="rooms.error.value" :error="rooms.error.value" @retry="rooms.refetch()" />
          <USkeleton v-else-if="rooms.isPending.value" class="h-40" />
          <template v-else>
            <UCheckbox :model-value="allMatchingSelected" :label="t('seasons.selectMatching', { count: matching.length })" :aria-label="t('seasons.selectMatching', { count: matching.length })" @update:model-value="value => selectMatching(!!value)" />
            <ul class="flex max-h-[28rem] flex-col divide-y divide-(--border) overflow-y-auto">
              <li v-for="room in matching" :key="room.id" class="flex items-center gap-3 py-1.5">
                <UCheckbox :model-value="selected.has(room.id)" :aria-label="t('rooms.selectRoom', { room: room.roomNumber })" @update:model-value="value => toggle(room.id, !!value)" />
                <span class="w-16 font-semibold tabular" dir="ltr">{{ room.roomNumber }}</span>
                <span class="flex-1 text-small"><bdi>{{ room.roomType.name }}</bdi> · <bdi>{{ room.floor.label }}</bdi></span>
                <CapacityValue :haji="room.effective?.sellableCapacity" :beds="room.effective?.physicalBeds" class="text-small" />
              </li>
            </ul>
            <p class="text-small" role="status">{{ t('rooms.selected', { count: selected.size }, selected.size) }}</p>
          </template>
        </section>

        <div class="flex flex-col gap-6">
          <section aria-labelledby="spec-heading" class="surface-panel flex flex-col gap-3 p-5">
            <h2 id="spec-heading" class="text-section">{{ t('seasons.step2') }}</h2>
            <URadioGroup v-model="spec.mode" :items="modes" />
            <div v-if="spec.mode === 'ABSOLUTE'" class="grid grid-cols-2 gap-3">
              <UFormField :label="t('capacity.bedsLabel')"><UInputNumber v-model="spec.physicalBeds" :min="1" :max="30" class="w-full" /></UFormField>
              <UFormField :label="t('capacity.hajiLabel')"><UInputNumber v-model="spec.sellableCapacity" :min="0" :max="30" class="w-full" /></UFormField>
            </div>
            <div v-else class="grid grid-cols-2 gap-3">
              <UFormField :label="t('seasons.moreBeds')"><UInputNumber v-model="spec.deltaBeds" :min="-30" :max="30" class="w-full" /></UFormField>
              <UFormField :label="t('seasons.moreHaji')"><UInputNumber v-model="spec.deltaSellable" :min="-30" :max="30" class="w-full" /></UFormField>
            </div>
            <UFormField :label="t('capacity.reason')" :hint="t('common.optional')"><UInput v-model="spec.reason" maxlength="500" class="w-full" /></UFormField>
          </section>

          <section aria-labelledby="impact-heading" class="surface-panel flex flex-col gap-3 p-5">
            <h2 id="impact-heading" class="text-section">{{ t('seasons.step3') }}</h2>
            <p class="sr-only" role="status">{{ shownPreview ? t('seasons.previewReady', { count: shownPreview.applied.length, skipped: shownPreview.skipped.length }, shownPreview.applied.length) : '' }}</p>
            <p v-if="!selected.size" class="text-(--fg-muted)">{{ t('seasons.chooseFirst') }}</p>
            <p v-else-if="overLimit" class="text-(--warning)">{{ t('seasons.selectionLimit', { max: MAX_OVERRIDE_SELECTOR_ROOMS }) }}</p>
            <p v-else-if="!numbersSet" class="text-(--fg-muted)">{{ t('seasons.numbersFirst') }}</p>
            <ErrorState v-else-if="previewError" :error="previewError" @retry="preview.refetch()" />
            <USkeleton v-else-if="!shownPreview || preview.isFetching.value" class="h-32" />
            <template v-else>
              <dl class="grid grid-cols-2 gap-2 text-small">
                <dt class="text-(--fg-muted)">{{ t('seasons.changing') }}</dt><dd class="tabular">{{ shownPreview.applied.length }}</dd>
                <dt class="text-(--fg-muted)">{{ t('seasons.skipped') }}</dt><dd class="tabular">{{ shownPreview.skipped.length }}</dd>
                <dt class="text-(--fg-muted)">{{ t('seasons.hotelHaji') }}</dt>
                <dd class="tabular">{{ t('seasons.beforeAfter', { before: shownPreview.hotelTotals.sellableBefore, after: shownPreview.hotelTotals.sellableDuring }) }} (<bdi dir="ltr">{{ signed(shownPreview.hotelTotals.sellableDuring - shownPreview.hotelTotals.sellableBefore) }}</bdi>)</dd>
                <dt class="text-(--fg-muted)">{{ t('seasons.selectedBeds') }}</dt>
                <dd class="tabular">{{ t('seasons.beforeAfter', { before: shownPreview.totals.bedsBefore, after: shownPreview.totals.bedsAfter }) }}</dd>
              </dl>
              <ul v-if="shownPreview.skipped.length" class="flex flex-col gap-1 rounded-md bg-(--warning-soft) p-3 text-small">
                <li v-for="skip in shownPreview.skipped" :key="skip.roomId"><span class="tabular" dir="ltr">{{ skip.roomNumber }}</span>: {{ t(`seasons.skip.${skip.reason}`) }}</li>
              </ul>
              <ul class="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-small">
                <li v-for="change in shownPreview.applied.slice(0, SHOWN_CHANGES)" :key="change.roomId" class="tabular">
                  <span dir="ltr">{{ change.roomNumber }}</span>: {{ t('seasons.roomChange', { haji: change.before.sellableCapacity, newHaji: change.after.sellableCapacity, beds: change.before.physicalBeds, newBeds: change.after.physicalBeds }) }}
                </li>
              </ul>
              <UTooltip :text="isInactive ? t('hotel.inactiveReason') : undefined" :disabled="!isInactive">
                <UButton :loading="apply.isPending.value" :disabled="!shownPreview.applied.length || isInactive" class="self-start" @click="applyShown">{{ applyLabel }}</UButton>
              </UTooltip>
            </template>
          </section>
        </div>
      </div>
    </template>
  </HotelFrame>
</template>
