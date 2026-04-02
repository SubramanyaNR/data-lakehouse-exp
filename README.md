# Data Lakehouse Experiment — Guruprasad Udupi Restaurant

A real-world data engineering experiment that migrates a restaurant application from **PostgreSQL** to **Apache Kafka** as the primary data store, running on a local Kubernetes cluster managed with ArgoCD.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                        │
│                                                                  │
│  ┌──────────┐    ┌──────────────────────────────────────────┐   │
│  │  ArgoCD  │───▶│              Kafka (Strimzi)             │   │
│  │          │    │  restaurant.orders   (3 partitions)      │   │
│  │ GitOps   │    │  restaurant.customers (1 partition)      │   │
│  │ operator │    │  restaurant.order-status (3 partitions)  │   │
│  └──────────┘    │  restaurant.menu  (1 partition)          │   │
│                  │  restaurant.migrations (1 partition)     │   │
│  ┌──────────┐    └──────────────────────────────────────────┘   │
│  │PostgreSQL│                       ▲                            │
│  │ (source) │                       │ (migrated via script)      │
│  └──────────┘                       │                            │
│                                     │                            │
│  ┌──────────┐    ┌──────────────────────────────────────────┐   │
│  │Prometheus│    │         Grafana Dashboards               │   │
│  │+ metrics │───▶│  Order throughput, latency, Kafka lag    │   │
│  └──────────┘    └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ port-forward
┌─────────────────────────────────────────────────────────────────┐
│                      Local Machine                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Restaurant App (Node.js + Python)           │   │
│  │                                                          │   │
│  │  server.js (Express, port 3001)                          │   │
│  │      │                                                   │   │
│  │      ├──▶ producer.py (FastAPI, port 8001) ──▶ Kafka     │   │
│  │      └──▶ consumer.py (FastAPI, port 8002) ◀── Kafka     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Restaurant App** | Node.js + Express | Web server, REST API, frontend |
| **Kafka Producer** | Python + FastAPI | Receives write commands, publishes events to Kafka |
| **Kafka Consumer** | Python + FastAPI | Replays Kafka topics, maintains in-memory state, serves reads |
| **Kafka Broker** | Apache Kafka via Strimzi | Event log — single source of truth |
| **PostgreSQL** | PostgreSQL 15 | Original data store (source for one-time migration) |
| **ArgoCD** | GitOps operator | Manages all K8s manifests from this repo |
| **Strimzi** | Kafka K8s operator | Manages Kafka cluster and topics declaratively |
| **Prometheus + Grafana** | Monitoring stack | Metrics for Kafka lag, order throughput, app latency |

---

## Data Flow

### Write (e.g. customer places an order)
```
Browser → server.js → producer.py → Kafka topic (restaurant.orders)
```
The producer publishes an `ORDER_CREATED` event. Kafka stores it durably in the topic.

### Read (e.g. kitchen checks pending orders)
```
Browser → server.js → consumer.py → in-memory state → response
```
The consumer has already replayed all Kafka events on startup and holds the full state in memory. Reads are served directly from there — no Kafka call needed at query time.

### Consumer startup (state rebuild)
```
consumer.py starts → subscribes to all topics from offset 0
    → replays every event ever stored
    → rebuilds orders / customers / menu in memory
    → marks itself ready → server starts accepting traffic
```
If the consumer crashes and restarts, it rebuilds state entirely from Kafka — no database needed.

---

## Kafka Topics

| Topic | Partitions | Compaction | Events |
|-------|-----------|------------|--------|
| `restaurant.orders` | 3 | yes (by orderId) | `ORDER_CREATED` |
| `restaurant.order-status` | 3 | yes (by orderId) | `ORDER_STATUS_CHANGED` |
| `restaurant.customers` | 1 | yes (by phone) | `CUSTOMER_CREATED`, `CUSTOMER_UPDATED` |
| `restaurant.menu` | 1 | yes (by item id) | `MENU_CATEGORY_UPSERTED`, `MENU_ITEM_UPSERTED` |
| `restaurant.migrations` | 1 | no | `MIGRATION_COMPLETED` |

