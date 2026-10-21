<script setup lang="ts">
import { allocationRuleSchema } from '@hajj/contracts/schemas/bookingRules'
import type { AllocationRuleDto } from '@hajj/contracts/types/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { roomMixFormOf, roomMixRequestOf } from '../../utils/bookingRules'

/**
 * A room-mix rule (v7 §5, §15): for a group of a size range — each gender counted apart — at most so many rooms of so
 * many seats or more, so a small group is not spread over the large rooms. An empty "up to" has no upper bound.
 */
const props = defineProps<{ hotel: HotelSummary, rule: AllocationRuleDto | null, pending: boolean, error: unknown }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [body: Record<string, unknown>] }>()
const { t } = useI18n()
const form = ref(roomMixFormOf(null))
watch(open, (isOpen) => { if (isOpen) form.value = roomMixFormOf(props.rule) })
const validate = validateWith(allocationRuleSchema, key => t(key), roomMixRequestOf)
</script>

<template>
  <RuleDrawer
    v-model:open="open"
    kind="allocation-rules"
    :hotel="hotel"
    :title="rule ? t('rules.roomMix.edit') : t('rules.roomMix.add')"
    :description="t('rules.roomMix.perGender')"
    :state="form"
    :validate="validate"
    :save-label="rule ? t('rules.save') : t('rules.roomMix.add')"
    :pending="pending"
    :error="error"
    @submit="emit('submit', roomMixRequestOf(form))"
  >
    <div class="grid grid-cols-2 gap-4">
      <UFormField :label="t('rules.roomMix.groupMin')" name="groupMin" required><UInputNumber v-model="form.groupMin" :min="1" :max="10000" class="w-full" /></UFormField>
      <UFormField :label="t('rules.roomMix.groupMax')" :help="t('rules.roomMix.groupMaxHelp')" name="groupMax"><UInputNumber v-model="form.groupMax" :min="1" :max="10000" class="w-full" /></UFormField>
      <UFormField :label="t('rules.roomMix.minSeats')" name="minSeats" required><UInputNumber v-model="form.minSeats" :min="1" :max="30" class="w-full" /></UFormField>
      <UFormField :label="t('rules.roomMix.maxRooms')" name="maxRooms" required><UInputNumber v-model="form.maxRooms" :min="0" :max="10000" class="w-full" /></UFormField>
    </div>
  </RuleDrawer>
</template>
