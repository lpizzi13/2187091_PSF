# SYSTEM DESCRIPTION:

Seismic Analysis Platform is a distributed, fault-tolerant system for real-time seismic event detection.
The platform consumes raw measurements from the provided simulator, redistributes data through a custom broker, performs FFT-based analysis on replicated processing services, stores classified events in a shared MySQL database, and exposes monitoring data through a gateway and a real-time dashboard.

Core architectural goals:
- distributed decomposition (no monolith)
- replicated processing nodes
- resilience to partial replica failures
- duplicate-safe persistence
- reproducible deployment with Docker Compose

# USER STORIES:

Implemented user stories:
- US-01 Sensor discovery
- US-02 Broker connects to sensor WebSocket streams
- US-03 Broker fan-out to processing replicas
- US-04 Concurrent handling of multiple sensors
- US-05 Sliding window in each replica
- US-06 FFT/DFT computation
- US-07 Dominant frequency extraction
- US-08 Event classification
- US-09 Incomplete window filtering
- US-10 Sensor-level processing isolation
- US-11 Event persistence
- US-12 Event metadata persistence
- US-13 Duplicate-safe persistence behavior
- US-14 Replicas listen to shutdown control stream
- US-15 Replicas terminate on shutdown command
- US-16 Single backend entry point
- US-17 Routing to healthy replicas
- US-18 Service continuity under replica failures
- US-19 Real-time dashboard visualization
- US-20 Historical event browsing and filtering

# CONTAINERS:

## CONTAINER_NAME: simulator

### DESCRIPTION:
Provided external seismic simulator image. It emits time-domain seismic measurements and control stream commands.

### USER STORIES:
US-01, US-02, US-14, US-15

### PORTS:
- 8080:8080

### PERSISTENCE EVALUATION
No project-owned persistence. Runtime state is transient and managed by the provided image.

### EXTERNAL SERVICES CONNECTIONS
None. This container is the upstream data source for broker and replicas.

### MICROSERVICES:

#### MICROSERVICE: simulator-api
- TYPE: backend (external, provided)
- DESCRIPTION: Exposes sensor discovery, sensor WebSocket streams, control SSE stream, and manual admin triggers for tests.
- PORTS: 8080
- TECHNOLOGICAL SPECIFICATION:
FastAPI-based API exposed by the provided image `seismic-signal-simulator:multiarch_v1`.
- SERVICE ARCHITECTURE:
Single service used as event producer and failure-simulation controller.
- ENDPOINTS:

| HTTP METHOD | URL | Description | User Stories |
| ----------- | --- | ----------- | ------------ |
| GET | `/health` | Simulator health and runtime config | US-01 |
| GET | `/api/devices/` | Sensor discovery list | US-01 |
| WS | `/api/device/{sensor_id}/ws` | Real-time measurement stream per sensor | US-02 |
| GET (SSE) | `/api/control` | Shared control stream with shutdown commands | US-14, US-15 |
| POST | `/api/admin/sensors/{sensor_id}/events` | Manual injection of seismic events | US-08, US-19 |
| POST | `/api/admin/shutdown` | Manual shutdown trigger for one connected replica | US-14, US-15, US-18 |

## CONTAINER_NAME: db

### DESCRIPTION:
Shared MySQL persistence layer storing classified seismic events from replicas.

### USER STORIES:
US-11, US-12, US-13, US-20

### PORTS:
- Internal DB service port: `3306`
- Docker host mapping in this compose profile: `3307:3306`

### PERSISTENCE EVALUATION
Schema is initialized via `database/init.sql`. Data is persisted in the container filesystem.
Current compose file does not declare a dedicated named volume, therefore data is not guaranteed across full container removal.

### EXTERNAL SERVICES CONNECTIONS
Inbound connections from all processing replicas through internal Docker network.

### MICROSERVICES:

#### MICROSERVICE: mysql-storage
- TYPE: backend (database)
- DESCRIPTION: Stores event records and supports historical queries.
- PORTS: `3306` internal (`3307:3306` exposed on host in compose)
- TECHNOLOGICAL SPECIFICATION:
MySQL 8.0, initialized via SQL script mounted in `/docker-entrypoint-initdb.d/init.sql`.
- SERVICE ARCHITECTURE:
Single shared relational database used by all replicas.
- DB STRUCTURE:

**`seismic_events`**:

