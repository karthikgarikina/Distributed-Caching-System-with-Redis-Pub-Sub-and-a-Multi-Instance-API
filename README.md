# Distributed Caching System with Redis Pub/Sub and Multi-Instance API

A high-performance, containerized backend system featuring a two-level distributed cache (L1 in-memory LRU + L2 shared Redis) with real-time cache invalidation using Redis Pub/Sub, orchestrated via Docker Compose and load-balanced with Nginx.

---

## 1. Architecture Overview

In multi-instance microservices, caching drastically reduces database pressure and latency. However, running multiple application instances introduces the **cache coherence** problem: when one instance mutates data in the database, the local in-memory caches on other instances become stale.

This system solves this challenge using a **Two-Level Distributed Cache** with a **Publish/Subscribe Invalidation Bus**:

```
                              Client Requests
                                     │
                                     ▼
                            ┌─────────────────┐
                            │   Nginx Proxy   │ (Port 80 - Round Robin)
                            └────────┬────────┘
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
      ┌─────────────┐         ┌─────────────┐         ┌─────────────┐
      │ Instance 1  │         │ Instance 2  │         │ Instance 3  │
      │ (Port 8081) │         │ (Port 8082) │         │ (Port 8083) │
      │ ┌─────────┐ │         │ ┌─────────┐ │         │ ┌─────────┐ │
      │ │L1 Cache │ │         │ │L1 Cache │ │         │ │L1 Cache │ │
      │ └────┬────┘ │         │ └────┬────┘ │         │ └────┬────┘ │
      └──────┼──────┘         └──────┼──────┘         └──────┼──────┘
             │                       │                       │
             ├───────────────────────┼───────────────────────┤
             ▼                       ▼                       ▼
     ┌──────────────────────────────────────────────────────────────┐
     │                      Redis (Port 6379)                       │
     │  - L2 Shared Cache                                           │
     │  - Pub/Sub Channel: "cache-invalidation"                     │
     └──────────────────────────────┬───────────────────────────────┘
                                    │
                                    ▼
                     ┌─────────────────────────────┐
                     │    PostgreSQL (Port 5432)   │
                     │    - Persistent Storage     │
                     └─────────────────────────────┘
```

### Two-Level Cache Read Flow (Cache-Aside)
1. **L1 Check**: Application checks local in-memory LRU cache.
   - **Hit**: Return product immediately with header `X-Cache: HIT-L1` (sub-millisecond latency).
   - **Miss**: Check L2.
2. **L2 Check**: Application checks shared Redis cache.
   - **Hit**: Populate local L1 cache, return with header `X-Cache: HIT-L2`.
   - **Miss**: Query PostgreSQL database.
3. **DB Query**: Fetch record from PostgreSQL.
   - Populate shared L2 (Redis) with TTL and local L1 cache.
   - Return product with header `X-Cache: MISS`.

### Distributed Cache Invalidation Flow (Write / Update / Delete)
1. **Database Write**: The servicing instance performs the DB write/update/delete first.
2. **L2 Eviction**: The servicing instance immediately deletes the affected key/pattern from Redis L2.
3. **Pub/Sub Broadcast**: The servicing instance publishes an invalidation event to the Redis `cache-invalidation` channel.
4. **L1 Eviction on All Nodes**: Every subscribed instance (including `app1`, `app2`, and `app3`) receives the message in real time and evicts the corresponding key(s) from its local in-memory L1 cache.

---

## 2. Project Structure

```
├── .env                  # Local environment configuration
├── .env.example          # Template documenting required environment variables
├── .dockerignore         # Docker build ignore rules
├── .gitignore            # Git ignore rules
├── Dockerfile            # Application container image definition (Node.js Alpine)
├── docker-compose.yml    # Complete 6-service orchestration
├── README.md             # Project documentation and testing guide
├── package.json          # Node.js dependencies
├── db/
│   └── init.sql          # PostgreSQL schema and seed data (6 sample products)
├── nginx/
│   └── nginx.conf        # Nginx load balancing reverse proxy configuration
└── src/
    ├── cache.js          # Two-level cache, Redis Pub/Sub invalidation, stats tracker
    ├── db.js             # PostgreSQL connection pool
    └── server.js         # Express HTTP API endpoints
```

---

## 3. Environment Configuration

The repository includes `.env.example` defining all required configuration variables:

```env
# Application Configuration
APP_PORT=8081
INSTANCE_ID=instance-1

# Database Connection
DATABASE_URL=postgresql://user:password@db:5432/products_db

# Redis Connection
REDIS_URL=redis://redis:6379
```

Copy `.env.example` to `.env` if not already present:
```bash
cp .env.example .env
```

---

## 4. How to Setup and Run

### Prerequisites
- Docker Engine (v20.10+)
- Docker Compose (v2.0+)

