<script setup lang="ts">
/** A load that failed (§20.3): what failed in people's words, and Retry — the page around it stays usable. */
defineProps<{ error: unknown }>()
defineEmits<{ retry: [] }>()
const message = useErrorMessage()
</script>

<template>
  <UAlert color="error" variant="soft" icon="i-lucide-triangle-alert" :title="message(error)" role="alert">
    <template #actions>
      <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-rotate-cw" @click="$emit('retry')">
        {{ $t('common.retry') }}
      </UButton>
    </template>
  </UAlert>
</template>
