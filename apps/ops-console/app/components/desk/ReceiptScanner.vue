<script setup lang="ts">
/**
 * Read a receipt's QR code with the device's camera (v7 §17), where the browser can (`BarcodeDetector`): one reading
 * at a time, the code found handed over once, and the camera stopped as soon as the dialog closes — a dialog closed
 * while the camera was still starting stops it too. A handheld scanner needs none of this: it types the code into the
 * desk's field.
 */
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ found: [code: string] }>()
const { t } = useI18n()
const SCAN_EVERY_MS = 300
/** How long to wait for the dialog to show its picture before giving up with a message. */
const VIDEO_WAIT_MS = 2000

interface DetectedCode { rawValue: string }
interface Detector { detect: (source: HTMLVideoElement) => Promise<DetectedCode[]> }
type DetectorClass = new (options: { formats: string[] }) => Detector

const video = ref<HTMLVideoElement | null>(null)
const problem = ref('')
let stream: MediaStream | null = null
// Each opening is a run; closing (or a code found) ends it, and whatever it still does afterwards stops by itself.
let run = 0

function stop(): void {
  run += 1
  stream?.getTracks().forEach(track => track.stop())
  stream = null
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The dialog's video element, once it shows (the dialog's body mounts after it opens); null after a while. */
function videoShown(): Promise<HTMLVideoElement | null> {
  if (video.value) return Promise.resolve(video.value)
  // Whichever comes first settles it (a promise settles once): the element, or after a while what there is (null).
  return new Promise((resolve) => {
    const unwatch = watch(video, (element) => {
      if (!element) return
      unwatch()
      resolve(element)
    })
    setTimeout(() => {
      unwatch()
      resolve(video.value)
    }, VIDEO_WAIT_MS)
  })
}

async function scan(mine: number, element: HTMLVideoElement, detector: Detector): Promise<void> {
  while (mine === run) {
    const [code] = await detector.detect(element).catch(() => [])
    if (mine !== run) return
    if (code?.rawValue) {
      stop()
      open.value = false
      emit('found', code.rawValue)
      return
    }
    await pause(SCAN_EVERY_MS)
  }
}

async function start(): Promise<void> {
  const mine = ++run
  problem.value = ''
  const Barcode = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector
  if (!Barcode || !navigator.mediaDevices?.getUserMedia) {
    problem.value = t('desk.cameraUnsupported')
    return
  }
  try {
    const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    if (mine !== run) return media.getTracks().forEach(track => track.stop())
    stream = media
    const element = await videoShown()
    if (mine !== run) return
    if (!element) {
      stop()
      problem.value = t('desk.cameraFailed')
      return
    }
    element.srcObject = media
    await element.play()
    await scan(mine, element, new Barcode({ formats: ['qr_code'] }))
  }
  catch (error) {
    if (mine !== run) return
    stop()
    problem.value = (error as { name?: string }).name === 'NotAllowedError' ? t('desk.cameraDenied') : t('desk.cameraFailed')
  }
}
watch(open, (isOpen) => {
  if (isOpen) void start()
  else stop()
})
onBeforeUnmount(stop)
</script>

<template>
  <UModal v-model:open="open" :title="t('desk.scanTitle')" :description="t('desk.scanHelp')">
    <template #body>
      <UAlert v-if="problem" color="warning" variant="soft" icon="i-lucide-camera-off" :title="problem" role="alert" />
      <!-- The camera picture only shows where to point; the code is what counts. -->
      <video v-else ref="video" class="aspect-square w-full rounded-md bg-black object-cover" muted playsinline :aria-label="t('desk.scanTitle')" />
    </template>
  </UModal>
</template>
