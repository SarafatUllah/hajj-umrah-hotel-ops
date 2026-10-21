<script setup lang="ts">
import type { CalendarRefsDto, CalendarRoomDto, CalendarSegment } from '@hajj/contracts/types/inventory'
import { addDays } from '@hajj/contracts/utils/dates'
import { barContent, nightIndexAt, placeOf } from '../../../utils/calendar'

/**
 * One room's row of the calendar (§31.3): the room cell (ticked to block it with others), then one bar per run of
 * nights — its fill is the status (available has none), a season's capacity a band on top. It renders again only when
 * its own data, the range or its active cell changes: the keyboard moving elsewhere leaves it alone.
 */
const props = defineProps<{
  room: CalendarRoomDto
  /** The room's position among the rooms shown, from 0. */
  row: number
  from: string
  nights: number
  columnWidth: number
  refs: CalendarRefsDto
  selectable: boolean
  isSelected: boolean
  /** The keyboard's night in this row (from 0), or `null` when the active cell is in another row. */
  activeNight: number | null
  showActive: boolean
}>()
const emit = defineEmits<{ open: [night: string], toggle: [on: boolean] }>()
const { t, localeProperties } = useI18n()
const format = useFormat()
const HEADER_ROWS = 4
const gridRow = computed(() => props.row + HEADER_ROWS + 1)

const STATUS_CLASS: Record<string, string> = {
  AVAILABLE: '',
  OPERATIONAL_BLOCK: 'bg-(--neutral-soft) text-(--neutral)',
  MAINTENANCE: 'bg-(--warning-soft) text-(--warning)',
  OUT_OF_SERVICE: 'bg-[repeating-linear-gradient(135deg,var(--danger-soft)_0_6px,color-mix(in_srgb,var(--danger)_25%,transparent)_6px_8px)] text-(--danger)',
  NOT_IN_INVENTORY: 'border border-dashed border-(--border-strong) bg-[repeating-linear-gradient(45deg,transparent_0_5px,var(--border)_5px_6px)] text-(--fg-muted)',
}
const STATUS_ICON: Record<string, string> = { OPERATIONAL_BLOCK: 'i-lucide-lock', MAINTENANCE: 'i-lucide-wrench', OUT_OF_SERVICE: 'i-lucide-ban', NOT_IN_INVENTORY: 'i-lucide-circle-dashed' }
const barClass = (segment: CalendarSegment) => [
  segment.status === 'MAINTENANCE' && segment.sellable ? 'border border-(--warning) text-(--warning)' : STATUS_CLASS[segment.status] ?? '',
  segment.capacitySource === 'PERIOD_OVERRIDE' ? 'border-t-[3px] border-t-(--season)' : '',
]

/** A run of nights in words, for its tooltip and for assistive technology. */
function describe(segment: CalendarSegment): string {
  const season = segment.periodId ? props.refs.periods[segment.periodId]?.name : null
  const block = segment.blockIds.map(id => props.refs.blocks[id]?.reason).filter(Boolean).join('; ')
  const beds = segment.physicalBeds ?? 0
  const capacity = segment.sellableCapacity === null ? '' : t('capacity.pair', { haji: t('capacity.haji', { count: segment.sellableCapacity }), beds: t('capacity.beds', { count: beds }, beds) })
  return [t('rooms.roomNamed', { room: props.room.roomNumber }), t(`status.inventory.${segment.status}`), `${format.date(segment.from, 'short')} – ${format.date(segment.to, 'short')}`, block, capacity, season ? t('rooms.seasonSource', { season }) : ''].filter(Boolean).join(t('calendar.separator'))
}

const bars = computed(() => props.room.segments.flatMap((segment) => {
  const place = placeOf(segment, props.from, props.nights)
  return place ? [{ segment, place, content: barContent(place.span, props.columnWidth), title: describe(segment), classes: barClass(segment) }] : []
}))

/** The night under the pointer, wherever in the bar (icon, label) the click landed. */
function openAt(event: MouseEvent, place: { column: number, span: number }): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const index = nightIndexAt({ x: event.clientX, left: rect.left, right: rect.right, rtl: localeProperties.value.dir === 'rtl' }, props.columnWidth, place.span)
  emit('open', addDays(props.from, place.column - 1 + index))
}

// The keyboard's cell: a new element (and id) per cell, so a screen reader announces each move.
const active = computed(() => {
  if (props.activeNight === null) return null
  const night = addDays(props.from, props.activeNight)
  const segment = props.room.segments.find(s => s.from <= night && night <= s.to)
  const date = format.date(night, 'long')
  return { id: `calendar-cell-${props.row}-${props.activeNight}`, column: props.activeNight + 2, label: segment ? `${date}: ${describe(segment)}` : date }
})
</script>

<template>
  <div role="row" :aria-rowindex="row + 3" class="contents">
    <div role="rowheader" aria-colindex="1" class="sticky start-0 z-10 flex items-center gap-2 border-b border-e border-(--border) bg-(--surface-1) px-2" :style="{ gridRow, gridColumn: 1 }">
      <UCheckbox v-if="selectable" :model-value="isSelected" :aria-label="t('rooms.selectRoom', { room: room.roomNumber })" @update:model-value="value => emit('toggle', !!value)" />
      <span class="font-semibold tabular" dir="ltr">{{ room.roomNumber }}</span>
      <span class="truncate text-caption text-(--fg-muted)">{{ room.roomType.code }} · <bdi>{{ room.floor.label }}</bdi></span>
    </div>
    <div
      v-for="bar in bars"
      :key="bar.segment.from"
      role="gridcell"
      :aria-colindex="bar.place.column + 1"
      :aria-colspan="bar.place.span"
      :aria-label="bar.title"
      class="z-0 mx-px my-1 flex cursor-pointer items-center gap-1 overflow-hidden rounded-sm px-1 text-start text-caption tabular hover:brightness-95"
      :class="bar.classes"
      :style="{ gridRow, gridColumn: `${bar.place.column + 1} / span ${bar.place.span}` }"
      :title="bar.title"
      @click="event => openAt(event, bar.place)"
    >
      <UIcon v-if="bar.content !== 'none' && STATUS_ICON[bar.segment.status]" :name="STATUS_ICON[bar.segment.status]!" class="size-3.5 shrink-0" />
      <span v-if="bar.content === 'full' && bar.segment.status !== 'AVAILABLE'" class="truncate">{{ t(`status.inventory.${bar.segment.status}`) }}</span>
      <span v-if="bar.content !== 'none' && bar.segment.sellableCapacity !== null" class="shrink-0">{{ bar.content === 'full' ? t('capacity.haji', { count: bar.segment.sellableCapacity }) : bar.segment.sellableCapacity }}</span>
    </div>
    <div
      v-if="active"
      v-show="showActive"
      :id="active.id"
      :key="active.id"
      role="gridcell"
      :aria-colindex="active.column"
      :aria-label="active.label"
      class="pointer-events-none z-10 scroll-mt-[114px] scroll-mb-2 scroll-ms-[168px] scroll-me-2 rounded-sm ring-2 ring-(--focus-ring)"
      :style="{ gridRow, gridColumn: active.column }"
    />
  </div>
</template>
