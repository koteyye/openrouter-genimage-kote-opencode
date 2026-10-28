import { tool } from "@opencode-ai/plugin"

import { redactSecrets } from "../logging.js"
import type { OpenRouterBudget } from "../openrouter/client.js"
import { isPluginError } from "../openrouter/errors.js"
import { requireResolvedPluginOptions } from "../config/resolve.js"
import { throwIfAborted } from "../utils/abort.js"
import { runToolOperation } from "./common.js"
import type { ToolDependencies } from "./types.js"

export function formatMoney(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.000001) return value.toExponential(6)
  return value.toFixed(6)
}

function addMoneyLine(lines: string[], label: string, value: number | undefined): void {
  if (value !== undefined) lines.push(`- ${label}: $${formatMoney(value)}`)
}

function addBooleanLine(lines: string[], label: string, value: boolean | undefined): void {
  if (value !== undefined) lines.push(`- ${label}: ${value ? "yes" : "no"}`)
}

function safeInlineText(value: string): string {
  return redactSecrets(value)
    .replace(/data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+/giu, "[REDACTED]")
    .replace(/[A-Za-z0-9+/]{96,}={0,2}/gu, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .slice(0, 160)
}

function safeBudget(budget: OpenRouterBudget) {
  return {
    scope: safeInlineText(budget.scope),
    limitUsd: budget.limit_usd,
    spendUsd: budget.spend_usd,
    remainingUsd: budget.remaining_usd,
    resetInterval: budget.reset_interval,
    resetsAt:
      budget.resets_at === null ? null : safeInlineText(budget.resets_at),
    includeByok: budget.include_byok,
  }
}

function addBudgetLines(
  lines: string[],
  label: string,
  budget: ReturnType<typeof safeBudget>,
): void {
  lines.push(`- ${label} scope: ${budget.scope}`)
  addMoneyLine(lines, `${label} limit`, budget.limitUsd)
  addMoneyLine(lines, `${label} spend`, budget.spendUsd)
  addMoneyLine(lines, `${label} remaining`, budget.remainingUsd)
  lines.push(`- ${label} reset interval: ${budget.resetInterval ?? "none"}`)
  lines.push(`- ${label} resets at: ${budget.resetsAt ?? "never"}`)
  addBooleanLine(lines, `${label} includes BYOK`, budget.includeByok)
}

export function createBalanceTool(dependencies: ToolDependencies) {
  return tool({
    description:
      "Show usage and spending limits for the configured OpenRouter API key, plus full account credits when a management key is available. This tool does not generate images and does not incur image-generation charges.",
    args: {},
    async execute(_args, context) {
      return runToolOperation(dependencies.logger, async () => {
        const options = requireResolvedPluginOptions(dependencies.configState)
        const runtime = dependencies.getRuntime()
        const key = await runtime.client.getCurrentKey(context.abort)
        const managementApiKey =
          options.managementApiKey ??
          (key.is_management_key === true ? options.apiKey : undefined)

        let credits:
          | { total_credits: number; total_usage: number; available: number }
          | undefined
        let creditsError: string | undefined
        if (managementApiKey !== undefined) {
          try {
            const result = await runtime.client.getCredits(
              managementApiKey,
              context.abort,
            )
            credits = {
              ...result,
              available: result.total_credits - result.total_usage,
            }
          } catch (error) {
            throwIfAborted(context.abort)
            creditsError = isPluginError(error) ? error.code : "unavailable"
          }
        }

        const limitReset =
          typeof key.limit_reset === "string"
            ? safeInlineText(key.limit_reset)
            : key.limit_reset
        const expiresAt =
          typeof key.expires_at === "string"
            ? safeInlineText(key.expires_at)
            : key.expires_at
        const budgets = key.budgets?.map(safeBudget)
        const effectiveBudget =
          key.effective_budget === undefined || key.effective_budget === null
            ? key.effective_budget
            : safeBudget(key.effective_budget)

        const lines = ["OpenRouter API-key usage:"]
        if (key.label !== undefined) {
          lines.push(`- Label: ${safeInlineText(key.label)}`)
        }
        addMoneyLine(lines, "Lifetime usage", key.usage)
        addMoneyLine(lines, "Daily usage", key.usage_daily)
        addMoneyLine(lines, "Weekly usage", key.usage_weekly)
        addMoneyLine(lines, "Monthly usage", key.usage_monthly)
        addMoneyLine(lines, "BYOK lifetime usage", key.byok_usage)
        addMoneyLine(lines, "BYOK daily usage", key.byok_usage_daily)
        addMoneyLine(lines, "BYOK weekly usage", key.byok_usage_weekly)
        addMoneyLine(lines, "BYOK monthly usage", key.byok_usage_monthly)

        if (key.limit === null) lines.push("- API-key spending limit: unlimited")
        else addMoneyLine(lines, "API-key spending limit", key.limit)
        if (key.limit_remaining === null) {
          lines.push("- Remaining API-key spending limit: unlimited")
        } else {
          addMoneyLine(
            lines,
            "Remaining API-key spending limit",
            key.limit_remaining,
          )
        }
        if (limitReset !== undefined) {
          lines.push(
            `- Limit reset: ${limitReset ?? "none"}`,
          )
        }
        if (effectiveBudget !== undefined && effectiveBudget !== null) {
          addBudgetLines(lines, "Effective budget", effectiveBudget)
        }
        if (budgets !== undefined && budgets.length > 0) {
          lines.push("", "OpenRouter budgets:")
          budgets.forEach((budget, index) => {
            addBudgetLines(lines, `Budget ${index + 1}`, budget)
          })
        }
        addBooleanLine(lines, "Free tier", key.is_free_tier)
        addBooleanLine(lines, "Management key", key.is_management_key)
        if (expiresAt !== undefined) {
          lines.push(
            `- Expires at: ${expiresAt ?? "never"}`,
          )
        }

        lines.push("", "OpenRouter account credits:")
        if (credits !== undefined) {
          addMoneyLine(lines, "Total purchased credits", credits.total_credits)
          addMoneyLine(lines, "Total account usage", credits.total_usage)
          addMoneyLine(lines, "Available account credits", credits.available)
        } else {
          lines.push("- Account credits: unavailable")
          lines.push(
            managementApiKey === undefined
              ? "- Reason: OpenRouter management key is not configured"
              : `- Reason: credits request failed (${creditsError ?? "unavailable"})`,
          )
        }

        return {
          title: "OpenRouter balance and usage",
          output: lines.join("\n"),
          metadata: {
            routing: options.routing,
            model: options.model,
            key: {
              usage: key.usage,
              usageDaily: key.usage_daily,
              usageWeekly: key.usage_weekly,
              usageMonthly: key.usage_monthly,
              spendingLimit: key.limit,
              remainingSpendingLimit: key.limit_remaining,
              limitReset,
              isFreeTier: key.is_free_tier,
              isManagementKey: key.is_management_key,
              expiresAt,
              budgets,
              effectiveBudget,
            },
            accountCredits:
              credits === undefined
                ? { available: false, reason: creditsError ?? "not-configured" }
                : {
                    available: true,
                    totalCredits: credits.total_credits,
                    totalUsage: credits.total_usage,
                    availableCredits: credits.available,
                  },
          },
        }
      })
    },
  })
}
