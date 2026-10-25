<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { AgencyDetail, AgencyDto, AgencyUserDto } from '@hajj/contracts/types/agency'
import { type AgencyDecision, agencyDecisions } from '../../utils/agencies'

/**
 * One agency (v7 §6, §15; `agency.view`): its profile and status (with the staff's reason), its bookings and quotes,
 * and its portal users. With `agency.manage` and every hotel: approve, suspend or reject it (with a reason), add a
 * user, turn a user's sign-in off or on again.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const access = useAccess()
const queryClient = useQueryClient()
const id = computed(() => String(route.params.id))

const allowed = computed(() => access.value.can('agency.view'))
const canManage = computed(() => access.value.can('agency.manage') && access.value.hasAllHotels)
const agency = useApiQuery(() => ['agency', id.value], () => api<AgencyDetail>(`/agencies/${id.value}`), { enabled: allowed })
const notFound = computed(() => !!agency.error.value && toApiError(agency.error.value).status === 404)
useSeoMeta({ title: () => agency.data.value?.name ?? t('nav.agencies') })
const refresh = () => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['agency', id.value] }),
  queryClient.invalidateQueries({ queryKey: ['agencies'] }),
])

const deciding = ref<AgencyDecision | null>(null)
async function decided(updated: AgencyDto): Promise<void> {
  deciding.value = null
  notify.done(t(`agencies.decision.${updated.status as AgencyDecision}.done`, { name: updated.name }))
  await refresh()
}
const addingUser = ref(false)
async function userAdded(user: AgencyUserDto): Promise<void> {
  notify.done(t('agencies.userAdded', { name: user.fullName }))
  await refresh()
}
const setActive = useMutation({
  mutationFn: ({ user, isActive }: { user: AgencyUserDto, isActive: boolean }) => api<AgencyUserDto>(`/agencies/${id.value}/users/${user.id}`, { method: 'PATCH', body: { isActive } }),
  onSuccess: async (user) => {
    notify.done(t(user.isActive ? 'agencies.userOn' : 'agencies.userOff', { name: user.fullName }))
    await refresh()
  },
  onError: notify.failed,
})
// A new password for a user who lost theirs (their sessions end).
const settingPassword = ref<AgencyUserDto | null>(null)
function passwordSet(user: AgencyUserDto): void {
  settingPassword.value = null
  notify.done(t('agencies.password.done', { name: user.fullName }))
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <UButton to="/agencies" color="neutral" variant="link" icon="i-lucide-arrow-left" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" class="self-start">{{ t('nav.agencies') }}</UButton>
    <EmptyState v-if="!allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <EmptyState v-else-if="notFound" :title="t('agencies.notFound')" icon="i-lucide-briefcase" />
    <ErrorState v-else-if="agency.error.value" :error="agency.error.value" @retry="agency.refetch()" />
    <USkeleton v-else-if="!agency.data.value" class="h-48" />
    <template v-else>
      <PageHeader :title="agency.data.value.name" :description="agency.data.value.licenseNo">
        <template #actions>
          <StatusBadge domain="agency" :value="agency.data.value.status" />
          <template v-if="canManage">
            <UButton v-for="decision in agencyDecisions(agency.data.value.status)" :key="decision" :color="decision === 'APPROVED' ? 'primary' : 'error'" :variant="decision === 'APPROVED' ? 'solid' : 'outline'" @click="deciding = decision">
              {{ t(`agencies.decision.${decision}.action`) }}
            </UButton>
          </template>
        </template>
      </PageHeader>
      <UAlert v-if="agency.data.value.statusReason" color="neutral" variant="soft" icon="i-lucide-info" :title="t('agencies.statusReason')" :description="agency.data.value.statusReason" />

      <dl class="surface-panel grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <div><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.contactName') }}</dt><dd><bdi>{{ agency.data.value.contactName }}</bdi></dd></div>
        <div><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.phone') }}</dt><dd class="tabular" dir="ltr">{{ agency.data.value.phone }}</dd></div>
        <div><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.agencyEmail') }}</dt><dd dir="ltr">{{ agency.data.value.email }}</dd></div>
        <div v-if="agency.data.value.whatsappNumber"><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.whatsapp') }}</dt><dd class="tabular" dir="ltr">{{ agency.data.value.whatsappNumber }}</dd></div>
        <div v-if="agency.data.value.address"><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.address') }}</dt><dd><bdi>{{ agency.data.value.address }}</bdi></dd></div>
        <div><dt class="text-caption text-(--fg-muted)">{{ t('agencies.registered') }}</dt><dd class="tabular">{{ format.dateTime(agency.data.value.createdAt) }}</dd></div>
        <div v-if="agency.data.value.approvedAt"><dt class="text-caption text-(--fg-muted)">{{ t('agencies.approvedAt') }}</dt><dd class="tabular">{{ format.dateTime(agency.data.value.approvedAt) }}</dd></div>
      </dl>
      <div class="flex flex-wrap gap-2">
        <UButton :to="{ path: '/bookings', query: { agency: agency.data.value.id } }" color="neutral" variant="outline" icon="i-lucide-notebook-tabs">{{ t('agencies.itsBookings') }}</UButton>
        <UButton :to="{ path: '/quotes', query: { agency: agency.data.value.id, status: 'ALL' } }" color="neutral" variant="outline" icon="i-lucide-message-square-quote">{{ t('agencies.itsQuotes') }}</UButton>
      </div>

      <section aria-labelledby="users-heading" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 id="users-heading" class="text-section">{{ t('agencies.users') }}</h2>
          <UButton v-if="canManage" color="neutral" variant="outline" icon="i-lucide-user-plus" @click="addingUser = true">{{ t('agencies.addUser') }}</UButton>
        </div>
        <p v-if="!agency.data.value.users.length" class="text-(--fg-muted)">{{ t('agencies.noUsers') }}</p>
        <ul v-else class="surface-panel divide-y divide-(--border)">
          <li v-for="user in agency.data.value.users" :key="user.id" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <bdi class="font-medium">{{ user.fullName }}</bdi>
            <span class="text-small" dir="ltr">{{ user.email }}</span>
            <span class="text-small text-(--fg-muted)">{{ user.lastLoginAt ? t('agencies.lastSignIn', { time: format.dateTime(user.lastLoginAt) }) : t('agencies.neverSignedIn') }}</span>
            <UBadge v-if="!user.isActive" color="neutral" variant="soft" size="sm">{{ t('agencies.signInOff') }}</UBadge>
            <UButton
              v-if="canManage"
              size="sm"
              color="neutral"
              variant="ghost"
              class="ms-auto"
              icon="i-lucide-key-round"
              :aria-label="t('agencies.password.actionNamed', { name: user.fullName })"
              @click="settingPassword = user"
            >
              {{ t('agencies.password.open') }}
            </UButton>
            <UButton
              v-if="canManage"
              size="sm"
              color="neutral"
              variant="ghost"
              :loading="setActive.isPending.value && setActive.variables.value?.user.id === user.id"
              :disabled="setActive.isPending.value"
              :aria-label="t(user.isActive ? 'agencies.turnOffNamed' : 'agencies.turnOnNamed', { name: user.fullName })"
              @click="setActive.mutate({ user, isActive: !user.isActive })"
            >
              {{ user.isActive ? t('agencies.turnOff') : t('agencies.turnOn') }}
            </UButton>
          </li>
        </ul>
      </section>
      <AgencyDecisionDialog :agency="agency.data.value" :decision="deciding" @close="deciding = null" @done="decided" />
      <AgencyUserDrawer v-model:open="addingUser" :agency-id="agency.data.value.id" @added="userAdded" />
      <AgencyPasswordDialog :agency-id="agency.data.value.id" :user="settingPassword" @close="settingPassword = null" @done="passwordSet" />
    </template>
  </div>
</template>