### Step 1: Start All Services
From the root directory of the repository, execute:
```bash
docker compose up -d --build
```

### Step 2: Verify Service Health
Check that all 6 containers (`db`, `redis`, `app1`, `app2`, `app3`, `nginx`) are healthy:
```bash
docker compose ps
```
All containers should display status `Up (healthy)`.

### Step 3: Viewing Logs
To view application logs in real-time:
```bash
docker compose logs -f
```
Or for an individual service:
```bash
docker compose logs -f app1
```

### Step 4: Stopping Services
```bash
docker compose down
```
To remove volumes as well:
```bash
docker compose down -v
```

---

## 5. API Reference

| Method | Endpoint | Description | Cache Status Header |
|---|---|---|---|
| `GET` | `/health` | Service health status | - |
| `GET` | `/api/instance/id` | Returns current instance ID string | - |
| `GET` | `/api/products/:id` | Get single product by ID (cache-aside) | `X-Cache: HIT-L1 / HIT-L2 / MISS` |
| `GET` | `/api/products?page=1` | Get paginated products list | `X-Cache: HIT-L1 / HIT-L2 / MISS` |
| `POST` | `/api/products` | Create product (invalidates `products:page:*`) | - |
| `PUT` | `/api/products/:id` | Update product (invalidates `product:<id>`) | - |
| `DELETE` | `/api/products/:id` | Delete product (invalidates `product:<id>`) | - |
| `GET` | `/api/cache/stats` | Instance cache statistics & hit ratio | - |
| `POST` | `/api/cache/invalidate` | Manually evict key or pattern across all nodes | - |
| `DELETE` | `/api/cache/clear` | Flush all L1 and L2 caches | - |

---

## Video Demo

https://youtu.be/s-9-F1nM2zE

---

## 6. Comprehensive Testing & Verification Guide

Follow these step-by-step verification procedures to test all 13 core requirements.

### Test 1: Container Orchestration & Health Checks (Requirement 1)
Run:
```bash
docker compose ps
```
**Expected Outcome**: All 6 containers (`db`, `redis`, `app1`, `app2`, `app3`, `nginx`) are in `healthy` status.

---

### Test 2: Database Schema & Seed Data (Requirement 2)
Inspect the database schema and count of seeded products:
```bash
docker exec -it db psql -U user -d products_db -c "\d products"
docker exec -it db psql -U user -d products_db -c "SELECT COUNT(*) FROM products;"
```
**Expected Outcome**: 
- Table `products` has columns: `id`, `name`, `description`, `price`, `stock` with appropriate constraints (`CHECK (price >= 0)`, `CHECK (stock >= 0)`).
- `COUNT(*)` is >= 5 (initial seed contains 6 products).

---

### Test 3: Nginx Load Balancing (Requirement 3)
Send 3 consecutive requests to the Nginx reverse proxy on port 80:
```bash
curl -s http://localhost/api/instance/id
curl -s http://localhost/api/instance/id
curl -s http://localhost/api/instance/id
```
**Expected Outcome**: The responses rotate in round-robin across:
```
instance-1
instance-2
instance-3
```

---

### Test 4: Direct Instance Identification (Requirement 4)
Send requests directly to individual instance ports:
```bash
curl -s http://localhost:8081/api/instance/id
curl -s http://localhost:8082/api/instance/id
curl -s http://localhost:8083/api/instance/id
```
**Expected Outcome**:
- Port 8081 returns `"instance-1"` with HTTP 200.
- Port 8082 returns `"instance-2"` with HTTP 200.
- Port 8083 returns `"instance-3"` with HTTP 200.

---

### Test 5: Two-Level Cache-Aside Pattern (Requirement 5)
1. Query product 1 via port 8081 (initial read, cache empty):
   ```bash
   curl -i http://localhost:8081/api/products/1
   ```
   **Response Header**: `X-Cache: MISS` (fetched from PostgreSQL, populated L1 and L2).

2. Query product 1 again on the same instance (port 8081):
   ```bash
   curl -i http://localhost:8081/api/products/1
   ```
   **Response Header**: `X-Cache: HIT-L1` (served directly from instance-1 memory).

3. Query product 1 on a different instance (port 8082):
   ```bash
   curl -i http://localhost:8082/api/products/1
   ```
   **Response Header**: `X-Cache: HIT-L2` (served from shared Redis, populated instance-2 L1).

---

### Test 6 & 7: Product Update & Redis Pub/Sub Invalidation (Requirements 6 & 7)
1. In a separate terminal, subscribe to the Redis invalidation channel:
   ```bash
   docker exec -it redis redis-cli SUBSCRIBE cache-invalidation
   ```

