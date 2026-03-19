# Restaurant App - PostgreSQL Benchmark

## Summary

| Metric | Value |
|--------|-------|
| **Best Pool Size** | 25 |
| **Max Throughput** | 50 req/s |
| **Hourly Capacity** | 1,80,000 orders |
| **Test Duration** | 75 minutes |

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
| 25 | 50 req/s | 100 req/s | 1,80,000 |
| 50 | 25 req/s | 50 req/s | 90,000 |

## Pool Size: 10

| Load | Actual RPS | Error % | p95 | Status |
|------|------------|---------|-----|--------|
| 10 | 9.97 ± 0 | 0% | 32.09ms | ✅ |
| 25 | 24.63 ± 0.09 | 0% | 326.68ms | ✅ |
| 50 | 45.12 ± 6.01 | 4.34% | 7708.56ms | ❌ |
| 100 | 76.11 ± 2.21 | 27.2% | 15282.85ms | ❌ |
| 200 | 116.33 ± 38.61 | 58.5% | 15320.92ms | ❌ |

## Pool Size: 25

| Load | Actual RPS | Error % | p95 | Status |
|------|------------|---------|-----|--------|
| 10 | 9.98 ± 0.01 | 0% | 27.35ms | ✅ |
| 25 | 24.83 ± 0.08 | 0% | 223.43ms | ✅ |
| 50 | 49.15 ± 0.44 | 0% | 461.71ms | ✅ |
| 100 | 94.59 ± 2.18 | 0% | 3813.14ms | ❌ |
| 200 | 146.6 ± 6.3 | 34% | 15379.63ms | ❌ |
| 300 | 182.05 ± 7.5 | 28% | 15243.33ms | ❌ |

## Pool Size: 50

| Load | Actual RPS | Error % | p95 | Status |
|------|------------|---------|-----|--------|
| 10 | 9.96 ± 0.01 | 0% | 165.77ms | ✅ |
| 25 | 24.84 ± 0.07 | 0% | 209.78ms | ✅ |
| 50 | 49.5 ± 0.03 | 100% | 1.19ms | ❌ |

---
*Generated: 2026-03-06T09:30:23.558Z*
