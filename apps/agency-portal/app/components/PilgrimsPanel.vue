<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import type { GuestSlotDto } from '@hajj/contracts/types/booking'

/**
 * The booking's pilgrims (v7 §7) with the agency's own copies in full: enter or correct anyone not yet arrived (the
 * hotel changes a pilgrim once checked in) while the booking is `editable` (it still holds its places).
 */
const props = defineProps<{ bookingId: string, guests: GuestSlotDto[], editable: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const errorMessage = useErrorMessage()
const EDITABLE = ['PENDING_DETAILS', 'READY']

const editing = ref<GuestSlotDto | null>(null)
const details = ref<GuestFieldValues>({ fullName: '' })
function edit(slot: GuestSlotDto) {
  editing.value = slot
  const d = slot.details
  details.value = { fullName: d?.fullName ?? '', gender: d?.gender ?? slot.gender ?? undefined, nationality: d?.nationality ?? undefined, dateOfBirth: d?.dateOfBirth ?? undefined, passportNo: d?.passportNo ?? undefined, passportExpiry: d?.passportExpiry ?? undefined }
}
const validate = validateWith(guestDetailsSchema, key => t(key))
const save = useMutation({
  mutationFn: () => api<GuestSlotDto>(`/agency/bookings/${props.bookingId}/guests/${editing.value!.id}`, { method: 'PUT', body: guestDetailsSchema.parse(details.value) }),
  onSuccess: () => {
    editing.value = null
    toast.add({ title: t('guest.saved'), color: 'success', icon: 'i-lucide-circle-check' })
    emit('changed')
  },
})
</script>

<template>
  <div class="surface-panel overflow-x-auto">
    <table class="w-full">
      <tbody class="divide-y divide-(--border)">
        <tr v-for="slot in guests" :key="slot.id">
          <td class="px-4 py-3 text-caption text-(--fg-muted)">
            {{ slotLabel(slot, t) }}
          </td>
          <td class="px-4 py-3"><bdi>{{ slot.details?.fullName ?? '—' }}</bdi></td>
          <td class="px-4 py-3 tabular" dir="ltr">{{ slot.details?.passportNo ?? '' }}</td>
          <td class="px-4 py-3"><StatusBadge domain="guest" :value="slot.status" /></td>
          <td class="px-4 py-3 text-end">
            <UButton v-if="editable && EDITABLE.includes(slot.status)" size="sm" color="neutral" variant="outline" icon="i-lucide-file-pen" @click="edit(slot)">
              {{ slot.details ? t('guest.editDetails') : t('guest.addDetails') }}
            </UButton>
          </td>
        </tr>
      </tbody>
    </table>
    <USlideover :open="!!editing" :title="editing ? slotLabel(editing, t) : ''" :description="t('guest.editHelp')" @update:open="value => { if (!value) editing = null }">
      <template #body>
        <UForm :state="details" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
          <GuestFields v-model="details" />
          <UAlert v-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
          <UButton type="submit" :loading="save.isPending.value" class="self-start">{{ t('common.save') }}</UButton>
        </UForm>
      </template>
    </USlideover>
  </div>
</template>
