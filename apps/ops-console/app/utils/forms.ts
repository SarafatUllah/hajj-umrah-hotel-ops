/** What a page needs of a `UForm` it holds a ref to: setting a server-found problem on one field. */
export interface FormRef { setErrors: (errors: Array<{ name: string, message: string }>, name?: string) => void }

/** What a drawer or dialog binds while its save runs: it stays open (no outside click, Escape or close button). */
export interface HeldOpen { dismissible: boolean, close: { disabled: boolean } }
export function heldWhile(pending: boolean): HeldOpen {
  return { dismissible: !pending, close: { disabled: pending } }
}

/** A select's choice: what it stores and what it shows. */
export interface Choice { value: string, label: string }
/** The active choices plus the one already saved, when it has since been deactivated (else the field shows empty). */
export function withSaved(choices: readonly Choice[], saved: Choice | null | undefined): Choice[] {
  return saved && !choices.some(choice => choice.value === saved.value) ? [...choices, saved] : [...choices]
}
