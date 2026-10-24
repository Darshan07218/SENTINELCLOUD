package com.sentinelcloud.bloodbank.domain;

/**
 * ACTIVE: units held for a hospital. RELEASED: given back to available
 * stock without being used. FULFILLED: actually issued/transfused.
 */
public enum ReservationStatus {
    ACTIVE, RELEASED, FULFILLED
}
