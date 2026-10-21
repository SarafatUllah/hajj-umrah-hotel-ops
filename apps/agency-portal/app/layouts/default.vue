<script setup lang="ts">
const { t } = useI18n()
const { me, ensure, signOut } = useAgencySession()
// Until the API answers, the header shows no agency; a failed answer leaves it so (the page shows the error).
onMounted(() => { void ensure().catch(() => undefined) })
const links = computed(() => [
  { label: t('portal.nav.bookings'), to: '/', icon: 'i-lucide-calendar-check' },
  { label: t('portal.nav.book'), to: '/book', icon: 'i-lucide-plus' },
  { label: t('portal.nav.quotes'), to: '/quotes', icon: 'i-lucide-tag' },
])
const toast = useToast()
const errorMessage = useErrorMessage()
async function signOutNow() {
  try {
    await signOut()
    await navigateTo('/login')
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' })
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header class="border-b border-(--border) bg-(--surface-1)">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <div class="flex flex-col">
          <NuxtLink to="/" class="text-subsection">{{ t('portal.name') }}</NuxtLink>
          <span v-if="me" class="text-small text-(--fg-muted)"><bdi>{{ me.agency.name }}</bdi></span>
        </div>
        <nav v-if="me?.agency.status === 'APPROVED'" :aria-label="t('portal.nav.main')" class="order-last flex w-full gap-1 sm:order-none sm:w-auto">
          <UButton v-for="link in links" :key="link.to" :to="link.to" :icon="link.icon" color="neutral" variant="ghost" active-variant="soft" active-color="primary">
            {{ link.label }}
          </UButton>
        </nav>
        <div class="flex items-center gap-1">
          <LocaleSwitch />
          <UColorModeButton />
          <UButton v-if="me" to="/account" color="neutral" variant="ghost" icon="i-lucide-user-round">{{ t('account.open') }}</UButton>
          <UButton v-if="me" color="neutral" variant="outline" icon="i-lucide-log-out" @click="signOutNow">{{ t('common.signOut') }}</UButton>
        </div>
      </div>
    </header>
    <main id="main" class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <slot />
    </main>
  </div>
</template>
