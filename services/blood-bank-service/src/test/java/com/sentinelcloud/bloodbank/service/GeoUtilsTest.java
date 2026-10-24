package com.sentinelcloud.bloodbank.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class GeoUtilsTest {

    @Test
    void distanceFromPointToItselfIsZero() {
        assertEquals(0.0, GeoUtils.haversineDistanceKm(18.52, 73.85, 18.52, 73.85), 0.001);
    }

    @Test
    void knownDistancePuneToMumbaiIsRoughlyCorrect() {
        double distance = GeoUtils.haversineDistanceKm(18.5204, 73.8567, 19.0760, 72.8777);
        assertTrue(distance > 100 && distance < 170, "expected ~120-150km, got " + distance);
    }

    @Test
    void boundingBoxContainsTheCenterPoint() {
        GeoUtils.BoundingBox box = GeoUtils.boundingBoxForRadius(18.52, 73.85, 25);
        assertTrue(18.52 >= box.minLat() && 18.52 <= box.maxLat());
        assertTrue(73.85 >= box.minLng() && 73.85 <= box.maxLng());
    }

    @Test
    void boundingBoxClampsLatitudeNearThePoles() {
        GeoUtils.BoundingBox box = GeoUtils.boundingBoxForRadius(89.5, 0, 500);
        assertTrue(box.maxLat() <= 90);
    }
}
