<script setup lang="ts">
/**
 * A confirmation (§35.4): tier 1 names the object and the consequence; tier 2 also asks "I understand". The confirm
 * button repeats the action ("Withdraw request"), never "OK". While `pending` it stays open (no outside click, Escape or close).
 */
const props = defineProps<{ title: string, description: string, confirmLabel: string, tier?: 1 | 2, destructive?: boolean, pending?: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [] }>()
const understood = ref(false)
watch(open, (value) => { if (!value) understood.value = false })
const canConfirm = computed(() => (props.tier ?? 1) === 1 || understood.value)
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :dismissible="!pending" :close="{ disabled: pending }">
    <template #body>
      <UCheckbox v-if="(tier ?? 1) === 2" v-model="understood" :label="$t('common.iUnderstand')" />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="outline" :disabled="pending" @click="open = false">{{ $t('common.cancel') }}</UButton>
        <UButton :color="destructive ? 'error' : 'primary'" :loading="pending" :disabled="!canConfirm" @click="emit('confirm')">{{ confirmLabel }}</UButton>
      </div>
    </template>
  </UModal>
</template>
