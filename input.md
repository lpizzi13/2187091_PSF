# Seismic Analysis Platform

## 1. System Overview

The goal of this project is to design and implement a distributed, fault-tolerant seismic analysis platform.

The system ingests real-time seismic data from a simulator, distributes it across multiple processing replicas, performs frequency-domain analysis, classifies events, and persists them in a shared database. A frontend dashboard provides real-time monitoring and historical exploration of detected events.

The architecture is designed to ensure high availability and resilience, even in the presence of partial failures of processing replicas.

---

## 2. User Stories

| ID    | Area        | User Story |
|-------|-------------|------------|
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

The system is composed of the following components:

•⁠  ⁠*Simulator*: provides seismic data streams (WebSocket) and control signals (SSE).
•⁠  ⁠*Broker*: receives sensor data and redistributes it to all processing replicas (fan-out model).
•⁠  ⁠*Processing Replicas*: perform FFT/DFT analysis, extract dominant frequencies, classify events, and persist them.
•⁠  ⁠*Database*: shared storage for detected events with duplicate-safe behavior.
•⁠  ⁠*Gateway*: single entry point for frontend requests, handling routing and health checks.
•⁠  ⁠*Frontend Dashboard*: provides real-time and historical visualization of events.

### Data Flow

### Communication Protocols

•⁠  ⁠Simulator → Broker: WebSocket (sensor data)
•⁠  ⁠Simulator → Processing: SSE (control stream)
•⁠  ⁠Broker → Processing: HTTP / internal messaging
•⁠  ⁠Processing → Database: DB connection
•⁠  ⁠Frontend ↔️ Gateway: HTTP / WebSocket

---

## 4. Event Schema

### Measurement Event

⁠ json
{
  "sensor_id": "sensor-01",
  "timestamp": "2026-03-28T10:15:30Z",
  "value": 1.42
}

{
  "event_id": "sensor-01_2026-03-28T10:15:30Z_earthquake",
  "sensor_id": "sensor-01",
  "region": "Replica Datacenter",
  "coordinates": {
    "lat": 45.4642,
    "lon": 9.19
  },
  "timestamp": "2026-03-28T10:15:30Z",
  "dominant_frequency_hz": 2.4,
  "classification": "earthquake",
  "detected_by": "processing-replica-1"
}
 ⁠

Event classification is based on dominant frequency:
•⁠  ⁠Earthquake: 0.5 ≤ f < 3.0 Hz
•⁠  ⁠Conventional explosion: 3.0 ≤ f < 8.0 Hz
•⁠  ⁠Nuclear-like event: f ≥ 8.0 Hz