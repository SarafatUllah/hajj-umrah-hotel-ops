<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'
import { PASSPORT_IMAGE_TYPES } from '@hajj/contracts/constants/pilgrimData'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import type { GuestSlotDto, PassportScanDto } from '@hajj/contracts/types/booking'

/**
 * Passport photos (v7 §13): drop them here, each is read in the background; then check what was read beside the
 * photo, correct it, and save it to a place — nothing becomes a pilgrim's details before that.
 */
const props = defineProps<{ bookingId: string, guests: GuestSlotDto[] }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const READING = ['QUEUED', 'PROCESSING']
const REVIEWABLE = ['NEEDS_REVIEW', 'FAILED']
const POLL_MS = 3000
/** A reading usually takes seconds; one still running after this is looked at only now and then. */
const READING_PATIENCE_MS = 120_000
const SLOW_POLL_MS = 30_000
const IMAGE_TYPES: readonly string[] = PASSPORT_IMAGE_TYPES

/** How soon to look again: often while a photo is being read, rarely once its reading has taken long, never after. */
function pollInterval(data: PassportScanDto[] | undefined): number | false {
  const reading = (data ?? []).filter(s => READING.includes(s.status))
  if (!reading.length) return false
  const newest = Math.max(...reading.map(s => Date.parse(s.createdAt)))
  return Date.now() - newest < READING_PATIENCE_MS ? POLL_MS : SLOW_POLL_MS
}
const scans = useApiQuery(() => ['agency-scans', props.bookingId], () => api<PassportScanDto[]>(`/agency/bookings/${props.bookingId}/passport-scans`), {
  refetchInterval: (query: { state: { data?: unknown } }) => pollInterval(query.state.data as PassportScanDto[] | undefined),
})
const refresh = () => queryClient.invalidateQueries({ queryKey: ['agency-scans', props.bookingId] })

