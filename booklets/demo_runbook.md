# Demo Runbook

This runbook provides the same demo flow for:
- Linux/macOS (bash/zsh)
- Windows (PowerShell)

Assumption: run commands from project root `2187091_PSF`.

## 1. Start the stack

### Linux/macOS
```bash
docker compose -f ./source/docker-compose.yml up --build -d
```

### Windows (PowerShell)
```powershell
docker compose -f ".\source\docker-compose.yml" up --build -d
```

## 2. Check service health

### Linux/macOS
```bash
curl -s http://localhost:8080/health
curl -s http://localhost/gateway/health
curl -s http://localhost/health
```

### Windows (PowerShell)
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/health" -Method Get
Invoke-RestMethod -Uri "http://localhost/gateway/health" -Method Get
Invoke-RestMethod -Uri "http://localhost/health" -Method Get
```

## 3. Inject a seismic event

### Linux/macOS
```bash
curl -s -X POST "http://localhost:8080/api/admin/sensors/sensor-05/events" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"earthquake"}'
```

### Windows (PowerShell)
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/api/admin/sensors/sensor-05/events" -Method Post -Headers @{"Content-Type"="application/json"} -Body '{"event_type":"earthquake"}'
```

## 4. Verify archive

### Linux/macOS
```bash
curl -s "http://localhost/api/events?limit=10&sensor_id=sensor-05"
```

### Windows (PowerShell)
```powershell
Invoke-RestMethod -Uri "http://localhost/api/events?limit=10&sensor_id=sensor-05" -Method Get
```

## 5. Trigger fault tolerance scenario

### Linux/macOS
```bash
curl -s -X POST "http://localhost:8080/api/admin/shutdown"
```

### Windows (PowerShell)
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/api/admin/shutdown" -Method Post
```

## 6. Verify continuity after shutdown

### Linux/macOS
```bash
curl -s http://localhost/health
docker compose -f ./source/docker-compose.yml ps
```

### Windows (PowerShell)
```powershell
Invoke-RestMethod -Uri "http://localhost/health" -Method Get
docker compose -f ".\source\docker-compose.yml" ps
```

## 7. Optional database verification

### Linux/macOS
```bash
docker exec seismic-db mysql -uadmin -psecret -D seismic_db -e "SELECT COUNT(*) AS total_events FROM seismic_events;"
docker exec seismic-db mysql -uadmin -psecret -D seismic_db -e "SELECT COUNT(*) AS rows_count, COUNT(DISTINCT event_id) AS distinct_event_ids, COUNT(*)-COUNT(DISTINCT event_id) AS duplicate_rows FROM seismic_events;"
```

### Windows (PowerShell)
```powershell
docker exec seismic-db mysql -uadmin -psecret -D seismic_db -e "SELECT COUNT(*) AS total_events FROM seismic_events;"
docker exec seismic-db mysql -uadmin -psecret -D seismic_db -e "SELECT COUNT(*) AS rows_count, COUNT(DISTINCT event_id) AS distinct_event_ids, COUNT(*)-COUNT(DISTINCT event_id) AS duplicate_rows FROM seismic_events;"
```

## 8. Stop the stack

### Linux/macOS
```bash
docker compose -f ./source/docker-compose.yml down
```

### Windows (PowerShell)
```powershell
docker compose -f ".\source\docker-compose.yml" down
```
