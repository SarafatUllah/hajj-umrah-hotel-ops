import { renameLabelledControls } from '../utils/controlNames'

/** After a language switch, once the page shows the new language, the labelled controls are named in it too. */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('i18n:localeSwitched', async () => {
    await nextTick()
    renameLabelledControls(document)
  })
})
