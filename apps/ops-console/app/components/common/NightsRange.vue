<script setup lang="ts">
import { rangeLength } from '@hajj/contracts/utils/dates'

/** Nights in hotel time (§1.3): "1 May – 31 Jul 2027 (92 nights)" — the last night named, never a bare end date. */
const props = defineProps<{ from: string, to: string, count?: boolean }>()
const { t } = useI18n()
const format = useFormat()
const nights = computed(() => rangeLength({ from: props.from, to: props.to }))
</script>

<template>
  <span class="tabular">{{ format.date(from, 'short') }} – {{ format.date(to) }}<template v-if="count !== false"> ({{ t('common.nights', nights) }})</template></span>
</template>
