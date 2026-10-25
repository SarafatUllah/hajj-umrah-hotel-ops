<script setup lang="ts">
/** A page's one heading (§3): title, an optional line under it, and its actions at the end (one primary at most). */
defineProps<{ title: string, description?: string }>()
</script>

<template>
  <header class="flex flex-wrap items-start justify-between gap-4 pb-6">
    <div class="min-w-0">
      <slot name="breadcrumb" />
      <h1 class="text-page-title">{{ title }}</h1>
      <p v-if="description" class="mt-1 text-(--fg-muted)">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
