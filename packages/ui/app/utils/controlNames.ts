const LABELLED_CONTROLS = '[role=checkbox][aria-label], [role=radio][aria-label], [role=switch][aria-label]'

/**
 * Reka names a labelled checkbox, radio or switch by copying the text of its `<label for>` into `aria-label` once,
 * when it mounts — so after an in-place language switch the label reads in the new language and the name in the old
 * one. This copies each label's text again. A control without a `<label for>` was named on purpose and is left alone.
 */
export function renameLabelledControls(root: ParentNode): void {
  for (const control of root.querySelectorAll<HTMLElement>(LABELLED_CONTROLS)) {
    const label = control.id ? root.querySelector<HTMLElement>(`label[for="${CSS.escape(control.id)}"]`) : null
    const text = (label?.innerText || label?.textContent || '').trim()
    if (text) control.setAttribute('aria-label', text)
  }
}
