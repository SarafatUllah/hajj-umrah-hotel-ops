<script setup lang="ts">
import { linkOf, NAVIGATION, visibleNavigation } from '../../utils/nav'

/** The console's navigation (§3): only what exists and what this user may open; hotel pages open for the last hotel. */
defineProps<{ collapsed?: boolean }>()
const emit = defineEmits<{ navigate: [] }>()
const { t, localeProperties } = useI18n()
// The rail's tooltips open away from the edge it sits on (the right in Arabic).
const tooltipSide = computed(() => (localeProperties.value.dir === 'rtl' ? 'left' : 'right'))
const { me } = useStaffSession()
const access = useAccess()
const { lastHotelCode } = useHotelScope()
const groups = computed(() => visibleNavigation(NAVIGATION, access.value, me.value?.organization.isDemo ?? false))
</script>

<template>
  <nav :aria-label="t('nav.label')" class="flex flex-col gap-4">
    <div v-for="group in groups" :key="group.key" class="flex flex-col gap-1">
      <template v-if="group.key !== 'main'">
        <USeparator v-if="collapsed" />
        <p v-else class="px-3 text-small text-(--fg-muted)">{{ t(`nav.group.${group.key}`) }}</p>
      </template>
      <UTooltip v-for="item in group.items" :key="item.key" :text="t(`nav.${item.key}`)" :disabled="!collapsed" :content="{ side: tooltipSide }">
        <UButton
          :to="linkOf(item, lastHotelCode)"
          :icon="item.icon"
          :aria-label="collapsed ? t(`nav.${item.key}`) : undefined"
          color="neutral"
          variant="ghost"
          active-variant="soft"
          active-color="primary"
          class="w-full"
          :class="collapsed ? 'justify-center' : 'justify-start'"
          @click="emit('navigate')"
        >
          <span v-if="!collapsed">{{ t(`nav.${item.key}`) }}</span>
        </UButton>
      </UTooltip>
    </div>
  </nav>
</template>
