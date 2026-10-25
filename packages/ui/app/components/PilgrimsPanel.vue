<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { GUEST_TO_COME_STATUSES } from '@hajj/contracts/constants/booking'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import type { GuestSlotDto } from '@hajj/contracts/types/booking'
import { isMaskedPassport } from '@hajj/contracts/utils/passport'

/**
 * The booking's pilgrims (v7 §7): place, name and what needs attention, passport, room and status. Enter or correct
 * anyone not yet arrived while the booking is `editable` (it still holds its places) — and, with `editsArrived` (the
 * hotel's staff), those who arrived, left or did not come too. Details read with a masked passport number are not
 * offered for correction: what is on screen is not the number, and saving would send the mask or drop the number.
 * The same panel for an agency and the hotel's staff: `base` is the booking's path in the API as the caller reaches
 * it, and the `actions` slot adds the caller's own actions per pilgrim (staff: check-in, no-show …).
 */
const props = defineProps<{ base: string, guests: GuestSlotDto[], editable: boolean, editsArrived?: boolean }>()
defineSlots<{ actions?: (scope: { guest: GuestSlotDto }) => unknown }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const errorMessage = useErrorMessage()
const EDITABLE = computed<readonly string[]>(() => (props.editsArrived ? [...GUEST_TO_COME_STATUSES, 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW'] : GUEST_TO_COME_STATUSES))
const canEdit = (slot: GuestSlotDto) => props.editable && EDITABLE.value.includes(slot.status) && !isMaskedPassport(slot.details?.passportNo)

const editing = ref<GuestSlotDto | null>(null)
const details = ref<GuestFieldValues>({ fullName: '' })
function edit(slot: GuestSlotDto) {
  editing.value = slot
  const d = slot.details
  details.value = { fullName: d?.fullName ?? '', gender: d?.gender ?? slot.gender ?? undefined, nationality: d?.nationality ?? undefined, dateOfBirth: d?.dateOfBirth ?? undefined, passportNo: d?.passportNo ?? undefined, passportExpiry: d?.passportExpiry ?? undefined }
}
const validate = validateWith(guestDetailsSchema, key => t(key))
const save = useMutation({
  mutationFn: () => api<GuestSlotDto>(`${props.base}/guests/${editing.value!.id}`, { method: 'PUT', body: guestDetailsSchema.parse(details.value) }),
  onSuccess: () => {
    editing.value = null
    notify.done(t('guest.saved'))
    emit('changed')
  },
})
</script>

<template>
  <div class="surface-panel overflow-x-auto">
    <table class="w-full">
      <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
        <tr>
          <th scope="col" class="px-4 py-2 text-start">{{ t('guest.slot') }}</th>
          <th scope="col" class="px-4 py-2 text-start">{{ t('guest.fullName') }}</th>
          <th scope="col" class="px-4 py-2 text-start">{{ t('guest.passportNo') }}</th>
          <th scope="col" class="px-4 py-2 text-start">{{ t('guest.room') }}</th>
          <th scope="col" class="px-4 py-2 text-start">{{ t('guest.status') }}</th>
          <th scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-(--border)">
        <tr v-for="slot in guests" :key="slot.id">
          <td class="px-4 py-3 text-caption text-(--fg-muted)">
            {{ slotLabel(slot, t) }}
          </td>
          <td class="px-4 py-3">
            <bdi>{{ slot.details?.fullName ?? '—' }}</bdi>
            <ul v-if="slot.warnings.length" class="mt-1 flex flex-col gap-0.5 text-small text-(--warning)">
              <li v-for="warning in slot.warnings" :key="warning.code" class="flex items-center gap-1">
                <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" />{{ t(`guestIssues.${warning.code}`, warning) }}
              </li>
            </ul>
          </td>
          <td class="px-4 py-3 tabular" dir="ltr">{{ slot.details?.passportNo ?? '' }}</td>
          <td class="px-4 py-3 tabular" dir="ltr">{{ slot.roomNumber ?? '' }}</td>
          <td class="px-4 py-3"><StatusBadge domain="guest" :value="slot.status" /></td>
          <td class="px-4 py-3">
            <div class="flex flex-wrap justify-end gap-2">
              <UButton
                v-if="canEdit(slot)"
                size="sm"
                color="neutral"
                variant="outline"
                icon="i-lucide-file-pen"
                :aria-label="slot.details ? t('guest.editDetailsFor', { name: slot.details.fullName }) : t('guest.addDetailsFor', { place: slotLabel(slot, t) })"
                @click="edit(slot)"
              >
                {{ slot.details ? t('guest.editDetails') : t('guest.addDetails') }}
              </UButton>
              <slot name="actions" :guest="slot" />
            </div>
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
