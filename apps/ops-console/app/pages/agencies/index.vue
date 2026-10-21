<script setup lang="ts">
import { keepPreviousData, useQueryClient } from '@tanstack/vue-query'
import { AGENCY_STATUSES, type AgencyStatus } from '@hajj/contracts/constants/accounts'
import type { AgencyDetail, AgencyDto, AgencyListPage } from '@hajj/contracts/types/agency'

/**
 * Agencies (v7 §6, §15; `agency.view`): those waiting for approval first by default, then any status — name, licence,
 * contact, status. One opens on its page (decisions and users). A new one, checked offline, is approved at once
 * (`agency.manage` with every hotel). Search and filters in the URL.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const format = useFormat()
const access = useAccess()
const queryClient = useQueryClient()
const { queryOf, setQuery, searchOf, pageOf } = useUrlQuery()
useSeoMeta({ title: () => t('nav.agencies') })
const PAGE_SIZE = 25
const ALL = 'ALL'

const allowed = computed(() => access.value.can('agency.view'))
const status = computed<AgencyStatus | typeof ALL>({
  get: () => AGENCY_STATUSES.find(s => s === queryOf('status')) ?? ALL,
  set: value => setQuery({ status: value === ALL ? undefined : value, page: undefined }),
})
const search = searchOf('q', { page: undefined })
const q = computed(() => queryOf('q') ?? '')
const page = pageOf()
const agencies = useApiQuery(
  () => ['agencies', 'list', status.value, q.value, page.value],
  () => api<AgencyListPage>('/agencies', { query: { status: status.value === ALL ? undefined : status.value, q: q.value || undefined, page: page.value, pageSize: PAGE_SIZE } }),
  { enabled: allowed, placeholderData: keepPreviousData },
)
const pending = useApiQuery(['agencies', 'pending-count'], () => api<AgencyListPage>('/agencies', { query: { status: 'PENDING', pageSize: 1 } }), { enabled: allowed })
const statusItems = computed(() => [{ value: ALL, label: t('agencies.allStatuses') }, ...AGENCY_STATUSES.map(value => ({ value, label: t(`status.agency.${value}`) }))])
const filtered = computed(() => status.value !== ALL || !!q.value)
const clearFilters = () => setQuery({ status: undefined, q: undefined, page: undefined })
const canCreate = computed(() => access.value.can('agency.manage') && access.value.hasAllHotels)
const linkOf = (agency: AgencyDto) => `/agencies/${agency.id}`

const creating = ref(false)
async function created(agency: AgencyDetail): Promise<void> {
  notify.done(t('agencies.created', { name: agency.name }))
  await queryClient.invalidateQueries({ queryKey: ['agencies'] })
  await navigateTo(linkOf(agency))
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('nav.agencies')">
      <template #actions>
        <UButton v-if="canCreate" icon="i-lucide-plus" @click="creating = true">{{ t('agencies.new') }}</UButton>
      </template>
    </PageHeader>
    <EmptyState v-if="!allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <UAlert v-if="pending.data.value?.total && status !== 'PENDING'" color="info" variant="soft" icon="i-lucide-hourglass" :title="t('agencies.waiting', { count: pending.data.value.total }, pending.data.value.total)">
        <template #actions><UButton size="sm" color="neutral" variant="outline" @click="status = 'PENDING'">{{ t('agencies.showWaiting') }}</UButton></template>
      </UAlert>
      <div class="flex flex-wrap gap-2">
        <UInput v-model="search" icon="i-lucide-search" :placeholder="t('agencies.search')" :aria-label="t('agencies.search')" class="w-64" />
        <USelect v-model="status" :items="statusItems" :aria-label="t('bookings.statusLabel')" class="w-48" />
        <UButton v-if="filtered" color="neutral" variant="ghost" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
      </div>
      <ErrorState v-if="agencies.error.value" :error="agencies.error.value" @retry="agencies.refetch()" />
      <div v-else-if="agencies.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 6" :key="n" class="h-12" /></div>
      <EmptyState v-else-if="!agencies.data.value?.items.length" :title="filtered ? t('agencies.noMatch') : t('agencies.none')" icon="i-lucide-briefcase">
        <UButton v-if="filtered" color="neutral" variant="outline" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
      </EmptyState>
      <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': agencies.isPlaceholderData.value }">
        <table class="w-full">
          <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
            <tr>
              <th scope="col" class="px-4 py-2 text-start">{{ t('agencyForm.name') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('agencyForm.licenseNo') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('agencyForm.contactName') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.status') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('agencies.registered') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--border)">
            <tr v-for="agency in agencies.data.value.items" :key="agency.id">
              <td class="px-4 py-2 font-semibold"><NuxtLink :to="linkOf(agency)" class="hover:underline"><bdi>{{ agency.name }}</bdi></NuxtLink></td>
              <td class="px-4 py-2 tabular" dir="ltr">{{ agency.licenseNo }}</td>
              <td class="px-4 py-2"><bdi>{{ agency.contactName }}</bdi><span class="block text-caption text-(--fg-muted)" dir="ltr">{{ agency.phone }}</span></td>
              <td class="px-4 py-2"><StatusBadge domain="agency" :value="agency.status" /></td>
              <td class="whitespace-nowrap px-4 py-2 tabular">{{ format.dateTime(agency.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <UPagination v-if="(agencies.data.value?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="agencies.data.value!.total" :items-per-page="PAGE_SIZE" class="self-center" />
    </template>
    <NewAgencyDrawer v-model:open="creating" @created="created" />
  </div>
</template>
