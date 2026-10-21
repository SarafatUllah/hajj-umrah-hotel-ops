<script setup lang="ts">
/** A rule's row actions: edit and delete, each named for assistive technology with the rule it acts on. */
defineProps<{ name: string }>()
const emit = defineEmits<{ edit: [], delete: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex justify-end gap-1">
    <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" :aria-label="t('rules.editNamed', { name })" @click="emit('edit')" />
    <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" :aria-label="t('rules.deleteNamed', { name })" @click="emit('delete')" />
  </div>
</template>
