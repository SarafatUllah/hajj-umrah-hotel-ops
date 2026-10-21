<script setup lang="ts">
/** The user menu (§7): who is signed in (name, email, roles, organization), two-factor setup, sign out. */
const { t } = useI18n()
const { me, signOut } = useStaffSession()
const toast = useToast()
const errorMessage = useErrorMessage()

async function signOutNow(): Promise<void> {
  try {
    await signOut()
    await navigateTo('/login')
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' })
  }
}
const items = computed(() => (me.value
  ? [
      [{ type: 'label' as const, label: me.value.user.fullName, description: me.value.user.email }],
      [{ type: 'label' as const, label: me.value.roles.map(r => r.name).join(', ') || t('user.noRole'), description: me.value.organization.name }],
      [{ label: t('user.twoFactor'), icon: 'i-lucide-shield-check', to: '/settings/two-factor' }],
      [{ label: t('common.signOut'), icon: 'i-lucide-log-out', onSelect: () => { void signOutNow() } }],
    ]
  : []))
const initials = computed(() => (me.value?.user.fullName ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase())
</script>

<template>
  <UDropdownMenu v-if="me" :items="items" :content="{ align: 'end' }">
    <UButton color="neutral" variant="ghost" :aria-label="t('user.menu', { name: me.user.fullName })">
      <UAvatar :text="initials" size="sm" />
      <span class="hidden max-w-40 truncate md:inline"><bdi>{{ me.user.fullName }}</bdi></span>
    </UButton>
  </UDropdownMenu>
</template>
