<script setup lang="ts">
/**
 * The hotel chooser (§6.2): a link to a hotel's page with no hotel used yet asks which one, then opens that page
 * (`?next=` names it; anything else opens the hotel's profile).
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const { hotels, remember } = useHotelScope()
const SAFE_NEXT = /^[a-z][a-z-]*$/
const next = computed(() => (typeof route.query.next === 'string' && SAFE_NEXT.test(route.query.next) ? route.query.next : ''))
useSeoMeta({ title: () => t('selectHotel.title') })

async function open(code: string): Promise<void> {
  remember(code)
  await navigateTo(next.value ? `/hotels/${encodeURIComponent(code)}/${next.value}` : `/hotels/${encodeURIComponent(code)}`)
}
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-6">
    <PageHeader :title="t('selectHotel.title')" :description="t('selectHotel.text')" />
    <ErrorState v-if="hotels.error.value" :error="hotels.error.value" @retry="hotels.refetch()" />
    <div v-else-if="hotels.isPending.value" class="grid gap-3 sm:grid-cols-2"><USkeleton v-for="n in 4" :key="n" class="h-20" /></div>
    <EmptyState v-else-if="!hotels.items.value.length" :title="t('hotels.noneAssigned')" icon="i-lucide-building-2" />
    <ul v-else class="grid gap-3 sm:grid-cols-2">
      <li v-for="hotel in hotels.items.value" :key="hotel.id">
        <button type="button" class="surface-panel flex w-full items-center gap-3 p-4 text-start hover:bg-(--surface-2)" @click="open(hotel.code)">
          <HotelMarker :hotel="hotel" />
          <span class="flex min-w-0 flex-col">
            <span class="truncate font-medium"><bdi>{{ hotel.name }}</bdi></span>
            <span class="text-small text-(--fg-muted)"><span dir="ltr">{{ hotel.code }}</span> · {{ hotel.city }}</span>
          </span>
          <StatusBadge v-if="hotel.status === 'INACTIVE'" domain="hotel" :value="hotel.status" class="ms-auto" />
        </button>
      </li>
    </ul>
  </div>
</template>
