<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { DemoResetResult } from '@hajj/contracts/types/staff'

/**
 * The demo data (§35.3): what the demo holds, and its reset — tier 3, a danger zone with a typed phrase. Only in the
 * demo organization, with `organization.resetDemo`. The demo's dates can move to start from today (on by default,
 * for live presentations). Everyone using the demo sees the reset at once; sign-ins keep working.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const queryClient = useQueryClient()
const access = useAccess()
const session = useStaffSession()
const hotels = useHotels()
useSeoMeta({ title: () => t('demo.title') })

const allowed = computed(() => !!session.me.value?.organization.isDemo && access.value.can('organization.resetDemo'))
const roomsTotal = computed(() => hotels.items.value.reduce((sum, h) => sum + (h.roomCount ?? 0), 0))
const fromToday = ref(true)
const typed = ref('')
const phrase = computed(() => t('demo.phrase'))
const today = computed(() => hotels.items.value[0]?.today)
const reset = useMutation({
  mutationFn: () => api<DemoResetResult>('/admin/demo/reset', { method: 'POST', body: fromToday.value && today.value ? { anchorDate: today.value } : {} }),
  onSuccess: async (result) => {
    typed.value = ''
    // Everything shown came from the data just replaced: all of it is asked again.
    await queryClient.invalidateQueries()
    await session.refresh()
    notify.done(t('demo.done', { date: result.anchorDate }))
  },
  onError: notify.failed,
})
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-6">
    <PageHeader :title="t('demo.title')" :description="t('demo.subtitle')" />
    <EmptyState v-if="!allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <section class="surface-panel flex flex-col gap-2 p-6">
        <h2 class="text-section">{{ t('demo.contains') }}</h2>
        <p>{{ t('demo.figures', { hotels: hotels.items.value.length, rooms: roomsTotal }) }}</p>
        <p class="text-(--fg-muted)">{{ t('demo.story') }}</p>
      </section>
      <section aria-labelledby="reset-heading" class="flex flex-col gap-4 rounded-lg border border-(--danger) p-6">
        <h2 id="reset-heading" class="text-section text-(--danger)">{{ t('demo.reset') }}</h2>
        <p>{{ t('demo.resetText') }}</p>
        <USwitch v-model="fromToday" :label="t('demo.fromToday')" />
        <UFormField :label="t('demo.typePhrase', { phrase })" name="phrase">
          <UInput v-model="typed" autocomplete="off" class="w-full sm:w-72" />
        </UFormField>
        <UButton color="error" icon="i-lucide-rotate-ccw" :disabled="typed.trim() !== phrase" :loading="reset.isPending.value" class="self-start" @click="reset.mutate()">{{ t('demo.resetButton') }}</UButton>
      </section>
    </template>
  </div>
</template>
