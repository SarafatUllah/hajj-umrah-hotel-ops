<script setup lang="ts">
import type { CalendarRefsDto, CalendarRoomDto, DailySummary } from '@hajj/contracts/types/inventory'
import { addDays, toEpochDay } from '@hajj/contracts/utils/dates'
import { type CalendarCell, moveCell, weekendColumns } from '../../../utils/calendar'

/**
 * The room calendar's grid (§31.1–§31.4): the header rows and the room column stay in view; one row per room, one
 * bar per run of nights, never an element per night. In reading order: right to left in Arabic. The grid is one
 * focusable `grid` with an active cell moved by the keyboard (arrows, Page Up/Down, Home/End, T for tonight, Enter
 * opens it), kept in view. Only the rows whose active cell changes render again on a key.
 */
const props = defineProps<{
  rooms: CalendarRoomDto[]
  /** Every room the filters match (more may load later). */
  total: number
  refs: CalendarRefsDto
  from: string
  nights: number
  columnWidth: number
  today: string
  seasons: Array<{ id: string, name: string, startDate: string, endDate: string }>
  summary: DailySummary[]
  selectable: boolean
  selected: Set<string>
}>()
const emit = defineEmits<{ open: [roomIndex: number, night: string], toggle: [roomId: string, on: boolean] }>()
const { t, localeProperties } = useI18n()
const ROOM_COLUMN = 168
const PAGE_ROWS = 10
const rtl = computed(() => localeProperties.value.dir === 'rtl')
const todayIndex = computed(() => toEpochDay(props.today) - toEpochDay(props.from))
const tonight = () => Math.min(Math.max(0, todayIndex.value), props.nights - 1)
const columns = computed(() => `${ROOM_COLUMN}px repeat(${props.nights}, ${props.columnWidth}px)`)

/** Weekend, past and tonight's columns as one background (no element per night or per room). */
const shading = computed(() => {
  const weekends = new Set(weekendColumns(props.from, props.nights))
  const stops: string[] = [`transparent 0 ${ROOM_COLUMN}px`]
  for (let night = 0; night < props.nights; night++) {
    const start = ROOM_COLUMN + night * props.columnWidth
    const color = night === todayIndex.value ? 'var(--primary-soft)' : night < todayIndex.value ? 'var(--surface-2)' : weekends.has(night + 1) ? 'color-mix(in srgb, var(--surface-2) 60%, transparent)' : 'transparent'
    stops.push(`${color} ${start}px ${start + props.columnWidth}px`)
  }
  return { backgroundImage: `linear-gradient(to ${rtl.value ? 'left' : 'right'}, ${stops.join(', ')})` }
})

// The keyboard: one active cell (row, night), announced through `aria-activedescendant`.
const active = ref<CalendarCell>({ row: 0, night: tonight() })
const focused = ref(false)
const activeId = computed(() => `calendar-cell-${active.value.row}-${active.value.night}`)
watch(() => [props.from, props.nights], () => { active.value = { row: active.value.row, night: tonight() } })
watch(() => props.rooms.length, (length) => {
  if (active.value.row > length - 1) active.value = { ...active.value, row: Math.max(length - 1, 0) }
})
// A moved cell stays in view, clear of the sticky headers and room column (its scroll margins).
watch(active, async () => {
  if (!focused.value) return
  await nextTick()
  document.getElementById(activeId.value)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

function onKey(event: KeyboardEvent): void {
  // Keys on a room's checkbox are the checkbox's; modified keys are the browser's (Alt+Arrow goes back).
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || !props.rooms.length) return
  if (event.key === 'Enter') {
    event.preventDefault()
    emit('open', active.value.row, addDays(props.from, active.value.night))
    return
  }
  if (event.key === 't' || event.key === 'T') {
    active.value = { ...active.value, night: tonight() }
    return
  }
  if (event.key === 'PageDown' || event.key === 'PageUp') {
    event.preventDefault()
    const row = active.value.row + (event.key === 'PageDown' ? PAGE_ROWS : -PAGE_ROWS)
    active.value = { ...active.value, row: Math.min(Math.max(row, 0), props.rooms.length - 1) }
    return
  }
  const next = moveCell(active.value, event.key, { rows: props.rooms.length, nights: props.nights, rtl: rtl.value })
  if (!next) return
  event.preventDefault()
  active.value = next
}
</script>

<template>
  <div class="surface-panel overflow-auto" style="max-height: 70vh">
    <div
      role="grid"
      tabindex="0"
      :aria-label="t('calendar.gridLabel')"
      :aria-rowcount="total + 2"
      :aria-colcount="nights + 1"
      :aria-activedescendant="rooms.length ? activeId : undefined"
      class="relative grid w-max min-w-full outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      :style="{ gridTemplateColumns: columns, gridTemplateRows: `24px 24px 40px 26px repeat(${rooms.length}, 38px)`, ...shading }"
      @keydown="onKey"
      @focus="focused = true"
      @blur="focused = false"
    >
      <CalendarHeader :from="from" :nights="nights" :column-width="columnWidth" :today="today" :seasons="seasons" :summary="summary" />
      <CalendarRow
        v-for="(room, index) in rooms"
        :key="room.roomId"
        :room="room"
        :row="index"
        :from="from"
        :nights="nights"
        :column-width="columnWidth"
        :refs="refs"
        :selectable="selectable"
        :is-selected="selected.has(room.roomId)"
        :active-night="index === active.row ? active.night : null"
        :show-active="focused && index === active.row"
        @open="night => emit('open', index, night)"
        @toggle="on => emit('toggle', room.roomId, on)"
      />
    </div>
  </div>
</template>
