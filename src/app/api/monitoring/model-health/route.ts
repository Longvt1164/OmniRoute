import { NextResponse } from "next/server";
import { getCachedProviderConnections } from "@/lib/db/readCache";
import { getAllCircuitBreakerStatuses } from "@/shared/utils/circuitBreaker";
import { isModelLocked, isAccountUnavailable } from "@omniroute/open-sse/services/accountFallback";
import { resolveProviderId } from "@/shared/constants/providers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSyncedAvailableModelsByConnection } from "@/lib/db/models";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import {
  classifyModelState,
  type ModelHealthState,
  type CircuitBreakerState,
} from "./classifyModelState";

/**
 * GET /api/monitoring/model-health
 *
 * Real-time health states for every provider/model combination.
 * Each model is classified as: HEALTHY, DEGRADED, RATE_LIMITED, AUTH_FAILED,
 * PROVIDER_DOWN, CONNECTION_BLOCKED, MODEL_LOCKED or UNKNOWN.
 *
 * An anonymous caller receives a reduced provider-level summary (provider,
 * circuitBreakerState, canExecute, healthyModels, totalModels) — never
 * connection ids/names, lockouts or per-key error state. Full detail requires a
 * management principal, matching GET /api/monitoring/health (GHSA-mvf8-qc78-5mxm).
 *
 * Response format (full view):
 * {
 *   timestamp: ISO string,
 *   summary: { healthy: N, degraded: N, rate_limited: N, ... },
 *   providers: [
 *     {
 *       provider: "openai",
 *       circuitBreakerState: "CLOSED" | "DEGRADED" | "OPEN" | "HALF_OPEN",
 *       canExecute: boolean,
 *       retryAfterMs?: number,
 *       connections: [
 *         {
 *           connectionId: "abc123",
 *           connectionName: "OpenAI Key 1",
 *           state: "HEALTHY" | "RATE_LIMITED" | ...,
 *           rateLimitedUntil?: ISO string,
 *           testStatus?: string,
 *           models: [{ model: "gpt-4", state: "HEALTHY" | "MODEL_LOCKED" | ... }]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ModelHealth {
  model: string;
  state: ModelHealthState;
  lockedUntil?: string;
  reason?: string;
}

interface ConnectionHealth {
  connectionId: string;
  connectionName: string;
  state: ModelHealthState;
  rateLimitedUntil?: string;
  testStatus?: string;
  models: ModelHealth[];
}

interface ProviderHealth {
  provider: string;
  circuitBreakerState: CircuitBreakerState;
  canExecute: boolean;
  retryAfterMs?: number;
  connections: ConnectionHealth[];
}

interface HealthSummary {
  healthy: number;
  degraded: number;
  rateLimited: number;
  authFailed: number;
  providerDown: number;
  connectionBlocked: number;
  modelLocked: number;
  unknown: number;
}

/**
 * Only the fields this route reads off a cached provider connection. The cache
 * is typed `unknown[]` (it also carries raw/encrypted variants), so the shape is
 * validated here rather than asserted with a cast.
 */
interface ProviderConnectionRow {
  id: string;
  provider: string;
  name: string | null;
  testStatus: string | null;
  rateLimitedUntil: string | null;
}

function asProviderConnectionRow(value: unknown): ProviderConnectionRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.provider !== "string" || row.provider.length === 0) return null;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  return {
    id: row.id,
    provider: row.provider,
    name: typeof row.name === "string" ? row.name : null,
    testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
    rateLimitedUntil: typeof row.rateLimitedUntil === "string" ? row.rateLimitedUntil : null,
  };
}

const MODEL_HEALTH_STATES: readonly ModelHealthState[] = [
  "HEALTHY",
  "DEGRADED",
  "RATE_LIMITED",
  "AUTH_FAILED",
  "PROVIDER_DOWN",
  "CONNECTION_BLOCKED",
  "MODEL_LOCKED",
  "UNKNOWN",
];

function isModelHealthState(value: string | null): value is ModelHealthState {
  return value !== null && (MODEL_HEALTH_STATES as readonly string[]).includes(value);
}

const CIRCUIT_BREAKER_STATES: readonly CircuitBreakerState[] = [
  "CLOSED",
  "DEGRADED",
  "OPEN",
  "HALF_OPEN",
];

// `CircuitBreakerStatus.state` is typed `string`; coerce to the known union and
// fall back to CLOSED for anything unexpected (fail open — never hide a
// provider because of an unknown state token).
function toCircuitBreakerState(value: unknown): CircuitBreakerState {
  return CIRCUIT_BREAKER_STATES.includes(value as CircuitBreakerState)
    ? (value as CircuitBreakerState)
    : "CLOSED";
}

function classifyConnectionState(connection: {
  rateLimitedUntil?: string | null;
  testStatus?: string | null;
}): ModelHealthState {
  if (isAccountUnavailable(connection.rateLimitedUntil)) {
    return "RATE_LIMITED";
  }

  const status = connection.testStatus;
  if (status === "unavailable") return "CONNECTION_BLOCKED";
  if (status === "banned" || status === "expired") return "AUTH_FAILED";
  if (status === "credits_exhausted") return "RATE_LIMITED";
  if (status === "deactivated") return "CONNECTION_BLOCKED";

  return "HEALTHY";
}

