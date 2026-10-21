<script setup lang="ts">
import type { ExtraBedPolicyDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { withSaved } from '../../utils/forms'

/**
 * A hotel's extra beds (v7 §11, §15; `booking.view`): per room type, the beds a room and a booking may get, the
 * price, and whether seasonally changed rooms may. A room type without a policy gets none. With `booking.settings`
 * on an active hotel: add, edit, delete (beds already booked stay).
 */
const props = defineProps<{ hotel: HotelSummary, canManage: boolean }>()
const { t } = useI18n()
const roomTypes = useRoomTypes()
const rules = useBookingRules('extra-bed-policies', () => props.hotel.id, true)
const { list, drawerOpen, editing, deleting, asked } = rules
const typeName = (id: string) => roomTypes.byId(id)?.name ?? t('rules.formerType')
const policies = computed(() => [...(list.data.value ?? [])].sort((a, b) => typeName(a.roomTypeId).localeCompare(typeName(b.roomTypeId))))
// A new policy is for a room type without one (none left: nothing to add); an edited one keeps its own.
const freeTypes = computed(() => {
  const taken = new Set(policies.value.filter(p => p.id !== editing.value?.id).map(p => p.roomTypeId))
  return roomTypes.items.value.filter(type => !taken.has(type.value))
})
const typeChoices = computed(() => withSaved(freeTypes.value, editing.value ? { value: editing.value.roomTypeId, label: typeName(editing.value.roomTypeId) } : null))
const canAdd = computed(() => props.canManage && list.data.value !== undefined && roomTypes.data.value !== undefined && roomTypes.items.value.some(type => !policies.value.some(p => p.roomTypeId === type.value)))
const describe = (policy: ExtraBedPolicyDto) => t('rules.extraBeds.describe', { type: typeName(policy.roomTypeId) })
</script>

<template>
  <RulePanel
    id="extra-beds"
    :title="t('rules.extraBeds.title')"
    :help="t('rules.extraBeds.help')"
    :add-label="canAdd ? t('rules.extraBeds.add') : undefined"
    :error="list.error.value"
    :loading="list.isPending.value"
    :empty="!policies.length"
    :empty-text="t('rules.extraBeds.none')"
    @add="rules.edit(null)"
    @retry="list.refetch()"
  >
    <table class="w-full">
      <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
        <tr>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.roomType') }}</th>
          <th scope="col" class="px-3 py-2 text-end">{{ t('rules.extraBeds.maxPerRoom') }}</th>
          <th scope="col" class="px-3 py-2 text-end">{{ t('rules.extraBeds.maxPerBooking') }}</th>
          <th scope="col" class="px-3 py-2 text-end">{{ t('rules.extraBeds.price') }}</th>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.extraBeds.seasons') }}</th>
          <th v-if="canManage" scope="col" class="px-3 py-2"><span class="sr-only">{{ t('rules.actions') }}</span></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-(--border)">
        <tr v-for="policy in policies" :key="policy.id">
          <td class="px-3 py-2"><bdi>{{ typeName(policy.roomTypeId) }}</bdi></td>
          <td class="px-3 py-2 text-end tabular">{{ policy.maxPerRoom }}</td>
          <td class="px-3 py-2 text-end tabular">{{ policy.maxPerBooking }}</td>
          <td class="px-3 py-2 text-end">
            <MoneyText :halalas="policy.amountHalalas" />
            <span class="block text-caption text-(--fg-muted)">{{ t('rules.extraBeds.perBedNight') }} · {{ policy.vatIncluded ? t('rules.vatIncluded') : t('rules.vatExcluded') }}</span>
          </td>
          <td class="px-3 py-2">{{ policy.allowInOverrideSeason ? t('rules.extraBeds.seasonsAllowed') : t('rules.extraBeds.seasonsNot') }}</td>
          <td v-if="canManage" class="whitespace-nowrap px-3 py-2"><RuleActions :name="describe(policy)" @edit="rules.edit(policy)" @delete="deleting = policy" /></td>
        </tr>
      </tbody>
    </table>
  </RulePanel>
  <ExtraBedDrawer v-model:open="drawerOpen" :hotel="hotel" :policy="editing" :room-types="typeChoices" :pending="rules.save.isPending.value" :error="rules.save.error.value" @submit="rules.submit" />
  <ConfirmDialog
    :open="!!deleting"
    destructive
    :title="t('rules.deleteTitle', { name: asked ? describe(asked) : '' })"
    :description="t('rules.extraBeds.deleteText')"
    :confirm-label="t('rules.delete')"
    :pending="rules.remove.isPending.value"
    @update:open="value => { if (!value) deleting = null }"
    @confirm="rules.confirmDelete"
  />
</template>
