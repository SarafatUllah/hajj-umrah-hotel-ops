<script setup lang="ts">
const { t } = useI18n()
const siteName = useRuntimeConfig().public.siteName
const { customer, ensure } = useCustomerSession()
// Until the API answers, the header shows neither a name nor "Sign in"; a failed answer leaves it so (the page shows the error).
onMounted(() => { void ensure().catch(() => undefined) })
const links = computed(() => [
  { label: t('site.nav.hotels'), to: '/' },
  { label: t('site.nav.book'), to: '/book' },
  { label: t('site.nav.bookings'), to: '/bookings' },
])
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header class="border-b border-(--border) bg-(--surface-1)">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <NuxtLink to="/" class="text-subsection">{{ siteName }}</NuxtLink>
        <nav :aria-label="t('site.nav.main')" class="order-last flex w-full gap-1 sm:order-none sm:w-auto">
          <UButton v-for="link in links" :key="link.to" :to="link.to" color="neutral" variant="ghost" active-variant="soft" active-color="primary">
            {{ link.label }}
          </UButton>
        </nav>
        <div class="flex items-center gap-1">
          <LocaleSwitch />
          <UColorModeButton />
          <UButton v-if="customer" to="/account" color="neutral" variant="outline" icon="i-lucide-user-round">{{ customer.fullName }}</UButton>
          <UButton v-else-if="customer === null" to="/sign-in" color="neutral" variant="outline">{{ t('common.signIn') }}</UButton>
        </div>
      </div>
    </header>
    <main id="main" class="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <slot />
    </main>
    <footer class="border-t border-(--border) px-4 py-6 text-center text-small text-(--fg-muted)">
      {{ t('site.footer') }}
    </footer>
  </div>
</template>
