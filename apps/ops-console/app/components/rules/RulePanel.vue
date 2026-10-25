<script setup lang="ts">
/**
 * One kind of a hotel's booking rules on its page (v7 §15): what the kind decides, its rules (the slot: a table) or
 * why none show, and adding one (`addLabel`, only for who may).
 */
defineProps<{ id: string, title: string, help: string, addLabel?: string, error: unknown, loading: boolean, empty: boolean, emptyText: string }>()
const emit = defineEmits<{ add: [], retry: [] }>()
</script>

<template>
  <section :aria-labelledby="`${id}-heading`" class="surface-panel flex flex-col gap-4 p-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex max-w-prose flex-col gap-1">
        <h2 :id="`${id}-heading`" class="text-section">{{ title }}</h2>
        <p class="text-small text-(--fg-muted)">{{ help }}</p>
      </div>
      <UButton v-if="addLabel" icon="i-lucide-plus" size="sm" @click="emit('add')">{{ addLabel }}</UButton>
    </div>
    <ErrorState v-if="error" :error="error" @retry="emit('retry')" />
    <USkeleton v-else-if="loading" class="h-24" />
    <p v-else-if="empty" class="text-(--fg-muted)">{{ emptyText }}</p>
    <div v-else class="overflow-x-auto"><slot /></div>
  </section>
</template>
