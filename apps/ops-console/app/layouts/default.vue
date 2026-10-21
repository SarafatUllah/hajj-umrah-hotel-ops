<script setup lang="ts">
/**
 * The console shell (§3–§5): the sidebar at the reading start (collapsible, remembered in a cookie) from 1024 px;
 * below that a menu opens the same navigation in a drawer. The header carries the hotel switcher, the language,
 * the theme and the user menu.
 */
const { t, localeProperties } = useI18n()
const { me, ensure } = useStaffSession()
onMounted(() => { void ensure().catch(() => undefined) })
const collapsed = useCookie<boolean>('ops-sidebar-collapsed', { default: () => false, sameSite: 'lax' })
const navOpen = ref(false)
// The drawer opens from the reading start: the left in English, the right in Arabic (§13.3).
const drawerSide = computed(() => (localeProperties.value.dir === 'rtl' ? 'right' : 'left'))
</script>

<template>
  <div class="flex min-h-dvh">
    <aside
      class="sticky top-0 hidden h-dvh shrink-0 flex-col gap-4 overflow-y-auto border-e border-(--border) bg-(--surface-1) p-3 lg:flex"
      :class="collapsed ? 'w-16' : 'w-62'"
    >
      <div class="flex min-h-10 items-center gap-2 px-1">
        <UIcon name="i-lucide-building-2" class="size-6 shrink-0 text-(--primary)" />
        <div v-if="!collapsed && me" class="flex min-w-0 flex-col">
          <span class="truncate font-medium"><bdi>{{ me.organization.name }}</bdi></span>
          <UBadge v-if="me.organization.isDemo" color="neutral" variant="outline" size="sm" class="self-start">{{ t('console.demo') }}</UBadge>
        </div>
      </div>
      <AppSidebar :collapsed="collapsed" class="flex-1" />
      <UButton
        color="neutral"
        variant="ghost"
        :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
        :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')"
        :class="collapsed ? 'justify-center' : 'justify-start'"
        :ui="{ leadingIcon: 'rtl:-scale-x-100' }"
        @click="collapsed = !collapsed"
      >
        <span v-if="!collapsed">{{ t('nav.collapse') }}</span>
      </UButton>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-(--border) bg-(--surface-1) px-4">
        <UButton class="lg:hidden" color="neutral" variant="ghost" icon="i-lucide-menu" :aria-label="t('nav.open')" @click="navOpen = true" />
        <HotelSwitcher class="min-w-0 flex-1 md:flex-none" />
        <div class="hidden flex-1 md:block" />
        <!-- On small screens the language and theme live in the menu drawer (§4–§5): the header keeps the hotel. -->
        <div class="hidden items-center md:flex">
          <LocaleSwitch />
          <UColorModeButton />
        </div>
        <UserMenu />
      </header>
      <main id="main" class="w-full flex-1 px-4 py-6 lg:px-6 xl:px-8">
        <slot />
      </main>
    </div>

    <USlideover v-model:open="navOpen" :side="drawerSide" :title="me?.organization.name ?? t('console.name')" class="lg:hidden">
      <template #body>
        <AppSidebar @navigate="navOpen = false" />
        <div class="mt-6 flex items-center gap-2 border-t border-(--border) pt-4">
          <LocaleSwitch />
          <UColorModeButton />
        </div>
      </template>
    </USlideover>
  </div>
</template>
