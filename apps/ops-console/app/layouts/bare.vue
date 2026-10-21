<script setup lang="ts">
/** Sign-in (§35.1): no navigation, only the language and the theme. */
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header class="flex justify-end gap-1 px-4 py-3">
      <LocaleSwitch />
      <UColorModeButton />
    </header>
    <main id="main" class="flex flex-1 items-start justify-center px-4 py-8">
      <slot />
    </main>
  </div>
</template>
