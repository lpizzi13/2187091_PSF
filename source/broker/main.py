from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp
from fastapi import FastAPI, WebSocket, WebSocketDisconnect


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger("broker")

SIMULATOR_URL = os.getenv("SIMULATOR_URL", "http://localhost:8080").rstrip("/")
RECONNECT_SECONDS = float(os.getenv("RECONNECT_SECONDS", "1.5"))
DISCOVERY_RETRY_SECONDS = float(os.getenv("DISCOVERY_RETRY_SECONDS", "3.0"))
DISCOVERY_REFRESH_SECONDS = float(os.getenv("DISCOVERY_REFRESH_SECONDS", "30.0"))


@dataclass(frozen=True)
class SensorSummary:
    id: str
    websocket_url: str


class ReplicaConnections:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._connections.add(ws)

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(ws)

    async def count(self) -> int:
        async with self._lock:
            return len(self._connections)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        message = json.dumps(payload, separators=(",", ":"))
        async with self._lock:
            recipients = list(self._connections)

        stale: list[WebSocket] = []
        for ws in recipients:
            try:
                await ws.send_text(message)
            except Exception:
                stale.append(ws)

        if stale:
            async with self._lock:
                for ws in stale:
                    self._connections.discard(ws)


class BrokerState:
    def __init__(self) -> None:
        self.replica_connections = ReplicaConnections()
        self.session: aiohttp.ClientSession | None = None
        self.sensor_tasks: dict[str, asyncio.Task[None]] = {}
        self.discovery_task: asyncio.Task[None] | None = None
        self.stop_event = asyncio.Event()


def build_ws_url(base_url: str, path: str) -> str:
    http_url = urljoin(f"{base_url}/", path.lstrip("/"))
    parsed = urlparse(http_url)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    return parsed._replace(scheme=ws_scheme).geturl()


async def discover_sensors(session: aiohttp.ClientSession) -> list[SensorSummary]:
    url = f"{SIMULATOR_URL}/api/devices/"
    async with session.get(url) as response:
        response.raise_for_status()
        payload = await response.json()

    sensors: list[SensorSummary] = []
    for item in payload:
        sensor_id = item.get("id")
        websocket_url = item.get("websocket_url")
        if isinstance(sensor_id, str) and isinstance(websocket_url, str):
            sensors.append(SensorSummary(id=sensor_id, websocket_url=websocket_url))
    return sensors


async def sensor_stream_loop(state: BrokerState, sensor: SensorSummary) -> None:
    assert state.session is not None
    ws_url = build_ws_url(SIMULATOR_URL, sensor.websocket_url)

    while not state.stop_event.is_set():
        try:
            async with state.session.ws_connect(ws_url, heartbeat=30) as ws:
                logger.info("Connected to sensor stream %s (%s)", sensor.id, ws_url)
                async for msg in ws:
                    if state.stop_event.is_set():
                        return

                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        if not isinstance(data, dict):
                            continue

                        measurement = {
                            "sensor_id": sensor.id,
                            "timestamp": data.get("timestamp"),
                            "value": data.get("value"),
                        }
                        await state.replica_connections.broadcast(measurement)
                    elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                        break

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Sensor stream %s disconnected (%s). Reconnecting in %.1fs.",
                sensor.id,
                exc,
                RECONNECT_SECONDS,
            )
            await asyncio.sleep(RECONNECT_SECONDS)


async def discovery_loop(state: BrokerState) -> None:
    assert state.session is not None

    while not state.stop_event.is_set():
        try:
            sensors = await discover_sensors(state.session)
            if not sensors:
                logger.warning("No sensors discovered from simulator.")
            for sensor in sensors:
                task = state.sensor_tasks.get(sensor.id)
                if task is None or task.done():
                    state.sensor_tasks[sensor.id] = asyncio.create_task(
                        sensor_stream_loop(state, sensor)
                    )
            await asyncio.sleep(DISCOVERY_REFRESH_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Sensor discovery failed (%s). Retrying in %.1fs.",
                exc,
                DISCOVERY_RETRY_SECONDS,
            )
            await asyncio.sleep(DISCOVERY_RETRY_SECONDS)


state = BrokerState()


@asynccontextmanager
async def lifespan(_: FastAPI):
    timeout = aiohttp.ClientTimeout(total=None, sock_read=None)
    state.session = aiohttp.ClientSession(timeout=timeout)
    state.discovery_task = asyncio.create_task(discovery_loop(state))
    try:
        yield
    finally:
        state.stop_event.set()
        if state.discovery_task:
            state.discovery_task.cancel()
        for task in state.sensor_tasks.values():
            task.cancel()
        tasks = [t for t in [state.discovery_task, *state.sensor_tasks.values()] if t]
        await asyncio.gather(*tasks, return_exceptions=True)
        if state.session:
            await state.session.close()


app = FastAPI(title="seismic-broker", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "simulator_url": SIMULATOR_URL,
        "active_sensor_streams": sum(1 for t in state.sensor_tasks.values() if not t.done()),
        "connected_replicas": await state.replica_connections.count(),
    }


@app.websocket("/data")
async def data_fanout(ws: WebSocket) -> None:
    await state.replica_connections.add(ws)
    logger.info("Replica connected to broker. Connected replicas: %s", await state.replica_connections.count())
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        await state.replica_connections.remove(ws)
        logger.info(
            "Replica disconnected from broker. Connected replicas: %s",
            await state.replica_connections.count(),
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