| Column | Type | Notes |
| ------ | ---- | ----- |
| `event_id` | `VARCHAR(255)` | Primary key, deterministic event id |
| `sensor_id` | `VARCHAR(50)` | Sensor identifier |
| `region` | `VARCHAR(100)` | Sensor region |
| `latitude` | `FLOAT` | Sensor latitude |
| `longitude` | `FLOAT` | Sensor longitude |
| `timestamp` | `DATETIME(6)` | Event UTC timestamp |
| `dominant_frequency_hz` | `FLOAT` | FFT dominant frequency |
| `classification` | `VARCHAR(50)` | Event class |
| `detected_by` | `VARCHAR(100)` | Replica id that produced detection |

Indexes:
- `idx_timestamp`
- `idx_sensor`
- `idx_region`

## CONTAINER_NAME: broker

### DESCRIPTION:
Custom fan-out broker deployed in the neutral region. It receives simulator sensor streams and broadcasts each measurement to all connected processing replicas.

### USER STORIES:
US-02, US-03, US-04

### PORTS:
- 8000 internal only (not published)

### PERSISTENCE EVALUATION
No persistent storage. In-memory connection set for attached replicas.

### EXTERNAL SERVICES CONNECTIONS
- Outbound to simulator: `http://simulator:8080/api/devices/` and sensor WebSocket URLs
- Inbound from replicas: `ws://broker:8000/data`

### MICROSERVICES:

#### MICROSERVICE: broker-api
- TYPE: backend
- DESCRIPTION: Discovers sensors, opens one WebSocket consumer per sensor, broadcasts normalized measurement payloads.
- PORTS: 8000 internal
- TECHNOLOGICAL SPECIFICATION:
Python 3.11, FastAPI, aiohttp, uvicorn.
- SERVICE ARCHITECTURE:
Asynchronous event-driven service with discovery loop, per-sensor streaming tasks, and WebSocket fan-out channel.
- ENDPOINTS:

| HTTP METHOD | URL | Description | User Stories |
| ----------- | --- | ----------- | ------------ |
| GET | `/health` | Broker liveness and active streams info | US-04 |
| WS | `/data` | Replica subscription endpoint for fan-out feed | US-03 |

## CONTAINER_NAME: replica-primary

### DESCRIPTION:
Primary processing replica. Performs FFT analysis and acts as preferred writer when healthy.

### USER STORIES:
US-05, US-06, US-07, US-08, US-09, US-10, US-11, US-12, US-13, US-14, US-15, US-18, US-19, US-20

### PORTS:
- 8000 internal only (not published)

### PERSISTENCE EVALUATION
No local persistence. Uses shared MySQL for event storage.

### EXTERNAL SERVICES CONNECTIONS
- Broker stream: `ws://broker:8000/data`
- Control stream: `http://simulator:8080/api/control`
- Sensor metadata API: `http://simulator:8080/api/devices/`
- MySQL: `mysql://admin:secret@db:3306/seismic_db`

### MICROSERVICES:

#### MICROSERVICE: processing-replica-service
- TYPE: backend
- DESCRIPTION: Maintains per-sensor windows, computes FFT, classifies events, persists deduplicated events, emits real-time feeds.
- PORTS: 8000 internal
- TECHNOLOGICAL SPECIFICATION:
Python 3.11, FastAPI, aiohttp, aiomysql, NumPy, uvicorn.
- SERVICE ARCHITECTURE:
Async service with three background loops:
1. broker consumer loop
2. control SSE loop
3. metadata refresh loop

Primary/backup logic:
- static primary id (`replica-primary`)
- backups persist only when primary health check fails
- DB lock + dedup query + insert-ignore for duplicate-safe behavior

- ENDPOINTS:

| HTTP METHOD | URL | Description | User Stories |
| ----------- | --- | ----------- | ------------ |
| GET | `/health` | Replica health and runtime counters | US-17, US-18 |
| GET | `/api/events` | Historical event list with filters | US-20 |
| GET (SSE) | `/api/events/stream` | Real-time event stream | US-19 |
| WS | `/api/events/ws` | Real-time events via WebSocket | US-19 |

## CONTAINER_NAME: replica-backup-1

### DESCRIPTION:
Backup processing replica #1. Same code as primary, configured with backup replica id.

### USER STORIES:
US-05, US-06, US-07, US-08, US-09, US-10, US-11, US-12, US-13, US-14, US-15, US-18, US-19, US-20

### PORTS:
- 8000 internal only (not published)

### PERSISTENCE EVALUATION
No local persistence. Writes to shared MySQL only when primary is unavailable.

