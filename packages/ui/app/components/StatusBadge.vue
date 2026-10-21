<script setup lang="ts">
import { type StatusDomain, statusLook } from '../utils/statusRegistry'

/** A status as label + icon + tone (§19): the registry decides the look, the locale the words. */
const props = defineProps<{ domain: StatusDomain, value: string }>()
const { t, te } = useI18n()
const look = computed(() => statusLook(props.domain, props.value))
const label = computed(() => {
  const key = `status.${props.domain}.${props.value}`
  return te(key) ? t(key) : props.value
})
</script>

<template>
  <UBadge :color="look.tone" :variant="look.variant" :icon="look.icon" size="md" class="text-caption">
    {{ label }}
  </UBadge>
</template>
