const EXPECTED_REPLICAS = 3;
const REPLICA_STALE_MS = 18000;
const REPLICA_RECOVERY_MS = 12000;
const HEALTH_POLL_MS = 4000;
const ARCHIVE_POLL_MS = 12000;
let MAX_LIVE_EVENTS = 12;
let MAX_LOG_ROWS = 16;

// Imposta a true solo durante il posizionamento manuale dei sensori sulla mappa.
// Quando hai finito di piazzarli, metti false per mostrare i puntini solo su evento reale.
const SHOW_ALL_SENSORS_ON_MAP = true;

// Coordinate manuali in percentuale rispetto alla mappa world.avif.
const SENSOR_MARKERS = [
  { sensorId: "sensor-01", xPct: 43.23, yPct: 29.85 },
  { sensorId: "sensor-02", xPct: 45.48, yPct: 52.33 },
  { sensorId: "sensor-03", xPct: 58.96, yPct: 45.9 },
  { sensorId: "sensor-04", xPct: 54.91, yPct: 66.78 },
  { sensorId: "sensor-05", xPct: 53.29, yPct: 48.03 },
  { sensorId: "sensor-06", xPct: 48.74, yPct: 31.3 },
  { sensorId: "sensor-07", xPct: 34.48, yPct: 76.59 },
  { sensorId: "sensor-08", xPct: 49.06, yPct: 45.06 },
];

const SENSOR_MARKERS_STORAGE_KEY = "dashboard.sensorMarkers.override.v2";
const MAP_EDITOR_QUERY_PARAM = "editSensors";

const SENSOR_TOOLTIP_LABELS = {
  "sensor-01": "sensor-01",
  "sensor-02": "sensor-02",
  "sensor-03": "sensor-03",
  "sensor-04": "sensor-04",
  "sensor-05": "sensor-05",
  "sensor-06": "sensor-06",
  "sensor-07": "sensor-07",
  "sensor-08": "Datacenter Hub (08-12)",
};

const SENSOR_MAP_GROUP = {
  "sensor-08": "sensor-08",
  "sensor-09": "sensor-08",
  "sensor-10": "sensor-08",
  "sensor-11": "sensor-08",
  "sensor-12": "sensor-08",
};

const dom = {
  utcNow: document.getElementById("utcNow"),
  systemStatus: document.getElementById("systemStatus"),
  replicaStrip: document.getElementById("replicaStrip"),
  sensorCount: document.getElementById("sensorCount"),
  streamState: document.getElementById("streamState"),
  liveEventsBody: document.getElementById("liveEventsBody"),
  archiveBody: document.getElementById("archiveBody"),
  archiveSearch: document.getElementById("archiveSearch"),
  archiveClassification: document.getElementById("archiveClassification"),
  archiveReplica: document.getElementById("archiveReplica"),
  archiveReset: document.getElementById("archiveReset"),
  archiveSummary: document.getElementById("archiveSummary"),
  systemLogs: document.getElementById("systemLogs"),
  sensorBlips: document.getElementById("sensorBlips"),
  analysisTitle: document.getElementById("analysisTitle"),
  detailSensor: document.getElementById("detailSensor"),
  detailName: document.getElementById("detailName"),
  detailLocation: document.getElementById("detailLocation"),
  detailUtc: document.getElementById("detailUtc"),
  detailFreq: document.getElementById("detailFreq"),
  detailType: document.getElementById("detailType"),
  detailReplica: document.getElementById("detailReplica"),
  freqBadge: document.getElementById("freqBadge"),
  timeChart: document.getElementById("timeChart"),
  freqChart: document.getElementById("freqChart"),
};

const state = {
  stream: null,
  streamConnected: false,
  liveEvents: [],
  archiveEvents: [],
  logs: [],
  replicas: new Map(),
  slotByReplica: new Map(),
  sensorsFromEvents: new Set(),
  streamEventIds: new Set(),
  latestStreamEventBySensor: new Map(),
  markerOverrides: new Map(),
  mapEditMode: false,
  activeMarkerDrag: null,
  knownSensors: 0,
  selectedEventId: null,
  archiveFilters: {
    search: "",
    classification: "",
    replica: "",
  },
};

function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function shortId(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "-";
  }
  const compact = value.replace(/^evt-/, "");
  return `#${compact.slice(-6).toUpperCase()}`;
}

function toUtcTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toISOString().slice(11, 19);
}

function toUtcDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

function frequencyText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return `${number.toFixed(2)} Hz`;
}

function classificationLabel(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "UNKNOWN";
  }
  return value.replace(/_/g, "-").toUpperCase();
}

function classificationCss(value) {
  if (typeof value !== "string") {
    return "";
  }
  return `class-${value.toLowerCase()}`;
}

function archiveFilterActive() {
  return Boolean(
    state.archiveFilters.search ||
    state.archiveFilters.classification ||
    state.archiveFilters.replica
  );
}

function severityFromClassification(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (normalized === "nuclear_like" || normalized === "atomic_like" || normalized === "atomic-like") {
    return "fail";
  }
  if (normalized === "conventional_explosion" || normalized === "bomba" || normalized === "bomb") {
    return "warn";
  }
  if (normalized === "earthquake") {
    return "ok";
  }
  return "ok";
}

