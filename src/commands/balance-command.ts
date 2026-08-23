export const OPENROUTER_BALANCE_COMMAND = {
  description:
    "Show OpenRouter usage, key limits, and account credits when available",
  template: `
Call the openrouter_balance tool exactly once.

Present the returned values in the user's language.

Clearly distinguish:
- API-key usage;
- API-key spending limit;
- remaining API-key spending limit;
- full account credits.

Do not treat the remaining key limit as the full account balance.
Do not invent unavailable values.
Do not call image generation tools.
Show monetary values with at least six decimal places and do not round a small non-zero value to zero.
  `.trim(),
} as const