/** Why the API would refuse this file, checked before sending it (the API checks again). */
function refusal(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'TYPE_NOT_ALLOWED'
  if (file.size > MAX_UPLOAD_BYTES) return 'FILE_TOO_LARGE'
  return null
}
interface UploadOutcome { sent: number, refused: Array<{ name: string, message: string }> }
/** One photo after the other; each failure is noted and the rest still go — unless the booking takes no more (409). */
async function uploadAll(files: File[]): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { sent: 0, refused: [] }
  for (const [index, file] of files.entries()) {
    const code = refusal(file)
    if (code) {
      outcome.refused.push({ name: file.name, message: t(`errors.codes.${code}`) })
      continue
    }
    try {
      const body = new FormData()
      body.append('file', file)
      await api(`/agency/bookings/${props.bookingId}/passport-scans`, { method: 'POST', body })
      outcome.sent += 1
    }
    catch (error) {
      const message = errorMessage(error)
      if (toApiError(error).status !== 409) {
        outcome.refused.push({ name: file.name, message })
        continue
      }
      outcome.refused.push(...files.slice(index).map(rest => ({ name: rest.name, message })))
      break
    }
  }
  return outcome
}
const upload = useMutation({
  mutationFn: uploadAll,
  onSuccess: ({ sent, refused }) => {
    if (!refused.length) {
      toast.add({ title: t('scans.uploaded', sent), color: 'success', icon: 'i-lucide-circle-check' })
      return
    }
    const description = refused.map(r => `${r.name}: ${r.message}`).join(' · ')
    toast.add({ title: t('scans.uploadedSome', { sent, total: sent + refused.length }), description, color: sent ? 'warning' : 'error', icon: 'i-lucide-triangle-alert' })
  },
  onError: error => toast.add({ title: errorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' }),
  onSettled: refresh,
})
const fileInput = ref<HTMLInputElement | null>(null)
function pick(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) upload.mutate(files)
}

// The review card: the photo beside the form, the fields read with low confidence pointed out.
const reviewing = ref<PassportScanDto | null>(null)
const details = ref<GuestFieldValues>({ fullName: '' })
const guestId = ref<string>('')
const places = computed(() => props.guests.filter(g => ['PENDING_DETAILS', 'READY'].includes(g.status)).map(g => ({ value: g.id, label: `${slotLabel(g, t)} · ${g.details?.fullName ?? '—'}` })))
/** Where a photo most likely belongs: the place it was matched to, else the first still waiting for details. */
const firstEmptyPlace = () => props.guests.find(g => g.status === 'PENDING_DETAILS')?.id ?? places.value[0]?.value ?? ''
function review(scan: PassportScanDto) {
  reviewing.value = scan
  const f = scan.fields ?? {}
  details.value = { fullName: f.fullName ?? '', gender: f.gender, nationality: f.nationality, dateOfBirth: f.dateOfBirth, passportNo: f.passportNo, passportExpiry: f.passportExpiry }
  guestId.value = scan.guestId ?? firstEmptyPlace()
}
const validate = validateWith(guestDetailsSchema, key => t(key))
const confirm = useMutation({
  mutationFn: () => api(`/agency/bookings/${props.bookingId}/passport-scans/${reviewing.value!.id}/confirm`, { method: 'POST', body: { guestId: guestId.value, details: guestDetailsSchema.parse(details.value) } }),
  onSuccess: async () => {
    reviewing.value = null
    toast.add({ title: t('scans.saved'), color: 'success', icon: 'i-lucide-circle-check' })
    await refresh()
    emit('changed')
  },
})
const discard = useMutation({
  mutationFn: (scanId: string) => api(`/agency/bookings/${props.bookingId}/passport-scans/${scanId}/discard`, { method: 'POST' }),
  onSuccess: async () => {
    reviewing.value = null
    toast.add({ title: t('scans.discarded'), color: 'success', icon: 'i-lucide-circle-check' })
    await refresh()
  },
  onError: error => toast.add({ title: errorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' }),
})
const imageUrl = (scan: PassportScanDto) => `/api/agency/bookings/${props.bookingId}/passport-scans/${scan.id}/image`
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-(--fg-muted)">{{ t('scans.help') }}</p>
      <!-- A real button opens the file chooser (keyboard and screen readers reach it); the input itself stays out of the way. -->
      <input ref="fileInput" type="file" accept="image/png,image/jpeg" multiple class="sr-only" tabindex="-1" aria-hidden="true" @change="pick">
      <UButton icon="i-lucide-upload" :loading="upload.isPending.value" @click="fileInput?.click()">{{ t('scans.add') }}</UButton>
    </div>
    <ErrorState v-if="scans.error.value" :error="scans.error.value" @retry="scans.refetch()" />
    <EmptyState v-else-if="!scans.data.value?.length" :title="t('scans.none')" icon="i-lucide-scan-line" />
    <ul v-else class="surface-panel divide-y divide-(--border)">
      <li v-for="scan in scans.data.value" :key="scan.id" class="flex flex-wrap items-center justify-between gap-3 p-4">
        <span><bdi>{{ scan.fields?.fullName ?? '—' }}</bdi> <span class="tabular text-(--fg-muted)" dir="ltr">{{ scan.fields?.passportNo ?? '' }}</span></span>
        <div class="flex items-center gap-2">
          <StatusBadge domain="scan" :value="scan.status" />
          <UButton v-if="REVIEWABLE.includes(scan.status)" size="sm" color="neutral" variant="outline" icon="i-lucide-eye" @click="review(scan)">{{ t('scans.review') }}</UButton>
        </div>
      </li>
    </ul>

    <USlideover :open="!!reviewing" :title="t('scans.reviewTitle')" :description="t('scans.reviewHelp')" :ui="{ content: 'max-w-2xl' }" @update:open="value => { if (!value) reviewing = null }">
      <template #body>
        <div v-if="reviewing" class="flex flex-col gap-4">
          <img :src="imageUrl(reviewing)" :alt="t('scans.imageAlt')" class="max-h-80 w-full rounded-md border border-(--border) object-contain">
          <UAlert v-if="reviewing.status === 'FAILED'" color="warning" variant="soft" icon="i-lucide-triangle-alert" :title="t('scans.failed')" />
          <UAlert v-else-if="reviewing.needsAttention.length" color="warning" variant="soft" icon="i-lucide-eye" :title="t('scans.attention')" :description="reviewing.needsAttention.map(f => t(`guest.${f}`)).join(', ')" />
          <UForm :state="details" :validate="validate" class="flex flex-col gap-4" @submit="confirm.mutate()">
            <UFormField :label="t('scans.place')" name="guestId" required>
              <USelect v-model="guestId" :items="places" :disabled="!places.length" class="w-full" />
            </UFormField>
            <UAlert v-if="!places.length" color="neutral" variant="soft" icon="i-lucide-info" :title="t('scans.noPlace')" />
            <GuestFields v-model="details" />
            <UAlert v-if="confirm.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(confirm.error.value)" role="alert" />
            <div class="flex flex-wrap gap-2">
              <UButton type="submit" :loading="confirm.isPending.value" :disabled="!guestId">{{ t('scans.save') }}</UButton>
              <UButton color="neutral" variant="outline" icon="i-lucide-trash-2" :loading="discard.isPending.value" @click="discard.mutate(reviewing.id)">{{ t('scans.discard') }}</UButton>
            </div>
          </UForm>
        </div>
      </template>
    </USlideover>
  </div>
</template>