### EXTERNAL SERVICES CONNECTIONS
Same as `replica-primary`.

### MICROSERVICES:

#### MICROSERVICE: processing-replica-service
- TYPE: backend
- DESCRIPTION: Same implementation as primary, participating in failover and replicated computation.
- PORTS: 8000 internal
- TECHNOLOGICAL SPECIFICATION:
Python 3.11 stack identical to primary.
- SERVICE ARCHITECTURE:
Hot standby processing node with active streaming and conditional persistence.

## CONTAINER_NAME: replica-backup-2

### DESCRIPTION:
Backup processing replica #2. Same service behavior as backup-1.

### USER STORIES:
US-05, US-06, US-07, US-08, US-09, US-10, US-11, US-12, US-13, US-14, US-15, US-18, US-19, US-20

### PORTS:
- 8000 internal only (not published)

### PERSISTENCE EVALUATION
No local persistence. Writes to shared MySQL only during primary outage.

### EXTERNAL SERVICES CONNECTIONS
Same as `replica-primary`.

### MICROSERVICES:

#### MICROSERVICE: processing-replica-service
- TYPE: backend
- DESCRIPTION: Same implementation as other replicas.
- PORTS: 8000 internal
- TECHNOLOGICAL SPECIFICATION:
Python 3.11 stack identical to primary.
- SERVICE ARCHITECTURE:
Hot standby processing node with active streaming and conditional persistence.

## CONTAINER_NAME: gateway

### DESCRIPTION:
Single entry-point reverse proxy in neutral region. Routes client requests to healthy processing replicas.

### USER STORIES:
US-16, US-17, US-18, US-19, US-20

### PORTS:
- 80:80

### PERSISTENCE EVALUATION
No persistence. Stateless proxy.

### EXTERNAL SERVICES CONNECTIONS
Upstream to processing replicas:
- `replica-primary:8000`
- `replica-backup-1:8000`
- `replica-backup-2:8000`

### MICROSERVICES:

#### MICROSERVICE: gateway-proxy
- TYPE: backend
- DESCRIPTION: Nginx reverse proxy with active/backup upstream policy and retry rules.
- PORTS: 80
- TECHNOLOGICAL SPECIFICATION:
Nginx 1.27-alpine.
- SERVICE ARCHITECTURE:
- static upstream list with `backup` servers
- failover on timeout/error/5xx
- long-lived settings for SSE/WS paths

- ENDPOINTS:

| HTTP METHOD | URL | Description | User Stories |
| ----------- | --- | ----------- | ------------ |
| GET | `/gateway/health` | Gateway self-health endpoint | US-16 |
| GET | `/health` | Proxied to active processing replica | US-17 |
| GET | `/api/events` | Proxied event archive endpoint | US-20 |
| GET (SSE) | `/api/events/stream` | Proxied live events stream | US-19 |
| WS | `/api/events/ws` | Proxied live events WebSocket | US-19 |

## CONTAINER_NAME: dashboard

### DESCRIPTION:
Frontend dashboard for live monitoring, archive exploration, and fault-tolerance visibility.

### USER STORIES:
US-19, US-20

### PORTS:
- 3000:3000

### PERSISTENCE EVALUATION
No server-side persistence. Browser local storage is used only for optional sensor marker map overrides.

### EXTERNAL SERVICES CONNECTIONS
- Requests to gateway endpoints (`/health`, `/api/events`, `/api/events/stream`)

### MICROSERVICES:

#### MICROSERVICE: dashboard-web
- TYPE: frontend
- DESCRIPTION: Single-page UI rendering live feed, replica status, map, event analysis, and archive filters.
- PORTS: 3000
- TECHNOLOGICAL SPECIFICATION:
Static HTML/CSS/JavaScript served by Nginx.
- SERVICE ARCHITECTURE:
Client-side polling + SSE subscription:
- periodic health polling
- archive polling
- real-time stream via EventSource

- PAGES:

| Name | Description | Related Microservice | User Stories |
| ---- | ----------- | -------------------- | ------------ |
| `index.html` | Main command-center page with map, live events, logs, and archive | `processing-replica-service` via `gateway-proxy` | US-19, US-20 |

# NOTES FOR DELIVERY SCOPE

- LoFi mockups are intentionally not included in this file and are planned in a separate workflow, as requested.
- Detailed NFR mapping per user story is provided in `booklets/user_stories_nfr.md`.
