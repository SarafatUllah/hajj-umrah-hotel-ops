/** What a page needs of a `UForm` it holds a ref to: setting a server-found problem on one field. */
export interface FormRef { setErrors: (errors: Array<{ name: string, message: string }>, name?: string) => void }
