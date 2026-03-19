# Restaurant App - PostgreSQL Benchmark

## Summary

| Metric | Value |
|--------|-------|
| **Best Pool Size** | 10 |
| **Max Throughput** | 25 req/s |
| **Hourly Capacity** | 90,000 orders |
| **Test Duration** | 155 minutes |

## System

| Component | Value |
|-----------|-------|
| CPU | Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz (4 cores) |
| Memory | 5.72 GB |
| OS | Ubuntu |
| PostgreSQL | PostgreSQL 18.1 on x86_64-pc-linux-gnu |

## Results by Pool Size

| Pool Size | Max RPS | Breaking Point | Hourly |
|-----------|---------|----------------|--------|
| 10 | 25 req/s | 50 req/s | 90,000 |
| 25 | 25 req/s | 10 req/s | 90,000 |
| 50 | 25 req/s | 50 req/s | 90,000 |

## Pool Size: 10

| Load | Actual RPS | Error % | p95 | Status |
|------|------------|---------|-----|--------|
| 10 | 9.97 ± 0 | 0% | 32.46ms | ✅ |
| 25 | 24.83 ± 0.08 | 0% | 80.74ms | ✅ |
| 50 | 48.55 ± 1.48 | 0% | 3105.02ms | ❌ |
| 100 | 87.55 ± 11.05 | 2.85% | 8344.53ms | ❌ |
| 200 | 149.74 ± 1.33 | 46.53% | 15188.9ms | ❌ |
| 300 | 182.5 ± 1.29 | 55.77% | 15186.41ms | ❌ |

## Pool Size: 25

| Load | Actual RPS | Error % | p95 | Status |
|------|------------|---------|-----|--------|
| 10 | 9.95 ± 0.03 | 0% | 450.64ms | ❌ |
| 25 | 24.82 ± 0.01 | 0% | 183.15ms | ✅ |
| 50 | 47.13 ± 3.32 | 0% | 4551.75ms | ❌ |
| 100 | 77.84 ± 0.34 | 3.78% | 14376.63ms | ❌ |
| 200 | 148.7 ± 1.58 | 50.01% | 15202ms | ❌ |

## Pool Size: 50

| Load | Actual RPS | Error % | p95 | Status |
|------|------------|---------|-----|--------|
| 10 | 9.97 ± 0 | 0% | 73.58ms | ✅ |
| 25 | 24.82 ± 0.02 | 0% | 260.7ms | ✅ |
| 50 | 49 ± 0.9 | 0% | 2271.26ms | ❌ |
| 100 | 77.31 ± 0.3 | 12.14% | 15180.08ms | ❌ |
| 200 | 147.5 ± 2.59 | 50.41% | 15202.69ms | ❌ |

---
*Generated: 2026-03-06T06:25:34.736Z*