export async function GET(request: Request) {
  // GHSA-mvf8-qc78-5mxm: full detail is reserved for a management principal.
  const fullView = (await requireManagementAuth(request, { alwaysRequireAuth: true })) === null;
  const url = new URL(request.url);

  // Filter params
  const filterProvider = url.searchParams.get("provider");
  const filterStateRaw = url.searchParams.get("state");
  const filterState = isModelHealthState(filterStateRaw) ? filterStateRaw : null;
  const onlyUnhealthy = url.searchParams.get("unhealthy") === "1";

  try {
    const timestamp = new Date().toISOString();

    const breakerStatuses = getAllCircuitBreakerStatuses();

    const allRows = (await getCachedProviderConnections())
      .map(asProviderConnectionRow)
      .filter((row): row is ProviderConnectionRow => row !== null);

    // Group connections by provider
    const connectionsByProvider = new Map<string, ProviderConnectionRow[]>();
    for (const row of allRows) {
      const provider = resolveProviderId(row.provider);
      const list = connectionsByProvider.get(provider);
      if (list) {
        list.push(row);
      } else {
        connectionsByProvider.set(provider, [row]);
      }
    }

    const providers: ProviderHealth[] = [];
    const summary: HealthSummary = {
      healthy: 0,
      degraded: 0,
      rateLimited: 0,
      authFailed: 0,
      providerDown: 0,
      connectionBlocked: 0,
      modelLocked: 0,
      unknown: 0,
    };

    for (const [provider, connections] of connectionsByProvider) {
      // Apply provider filter
      if (filterProvider && provider !== filterProvider) continue;

      const breakerStatus = breakerStatuses.find((b) => b.name === provider);
      const circuitBreakerState = toCircuitBreakerState(breakerStatus?.state);
      // `canExecute()` is true for CLOSED/DEGRADED/HALF_OPEN and false only for
      // OPEN (the status object does not expose half-open probe budget).
      const canExecute = circuitBreakerState !== "OPEN";
      const retryAfterMs =
        typeof breakerStatus?.retryAfterMs === "number" && breakerStatus.retryAfterMs > 0
          ? breakerStatus.retryAfterMs
          : undefined;

      const providerHealth: ProviderHealth = {
        provider,
        circuitBreakerState,
        canExecute,
        retryAfterMs,
        connections: [],
      };

      // Models have no column on the connection row; they live in the synced
      // available-models store keyed by connection id.
      let syncedByConnection: Record<string, Array<{ id?: string }>> = {};
      try {
        syncedByConnection = await getSyncedAvailableModelsByConnection(provider);
      } catch (err) {
        console.error(
          `[API] model-health: failed to load synced models for ${provider}:`,
          sanitizeErrorMessage(err)
        );
      }

      for (const conn of connections) {
        const connectionState = classifyConnectionState(conn);

        const connectionHealth: ConnectionHealth = {
          connectionId: conn.id,
          connectionName: conn.name || `${provider} ${conn.id.slice(0, 8)}`,
          state: connectionState,
          rateLimitedUntil: conn.rateLimitedUntil || undefined,
          testStatus: conn.testStatus || undefined,
          models: [],
        };

        for (const model of syncedByConnection[conn.id] ?? []) {
          if (typeof model.id !== "string" || model.id.length === 0) continue;

          const modelState = classifyModelState(
            connectionState,
            circuitBreakerState,
            isModelLocked(provider, conn.id, model.id)
          );

          // Apply state filter
          if (filterState && modelState !== filterState) continue;
          if (onlyUnhealthy && modelState === "HEALTHY") continue;

          connectionHealth.models.push({ model: model.id, state: modelState });

          // Update summary
          switch (modelState) {
            case "HEALTHY":
              summary.healthy++;
              break;
            case "DEGRADED":
              summary.degraded++;
              break;
            case "RATE_LIMITED":
              summary.rateLimited++;
              break;
            case "AUTH_FAILED":
              summary.authFailed++;
              break;
            case "PROVIDER_DOWN":
              summary.providerDown++;
              break;
            case "CONNECTION_BLOCKED":
              summary.connectionBlocked++;
              break;
            case "MODEL_LOCKED":
              summary.modelLocked++;
              break;
            default:
              summary.unknown++;
          }
        }

        // Only include connections that have models (after filtering)
        if (connectionHealth.models.length > 0 || !filterState) {
          providerHealth.connections.push(connectionHealth);
        }
      }

      // Only include providers that have connections (after filtering)
      if (providerHealth.connections.length > 0 || !filterProvider) {
        providers.push(providerHealth);
      }
    }

    const payload = {
      timestamp,
      summary,
      providers: fullView
        ? providers
        : providers.map((p) => ({
            provider: p.provider,
            circuitBreakerState: p.circuitBreakerState,
            canExecute: p.canExecute,
            healthyModels: p.connections.reduce(
              (sum, c) => sum + c.models.filter((m) => m.state === "HEALTHY").length,
              0
            ),
            totalModels: p.connections.reduce((sum, c) => sum + c.models.length, 0),
          })),
    };

    return NextResponse.json(payload);
  } catch (error) {
    console.error("[API] GET /api/monitoring/model-health error:", error);
    return NextResponse.json(
      { error: "Failed to fetch model health", message: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
