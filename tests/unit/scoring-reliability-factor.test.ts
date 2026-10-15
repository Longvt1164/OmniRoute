import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WEIGHTS,
  calculateFactors,
  scorePool,
  validateWeights,
  type ProviderCandidate,
} from "../../open-sse/services/autoCombo/scoring.ts";

function candidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    provider: "p",
    model: "p/m",
    quotaRemaining: 80,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 500,
    latencyStdDev: 50,
    errorRate: 0,
    ...overrides,
  } as ProviderCandidate;
}

const factorsOf = (c: ProviderCandidate) => calculateFactors(c, [c], "default", () => 0.5);

test("the default weight makes the factor vote — a failing provider drops", () => {
  // Behaviour change: `reliability` used to default to 0, so this factor never
  // moved the ranking. It now carries the engine's default weight, so a
  // provider that fails nearly every call must rank below a solid one at the
  // engine's own weights.
  const pool = [
    candidate({ provider: "solid", model: "solid/m", errorRate: 0.01 }),
    candidate({ provider: "broken", model: "broken/m", errorRate: 0.99 }),
  ];
  const ranked = scorePool(pool, "default");
  assert.equal(ranked[0].provider, "solid", "the reliability weight must separate them");
});

test("reliability is failure-rate only — the breaker signal is not double-counted", () => {
  // The `health` factor already encodes the circuit-breaker state
  // (CLOSED=1.0, DEGRADED=0.7, HALF_OPEN=0.5, OPEN=0.0). Folding the state in
  // here as well penalised the same failure twice and diverged from
  // speedRanking.ts, which keeps `reliability = 1 - failureRate` apart from
  // `health = healthScoreFor(state)`.
  for (const circuitBreakerState of ["CLOSED", "DEGRADED", "HALF_OPEN", "OPEN"] as const) {
    assert.equal(
      factorsOf(candidate({ errorRate: 0.5, circuitBreakerState })).reliability,
      0.5,
      `${circuitBreakerState} must not move the failure-rate factor`
    );
  }
});

test("given a weight, a provider that fails nearly every call drops", () => {
  // Move weight from `health` to `reliability` without changing the total, so
  // this tests the factor rather than renormalisation. Both candidates are
  // CLOSED, so the health factor cancels either way.
  const weights = {
    ...DEFAULT_WEIGHTS,
    reliability: 0.1,
    health: DEFAULT_WEIGHTS.health - 0.02,
  };
  const ranked = scorePool(
    [
      candidate({ provider: "broken", model: "broken/m", errorRate: 0.99 }),
      candidate({ provider: "solid", model: "solid/m", errorRate: 0.01 }),
    ],
    "default",
    weights
  );
  assert.equal(ranked[0].provider, "solid");
});

test("failureRate wins over errorRate, as it does in speed ranking", () => {
  const factors = factorsOf(candidate({ errorRate: 0.9, failureRate: 0.1 }));
  assert.equal(factors.reliability, 0.9);
});

test("no observation reads as fully reliable", () => {
  const factors = factorsOf(candidate({ errorRate: undefined as unknown as number }));
  assert.equal(factors.reliability, 1);
});

test("a garbage rate reads as unobserved, not as total failure", () => {
  // The interesting part is not that the value stays inside [0,1] -- asserting
  // only that would have locked in the bug this test was written to catch.
  // Corrupt telemetry (NaN from a divide, Infinity from a bad ratio) must mean
  // "nothing usable observed", which is reliability 1, not 0.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(
      factorsOf(candidate({ errorRate: bad })).reliability,
      1,
      `rate ${bad} must read as unobserved, not as a candidate that fails every call`
    );
  }
  // A rate above 1 is still a rate: it means everything failed.
  assert.equal(factorsOf(candidate({ errorRate: 2 })).reliability, 0);
});

test("the factor agrees with the speed ranking on the same garbage input", () => {
  // Both read the same field off the same candidate; disagreeing on NaN would
  // mean two parts of the router rank the same provider from opposite ends.
  const boundedRate = (value: number) =>
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ? 0 : Math.min(1, value);
  for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.4, 2]) {
    assert.equal(
      factorsOf(candidate({ errorRate: rate })).reliability,
      Math.min(1, Math.max(0, 1 - boundedRate(rate))),
      `divergence from speedRanking's toBoundedRate on ${rate}`
    );
  }
});

test("the default weights still sum to one", () => {
  assert.equal(validateWeights(DEFAULT_WEIGHTS), true);
});

test("reliability is a declared, enabled weight", () => {
  assert.ok("reliability" in DEFAULT_WEIGHTS, "the factor must be declared to be settable");
  // Enabled on purpose (was 0): combined with the separate `health` factor this
  // is what drops a provider that fails most of its calls below a healthy one.
  assert.equal(DEFAULT_WEIGHTS.reliability, 0.08, "ships enabled");
});