function firstDefined(values, fallback) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return fallback;
}

function setText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function applyDensityProfile() {
  const h = window.innerHeight || 1080;
  const w = window.innerWidth || 1920;

  if (h < 680 || w < 980) {
    MAX_LIVE_EVENTS = 6;
    MAX_LOG_ROWS = 8;
  } else if (h < 820 || w < 1200) {
    MAX_LIVE_EVENTS = 8;
    MAX_LOG_ROWS = 11;
  } else if (h < 980) {
    MAX_LIVE_EVENTS = 10;
    MAX_LOG_ROWS = 14;
  } else {
    MAX_LIVE_EVENTS = 12;
    MAX_LOG_ROWS = 18;
  }

  state.liveEvents = state.liveEvents.slice(0, MAX_LIVE_EVENTS);
  state.archiveEvents = state.archiveEvents.slice(0, 80);
  state.logs = state.logs.slice(0, MAX_LOG_ROWS);
}

function pushLog(message, level = "ok") {
  const entry = {
    timestamp: nowIso(),
    message,
    level,
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, MAX_LOG_ROWS);
  renderLogs();
}

function assignReplicaSlot(replicaId) {
  if (!replicaId) {
    return null;
  }
  if (state.slotByReplica.has(replicaId)) {
    return state.slotByReplica.get(replicaId);
  }

  const used = new Set(state.slotByReplica.values());
  let slot = 1;
  while (used.has(slot)) {
    slot += 1;
  }
  state.slotByReplica.set(replicaId, slot);
  return slot;
}

function replicaLabel(replicaId) {
  if (!replicaId) {
    return "-";
  }
  const slot = assignReplicaSlot(replicaId);
  if (!slot) {
    return replicaId.slice(0, 8);
  }
  return `R${slot}`;
}

function isLivenessSource(source) {
  return source === "health" || source === "stream-open" || source === "stream-heartbeat" || source === "event-live";
}

function effectiveReplicaState(replica) {
  if (!replica) {
    return "unknown";
  }
  if (replica.status === "fail") {
    return "fail";
  }
  if (replica.recoveringUntil && Date.now() < replica.recoveringUntil) {
    return "recovering";
  }
  if (replica.status === "ok") {
    return "ok";
  }
  return "unknown";
}

function registerReplica(replicaId, source) {
  if (typeof replicaId !== "string" || replicaId.length === 0) {
    return;
  }

  const liveSource = isLivenessSource(source);
  const now = Date.now();
  const slot = assignReplicaSlot(replicaId);
  const existing = state.replicas.get(replicaId);

  if (!existing) {
    state.replicas.set(replicaId, {
      id: replicaId,
      slot,
      status: liveSource ? "ok" : "unknown",
      lastSeen: liveSource ? now : 0,
      restarts: 0,
      startedAt: null,
      controlCommandsSeen: 0,
      recoveringUntil: 0,
    });
    if (liveSource) {
      pushLog(`SUBSCRIPTION ACTIVE (${replicaLabel(replicaId)})`, "ok");
    }
    return;
  }

  if (!liveSource) {
    return;
  }

  const wasFail = existing.status === "fail";
  const wasUnknown = existing.status === "unknown";
  existing.lastSeen = now;
  existing.status = "ok";
  if (wasFail) {
    existing.restarts += 1;
    pushLog(`${replicaLabel(replicaId)} ONLINE (Replica restored)`, "ok");
  } else if (wasUnknown) {
    pushLog(`SUBSCRIPTION ACTIVE (${replicaLabel(replicaId)})`, "ok");
  }
}

function registerReplicaFromHealth(payload) {
  if (!payload || typeof payload.replica_id !== "string") {
    return;
  }

  const replicaId = payload.replica_id;
  const controlCommandsSeen = Number(payload.control_commands_seen);
  const startedAt = typeof payload.started_at === "string" ? payload.started_at : null;

  const existing = state.replicas.get(replicaId);
  const previousCommands = existing && Number.isFinite(existing.controlCommandsSeen)
    ? existing.controlCommandsSeen
    : null;
  const previousStartedAt = existing && typeof existing.startedAt === "string"
    ? existing.startedAt
    : null;

  registerReplica(replicaId, "health");
  const updated = state.replicas.get(replicaId);
  if (!updated) {
    return;
  }

  if (Number.isFinite(controlCommandsSeen)) {
    if (previousCommands !== null && controlCommandsSeen > previousCommands) {
      pushLog(`SHUTDOWN CMD RECEIVED (${replicaLabel(replicaId)})`, "fail");
    }
    updated.controlCommandsSeen = controlCommandsSeen;
  }

  if (startedAt) {
    if (previousStartedAt && previousStartedAt !== startedAt) {
      updated.restarts += 1;
      pushLog(`${replicaLabel(replicaId)} RESTARTED (new process)`, "warn");
      updated.recoveringUntil = Date.now() + REPLICA_RECOVERY_MS;
      updated.status = "ok";
      updated.lastSeen = Date.now();
    }
    updated.startedAt = startedAt;
  }
}

