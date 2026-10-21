<script setup lang="ts">
/**
 * A row of figures divided by rules, not cards (§21.1); a description list for assistive technology. Each figure:
 * what it is, its value (tabular), and optionally what it means and the page it comes from.
 */
defineProps<{ items: Array<{ label: string, value: string | number, hint?: string, to?: string }> }>()
const format = useFormat()
const shown = (value: string | number) => (typeof value === 'number' ? format.number(value) : value)
</script>

<template>
  <dl class="surface-panel grid grid-cols-2 divide-(--border) md:flex md:divide-x">
    <div v-for="item in items" :key="item.label" class="flex flex-1 flex-col gap-1 p-4">
      <dt class="text-small text-(--fg-muted)">{{ item.label }}</dt>
      <dd class="text-metric">
        <NuxtLink v-if="item.to" :to="item.to" class="hover:underline">{{ shown(item.value) }}</NuxtLink>
        <template v-else>{{ shown(item.value) }}</template>
      </dd>
      <dd v-if="item.hint" class="text-small text-(--fg-muted)">{{ item.hint }}</dd>
    </div>
  </dl>
</template>
