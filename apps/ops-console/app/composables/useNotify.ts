/** The console's two toasts: something was done, or something failed (in people's words, never the server's text). */
export function useNotify() {
  const toast = useToast()
  const errorMessage = useErrorMessage()
  return {
    done: (title: string) => toast.add({ title, color: 'success', icon: 'i-lucide-circle-check' }),
    failed: (error: unknown) => toast.add({ title: errorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' }),
  }
}
