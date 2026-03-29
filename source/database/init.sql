CREATE DATABASE IF NOT EXISTS seismic_db;
USE seismic_db;

CREATE TABLE IF NOT EXISTS seismic_events (
    event_id VARCHAR(255) PRIMARY KEY, -- Hash deterministico (sensor_id + classification + time-bucket)
    sensor_id VARCHAR(50) NOT NULL,
    region VARCHAR(100),
    latitude FLOAT,
    longitude FLOAT,
    timestamp DATETIME(6) NOT NULL,    -- Supporto per i microsecondi dei sensori
    dominant_frequency_hz FLOAT NOT NULL,
    classification VARCHAR(50) NOT NULL,
    detected_by VARCHAR(100) NOT NULL, -- Nome della replica che ha fatto il calcolo
    INDEX idx_timestamp (timestamp),   -- Ottimizza la ricerca storica per la dashboard
    INDEX idx_sensor (sensor_id),       -- Ottimizza i filtri della dashboard
    INDEX idx_region (region)
);
