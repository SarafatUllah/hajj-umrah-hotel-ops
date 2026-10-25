/** A fixed list of values as select or radio items, in the list's order, each labelled by `label` (a translation). */
export function choiceItems<V extends string>(values: readonly V[], label: (value: V) => string): Array<{ value: V, label: string }> {
  return values.map(value => ({ value, label: label(value) }))
}