function markStaleReplicas() {
  const now = Date.now();
  for (const replica of state.replicas.values()) {
    if (replica.status === "ok" && now - replica.lastSeen > REPLICA_STALE_MS) {
      replica.status = "fail";
      replica.recoveringUntil = 0;
      pushLog(`${replicaLabel(replica.id)} OFFLINE (No heartbeat)`, "fail");
    }
  }
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const eventId = raw.event_id || raw.eventId || raw.id;
  const sensorId = raw.sensor_id || raw.sensorId || "unknown";
  const sensorNameRaw = firstDefined([raw.sensor_name, raw.sensorName, raw.name], null);
  const sensorName = typeof sensorNameRaw === "string" && sensorNameRaw.trim() !== ""
    ? sensorNameRaw.trim()
    : null;
  const classification = (
    raw.classification ||
    raw.eventType ||
    "unknown"
  ).toString().toLowerCase();
  const dominantFrequency = Number(
    firstDefined(
      [raw.dominant_frequency_hz, raw.dominantFrequencyHz, raw.frequencyHz],
      NaN
    )
  );
  const timestamp = raw.timestamp || raw.startsAt || nowIso();
  const detectedBy = raw.detected_by || raw.detectedBy || raw.replica_id || null;
  const persistedRaw = firstDefined([raw.persisted, raw.isPersisted], true);
  let persisted = true;
  if (typeof persistedRaw === "boolean") {
    persisted = persistedRaw;
  } else if (typeof persistedRaw === "number") {
    persisted = persistedRaw !== 0;
  } else if (typeof persistedRaw === "string") {
    const normalizedPersisted = persistedRaw.trim().toLowerCase();
    persisted = !(normalizedPersisted === "false" || normalizedPersisted === "0");
  }
  const region = typeof raw.region === "string" ? raw.region : null;
  const coordinates = raw.coordinates && typeof raw.coordinates === "object"
    ? {
        lat: firstDefined([raw.coordinates.lat], null),
        lon: firstDefined([raw.coordinates.lon], null),
      }
    : { lat: null, lon: null };

  if (typeof eventId !== "string" || eventId.length === 0) {
    return null;
  }

  return {
    event_id: eventId,
    sensor_id: String(sensorId),
    sensor_name: sensorName,
    classification,
    dominant_frequency_hz: Number.isFinite(dominantFrequency) ? dominantFrequency : null,
    timestamp,
    detected_by: detectedBy ? String(detectedBy) : null,
    persisted,
    region,
    coordinates,
  };
}

function mergeLiveEvent(incoming, source = "event-live") {
  if (!incoming) {
    return;
  }

  if (incoming.sensor_id) {
    state.sensorsFromEvents.add(incoming.sensor_id);
    if (source === "event-live") {
      const markerSensorId = markerSensorIdForMap(incoming.sensor_id);
      state.streamEventIds.add(incoming.event_id);
      state.latestStreamEventBySensor.set(markerSensorId, incoming);
    }
  }
  if (incoming.detected_by) {
    registerReplica(incoming.detected_by, source);
  }

  const existing = state.liveEvents.find((item) => item.event_id === incoming.event_id);
  if (existing) {
    if (incoming.detected_by) {
      existing.replicas.add(incoming.detected_by);
    }
    if (new Date(incoming.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
      existing.timestamp = incoming.timestamp;
      existing.sensor_id = incoming.sensor_id;
      existing.sensor_name = incoming.sensor_name;
      existing.classification = incoming.classification;
      existing.dominant_frequency_hz = incoming.dominant_frequency_hz;
      existing.region = incoming.region;
      existing.coordinates = incoming.coordinates;
    }
  } else {
    const item = {
      ...incoming,
      replicas: new Set(incoming.detected_by ? [incoming.detected_by] : []),
    };
    state.liveEvents.unshift(item);
  }

  state.liveEvents.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  state.liveEvents = state.liveEvents.slice(0, MAX_LIVE_EVENTS);

  const liveIds = new Set(state.liveEvents.map((item) => item.event_id));
  for (const eventId of state.streamEventIds) {
    if (!liveIds.has(eventId)) {
      state.streamEventIds.delete(eventId);
    }
  }
  for (const [sensorId, event] of state.latestStreamEventBySensor.entries()) {
    if (!event || !liveIds.has(event.event_id)) {
      state.latestStreamEventBySensor.delete(sensorId);
    }
  }

  if (!state.selectedEventId) {
    state.selectedEventId = incoming.event_id;
  }
}

function updateArchiveEvents(events) {
  state.archiveEvents = events.map(normalizeEvent).filter(Boolean);
  state.archiveEvents.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  for (const event of state.archiveEvents) {
    if (event.detected_by) {
      registerReplica(event.detected_by, "archive");
    }
    if (event.sensor_id) {
      state.sensorsFromEvents.add(event.sensor_id);
    }
  }

  if (!state.selectedEventId && state.archiveEvents.length > 0) {
    state.selectedEventId = state.archiveEvents[0].event_id;
  }

  refreshArchiveFilterOptions();
}

async function loadArchiveEvents() {
  try {
    const response = await fetch("/api/events?limit=80", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`archive fetch failed (${response.status})`);
    }
    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    updateArchiveEvents(items);

    if (state.liveEvents.length === 0) {
      for (const event of state.archiveEvents.slice(0, 10)) {
        mergeLiveEvent(event, "event-history");
      }
    }
    renderAll();
  } catch (error) {
    pushLog(`ARCHIVE UNAVAILABLE (${error.message})`, "warn");
  }
}

