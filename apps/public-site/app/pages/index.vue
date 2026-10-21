<script setup lang="ts">

const { t } = useI18n()
const { data: hotels, error, isPending, refetch } = usePublicHotels()
useSeoMeta({ title: () => t('home.title'), description: () => t('home.lead') })
</script>

<template>
  <div>
    <PageHeader :title="t('home.title')" :description="t('home.lead')" />
    <section aria-labelledby="hotels-heading" class="flex flex-col gap-4">
      <h2 id="hotels-heading" class="text-section">{{ t('home.hotels') }}</h2>
      <ErrorState v-if="error" :error="error" @retry="refetch()" />
      <div v-else-if="isPending" class="grid gap-4 sm:grid-cols-2">
        <USkeleton v-for="n in 4" :key="n" class="h-32" />
      </div>
      <EmptyState v-else-if="!hotels?.length" :title="t('home.noHotels')" icon="i-lucide-building-2" />
      <ul v-else class="grid gap-4 sm:grid-cols-2">
        <li v-for="hotel in hotels" :key="hotel.id" class="surface-panel flex flex-col gap-2 p-5">
          <h3 class="text-subsection"><bdi>{{ hotel.name }}</bdi></h3>
          <p class="text-(--fg-muted)"><bdi>{{ hotel.city }}</bdi><template v-if="hotel.address"> · <bdi>{{ hotel.address }}</bdi></template></p>
          <UButton :to="{ path: '/book', query: { hotel: hotel.id } }" class="mt-2 self-start" trailing-icon="i-lucide-arrow-right" :ui="{ trailingIcon: 'rtl:-scale-x-100' }">
            {{ t('home.bookHere') }}
          </UButton>
        </li>
      </ul>
    </section>
  </div>
</template>
