from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import socket
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

import aiohttp
import aiomysql
import numpy as np
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger("processing-replica")


def env_float(name: str, default: float) -> float:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        return float(raw_value)
    except ValueError:
        logger.warning("Invalid %s=%r, using default %.3f", name, raw_value, default)
        return default


def env_int(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        parsed = int(raw_value)
        if parsed <= 0:
            raise ValueError("must be > 0")
        return parsed
    except ValueError:
        logger.warning("Invalid %s=%r, using default %d", name, raw_value, default)
        return default


def env_csv(name: str, default: str) -> list[str]:
    raw_value = os.getenv(name, default)
    return [item.strip() for item in raw_value.split(",") if item.strip()]


REPLICA_ID = os.getenv("REPLICA_ID", socket.gethostname())
PRIMARY_REPLICA_ID = os.getenv("PRIMARY_REPLICA_ID", "replica-primary")
PRIMARY_REPLICA_HEALTH_URL = os.getenv(
    "PRIMARY_REPLICA_HEALTH_URL",
    f"http://{PRIMARY_REPLICA_ID}:8000/health",
)
BROKER_URL = os.getenv("BROKER_URL", "ws://localhost:8000/data")
SIMULATOR_CONTROL_URL = os.getenv("SIMULATOR_CONTROL_URL", "http://localhost:8080/api/control")
SIMULATOR_API_URL = os.getenv("SIMULATOR_API_URL", "").rstrip("/")
if not SIMULATOR_API_URL:
    control_parts = urlparse(SIMULATOR_CONTROL_URL)
    SIMULATOR_API_URL = f"{control_parts.scheme}://{control_parts.netloc}"

DB_URL = os.getenv("DB_URL", "mysql://admin:secret@localhost:3306/seismic_db")
SAMPLING_RATE_HZ = env_float("SAMPLING_RATE_HZ", 20.0)
WINDOW_SIZE = env_int("WINDOW_SIZE", 128)
HOP_SIZE_RAW = env_int("HOP_SIZE", 32)
HOP_SIZE = min(HOP_SIZE_RAW, WINDOW_SIZE)
if HOP_SIZE_RAW != HOP_SIZE:
    logger.warning(
        "HOP_SIZE=%d is larger than WINDOW_SIZE=%d. Clamping HOP_SIZE to %d.",
        HOP_SIZE_RAW,
        WINDOW_SIZE,
        HOP_SIZE,
    )
MIN_EVENT_GAP_SECONDS = env_float("MIN_EVENT_GAP_SECONDS", 4.0)
EVENT_DEDUP_SECONDS = env_float(
    "EVENT_DEDUP_SECONDS",
    max(MIN_EVENT_GAP_SECONDS * 4.0, 16.0),
)
PRIMARY_HEALTHCHECK_TTL_SECONDS = env_float("PRIMARY_HEALTHCHECK_TTL_SECONDS", 1.0)
PRIMARY_HEALTHCHECK_TIMEOUT_SECONDS = env_float("PRIMARY_HEALTHCHECK_TIMEOUT_SECONDS", 0.8)
DB_WRITER_LOCK_NAME = os.getenv("DB_WRITER_LOCK_NAME", "seismic_single_writer_lock")
DB_WRITER_LOCK_TIMEOUT_SECONDS = max(0.1, env_float("DB_WRITER_LOCK_TIMEOUT_SECONDS", 2.0))
SHUTDOWN_FORCE_EXIT_AFTER_SECONDS = max(
    0.0,
    env_float("SHUTDOWN_FORCE_EXIT_AFTER_SECONDS", 3.0),
)
REPLICA_IDS = env_csv(
    "REPLICA_IDS",
    f"{PRIMARY_REPLICA_ID},replica-backup-1,replica-backup-2",
)
REPLICA_HEALTH_TIMEOUT_SECONDS = max(
    0.1,
    env_float("REPLICA_HEALTH_TIMEOUT_SECONDS", 0.8),
)

BROKER_RECONNECT_SECONDS = env_float("BROKER_RECONNECT_SECONDS", 1.5)
CONTROL_RECONNECT_SECONDS = env_float("CONTROL_RECONNECT_SECONDS", 2.0)
METADATA_REFRESH_SECONDS = env_float("METADATA_REFRESH_SECONDS", 60.0)
DB_RETRY_SECONDS = env_float("DB_RETRY_SECONDS", 2.0)


@dataclass(frozen=True)
class SensorMetadata:
    name: str | None
    region: str | None
    latitude: float | None
    longitude: float | None


class ReplicaState:
    def __init__(self) -> None:
        self.session: aiohttp.ClientSession | None = None
        self.db_pool: aiomysql.Pool | None = None
        self.background_tasks: list[asyncio.Task[None]] = []
        self.stop_event = asyncio.Event()

        self.sensor_windows: dict[str, deque[float]] = {}
        self.sensor_sample_counts: dict[str, int] = {}
        self.last_emitted_by_sensor: dict[str, tuple[str, float]] = {}
        self.sensor_metadata: dict[str, SensorMetadata] = {}

        self.ws_clients: set[WebSocket] = set()
        self.ws_lock = asyncio.Lock()

        self.sse_subscribers: set[asyncio.Queue[str]] = set()
        self.sse_lock = asyncio.Lock()

        self.started_at = datetime.now(timezone.utc)
        self.last_broker_message_at: datetime | None = None
        self.measurements_seen = 0
        self.events_persisted = 0
        self.events_duplicates = 0
        self.events_skipped_non_writer = 0
        self.control_commands_seen = 0
        self.shutdown_in_progress = False
        self.primary_health_cached = False
        self.primary_health_checked_at = 0.0


state = ReplicaState()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        return utc_now()

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return utc_now()

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def classify_frequency(freq_hz: float) -> str | None:
    if 0.5 <= freq_hz < 3.0:
        return "earthquake"
    if 3.0 <= freq_hz < 8.0:
        return "conventional_explosion"
    if freq_hz >= 8.0:
        return "nuclear_like"
    return None


def compute_event_bucket(timestamp: datetime) -> int:
    """
    Map an event timestamp to a shared time bucket so all replicas derive
    the same logical event id for near-simultaneous detections.
    """
    gap = max(MIN_EVENT_GAP_SECONDS, 0.1)
    return int((timestamp.timestamp() / gap) + 0.5)


def build_event_id(sensor_id: str, event_bucket: int, classification: str) -> str:
    raw = f"{sensor_id}|{classification}|{event_bucket}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]
    return f"evt-{digest}"


def analyze_measurement(sensor_id: str, timestamp: Any, value: float) -> dict[str, Any] | None:
    state.measurements_seen += 1

    window = state.sensor_windows.setdefault(sensor_id, deque(maxlen=WINDOW_SIZE))
    sample_count = state.sensor_sample_counts.get(sensor_id, 0) + 1
    state.sensor_sample_counts[sensor_id] = sample_count
    window.append(float(value))
    if len(window) < WINDOW_SIZE:
        return None
    if sample_count > WINDOW_SIZE and (sample_count - WINDOW_SIZE) % HOP_SIZE != 0:
        return None

    samples = np.asarray(window, dtype=np.float64)
    centered = samples - float(np.mean(samples))
    magnitudes = np.abs(np.fft.rfft(centered))
    if magnitudes.size <= 1:
        return None

    frequencies = np.fft.rfftfreq(centered.size, d=1.0 / SAMPLING_RATE_HZ)
    dominant_index = int(np.argmax(magnitudes[1:]) + 1)
    dominant_frequency_hz = float(frequencies[dominant_index])
    classification = classify_frequency(dominant_frequency_hz)
    if classification is None:
        return None

    now_monotonic = time.monotonic()
    previous = state.last_emitted_by_sensor.get(sensor_id)
    if previous is not None:
        previous_class, previous_ts = previous
        if previous_class == classification and now_monotonic - previous_ts < MIN_EVENT_GAP_SECONDS:
            return None
    state.last_emitted_by_sensor[sensor_id] = (classification, now_monotonic)

    event_time = parse_timestamp(timestamp)
    event_iso = isoformat_utc(event_time)
    event_bucket = compute_event_bucket(event_time)
    metadata = state.sensor_metadata.get(sensor_id, SensorMetadata(None, None, None, None))

    return {
        "event_id": build_event_id(sensor_id, event_bucket, classification),
        "sensor_id": sensor_id,
        "sensor_name": metadata.name,
        "region": metadata.region,
        "coordinates": {"lat": metadata.latitude, "lon": metadata.longitude},
        "timestamp": event_iso,
        "dominant_frequency_hz": round(dominant_frequency_hz, 6),
        "classification": classification,
        "detected_by": REPLICA_ID,
    }


def parse_db_config(db_url: str) -> dict[str, Any]:
    parsed = urlparse(db_url)
    scheme = parsed.scheme.lower()
    if not scheme.startswith("mysql"):
        raise ValueError(f"Unsupported DB_URL scheme: {parsed.scheme!r}. Use a mysql:// URL.")

    if parsed.username is None:
        raise ValueError("DB_URL must include username.")
    if parsed.path in ("", "/"):
        raise ValueError("DB_URL must include database name in the path.")

    return {
        "host": parsed.hostname or "db",
        "port": parsed.port or 3306,
        "user": unquote(parsed.username),
        "password": unquote(parsed.password or ""),
        "db": parsed.path.lstrip("/"),
    }


async def create_db_pool_with_retry() -> aiomysql.Pool:
    db_config = parse_db_config(DB_URL)

    while not state.stop_event.is_set():
        try:
            pool = await aiomysql.create_pool(
                minsize=1,
                maxsize=10,
                autocommit=True,
                cursorclass=aiomysql.DictCursor,
                **db_config,
            )
            logger.info(
                "Connected to MySQL at %s:%s/%s",
                db_config["host"],
                db_config["port"],
                db_config["db"],
            )
            return pool
        except Exception as exc:
            logger.warning("MySQL unavailable (%s). Retrying in %.1fs.", exc, DB_RETRY_SECONDS)
            await asyncio.sleep(DB_RETRY_SECONDS)

    raise RuntimeError("Stopped before DB pool initialization completed.")


async def refresh_sensor_metadata() -> None:
    if state.session is None:
        return

    url = f"{SIMULATOR_API_URL}/api/devices/"
    async with state.session.get(url) as response:
        response.raise_for_status()
        payload = await response.json()

    metadata: dict[str, SensorMetadata] = {}
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            sensor_id = item.get("id")
            if not isinstance(sensor_id, str):
                continue

            coordinates = item.get("coordinates")
            latitude: float | None = None
            longitude: float | None = None
            if isinstance(coordinates, dict):
                lat_value = coordinates.get("latitude")
                lon_value = coordinates.get("longitude")
                latitude = float(lat_value) if isinstance(lat_value, (int, float)) else None
                longitude = float(lon_value) if isinstance(lon_value, (int, float)) else None

            region = item.get("region")
            name = item.get("name")
            metadata[sensor_id] = SensorMetadata(
                name=name if isinstance(name, str) else None,
                region=region if isinstance(region, str) else None,
                latitude=latitude,
                longitude=longitude,
            )

    state.sensor_metadata = metadata


async def metadata_refresh_loop() -> None:
    while not state.stop_event.is_set():
        try:
            await refresh_sensor_metadata()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Sensor metadata refresh failed (%s).", exc)
        await asyncio.sleep(METADATA_REFRESH_SECONDS)


async def is_primary_replica_healthy() -> bool:
    if REPLICA_ID == PRIMARY_REPLICA_ID:
        return True
    if state.session is None:
        return False

    now = time.monotonic()
    if now - state.primary_health_checked_at < max(0.1, PRIMARY_HEALTHCHECK_TTL_SECONDS):
        return state.primary_health_cached

    state.primary_health_checked_at = now
    healthy = False
    try:
        async with state.session.get(
            PRIMARY_REPLICA_HEALTH_URL,
            timeout=PRIMARY_HEALTHCHECK_TIMEOUT_SECONDS,
        ) as response:
            healthy = response.status == 200
    except Exception:
        healthy = False

    state.primary_health_cached = healthy
    return healthy


async def should_persist_on_this_replica() -> bool:
    if REPLICA_ID == PRIMARY_REPLICA_ID:
        return True
    primary_healthy = await is_primary_replica_healthy()
    return not primary_healthy


async def persist_event(event: dict[str, Any]) -> tuple[bool, str]:
    if state.db_pool is None:
        raise RuntimeError("DB pool is not initialized.")

    event_timestamp = parse_timestamp(event.get("timestamp")).replace(tzinfo=None)
    dedup_window_seconds = max(1, int(round(EVENT_DEDUP_SECONDS)))

    dedup_query = """
        SELECT event_id
        FROM seismic_events
        WHERE sensor_id = %s
          AND classification = %s
          AND TIMESTAMPDIFF(SECOND, timestamp, %s) BETWEEN 0 AND %s
        ORDER BY timestamp DESC
        LIMIT 1
    """

    query = """
        INSERT IGNORE INTO seismic_events (
            event_id,
            sensor_id,
            region,
            latitude,
            longitude,
            timestamp,
            dominant_frequency_hz,
            classification,
            detected_by
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    params = (
        event["event_id"],
        event["sensor_id"],
        event.get("region"),
        event["coordinates"].get("lat"),
        event["coordinates"].get("lon"),
        event_timestamp,
        event["dominant_frequency_hz"],
        event["classification"],
        event["detected_by"],
    )

    async with state.db_pool.acquire() as conn:
        async with conn.cursor() as cursor:
            lock_acquired = False
            try:
                await cursor.execute(
                    "SELECT GET_LOCK(%s, %s) AS got_lock",
                    (DB_WRITER_LOCK_NAME, DB_WRITER_LOCK_TIMEOUT_SECONDS),
                )
                lock_row = await cursor.fetchone()
                got_lock = None
                if isinstance(lock_row, dict):
                    got_lock = lock_row.get("got_lock")
                lock_acquired = int(got_lock or 0) == 1
                if not lock_acquired:
                    return False, event["event_id"]

                await cursor.execute(
                    dedup_query,
                    (
                        event["sensor_id"],
                        event["classification"],
                        event_timestamp,
                        dedup_window_seconds,
                    ),
                )
                existing_recent = await cursor.fetchone()
                if isinstance(existing_recent, dict):
                    existing_id = existing_recent.get("event_id")
                    if isinstance(existing_id, str) and existing_id:
                        return False, existing_id

                await cursor.execute(query, params)
                if cursor.rowcount == 1:
                    return True, event["event_id"]

                # Fallback for races: if another replica inserted the same id
                # concurrently, use the canonical id already stored.
                await cursor.execute(
                    "SELECT event_id FROM seismic_events WHERE event_id = %s LIMIT 1",
                    (event["event_id"],),
                )
                existing_same_id = await cursor.fetchone()
                if isinstance(existing_same_id, dict):
                    existing_id = existing_same_id.get("event_id")
                    if isinstance(existing_id, str) and existing_id:
                        return False, existing_id
            finally:
                if lock_acquired:
                    try:
                        await cursor.execute(
                            "SELECT RELEASE_LOCK(%s)",
                            (DB_WRITER_LOCK_NAME,),
                        )
                    except Exception:
                        pass

    return False, event["event_id"]


async def broadcast_realtime_event(event: dict[str, Any]) -> None:
    serialized = json.dumps(event, separators=(",", ":"))

    async with state.ws_lock:
        ws_clients = list(state.ws_clients)

    stale_ws: list[WebSocket] = []
    for ws in ws_clients:
        try:
            await ws.send_text(serialized)
        except Exception:
            stale_ws.append(ws)

    if stale_ws:
        async with state.ws_lock:
            for ws in stale_ws:
                state.ws_clients.discard(ws)

    async with state.sse_lock:
        subscribers = list(state.sse_subscribers)

    for queue in subscribers:
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            queue.put_nowait(serialized)
        except asyncio.QueueFull:
            continue


async def broker_consumer_loop() -> None:
    if state.session is None:
        raise RuntimeError("HTTP session is not initialized.")

    while not state.stop_event.is_set():
        try:
            async with state.session.ws_connect(BROKER_URL, heartbeat=30) as ws:
                logger.info("Connected to broker stream at %s", BROKER_URL)
                async for msg in ws:
                    if state.stop_event.is_set():
                        return

                    if msg.type != aiohttp.WSMsgType.TEXT:
                        if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                        continue

                    try:
                        payload = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue

                    sensor_id = payload.get("sensor_id")
                    value = payload.get("value")
                    if not isinstance(sensor_id, str) or not isinstance(value, (int, float)):
                        continue

                    state.last_broker_message_at = utc_now()
                    detected_event = analyze_measurement(
                        sensor_id=sensor_id,
                        timestamp=payload.get("timestamp"),
                        value=float(value),
                    )
                    if detected_event is None:
                        continue

                    if await should_persist_on_this_replica():
                        inserted, canonical_event_id = await persist_event(detected_event)
                    else:
                        inserted, canonical_event_id = False, detected_event["event_id"]
                        state.events_skipped_non_writer += 1

                    if canonical_event_id != detected_event["event_id"]:
                        detected_event["event_id"] = canonical_event_id
                    if inserted:
                        state.events_persisted += 1
                    else:
                        state.events_duplicates += 1

                    out_event = {**detected_event, "persisted": inserted}
                    print(f"[REPLICA_OUT] {json.dumps(out_event, ensure_ascii=False)}", flush=True)
                    # Stream only canonical persisted events to avoid duplicate/triplet
                    # notifications on the dashboard while replicas process in parallel.
                    if inserted:
                        await broadcast_realtime_event(out_event)

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Broker stream unavailable (%s). Reconnecting in %.1fs.",
                exc,
                BROKER_RECONNECT_SECONDS,
            )
            await asyncio.sleep(BROKER_RECONNECT_SECONDS)


async def handle_control_event(event_type: str | None, data_lines: list[str]) -> None:
    if not data_lines:
        return

    raw_payload = "\n".join(data_lines).strip()
    if not raw_payload:
        return

    parsed_payload: Any = raw_payload
    try:
        parsed_payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        pass

    command: str | None = None
    if isinstance(parsed_payload, dict):
        maybe_command = parsed_payload.get("command")
        if isinstance(maybe_command, str):
            command = maybe_command.strip().upper()
    elif isinstance(parsed_payload, str):
        command = parsed_payload.strip().upper()

    if event_type == "command" and command is None:
        command = raw_payload.strip().upper()

    if command == "SHUTDOWN":
        if state.shutdown_in_progress:
            return
        state.shutdown_in_progress = True
        state.control_commands_seen += 1
        logger.error("SHUTDOWN command received. Terminating replica %s.", REPLICA_ID)

        # Hard-exit immediately to avoid hanging in half-shutdown state
        # (process alive but HTTP listener closed), which causes health flapping.
        os._exit(1)


async def control_stream_loop() -> None:
    if state.session is None:
        raise RuntimeError("HTTP session is not initialized.")

    headers = {"Accept": "text/event-stream"}
    while not state.stop_event.is_set():
        try:
            async with state.session.get(SIMULATOR_CONTROL_URL, headers=headers) as response:
                response.raise_for_status()
                logger.info("Subscribed to control stream at %s", SIMULATOR_CONTROL_URL)

                event_type: str | None = None
                data_lines: list[str] = []
                async for chunk in response.content:
                    if state.stop_event.is_set():
                        return

                    line = chunk.decode("utf-8", errors="ignore").rstrip("\r\n")
                    if line == "":
                        await handle_control_event(event_type, data_lines)
                        event_type = None
                        data_lines = []
                        continue

                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        event_type = line.partition(":")[2].strip()
                        continue
                    if line.startswith("data:"):
                        data_lines.append(line.partition(":")[2].lstrip())

                if data_lines:
                    await handle_control_event(event_type, data_lines)

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Control stream unavailable (%s). Reconnecting in %.1fs.",
                exc,
                CONTROL_RECONNECT_SECONDS,
            )
            await asyncio.sleep(CONTROL_RECONNECT_SECONDS)


def serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    timestamp_value = row.get("timestamp")
    if isinstance(timestamp_value, datetime):
        if timestamp_value.tzinfo is None:
            timestamp_value = timestamp_value.replace(tzinfo=timezone.utc)
        event_timestamp = isoformat_utc(timestamp_value)
    else:
        event_timestamp = isoformat_utc(utc_now())

    sensor_id = row.get("sensor_id")
    sensor_metadata = (
        state.sensor_metadata.get(sensor_id, SensorMetadata(None, None, None, None))
        if isinstance(sensor_id, str)
        else SensorMetadata(None, None, None, None)
    )

    return {
        "event_id": row.get("event_id"),
        "sensor_id": sensor_id,
        "sensor_name": sensor_metadata.name,
        "region": row.get("region"),
        "coordinates": {
            "lat": row.get("latitude"),
            "lon": row.get("longitude"),
        },
        "timestamp": event_timestamp,
        "dominant_frequency_hz": row.get("dominant_frequency_hz"),
        "classification": row.get("classification"),
        "detected_by": row.get("detected_by"),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    timeout = aiohttp.ClientTimeout(total=None, sock_read=None)
    state.session = aiohttp.ClientSession(timeout=timeout)
    state.db_pool = await create_db_pool_with_retry()

    try:
        await refresh_sensor_metadata()
    except Exception as exc:
        logger.warning("Initial sensor metadata fetch failed (%s). Continuing.", exc)

    state.background_tasks = [
        asyncio.create_task(broker_consumer_loop()),
        asyncio.create_task(control_stream_loop()),
        asyncio.create_task(metadata_refresh_loop()),
    ]

    try:
        yield
    finally:
        state.stop_event.set()
        for task in state.background_tasks:
            task.cancel()
        await asyncio.gather(*state.background_tasks, return_exceptions=True)

        if state.session is not None:
            await state.session.close()
        if state.db_pool is not None:
            state.db_pool.close()
            await state.db_pool.wait_closed()


app = FastAPI(title="processing-replica", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "replica_id": REPLICA_ID,
        "is_primary_replica": REPLICA_ID == PRIMARY_REPLICA_ID,
        "primary_replica_id": PRIMARY_REPLICA_ID,
        "primary_replica_health_url": PRIMARY_REPLICA_HEALTH_URL,
        "primary_replica_healthy_cache": (
            True if REPLICA_ID == PRIMARY_REPLICA_ID else state.primary_health_cached
        ),
        "db_writer_lock_name": DB_WRITER_LOCK_NAME,
        "broker_url": BROKER_URL,
        "simulator_control_url": SIMULATOR_CONTROL_URL,
        "sampling_rate_hz": SAMPLING_RATE_HZ,
        "window_size": WINDOW_SIZE,
        "hop_size": HOP_SIZE,
        "measurements_seen": state.measurements_seen,
        "events_persisted": state.events_persisted,
        "events_duplicates": state.events_duplicates,
        "events_skipped_non_writer": state.events_skipped_non_writer,
        "control_commands_seen": state.control_commands_seen,
        "shutdown_in_progress": state.shutdown_in_progress,
        "known_sensors": len(state.sensor_metadata),
        "connected_ws_clients": len(state.ws_clients),
        "connected_sse_clients": len(state.sse_subscribers),
        "last_broker_message_at": isoformat_utc(state.last_broker_message_at)
        if state.last_broker_message_at
        else None,
        "started_at": isoformat_utc(state.started_at),
    }


async def collect_replica_health(replica_id: str) -> dict[str, Any]:
    if replica_id == REPLICA_ID:
        return {
            "replica_id": replica_id,
            "reachable": True,
            "health": await health(),
        }

    if state.session is None:
        return {
            "replica_id": replica_id,
            "reachable": False,
            "error": "session_not_initialized",
        }

    replica_health_url = f"http://{replica_id}:8000/health"
    timeout = aiohttp.ClientTimeout(total=REPLICA_HEALTH_TIMEOUT_SECONDS)
    try:
        async with state.session.get(replica_health_url, timeout=timeout) as response:
            if response.status != 200:
                return {
                    "replica_id": replica_id,
                    "reachable": False,
                    "error": f"http_{response.status}",
                }
            payload = await response.json()
            if not isinstance(payload, dict):
                return {
                    "replica_id": replica_id,
                    "reachable": False,
                    "error": "invalid_health_payload",
                }
            return {
                "replica_id": replica_id,
                "reachable": True,
                "health": payload,
            }
    except Exception as exc:
        return {
            "replica_id": replica_id,
            "reachable": False,
            "error": str(exc),
        }


@app.get("/api/replicas/status")
async def replicas_status() -> dict[str, Any]:
    replica_ids = REPLICA_IDS or [REPLICA_ID]
    items = await asyncio.gather(*(collect_replica_health(replica_id) for replica_id in replica_ids))
    return {
        "queried_by": REPLICA_ID,
        "replica_ids": replica_ids,
        "items": items,
        "timestamp": isoformat_utc(utc_now()),
    }


@app.get("/api/events")
async def get_events(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    sensor_id: str | None = Query(default=None),
    classification: str | None = Query(default=None),
    region: str | None = Query(default=None),
) -> dict[str, Any]:
    if state.db_pool is None:
        return {"items": [], "limit": limit, "offset": offset, "count": 0}

    conditions: list[str] = []
    params: list[Any] = []

    if sensor_id:
        conditions.append("sensor_id = %s")
        params.append(sensor_id)
    if classification:
        conditions.append("classification = %s")
        params.append(classification)
    if region:
        conditions.append("region = %s")
        params.append(region)

    where_clause = ""
    if conditions:
        where_clause = " WHERE " + " AND ".join(conditions)

    query = (
        "SELECT event_id, sensor_id, region, latitude, longitude, timestamp, "
        "dominant_frequency_hz, classification, detected_by "
        "FROM seismic_events"
        f"{where_clause} "
        "ORDER BY timestamp DESC "
        "LIMIT %s OFFSET %s"
    )
    params.extend([limit, offset])

    async with state.db_pool.acquire() as conn:
        async with conn.cursor() as cursor:
            await cursor.execute(query, params)
            rows = await cursor.fetchall()

    items = [serialize_row(row) for row in rows]
    return {
        "items": items,
        "limit": limit,
        "offset": offset,
        "count": len(items),
    }


@app.get("/api/events/stream")
async def stream_events(request: Request) -> StreamingResponse:
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=200)
    async with state.sse_lock:
        state.sse_subscribers.add(queue)

    async def event_generator():
        open_payload = json.dumps(
            {"connectedAt": isoformat_utc(utc_now()), "replica_id": REPLICA_ID},
            separators=(",", ":"),
        )
        yield f"event: open\ndata: {open_payload}\n\n"

        try:
            while not state.stop_event.is_set():
                if await request.is_disconnected():
                    break

                try:
                    event_payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"event: event\ndata: {event_payload}\n\n"
                except asyncio.TimeoutError:
                    heartbeat = json.dumps(
                        {"timestamp": isoformat_utc(utc_now()), "replica_id": REPLICA_ID},
                        separators=(",", ":"),
                    )
                    yield f"event: heartbeat\ndata: {heartbeat}\n\n"
        finally:
            async with state.sse_lock:
                state.sse_subscribers.discard(queue)

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=headers)


@app.websocket("/api/events/ws")
async def websocket_events(websocket: WebSocket) -> None:
    await websocket.accept()
    async with state.ws_lock:
        state.ws_clients.add(websocket)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with state.ws_lock:
            state.ws_clients.discard(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=False)
