<script setup lang="ts">
/** "Nothing here yet" or "nothing matches" (§20.2): what it means, and the one thing to do next. */
defineProps<{ title: string, description?: string, icon?: string }>()
</script>

<template>
  <div class="flex flex-col items-center gap-3 px-4 py-12 text-center">
    <UIcon :name="icon ?? 'i-lucide-inbox'" class="size-6 text-(--fg-subtle)" aria-hidden="true" />
    <p class="text-subsection">{{ title }}</p>
    <p v-if="description" class="max-w-prose text-(--fg-muted)">{{ description }}</p>
    <div v-if="$slots.default" class="mt-2 flex gap-2">
      <slot />
    </div>
  </div>
</template>
