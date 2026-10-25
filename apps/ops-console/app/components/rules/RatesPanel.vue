<script setup lang="ts">
import type { RateDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { sortedRates } from '../../utils/bookingRules'
import { withSaved } from '../../utils/forms'

/**
 * A hotel's rates (v7 §8, §15; `rate.view`): by room type, the public price and the agencies' default, per person or
 * per room and night, by season. With `rate.manage` on an active hotel: add, edit, delete (a booking keeps its price).
 */
const props = defineProps<{ hotel: HotelSummary, canManage: boolean }>()
const { t } = useI18n()
const roomTypes = useRoomTypes()
const rules = useBookingRules('rates', () => props.hotel.id, true)
const { list, drawerOpen, editing, deleting, asked } = rules
const typeName = (id: string) => roomTypes.byId(id)?.name ?? t('rules.formerType')
const rates = computed(() => sortedRates(list.data.value ?? [], typeName))
const typeChoices = computed(() => withSaved(roomTypes.items.value, editing.value ? { value: editing.value.roomTypeId, label: typeName(editing.value.roomTypeId) } : null))
const describe = (rate: RateDto) => t('rules.rates.describe', { type: typeName(rate.roomTypeId), price: t(`rules.priceTypeName.${rate.priceType}`), unit: t(`booking.priceUnit.${rate.unit}`) })
</script>

<template>
  <RulePanel
    id="rates"
    :title="t('rules.rates.title')"
    :help="t('rules.rates.help')"
    :add-label="canManage ? t('rules.rates.add') : undefined"
    :error="list.error.value"
    :loading="list.isPending.value"
    :empty="!rates.length"
    :empty-text="t('rules.rates.none')"
    @add="rules.edit(null)"
    @retry="list.refetch()"
  >
    <table class="w-full">
      <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
        <tr>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.roomType') }}</th>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.priceTypeLabel') }}</th>
          <th scope="col" class="px-3 py-2 text-start">{{ t('rules.season') }}</th>
          <th scope="col" class="px-3 py-2 text-end">{{ t('rules.amount') }}</th>
          <th v-if="canManage" scope="col" class="px-3 py-2"><span class="sr-only">{{ t('rules.actions') }}</span></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-(--border)">
        <tr v-for="rate in rates" :key="rate.id">
          <td class="px-3 py-2"><bdi>{{ typeName(rate.roomTypeId) }}</bdi></td>
          <td class="px-3 py-2">{{ t(`rules.priceType.${rate.priceType}`) }}</td>
          <td class="whitespace-nowrap px-3 py-2"><NightsRange :from="rate.startDate" :to="rate.endDate" :count="false" /></td>
          <td class="px-3 py-2 text-end">
            <MoneyText :halalas="rate.amountHalalas" />
            <span class="block text-caption text-(--fg-muted)">{{ t(`booking.priceUnit.${rate.unit}`) }} · {{ rate.vatIncluded ? t('rules.vatIncluded') : t('rules.vatExcluded') }}</span>
          </td>
          <td v-if="canManage" class="whitespace-nowrap px-3 py-2 text-end">
            <RuleActions :name="describe(rate)" @edit="rules.edit(rate)" @delete="deleting = rate" />
          </td>
        </tr>
      </tbody>
    </table>
  </RulePanel>
  <RateDrawer v-model:open="drawerOpen" :hotel="hotel" :rate="editing" :room-types="typeChoices" :pending="rules.save.isPending.value" :error="rules.save.error.value" @submit="rules.submit" />
  <ConfirmDialog
    :open="!!deleting"
    destructive
    :title="t('rules.deleteTitle', { name: asked ? describe(asked) : '' })"
    :description="t('rules.rates.deleteText')"
    :confirm-label="t('rules.delete')"
    :pending="rules.remove.isPending.value"
    @update:open="value => { if (!value) deleting = null }"
    @confirm="rules.confirmDelete"
  />
</template>
