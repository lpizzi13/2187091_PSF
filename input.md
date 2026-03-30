# Seismic Analysis Platform

## 1. System Overview

The goal of this project is to design and implement a distributed, fault-tolerant seismic analysis platform.

The system ingests real-time seismic data from a provided simulator, redistributes each measurement across replicated processing services, performs frequency-domain analysis, classifies events, and persists them with duplicate-safe behavior.

A dashboard provides real-time monitoring and historical event exploration through a single gateway entry point.

---

## 2. User Stories

| ID | Area | User Story |
| --- | --- | --- |
| US-01 | Ingestion | As a system, I want to discover available seismic sensors so that I can subscribe to active streams. |
| US-02 | Ingestion | As a broker, I want to connect to sensor WebSocket streams so that I can receive real-time data. |
| US-03 | Broker | As a broker, I want to distribute each measurement to all processing replicas so that analysis is replicated. |
| US-04 | Broker | As a broker, I want to handle multiple sensor streams concurrently so that all devices are monitored. |
| US-05 | Processing | As a processing replica, I want to maintain a sliding window of samples so that I can analyze recent data. |
| US-06 | Processing | As a processing replica, I want to compute FFT/DFT so that I can extract frequency components. |
| US-07 | Processing | As a processing replica, I want to detect dominant frequency so that I can classify events. |
| US-08 | Processing | As a processing replica, I want to classify events so that meaningful alerts can be generated. |
| US-09 | Processing | As a processing replica, I want to ignore incomplete data windows so that classification remains accurate. |
| US-10 | Processing | As a processing replica, I want to process sensors independently so that noisy data does not affect others. |
| US-11 | Persistence | As a system, I want to store detected events so that they can be analyzed later. |
| US-12 | Persistence | As a system, I want to store metadata (sensor, timestamp, frequency, type) so that events can be queried. |
| US-13 | Persistence | As a system, I want duplicate-safe storage so that events are not saved multiple times. |
| US-14 | Fault Tolerance | As a processing replica, I want to receive shutdown commands so that failures can be simulated. |
| US-15 | Fault Tolerance | As a processing replica, I want to terminate on shutdown so that system resilience is tested. |
| US-16 | Gateway | As a client, I want a single entry point so that I do not need to know internal services. |
| US-17 | Gateway | As a gateway, I want to route requests to healthy replicas so that failed ones are excluded. |
| US-18 | Fault Tolerance | As a system, I want to continue operating despite replica failures so that availability is ensured. |
| US-19 | Dashboard | As a user, I want to view real-time events so that I can monitor seismic activity. |
| US-20 | Dashboard | As a user, I want to browse and filter historical events so that I can analyze past data. |

---

## 3. High-Level Architecture

Main components:
- Simulator: exposes sensors, measurements, and control commands.
- Broker: fan-out component that redistributes all sensor measurements.
- Processing replicas: FFT analysis, classification, real-time emission, persistence.
- Database: shared MySQL storage for classified events.
- Gateway: single entry point and failover router toward replicas.
- Dashboard: live and historical observability UI.

Communication protocols:
- Simulator -> Broker: WebSocket (per-sensor stream)
- Simulator -> Processing replicas: SSE (`/api/control`)
- Broker -> Processing replicas: WebSocket (`/data`)
- Processing replicas -> Database: MySQL
- Dashboard -> Gateway: HTTP + SSE

---

## 4. Standard Event Schema

### 4.1 Measurement Event (broker input/output)

```json
{
  "sensor_id": "sensor-01",
  "timestamp": "2026-03-28T10:15:30Z",
  "value": 1.42
}
```

### 4.2 Detected Event (processing output)

```json
{
  "event_id": "evt-0602ff0d1999a5a0c30e",
  "sensor_id": "sensor-01",
  "sensor_name": "Borealis Ridge",
  "region": "North Atlantic",
  "coordinates": {
    "lat": 64.1466,
    "lon": -21.9426
  },
  "timestamp": "2026-03-30T08:21:12.680217Z",
  "dominant_frequency_hz": 1.5625,
  "classification": "earthquake",
  "detected_by": "replica-primary",
  "persisted": true
}
```

### 4.3 Event Classification Bands

- Earthquake: `0.5 <= f < 3.0` Hz
- Conventional explosion: `3.0 <= f < 8.0` Hz
- Nuclear-like event: `f >= 8.0` Hz

---

## 5. Rule Model

### RM-01 Sensor Discovery Rule
On startup, broker and processing replicas must fetch the simulator sensor list from `/api/devices/` and refresh metadata periodically.

### RM-02 Ingestion/Fan-Out Rule
For every sensor sample received by broker, one normalized measurement message must be broadcast to all connected processing replicas.

### RM-03 Windowing Rule
Each processing replica keeps an in-memory sliding window per sensor.
An event can be analyzed only when at least `WINDOW_SIZE` samples are available.

### RM-04 Frequency Analysis Rule
When a full window is available at hop boundaries (`HOP_SIZE`), the replica applies FFT/DFT equivalent processing, extracts dominant non-DC frequency, and maps it to a classification band.

### RM-05 Classification Rule
Classification must follow exactly these thresholds:
- `0.5 <= f < 3.0`: `earthquake`
- `3.0 <= f < 8.0`: `conventional_explosion`
- `f >= 8.0`: `nuclear_like`

### RM-06 Emission Cooldown Rule
For each sensor, repeated consecutive events with same classification inside `MIN_EVENT_GAP_SECONDS` are ignored.

### RM-07 Replica Failure Rule
Each processing replica must subscribe to simulator control SSE (`/api/control`).
On `{"command":"SHUTDOWN"}`, the receiving replica must terminate.

### RM-08 Primary/Backup Write Rule
Primary replica (`replica-primary`) is the preferred writer.
Backup replicas persist only when primary health check fails.

### RM-09 Duplicate-Safe Persistence Rule
Before insert, replicas apply DB lock + recent-event dedup check and use `INSERT IGNORE` with deterministic `event_id` semantics to avoid duplicates.

### RM-10 Gateway Routing Rule
Gateway exposes a single entry point and routes to healthy processing replicas.
Backup replicas are used automatically when primary is unavailable.

### RM-11 Real-Time UI Rule
Dashboard must receive live events from `/api/events/stream` and must keep historical visibility through `/api/events` with filters.

---

## 6. Non-Functional Requirements (Project-Level)

- Availability: service remains operational under partial replica failures.
- Fault tolerance: controlled shutdown of one replica must not stop overall event flow.
- Scalability: processing logic runs concurrently for multiple sensors and replicas.
- Consistency: duplicate-safe persistence in shared DB.
- Observability: health endpoints, runtime counters, logs, and dashboard status views.
- Reproducibility: full stack must start via `docker compose up`.
