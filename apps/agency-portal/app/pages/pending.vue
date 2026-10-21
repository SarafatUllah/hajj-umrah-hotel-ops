<script setup lang="ts">
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const notify = useNotify()
const session = useAgencySession()
const { me } = session
const checking = ref(false)
/** Where the agency stands: waiting for approval (also while unknown), suspended, or refused. */
const standing = computed(() => (me.value && me.value.agency.status !== 'APPROVED' ? me.value.agency.status : 'PENDING'))
useSeoMeta({ title: () => t(`pending.title.${standing.value}`) })

/** Asks the hotel's answer again; once approved, the agency goes on to its bookings. */
async function check(): Promise<void> {
  checking.value = true
  try {
    const fresh = await session.refresh()
    if (fresh?.agency.status === 'APPROVED') await navigateTo('/')
  }
  catch (error) {
    notify.failed(error)
  }
  finally {
    checking.value = false
  }
}
onMounted(check)
</script>

<template>
  <div class="mx-auto flex max-w-xl flex-col gap-4">
    <PageHeader :title="t(`pending.title.${standing}`)" />
    <div class="surface-panel flex flex-col gap-3 p-6">
      <StatusBadge v-if="me" domain="agency" :value="me.agency.status" class="self-start" />
      <p>{{ t(`pending.text.${standing}`) }}</p>
      <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="checking" class="self-start" @click="check">{{ t('pending.check') }}</UButton>
    </div>
  </div>
</template>