---

## Prerequisites

- Kubernetes cluster (local — e.g. kubeadm, k3s, kind)
- `kubectl` configured
- ArgoCD installed in the cluster
- Node.js v18+
- Python 3.10+

---

## Setup

### 1. Deploy infrastructure via ArgoCD

```bash
kubectl apply -f argocd-apps/root-app.yaml
```

This deploys (via GitOps):
- Namespaces
- Strimzi Kafka operator
- Kafka cluster (`my-cluster`) + all 5 topics
- Prometheus + Grafana monitoring stack

Wait for everything to be ready:
```bash
kubectl get pods -n kafka
kubectl get kafkatopics -n kafka
```

### 2. Start port-forwards

```bash
bash port-forward2.sh
```

Exposes on localhost:

| Service | Port |
|---------|------|
| PostgreSQL | 5432 |
| Kafka bootstrap | 9092 |
| ArgoCD | 8080 |
| Grafana | 3000 |
| Prometheus | 9090 |

### 3. Install app dependencies

```bash
cd Udupi_veg_Restaurant/grilli-master

# Node.js dependencies
npm install

# Python dependencies (for Kafka producer/consumer)
pip install -r kafka/requirements.txt
```

### 4. Run the one-time migration (PostgreSQL → Kafka)

Migrates existing customers, orders, and order status history from the K8s PostgreSQL pod into Kafka topics.

```bash
PG_PASSWORD=$(kubectl get secret -n postgres postgresql -o jsonpath="{.data.postgres-password}" | base64 -d) \
KAFKA_BROKER=localhost:9092 \
node db/migrate-pg-to-kafka.js
```

### 5. Start the application

```bash
DB_ADAPTER=kafka KAFKA_BROKER=localhost:9092 node server.js
```

This automatically spawns `producer.py` and `consumer.py` as child processes. Once the consumer finishes replaying Kafka topics you'll see:

```
✅ Kafka producer service ready
✅ Kafka consumer service ready (state replayed)
```

App is available at **http://localhost:3001**

---

## Running with PostgreSQL (no Kafka)

```bash
PG_HOST=localhost PG_PASSWORD=<password> node server.js
```

`DB_ADAPTER` defaults to `postgres` — the app uses direct SQL queries instead of Kafka.

---

## Project Structure

```
data-lakehouse-exp/
├── argocd-apps/                    # ArgoCD Application manifests
├── manifests/
│   ├── kafka-cluster/              # Strimzi KafkaCluster + PodMonitor
│   ├── kafka-topics/               # KafkaTopic definitions (5 topics)
│   ├── monitoring/                 # Prometheus, Grafana dashboards
│   ├── namespaces/
│   └── strimzi-operator/           # Strimzi operator install manifests
├── port-forward2.sh                # Port-forward all services to localhost
└── Udupi_veg_Restaurant/
    └── grilli-master/
        ├── server.js               # Express app (DB-adapter agnostic)
        ├── db/
        │   ├── index.js            # Selects adapter via DB_ADAPTER env var
        │   ├── postgres.js         # PostgreSQL adapter
        │   ├── kafka.js            # HTTP proxy → Python Kafka services
        │   └── migrate-pg-to-kafka.js  # One-time migration script
        └── kafka/
            ├── producer.py         # FastAPI producer service (port 8001)
            ├── consumer.py         # FastAPI consumer service (port 8002)
            └── requirements.txt
```

---

## Monitoring

With `port-forward2.sh` running:

- **Grafana**: http://localhost:3000 — Kafka consumer lag, order throughput, request latency
- **Prometheus**: http://localhost:9090 — raw metrics
- **ArgoCD**: https://localhost:8080 — GitOps sync status
