declare module '#app' {
  interface PageMeta {
    /** A portfolio page (§6.1): the hotel switcher sets `?hotel=` (or "All hotels") instead of remembering a hotel. */
    scope?: 'portfolio'
  }
}

export {}
