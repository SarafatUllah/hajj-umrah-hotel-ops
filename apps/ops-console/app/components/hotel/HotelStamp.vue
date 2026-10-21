<script setup lang="ts">
/** The hotel a write acts on (§6.5), on every drawer and dialog that changes hotel data: "Al Safa Grand Makkah (MKK-GRAND)". */
defineProps<{ hotel: { id: string, code: string, name: string } }>()
</script>

<template>
  <p class="flex items-center gap-2 text-small text-(--fg-muted)">
    <HotelMarker :hotel="hotel" size="sm" />
    <span><bdi>{{ hotel.name }}</bdi> (<span dir="ltr">{{ hotel.code }}</span>)</span>
  </p>
</template>
