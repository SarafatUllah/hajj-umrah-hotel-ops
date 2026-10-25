<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { DOC_TYPES, DOCUMENT_MIME_TYPES, MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'
import { uploadDocumentFieldsSchema } from '@hajj/contracts/schemas/document'
import type { DocumentDto, HotelSummary } from '@hajj/contracts/types/hotel'
import { heldWhile } from '../../utils/forms'

/** Upload a hotel document (§23, Task 19): its type, title and file — the limits stated before choosing it. */
const props = defineProps<{ hotel: HotelSummary }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [DocumentDto] }>()
const { t, locale } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const ALLOWED: readonly string[] = DOCUMENT_MIME_TYPES
const types = computed(() => choiceItems(DOC_TYPES, value => t(`documents.type.${value}`)))
const form = ref({ docType: 'LICENSE' as typeof DOC_TYPES[number], title: '', description: '' })
const file = ref<File | null>(null)
const fileProblem = ref<string | null>(null)
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  form.value = { docType: 'LICENSE', title: '', description: '' }
  file.value = null
  fileProblem.value = null
})
/** Counts the picks: a slow shrink of an earlier pick never overwrites a later one. */
let picks = 0
async function pick(event: Event): Promise<void> {
  const picked = (event.target as HTMLInputElement).files?.[0] ?? null
  const pickNo = ++picks
  // A scanned page photographed over the limit is redrawn smaller first (utils/photos); a PDF is checked as it is.
  const chosen = picked ? await shrinkPhoto(picked) : null
  if (pickNo !== picks) return
  const refusal = chosen ? uploadRefusal(chosen, ALLOWED) : null
  fileProblem.value = refusal ? t(`errors.codes.${refusal}`) : null
  file.value = refusal ? null : chosen
}
const validate = validateWith(uploadDocumentFieldsSchema, key => t(key))
const save = useMutation({
  mutationFn: () => {
    const body = new FormData()
    body.append('docType', form.value.docType)
    body.append('title', form.value.title)
    if (form.value.description.trim()) body.append('description', form.value.description)
    body.append('file', file.value!)
    return api<DocumentDto>(`/hotels/${props.hotel.id}/documents`, { method: 'POST', body })
  },
  onSuccess: (document) => {
    open.value = false
    emit('saved', document)
  },
})
const limits = computed(() => t('documents.limits', { size: formatBytes(MAX_UPLOAD_BYTES, locale.value) }))
</script>

<template>
  <USlideover v-bind="heldWhile(save.isPending.value)" v-model:open="open" :title="t('documents.upload')" :description="limits">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <UFormField :label="t('documents.docType')" name="docType" required><USelect v-model="form.docType" :items="types" class="w-full" /></UFormField>
        <UFormField :label="t('documents.title')" name="title" required><UInput v-model="form.title" class="w-full" /></UFormField>
        <UFormField :label="t('documents.description')" name="description" :hint="t('common.optional')"><UTextarea v-model="form.description" :rows="3" class="w-full" /></UFormField>
        <div class="flex flex-col gap-1">
          <label for="document-file" class="text-small font-medium">{{ t('documents.file') }} <span class="text-(--danger)" aria-hidden="true">*</span></label>
          <input
            id="document-file"
            type="file"
            required
            :accept="ALLOWED.join(',')"
            :aria-invalid="fileProblem ? 'true' : undefined"
            aria-describedby="document-file-help document-file-problem"
            class="block w-full text-small file:me-3 file:rounded-md file:border file:border-(--border) file:bg-(--surface-2) file:px-3 file:py-1.5"
            @change="pick"
          >
          <p id="document-file-help" class="text-small text-(--fg-muted)">{{ limits }}</p>
          <p id="document-file-problem" class="text-small text-(--danger)" aria-live="polite">{{ fileProblem }}</p>
        </div>
        <UAlert v-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value" :disabled="!file">{{ t('documents.upload') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="save.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
