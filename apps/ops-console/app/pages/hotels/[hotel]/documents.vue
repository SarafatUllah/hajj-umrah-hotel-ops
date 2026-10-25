<script setup lang="ts">
import { keepPreviousData, useMutation } from '@tanstack/vue-query'
import type { DocumentDto, DocumentPage } from '@hajj/contracts/types/hotel'

/**
 * A hotel's documents (§23, Task 19): type, title, size and date, each downloadable. With `hotel.manage`: upload,
 * archive (tier 1) and see the archived ones too.
 */
definePageMeta({ middleware: 'auth' })
const { t, locale } = useI18n()
const api = useApi()
const notify = useNotify()
const format = useFormat()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const PAGE_SIZE = 20
const page = ref(1)
const includeArchived = ref(false)
watch(includeArchived, () => { page.value = 1 })
const canManage = computed(() => ready.value && access.value.canInHotel('hotel.manage', hotelId.value))

const documents = useApiQuery(
  () => ['documents', hotelId.value, includeArchived.value, page.value],
  () => api<DocumentPage>(`/hotels/${hotelId.value}/documents`, { query: { includeArchived: String(includeArchived.value), page: page.value, pageSize: PAGE_SIZE } }),
  { enabled: ready, placeholderData: keepPreviousData },
)
const refresh = () => hotelRefresh(hotelId.value)
const downloadUrl = (doc: DocumentDto) => `/api/hotels/${hotelId.value}/documents/${doc.id}/download${doc.archivedAt ? '?includeArchived=true' : ''}`

const uploading = ref(false)
async function uploaded(doc: DocumentDto): Promise<void> {
  notify.done(t('documents.uploaded', { title: doc.title }))
  await refresh()
}
const archiving = ref<DocumentDto | null>(null)
const archive = useMutation({
  mutationFn: (doc: DocumentDto) => api<DocumentDto>(`/hotels/${hotelId.value}/documents/${doc.id}/archive`, { method: 'POST' }),
  onSuccess: async (doc) => {
    archiving.value = null
    notify.done(t('documents.archived', { title: doc.title }))
    await refresh()
  },
  onError: (error) => {
    archiving.value = null
    notify.failed(error)
  },
})
</script>

<template>
  <HotelFrame tab="documents" :title="t('hotel.tab.documents')">
    <template #actions>
      <UButton v-if="canManage" icon="i-lucide-upload" :disabled="isInactive" @click="uploading = true">{{ t('documents.upload') }}</UButton>
    </template>
    <USwitch v-if="canManage" v-model="includeArchived" :label="t('documents.includeArchived')" />
    <ErrorState v-if="documents.error.value" :error="documents.error.value" @retry="documents.refetch()" />
    <div v-else-if="documents.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 4" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!documents.data.value?.items.length" :title="t('documents.none')" icon="i-lucide-file-text" />
    <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': documents.isPlaceholderData.value }">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('documents.title') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('documents.docType') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('documents.size') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('documents.date') }}</th>
            <th scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="doc in documents.data.value.items" :key="doc.id" :class="{ 'text-(--fg-muted)': doc.archivedAt }">
            <td class="px-4 py-3">
              <span class="font-medium"><bdi>{{ doc.title }}</bdi></span>
              <span class="block text-small text-(--fg-muted)" dir="ltr">{{ doc.originalFilename }}</span>
            </td>
            <td class="px-4 py-3">{{ t(`documents.type.${doc.docType}`) }}<UBadge v-if="doc.archivedAt" color="neutral" variant="outline" size="sm" class="ms-2">{{ t('documents.archivedBadge') }}</UBadge></td>
            <td class="px-4 py-3 text-end tabular">{{ formatBytes(doc.sizeBytes, locale) }}</td>
            <td class="px-4 py-3 tabular">{{ format.dateTime(doc.createdAt, hotel?.timezone) }}</td>
            <td class="px-4 py-3 text-end">
              <div class="flex justify-end gap-1">
                <UButton :href="downloadUrl(doc)" external size="sm" color="neutral" variant="ghost" icon="i-lucide-download" :aria-label="t('documents.download', { title: doc.title })" />
                <UButton v-if="canManage && !doc.archivedAt" size="sm" color="neutral" variant="ghost" :disabled="isInactive" :aria-label="t('documents.archiveNamed', { title: doc.title })" @click="archiving = doc">{{ t('documents.archive') }}</UButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <UPagination v-if="(documents.data.value?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="documents.data.value!.total" :items-per-page="PAGE_SIZE" class="self-center" />

    <template v-if="hotel">
      <DocumentDrawer v-model:open="uploading" :hotel="hotel" @saved="uploaded" />
      <ConfirmDialog
        :open="!!archiving"
        :title="t('documents.archiveTitle', { title: archiving?.title ?? '' })"
        :description="t('documents.archiveText', { hotel: hotel.name })"
        :confirm-label="t('documents.archiveNamed', { title: archiving?.title ?? '' })"
        :pending="archive.isPending.value"
        @update:open="value => { if (!value) archiving = null }"
        @confirm="archiving && archive.mutate(archiving)"
      />
    </template>
  </HotelFrame>
</template>
