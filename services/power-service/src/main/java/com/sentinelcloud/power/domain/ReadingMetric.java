package com.sentinelcloud.power.domain;

/** The four telemetry dimensions this service monitors and runs anomaly detection over. */
public enum ReadingMetric {
    VOLTAGE, CURRENT, LOAD_PERCENTAGE, TEMPERATURE
}
