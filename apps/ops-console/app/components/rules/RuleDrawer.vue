<script setup lang="ts">
import type { BookingRuleKind } from '@hajj/contracts/schemas/bookingRules'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import { ruleConflictKey } from '../../utils/bookingRules'
import { heldWhile } from '../../utils/forms'

/**
 * The frame of a booking rule's drawer (v7 §15): the hotel stamped, the rule's fields (the slot), why a save failed —
 * another rule of this kind covering the same nights or sizes said as such — and save or cancel.
 */
interface Props {
  kind: BookingRuleKind
  hotel: HotelSummary
  title: string
  description?: string
  state: object
  validate(state: object): Array<{ name: string, message: string }>
  saveLabel: string
  pending: boolean
  error: unknown
}
const props = defineProps<Props>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [] }>()
const { t, te } = useI18n()
const errorMessage = useErrorMessage()
const failure = computed(() => {
  if (!props.error) return ''
  const key = ruleConflictKey(props.kind, toApiError(props.error).code)
  return key && te(key) ? t(key) : errorMessage(props.error)
})
</script>

<template>
  <USlideover v-bind="heldWhile(pending)" v-model:open="open" :title="title" :description="description">
    <template #body>
      <UForm :state="state" :validate="validate" class="flex flex-col gap-4" @submit="emit('submit')">
        <HotelStamp :hotel="hotel" />
        <slot />
        <UAlert v-if="failure" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="failure" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="pending">{{ saveLabel }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="pending" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
