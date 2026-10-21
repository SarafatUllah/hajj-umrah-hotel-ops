<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { bulkCreateFloorsSchema } from '@hajj/contracts/schemas/floor'
import type { FloorListItem, HotelSummary } from '@hajj/contracts/types/hotel'
import { floorLevels } from '../../utils/floors'

/**
 * Add floors in bulk (§25): from one level to another, previewed live ("Creates 10 floors: 2, 3 … 11"). All or
 * nothing: levels that already exist are named and marked in the preview, and nothing is created.
 */
const props = defineProps<{ hotel: HotelSummary }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [FloorListItem[]] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const MAX_FLOORS = 60
const form = ref({ fromLevel: 1, toLevel: 10 })
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  form.value = { fromLevel: 1, toLevel: 10 }
})
const levels = computed(() => floorLevels(form.value.fromLevel, form.value.toLevel))
const existing = computed<number[]>(() => (save.error.value ? toApiError(save.error.value).detail<number[]>('existing') ?? [] : []))
const validate = validateWith(bulkCreateFloorsSchema, key => t(key))
const save = useMutation({
  mutationFn: () => api<FloorListItem[]>(`/hotels/${props.hotel.id}/floors/bulk`, { method: 'POST', body: form.value }),
  onSuccess: (floors) => {
    open.value = false
    emit('saved', floors)
  },
})
</script>

<template>
  <USlideover v-model:open="open" :title="t('floors.addMany')" :description="t('floors.bulkHelp')">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('floors.fromLevel')" name="fromLevel" required><UInputNumber v-model="form.fromLevel" :min="-5" :max="200" class="w-full" /></UFormField>
          <UFormField :label="t('floors.toLevel')" name="toLevel" required><UInputNumber v-model="form.toLevel" :min="-5" :max="200" class="w-full" /></UFormField>
        </div>
        <div class="surface-panel flex flex-col gap-2 p-3" aria-live="polite">
          <p v-if="!levels.length" class="text-small text-(--fg-muted)">{{ t('floors.previewNone') }}</p>
          <p v-else-if="levels.length > MAX_FLOORS" class="text-small text-(--warning)">{{ t('floors.previewTooMany', { max: MAX_FLOORS }) }}</p>
          <template v-else>
            <p class="text-small">{{ t('floors.preview', levels.length) }}</p>
            <ul class="flex flex-wrap gap-1">
              <li v-for="level in levels" :key="level">
                <UBadge :color="existing.includes(level) ? 'error' : 'neutral'" variant="soft" class="tabular">{{ level }}</UBadge>
              </li>
            </ul>
          </template>
        </div>
        <UAlert v-if="existing.length" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="t('floors.exist', { levels: existing.join(', ') }, existing.length)" role="alert" />
        <UAlert v-else-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value" :disabled="!levels.length || levels.length > MAX_FLOORS">{{ t('floors.createMany', levels.length) }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
