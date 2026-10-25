<script setup lang="ts">
/**
 * A hotel's booking rules (v7 §15), a profile tab: its rates (`rate.view`; changed with `rate.manage`), the agencies'
 * quotas, the room-mix rules and the extra beds (`booking.view`; changed with `booking.settings`). Read on an inactive
 * hotel, changed only on an active one. The organization's booking settings are linked.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const can = (permission: 'rate.view' | 'rate.manage' | 'booking.view' | 'booking.settings') => ready.value && access.value.canInHotel(permission, hotelId.value)
const seesRules = computed(() => can('booking.view'))
const seesRates = computed(() => can('rate.view'))
const managesRates = computed(() => can('rate.manage') && !isInactive.value)
const managesRules = computed(() => can('booking.settings') && !isInactive.value)
</script>

<template>
  <HotelFrame tab="bookingRules" :title="t('hotel.tab.bookingRules')">
    <EmptyState v-if="ready && !seesRules" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else-if="hotel">
      <p class="max-w-prose text-(--fg-muted)">
        {{ t('rules.pageHelp') }}
        <NuxtLink v-if="access.can('booking.view')" to="/admin/booking-settings" class="text-(--primary) hover:underline">{{ t('rules.settingsLink') }}</NuxtLink>
      </p>
      <RatesPanel v-if="seesRates" :hotel="hotel" :can-manage="managesRates" />
      <QuotasPanel :hotel="hotel" :can-manage="managesRules" />
      <RoomMixPanel :hotel="hotel" :can-manage="managesRules" />
      <ExtraBedsPanel :hotel="hotel" :can-manage="managesRules" />
    </template>
  </HotelFrame>
</template>