2. Update product 1 by sending a `PUT` request to instance 1:
   ```bash
   curl -X PUT http://localhost:8081/api/products/1 \
     -H "Content-Type: application/json" \
     -d '{"name": "Ultra Laptop Pro", "price": "1499.99"}'
   ```
   **Expected Outcome**: Returns HTTP 200 with updated product data.

3. Check the subscriber terminal:
   **Expected Pub/Sub Message**:
   ```json
   {
     "type": "INVALIDATE_KEY",
     "key": "product:1",
     "instanceId": "instance-1",
     "timestamp": "2026-10-06T..."
   }
   ```

---

### Test 8: Cross-Instance Invalidation Coherence (Requirement 8)
1. Prime product 2 on `app1`:
   ```bash
   curl -i http://localhost:8081/api/products/2
   ```
   *Header: `X-Cache: MISS`*
2. Confirm L1 Hit on `app1`:
   ```bash
   curl -i http://localhost:8081/api/products/2
   ```
   *Header: `X-Cache: HIT-L1`*
3. Confirm L2 Hit on `app2`:
   ```bash
   curl -i http://localhost:8082/api/products/2
   ```
   *Header: `X-Cache: HIT-L2`*
4. Invalidate via `app3` by updating product 2:
   ```bash
   curl -X PUT http://localhost:8083/api/products/2 \
     -H "Content-Type: application/json" \
     -d '{"name": "Updated Smartphone 5G", "price": "899.00"}'
   ```
5. Verify Invalidation on `app1`:
   ```bash
   curl -i http://localhost:8081/api/products/2
   ```
   *Header: `X-Cache: MISS`* (Old L1 cache was evicted by Pub/Sub; returns updated name and price).
6. Verify Invalidation on `app2`:
   ```bash
   curl -i http://localhost:8082/api/products/2
   ```
   *Header: `X-Cache: HIT-L2` or `MISS`* (Old L1 cache was evicted by Pub/Sub; returns updated name and price).

---

### Test 9: List Cache Invalidation on Product Creation (Requirement 9)
1. Prime paginated list cache:
   ```bash
   curl -i http://localhost/api/products?page=1
   ```
   *Header: `X-Cache: MISS`*
2. Verify list is now cached:
   ```bash
   curl -i http://localhost/api/products?page=1
   ```
   *Header: `X-Cache: HIT-L1` or `HIT-L2`*
3. Create a new product:
   ```bash
   curl -X POST http://localhost/api/products \
     -H "Content-Type: application/json" \
     -d '{"name": "Smart Watch", "description": "Waterproof fitness tracker", "price": "149.99", "stock": 75}'
   ```
   *Pub/Sub message broadcast: `{"type": "INVALIDATE_PATTERN", "pattern": "products:page:*"}`*
4. Re-fetch paginated list:
   ```bash
   curl -i http://localhost/api/products?page=1
   ```
   **Expected Outcome**: Header is `X-Cache: MISS`, and the new product `"Smart Watch"` is present in the results.

---

### Test 10: Local Cache Statistics (Requirement 10)
Query cache stats on instance 1:
```bash
curl -s http://localhost:8081/api/cache/stats
```
**Expected Outcome**: Returns HTTP 200 with JSON matching:
```json
{
  "instanceId": "instance-1",
  "l1_hits": 10,
  "l1_misses": 5,
  "l2_hits": 3,
  "l2_misses": 2,
  "db_hits": 2,
  "total_requests": 15,
  "hit_ratio": 0.866
}
```

---

### Test 11: Manual Invalidation (Requirement 11)
1. Prime cache for product 3 on `app1`:
   ```bash
   curl -i http://localhost:8081/api/products/3
   ```
2. Manually invalidate product 3 via `app2`:
   ```bash
   curl -X POST http://localhost:8082/api/cache/invalidate \
     -H "Content-Type: application/json" \
     -d '{"key": "product:3"}'
   ```
   **Response**: `{"status": "ok", "invalidated": "product:3"}`
3. Verify eviction on `app1`:
   ```bash
   curl -i http://localhost:8081/api/products/3
   ```
   **Response Header**: `X-Cache: MISS`

---

### Test 12: Flush All Caches (Requirement 12)
1. Clear all caches:
   ```bash
   curl -X DELETE http://localhost/api/cache/clear
   ```
   **Response**: `{"status": "ok", "message": "All caches cleared"}`
2. Verify Redis is empty:
   ```bash
   docker exec -it redis redis-cli DBSIZE
   ```
   **Output**: `(integer) 0`
3. Request any previously cached product:
   ```bash
   curl -i http://localhost/api/products/1
   ```
   **Response Header**: `X-Cache: MISS`

---

### Test 13: Environment Template (Requirement 13)
Verify that `.env.example` exists at the root and contains:
```bash
cat .env.example
```
**Expected Keys**: `APP_PORT`, `INSTANCE_ID`, `DATABASE_URL`, `REDIS_URL`.
