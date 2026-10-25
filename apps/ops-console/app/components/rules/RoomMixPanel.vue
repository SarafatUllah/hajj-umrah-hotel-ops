<script setup lang="ts">
import type { AllocationRuleDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'

/**
 * A hotel's room-mix rules (v7 §5, §15; `booking.view`): by group size, each gender apart, at most so many rooms of
 * so many seats or more. With `booking.settings` on an active hotel: add, edit, delete.
 */
const props = defineProps<{ hotel: HotelSummary, canManage: boolean }>()
const { t } = useI18n()
const rules = useBookingRules('allocation-rules', () => props.hotel.id, true)
const { list, drawerOpen, editing, deleting, asked } = rules
const mix = computed(() => [...(list.data.value ?? [])].sort((a, b) => a.groupMin - b.groupMin))
const sizes = (rule: AllocationRuleDto) => (rule.groupMax === null ? t('rules.roomMix.fromSize', { min: rule.groupMin }) : t('rules.roomMix.sizeRange', { min: rule.groupMin, max: rule.groupMax }))
const describe = (rule: AllocationRuleDto) => t('rules.roomMix.describe', { sizes: sizes(rule) })
</script>

<template>
  <RulePanel
    id="room-mix"
    :title="t('rules.roomMix.title')"
    :help="t('rules.roomMix.help')"
    :add-label="canManage ? t('rules.roomMix.add') : undefined"
    :error="list.error.value"
    :loading="list.isPending.value"
    :empty="!mix.length"
    :empty-text="t('rules.roomMix.none')"
    @add="rules.edit(null)"
    @retry="list.refetch()"
  >
    <table class="w-full">
      <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
        <tr>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.roomMix.groupSize') }}</th>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.roomMix.limit') }}</th>
          <th v-if="canManage" scope="col" class="px-3 py-2"><span class="sr-only">{{ t('rules.actions') }}</span></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-(--border)">
        <tr v-for="rule in mix" :key="rule.id">
          <td class="px-3 py-2 tabular">{{ sizes(rule) }}</td>
          <td class="px-3 py-2">{{ t('rules.roomMix.atMost', { seats: rule.minSeats, count: rule.maxRooms }, rule.maxRooms) }}</td>
          <td v-if="canManage" class="whitespace-nowrap px-3 py-2"><RuleActions :name="describe(rule)" @edit="rules.edit(rule)" @delete="deleting = rule" /></td>
        </tr>
      </tbody>
    </table>
  </RulePanel>
  <RoomMixDrawer v-model:open="drawerOpen" :hotel="hotel" :rule="editing" :pending="rules.save.isPending.value" :error="rules.save.error.value" @submit="rules.submit" />
  <ConfirmDialog
    :open="!!deleting"
    destructive
    :title="t('rules.deleteTitle', { name: asked ? describe(asked) : '' })"
    :description="t('rules.roomMix.deleteText')"
    :confirm-label="t('rules.delete')"
    :pending="rules.remove.isPending.value"
    @update:open="value => { if (!value) deleting = null }"
    @confirm="rules.confirmDelete"
  />
</template>
