<script setup lang="ts">
/**
 * The hotel switcher (§6.2–§6.3). On a hotel's page another hotel opens the same page for it (hotel-specific filters
 * and selections dropped); on a portfolio page it sets `?hotel=` (or "All hotels"); elsewhere it only remembers the
 * choice for the hotel links. One hotel: a static label. No hotel: nothing.
 */
const ALL = '__all__'
const SEARCH_FROM = 7
const { t } = useI18n()
const route = useRoute()
const { hotels, current, isHotelPage, lastHotelCode, remember } = useHotelScope()
const isPortfolio = computed(() => route.meta.scope === 'portfolio')

const shown = computed(() => current.value ?? (isHotelPage.value ? undefined : hotels.byCode(lastHotelCode.value)))
const items = computed(() => [
  ...(isPortfolio.value ? [{ value: ALL, label: t('switcher.all', { count: hotels.items.value.length }) }] : []),
  ...hotels.items.value.map(h => ({ value: h.code, label: h.name, description: h.status === 'INACTIVE' ? t('status.hotel.INACTIVE') : h.city })),
])
const value = computed(() => (isPortfolio.value && !current.value ? ALL : shown.value?.code))

async function choose(code: string | undefined): Promise<void> {
  if (!code) return
  if (isHotelPage.value) {
    await navigateTo(route.path.replace(/^\/hotels\/[^/]+/, `/hotels/${encodeURIComponent(code)}`))
    return
  }
  if (isPortfolio.value) {
    const { hotel: _dropped, ...rest } = route.query
    await navigateTo({ path: route.path, query: code === ALL ? rest : { ...rest, hotel: code } })
    return
  }
  remember(code === ALL ? null : code)
}
</script>

<template>
  <div v-if="hotels.items.value.length" class="flex min-w-0 items-center gap-2">
    <template v-if="hotels.items.value.length === 1">
      <HotelMarker :hotel="hotels.items.value[0]!" size="sm" />
      <span class="truncate font-medium"><bdi>{{ hotels.items.value[0]!.name }}</bdi></span>
    </template>
    <template v-else>
      <USelectMenu
        :model-value="value"
        :items="items"
        value-key="value"
        :search-input="items.length >= SEARCH_FROM ? { placeholder: t('switcher.search') } : false"
        :aria-label="t('switcher.label')"
        :placeholder="t('switcher.choose')"
        class="w-full md:w-72"
        :class="{ 'opacity-70': !isHotelPage && !isPortfolio }"
        @update:model-value="choose"
      >
        <template #leading>
          <HotelMarker v-if="shown && value !== ALL" :hotel="shown" size="sm" />
          <UIcon v-else name="i-lucide-building-2" class="size-5" />
        </template>
      </USelectMenu>
      <span v-if="!isHotelPage && !isPortfolio" class="hidden text-small text-(--fg-muted) xl:inline">{{ t('switcher.notUsed') }}</span>
    </template>
  </div>
</template>
