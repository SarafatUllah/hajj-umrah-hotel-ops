<script setup lang="ts">
/**
 * Every hotel page's frame (§6): the hotel named with its marker on the page, or the inaccessible-hotel state for a
 * code this user cannot see; the inactive banner; on a profile page its tabs (§23 — each its own page, so it can be
 * bookmarked and the back button works; Activity only with `audit.view`).
 */
type ProfileTab = 'overview' | 'floors' | 'settings' | 'documents' | 'activity'
const props = defineProps<{ tab?: ProfileTab, title?: string }>()
const { t } = useI18n()
const access = useAccess()
const { hotels, hotel, unknown, isInactive } = useCurrentHotel()
const tabs = computed(() => {
  if (!props.tab || !hotel.value) return []
  const base = `/hotels/${encodeURIComponent(hotel.value.code)}`
  const all: Array<{ key: ProfileTab, to: string, show: boolean }> = [
    { key: 'overview', to: base, show: true },
    { key: 'floors', to: `${base}/floors`, show: access.value.canInHotel('room.view', hotel.value.id) },
    { key: 'settings', to: `${base}/settings`, show: true },
    { key: 'documents', to: `${base}/documents`, show: true },
    { key: 'activity', to: `${base}/activity`, show: access.value.canInHotel('audit.view', hotel.value.id) },
  ]
  return all.filter(item => item.show)
})
useSeoMeta({ title: () => [props.title, hotel.value?.name].filter(Boolean).join(' · ') })
</script>

<template>
  <div class="flex flex-col gap-6">
    <ErrorState v-if="hotels.error.value" :error="hotels.error.value" @retry="hotels.refetch()" />
    <USkeleton v-else-if="!hotel && !unknown" class="h-24" />
    <div v-else-if="unknown" class="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center" role="alert">
      <UIcon name="i-lucide-building-2" class="size-8 text-(--fg-muted)" />
      <h1 class="text-page-title">{{ t('hotel.inaccessible') }}</h1>
      <p class="text-(--fg-muted)">{{ t('hotel.inaccessibleText') }}</p>
      <div class="flex flex-wrap justify-center gap-2">
        <UButton to="/select-hotel">{{ t('hotel.chooseAnother') }}</UButton>
        <UButton to="/" color="neutral" variant="outline">{{ t('hotel.goHome') }}</UButton>
      </div>
    </div>
    <template v-else-if="hotel">
      <header class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <HotelMarker :hotel="hotel" />
            <div class="flex min-w-0 flex-col">
              <h1 class="text-page-title truncate">
                <template v-if="title">{{ title }}</template>
                <bdi v-else>{{ hotel.name }}</bdi>
              </h1>
              <p class="text-small text-(--fg-muted)">
                <template v-if="title"><bdi>{{ hotel.name }}</bdi> · </template><span dir="ltr">{{ hotel.code }}</span> · {{ hotel.city }}
              </p>
            </div>
            <StatusBadge domain="hotel" :value="hotel.status" />
          </div>
          <div class="flex flex-wrap items-center gap-2"><slot name="actions" :hotel="hotel" /></div>
        </div>
        <nav v-if="tabs.length" :aria-label="t('hotel.tabs')" class="-mb-px flex gap-1 overflow-x-auto border-b border-(--border)">
          <NuxtLink
            v-for="item in tabs"
            :key="item.key"
            :to="item.to"
            class="whitespace-nowrap border-b-2 px-3 py-2 text-small font-medium"
            :class="item.key === tab ? 'border-(--primary) text-(--fg)' : 'border-transparent text-(--fg-muted) hover:text-(--fg)'"
            :aria-current="item.key === tab ? 'page' : undefined"
          >
            {{ t(`hotel.tab.${item.key}`) }}
          </NuxtLink>
        </nav>
      </header>
      <UAlert v-if="isInactive" color="neutral" variant="soft" icon="i-lucide-circle-pause" :title="t('hotel.inactiveBanner')" />
      <slot :hotel="hotel" />
    </template>
  </div>
</template>