async function pollHealth() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`health status ${response.status}`);
    }

    const payload = await response.json();
    registerReplicaFromHealth(payload);
    if (payload && Number.isFinite(payload.known_sensors)) {
      state.knownSensors = payload.known_sensors;
    }
    markStaleReplicas();
    renderStatus();
  } catch (error) {
    markStaleReplicas();
    renderStatus();
    pushLog(`HEALTH CHECK FAILED (${error.message})`, "warn");
  }
}

function connectEventStream() {
  if (state.stream) {
    state.stream.close();
  }

  const stream = new EventSource("/api/events/stream");
  state.stream = stream;

  stream.onopen = () => {
    state.streamConnected = true;
    dom.streamState.textContent = "STREAM: LIVE";
    dom.streamState.className = "stream-state ok";
    pushLog("EVENT STREAM CONNECTED", "ok");
  };

  stream.addEventListener("open", (event) => {
    const payload = safeJson(event.data);
    if (payload && typeof payload.replica_id === "string") {
      registerReplica(payload.replica_id, "stream-open");
      renderStatus();
    }
  });

  stream.addEventListener("heartbeat", (event) => {
    const payload = safeJson(event.data);
    if (payload && typeof payload.replica_id === "string") {
      registerReplica(payload.replica_id, "stream-heartbeat");
      renderStatus();
    }
  });

  stream.addEventListener("event", (event) => {
    const payload = safeJson(event.data);
    const normalized = normalizeEvent(payload);
    if (!normalized) {
      return;
    }
    if (normalized.persisted === false) {
      return;
    }

    mergeLiveEvent(normalized);
    if (state.archiveEvents.every((row) => row.event_id !== normalized.event_id)) {
      state.archiveEvents.unshift(normalized);
      state.archiveEvents = state.archiveEvents.slice(0, 80);
      refreshArchiveFilterOptions();
    }

    pushLog(
      `EVENT ${shortId(normalized.event_id)} ${classificationLabel(normalized.classification)} (${normalized.sensor_id})`,
      severityFromClassification(normalized.classification)
    );
    renderAll();
  });

  stream.onerror = () => {
    if (state.streamConnected) {
      pushLog("EVENT STREAM LOST, RETRYING", "warn");
    }
    state.streamConnected = false;
    dom.streamState.textContent = "STREAM: RECONNECTING";
    dom.streamState.className = "stream-state warn";
    stream.close();
    setTimeout(connectEventStream, 2500);
  };
}

function getSelectedEvent() {
  if (!state.selectedEventId) {
    return null;
  }
  return (
    state.liveEvents.find((event) => event.event_id === state.selectedEventId) ||
    state.archiveEvents.find((event) => event.event_id === state.selectedEventId) ||
    null
  );
}

function statusFromReplicaState() {
  const entries = [...state.replicas.values()];
  if (entries.length === 0) {
    return { label: "DEGRADED", css: "warn" };
  }

  const healthy = entries.filter((item) => effectiveReplicaState(item) === "ok").length;
  const failed = entries.filter((item) => effectiveReplicaState(item) === "fail").length;
  const recovering = entries.filter((item) => effectiveReplicaState(item) === "recovering").length;
  const unknown = entries.filter((item) => effectiveReplicaState(item) === "unknown").length;

  if (healthy === 0 && recovering === 0 && failed > 0 && unknown === 0) {
    return { label: "FAIL", css: "fail" };
  }
  if (failed > 0 || recovering > 0 || unknown > 0) {
    return { label: "DEGRADED", css: "warn" };
  }
  if (healthy < EXPECTED_REPLICAS) {
    return { label: "DEGRADED", css: "warn" };
  }
  return { label: "OPERATIONAL", css: "ok" };
}

function renderStatus() {
  const status = statusFromReplicaState();
  dom.systemStatus.textContent = status.label;
  dom.systemStatus.className = `v ${status.css}`;

  const slotsCount = Math.max(
    EXPECTED_REPLICAS,
    ...[...state.slotByReplica.values(), EXPECTED_REPLICAS]
  );
  const bySlot = new Map();
  for (const replica of state.replicas.values()) {
    bySlot.set(replica.slot, replica);
  }

  const parts = [];
  for (let slot = 1; slot <= slotsCount; slot += 1) {
    const replica = bySlot.get(slot);
    let label = `P${slot}: N/A`;
    let css = "warn";
    if (replica) {
      const effective = effectiveReplicaState(replica);
      if (effective === "ok") {
        label = `P${slot}: OK`;
        css = "ok";
      } else if (effective === "fail") {
        label = `P${slot}: FAIL`;
        css = "fail";
      } else if (effective === "recovering") {
        label = `P${slot}: REC`;
        css = "warn";
      } else {
        label = `P${slot}: N/A`;
        css = "warn";
      }
    }
    parts.push(`<span class="replica-pill ${css}">${label}</span>`);
  }
  dom.replicaStrip.className = "replica-strip";
  dom.replicaStrip.innerHTML = parts.join("");

  const sensorCount = state.knownSensors || state.sensorsFromEvents.size || 0;
  dom.sensorCount.textContent = `${sensorCount} ACTIVE`;
}

