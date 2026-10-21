<script setup lang="ts">
import { accessOf } from '../utils/access'
import { homeOf } from '../utils/nav'

/** `/`: each staff member starts where their work is (§35.2). */
definePageMeta({ middleware: 'auth' })
const { me } = useStaffSession()
await navigateTo(homeOf(accessOf(me.value)), { replace: true })
</script>

<template>
  <div />
</template>
