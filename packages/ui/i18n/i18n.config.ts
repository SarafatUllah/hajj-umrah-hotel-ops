/** Arabic has six plural forms: messages list them as `zero | one | two | few | many | other`. */
const ARABIC_FORMS: Intl.LDMLPluralRule[] = ['zero', 'one', 'two', 'few', 'many', 'other']
const arabicPlurals = new Intl.PluralRules('ar')

export default defineI18nConfig(() => ({
  fallbackLocale: 'en',
  pluralRules: {
    ar: (choice: number, choicesLength: number) => {
      if (choicesLength < ARABIC_FORMS.length) return Math.min(choice === 1 ? 0 : 1, choicesLength - 1)
      return ARABIC_FORMS.indexOf(choice === 0 ? 'zero' : arabicPlurals.select(choice))
    },
  },
}))