function renderLiveTable() {
  const rows = state.liveEvents
    .map((event) => {
      const replicas = event.replicas
        ? [...event.replicas].map((id) => replicaLabel(id)).join(", ")
        : event.detected_by
          ? replicaLabel(event.detected_by)
          : "-";
      const selectedClass = event.event_id === state.selectedEventId ? "selected" : "";
      return `
        <tr data-event-id="${event.event_id}" class="${selectedClass}">
          <td>${shortId(event.event_id)}</td>
          <td>${toUtcTime(event.timestamp)}</td>
          <td>${event.sensor_id}</td>
          <td class="${classificationCss(event.classification)}">${classificationLabel(event.classification)}</td>
          <td>${frequencyText(event.dominant_frequency_hz)}</td>
          <td>${replicas || "-"}</td>
        </tr>
      `;
    })
    .join("");

  dom.liveEventsBody.innerHTML = rows || `
    <tr>
      <td colspan="6">No live events yet. Waiting for stream...</td>
    </tr>
  `;

  for (const row of dom.liveEventsBody.querySelectorAll("tr[data-event-id]")) {
    row.addEventListener("click", () => {
      state.selectedEventId = row.dataset.eventId;
      renderAll();
    });
  }
}

function syncArchiveSelectOptions(select, options, emptyLabel, selectedValue) {
  const signature = options.map((option) => `${option.value}:${option.label}`).join("|");
  const nextValue = options.some((option) => option.value === selectedValue) ? selectedValue : "";

  if (select.dataset.signature !== signature) {
    const fragment = document.createDocumentFragment();

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = emptyLabel;
    fragment.append(emptyOption);

    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      fragment.append(element);
    }

    select.replaceChildren(fragment);
    select.dataset.signature = signature;
  }

  if (select.value !== nextValue) {
    select.value = nextValue;
  }

  return nextValue;
}

function refreshArchiveFilterOptions() {
  const classificationOptions = [...new Set(state.archiveEvents.map((event) => event.classification))]
    .filter(Boolean)
    .sort()
    .map((value) => ({ value, label: classificationLabel(value) }));

  const replicaOptions = [...new Set(
    state.archiveEvents
      .map((event) => event.detected_by)
      .filter((value) => typeof value === "string" && value.length > 0)
  )]
    .map((value) => ({ value, label: replicaLabel(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  state.archiveFilters.classification = syncArchiveSelectOptions(
    dom.archiveClassification,
    classificationOptions,
    "ALL TYPES",
    state.archiveFilters.classification
  );

  state.archiveFilters.replica = syncArchiveSelectOptions(
    dom.archiveReplica,
    replicaOptions,
    "ALL REPLICAS",
    state.archiveFilters.replica
  );
}

function archiveSearchHaystack(event) {
  return [
    event.event_id,
    shortId(event.event_id),
    event.sensor_id,
    event.region,
    classificationLabel(event.classification),
    event.detected_by,
    event.detected_by ? replicaLabel(event.detected_by) : null,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function getFilteredArchiveEvents() {
  const query = state.archiveFilters.search.trim().toLowerCase();

  return state.archiveEvents.filter((event) => {
    if (
      state.archiveFilters.classification &&
      event.classification !== state.archiveFilters.classification
    ) {
      return false;
    }

    if (state.archiveFilters.replica && event.detected_by !== state.archiveFilters.replica) {
      return false;
    }

    if (query && !archiveSearchHaystack(event).includes(query)) {
      return false;
    }

    return true;
  });
}

function renderArchiveTable() {
  const filteredEvents = getFilteredArchiveEvents();
  const rows = filteredEvents
    .map((event) => `
      <tr data-event-id="${event.event_id}" class="${event.event_id === state.selectedEventId ? "selected" : ""}">
        <td>${toUtcTime(event.timestamp)}</td>
        <td>${shortId(event.event_id)}</td>
        <td class="${classificationCss(event.classification)}">${classificationLabel(event.classification)}</td>
        <td>${event.detected_by ? `${replicaLabel(event.detected_by)} PERSISTED` : "PERSISTED"}</td>
      </tr>
    `)
    .join("");

  if (archiveFilterActive()) {
    dom.archiveSummary.textContent = `MATCH ${filteredEvents.length}/${state.archiveEvents.length}`;
  } else {
    dom.archiveSummary.textContent = `ROWS ${filteredEvents.length}/${state.archiveEvents.length}`;
  }

  dom.archiveBody.innerHTML = rows || `
    <tr>
      <td colspan="4">${archiveFilterActive() ? "No archived events match the current filters." : "No historical events stored yet."}</td>
    </tr>
  `;

  for (const row of dom.archiveBody.querySelectorAll("tr[data-event-id]")) {
    row.addEventListener("click", () => {
      state.selectedEventId = row.dataset.eventId;
      renderAll();
    });
  }
}

function renderLogs() {
  dom.systemLogs.innerHTML = state.logs
    .map((entry) => `
      <li class="log-item ${entry.level}">
        ${toUtcTime(entry.timestamp)} - ${entry.message}
      </li>
    `)
    .join("");
}

function deterministicSeed(value) {
  let hash = 0;
  const text = String(value || "seed");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function clampPct(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(99.8, Math.max(0.2, parsed));
}

function mapDotClass(event) {
  if (!event) {
    return "idle";
  }
  return severityFromClassification(event.classification);
}

function markerSensorIdForMap(sensorId) {
  if (typeof sensorId !== "string" || sensorId.length === 0) {
    return sensorId;
  }
  return SENSOR_MAP_GROUP[sensorId] || sensorId;
}

function markerTooltipLabel(sensorId) {
  if (typeof sensorId !== "string" || sensorId.length === 0) {
    return "Unknown sensor";
  }
  return SENSOR_TOOLTIP_LABELS[sensorId] || sensorId;
}

function loadMarkerOverrides() {
  try {
    const raw = window.localStorage.getItem(SENSOR_MARKERS_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Map();
    }

    const overrides = new Map();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || typeof entry.sensorId !== "string") {
        continue;
      }
      overrides.set(entry.sensorId, {
        sensorId: entry.sensorId,
        xPct: clampPct(entry.xPct),
        yPct: clampPct(entry.yPct),
      });
    }
    return overrides;
  } catch {
    return new Map();
  }
}

function persistMarkerOverrides() {
  try {
    const payload = [...state.markerOverrides.values()].map((entry) => ({
      sensorId: entry.sensorId,
      xPct: Number(clampPct(entry.xPct).toFixed(2)),
      yPct: Number(clampPct(entry.yPct).toFixed(2)),
    }));
    window.localStorage.setItem(SENSOR_MARKERS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures (private mode or blocked storage).
  }
}

function getMergedSensorMarkers() {
  const merged = new Map();

  for (const marker of SENSOR_MARKERS) {
    if (!marker || typeof marker.sensorId !== "string") {
      continue;
    }
    merged.set(marker.sensorId, {
      sensorId: marker.sensorId,
      xPct: clampPct(marker.xPct),
      yPct: clampPct(marker.yPct),
    });
  }

  for (const [sensorId, override] of state.markerOverrides.entries()) {
    if (!merged.has(sensorId)) {
      continue;
    }
    merged.set(sensorId, {
      sensorId,
      xPct: clampPct(override.xPct),
      yPct: clampPct(override.yPct),
    });
  }

  return [...merged.values()];
}

function setMarkerPosition(sensorId, xPct, yPct, options = {}) {
  if (typeof sensorId !== "string" || sensorId.length === 0) {
    return;
  }
  const persist = options.persist !== false;
  state.markerOverrides.set(sensorId, {
    sensorId,
    xPct: clampPct(xPct),
    yPct: clampPct(yPct),
  });
  if (persist) {
    persistMarkerOverrides();
  }
}

function exportCurrentMarkers() {
  const markers = getMergedSensorMarkers().map((entry) => ({
    sensorId: entry.sensorId,
    xPct: Number(entry.xPct.toFixed(2)),
    yPct: Number(entry.yPct.toFixed(2)),
  }));
  console.log(JSON.stringify(markers, null, 2));
  return markers;
}

function resetMarkerOverrides() {
  state.markerOverrides.clear();
  try {
    window.localStorage.removeItem(SENSOR_MARKERS_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
  renderSensorMap();
  pushLog("MAP MARKERS RESET TO CODE DEFAULTS", "warn");
}

function updateDraggedMarkerFromPointer(event) {
  if (!state.activeMarkerDrag || !dom.sensorBlips) {
    return;
  }

  const bounds = dom.sensorBlips.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return;
  }

  const xPct = ((event.clientX - bounds.left) / bounds.width) * 100;
  const yPct = ((event.clientY - bounds.top) / bounds.height) * 100;
  const x = clampPct(xPct);
  const y = clampPct(yPct);

  setMarkerPosition(state.activeMarkerDrag.sensorId, x, y, { persist: false });

  if (state.activeMarkerDrag.element) {
    state.activeMarkerDrag.element.style.left = `${x.toFixed(2)}%`;
    state.activeMarkerDrag.element.style.top = `${y.toFixed(2)}%`;
    state.activeMarkerDrag.element.title = `${markerTooltipLabel(state.activeMarkerDrag.sensorId)} (${x.toFixed(2)}%, ${y.toFixed(2)}%)`;
  }
}

function onSensorMapPointerDown(event) {
  if (!state.mapEditMode) {
    return;
  }
  const target = event.target instanceof Element
    ? event.target.closest(".sensor-dot[data-sensor-id]")
    : null;
  if (!target) {
    return;
  }

  const sensorId = target.dataset.sensorId;
  if (!sensorId) {
    return;
  }

  state.activeMarkerDrag = {
    sensorId,
    pointerId: event.pointerId,
    element: target,
  };
  target.classList.add("dragging");
  if (typeof target.setPointerCapture === "function") {
    target.setPointerCapture(event.pointerId);
  }
  updateDraggedMarkerFromPointer(event);
  event.preventDefault();
}

function onSensorMapPointerMove(event) {
  if (!state.activeMarkerDrag) {
    return;
  }
  if (event.pointerId !== state.activeMarkerDrag.pointerId) {
    return;
  }
  updateDraggedMarkerFromPointer(event);
}

function onSensorMapPointerEnd(event) {
  if (!state.activeMarkerDrag) {
    return;
  }
  if (event.pointerId !== state.activeMarkerDrag.pointerId) {
    return;
  }

  const active = state.activeMarkerDrag;
  if (active.element) {
    active.element.classList.remove("dragging");
    if (
      typeof active.element.releasePointerCapture === "function" &&
      active.element.hasPointerCapture(event.pointerId)
    ) {
      active.element.releasePointerCapture(event.pointerId);
    }
  }
  state.activeMarkerDrag = null;
  persistMarkerOverrides();
  renderSensorMap();
}

function initMapEditor() {
  if (!dom.sensorBlips) {
    return;
  }
  dom.sensorBlips.addEventListener("pointerdown", onSensorMapPointerDown);
  dom.sensorBlips.addEventListener("pointermove", onSensorMapPointerMove);
  window.addEventListener("pointerup", onSensorMapPointerEnd);
  window.addEventListener("pointercancel", onSensorMapPointerEnd);
}

function registerMapEditorApi() {
  window.sensorMapEditor = {
    enableEditMode() {
      state.mapEditMode = true;
      renderSensorMap();
      pushLog("MAP EDIT MODE ENABLED", "warn");
    },
    disableEditMode() {
      state.mapEditMode = false;
      renderSensorMap();
      pushLog("MAP EDIT MODE DISABLED", "ok");
    },
    exportMarkers: exportCurrentMarkers,
    resetMarkers: resetMarkerOverrides,
  };
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(180, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  return { context, width, height, ratio };
}

function drawGrid(context, width, height, verticalLines, horizontalLines) {
  context.strokeStyle = "rgba(132, 162, 132, 0.25)";
  context.lineWidth = 1;
  for (let i = 0; i <= verticalLines; i += 1) {
    const x = (width * i) / verticalLines;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let j = 0; j <= horizontalLines; j += 1) {
    const y = (height * j) / horizontalLines;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function drawTimeDomain(event) {
  const { context, width, height } = prepareCanvas(dom.timeChart);
  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, 10, 6);

  if (!event) {
    context.fillStyle = "rgba(214, 235, 215, 0.7)";
    context.font = "24px Share Tech Mono";
    context.fillText("Waiting for event selection...", 24, 38);
    return;
  }

  const freq = Number(event.dominant_frequency_hz) || 1.5;
  const seed = deterministicSeed(event.event_id);
  context.strokeStyle = "#b7f277";
  context.lineWidth = 2.2;
  context.beginPath();

  const samples = 320;
  for (let i = 0; i < samples; i += 1) {
    const x = (i / (samples - 1)) * width;
    const carrier = Math.sin((i / samples) * Math.PI * 2 * (freq * 2.1));
    const envelope = 0.64 + 0.35 * Math.sin((i + seed % 50) / 42);
    const noise = Math.sin((i + seed) * 0.37) * 0.06;
    const value = (carrier * envelope + noise) * 0.34;
    const y = height * 0.5 - value * height * 0.8;

    if (i === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
}

function drawFrequencyDomain(event) {
  const { context, width, height } = prepareCanvas(dom.freqChart);
  context.clearRect(0, 0, width, height);

  const zoneA = width * (2.5 / 30);
  const zoneB = width * (8.0 / 30);
  context.fillStyle = "rgba(141, 227, 117, 0.12)";
  context.fillRect(0, 0, zoneA, height);
  context.fillStyle = "rgba(238, 211, 108, 0.13)";
  context.fillRect(zoneA, 0, zoneB - zoneA, height);
  context.fillStyle = "rgba(255, 108, 108, 0.12)";
  context.fillRect(zoneB, 0, width - zoneB, height);

  drawGrid(context, width, height, 8, 5);

  if (!event) {
    context.fillStyle = "rgba(214, 235, 215, 0.7)";
    context.font = "24px Share Tech Mono";
    context.fillText("No spectrum available", 24, 38);
    dom.freqBadge.textContent = "DOMINANT FREQUENCY: --";
    return;
  }

  const freq = Number(event.dominant_frequency_hz) || 1.0;
  const sigma = Math.max(0.9, Math.min(2.7, freq / 3));

  context.strokeStyle = "#9df85f";
  context.lineWidth = 3;
  context.beginPath();
  const points = 90;
  for (let i = 0; i < points; i += 1) {
    const hz = 0.5 + (i / (points - 1)) * 29.5;
    const x = (i / (points - 1)) * width;
    const peak = Math.exp(-((hz - freq) ** 2) / (2 * sigma ** 2));
    const harmonics = Math.exp(-((hz - freq * 1.85) ** 2) / (2 * (sigma * 1.35) ** 2)) * 0.22;
    const baseline = 0.035 + 0.02 * Math.sin(i * 0.42);
    const amplitude = Math.min(1, baseline + peak * 0.92 + harmonics);
    const y = height - amplitude * (height * 0.9) - 8;
    if (i === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();

  dom.freqBadge.textContent = `DOMINANT FREQUENCY: ${freq.toFixed(2)} Hz`;
}

function renderAnalysis() {
  const event = getSelectedEvent();
  if (!event) {
    setText(dom.analysisTitle, "NO EVENT SELECTED");
    setText(dom.detailSensor, "-");
    setText(dom.detailName, "-");
    setText(dom.detailLocation, "-");
    setText(dom.detailUtc, "-");
    setText(dom.detailFreq, "-");
    setText(dom.detailType, "-");
    setText(dom.detailReplica, "-");
    drawTimeDomain(null);
    drawFrequencyDomain(null);
    return;
  }

  setText(dom.analysisTitle, `ID ${shortId(event.event_id)}`);
  setText(dom.detailSensor, event.sensor_id);
  setText(dom.detailName, event.sensor_name || "-");
  setText(
    dom.detailLocation,
    event.region ||
    (event.coordinates && (event.coordinates.lat || event.coordinates.lon)
      ? `${firstDefined([event.coordinates.lat], "-")}, ${firstDefined([event.coordinates.lon], "-")}`
      : "Unknown");
  dom.detailUtc.textContent = toUtcTime(event.timestamp);
  dom.detailFreq.textContent = frequencyText(event.dominant_frequency_hz);
  dom.detailType.textContent = classificationLabel(event.classification);
  dom.detailType.className = classificationCss(event.classification);
  setText(dom.detailReplica, event.detected_by ? replicaLabel(event.detected_by) : "-");

  drawTimeDomain(event);
  drawFrequencyDomain(event);
}

function renderSensorMap() {
  if (!dom.sensorBlips) {
    return;
  }

  const points = getMergedSensorMarkers()
    .filter(
      (marker) =>
        SHOW_ALL_SENSORS_ON_MAP ||
        state.mapEditMode ||
        state.latestStreamEventBySensor.has(marker.sensorId)
    )
    .map((marker) => {
      const event = state.latestStreamEventBySensor.get(marker.sensorId) || null;
      const dotClass = mapDotClass(event);
      const x = clampPct(marker.xPct);
      const y = clampPct(marker.yPct);
      const seed = deterministicSeed(marker.sensorId);
      const baseLabel = markerTooltipLabel(marker.sensorId);
      const editHint = state.mapEditMode ? ` (${x.toFixed(2)}%, ${y.toFixed(2)}%)` : "";
      const title = `${baseLabel}${editHint}`;
      const editClass = state.mapEditMode ? " editable" : "";

      return `
        <span class="sensor-dot ${dotClass}${editClass}" data-sensor-id="${marker.sensorId}" title="${title}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;animation-delay:${(seed % 12) / 10}s"></span>
      `;
    });

  dom.sensorBlips.innerHTML = points.join("");
}

function renderClock() {
  dom.utcNow.textContent = `UTC: ${new Date().toISOString().slice(11, 19)}`;
}

function renderAll() {
  renderStatus();
  renderLiveTable();
  renderArchiveTable();
  renderSensorMap();
  renderAnalysis();
}

function initResizeHandler() {
  let timeout = null;
  window.addEventListener("resize", () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      applyDensityProfile();
      renderAll();
    }, 140);
  });
}

function initArchiveFilters() {
  dom.archiveSearch.addEventListener("input", (event) => {
    state.archiveFilters.search = event.target.value;
    renderArchiveTable();
  });

  dom.archiveClassification.addEventListener("change", (event) => {
    state.archiveFilters.classification = event.target.value;
    renderArchiveTable();
  });

  dom.archiveReplica.addEventListener("change", (event) => {
    state.archiveFilters.replica = event.target.value;
    renderArchiveTable();
  });

  dom.archiveReset.addEventListener("click", () => {
    state.archiveFilters.search = "";
    state.archiveFilters.classification = "";
    state.archiveFilters.replica = "";
    dom.archiveSearch.value = "";
    dom.archiveClassification.value = "";
    dom.archiveReplica.value = "";
    renderArchiveTable();
  });
}

async function boot() {
  state.markerOverrides = loadMarkerOverrides();
  state.mapEditMode = new URLSearchParams(window.location.search).get(MAP_EDITOR_QUERY_PARAM) === "1";
  registerMapEditorApi();

  applyDensityProfile();
  renderClock();
  setInterval(renderClock, 1000);
  initResizeHandler();
  initArchiveFilters();
  refreshArchiveFilterOptions();
  initMapEditor();

  pushLog("DASHBOARD INITIALIZED", "ok");
  if (state.mapEditMode) {
    pushLog("MAP EDIT MODE ACTIVE (?editSensors=1)", "warn");
  }
  await loadArchiveEvents();
  connectEventStream();
  await pollHealth();

  setInterval(pollHealth, HEALTH_POLL_MS);
  setInterval(loadArchiveEvents, ARCHIVE_POLL_MS);
  setInterval(() => {
    markStaleReplicas();
    renderStatus();
  }, 2500);
}

boot();
