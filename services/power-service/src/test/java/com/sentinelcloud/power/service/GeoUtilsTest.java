package com.sentinelcloud.power.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class GeoUtilsTest {

    @Test
    void distanceBetweenIdenticalPointsIsZero() {
        assertEquals(0.0, GeoUtils.haversineDistanceKm(18.52, 73.85, 18.52, 73.85), 0.0001);
    }

    @Test
    void distanceIsSymmetric() {
        double a = GeoUtils.haversineDistanceKm(18.5236, 73.8737, 18.5308, 73.8794);
        double b = GeoUtils.haversineDistanceKm(18.5308, 73.8794, 18.5236, 73.8737);
        assertEquals(a, b, 0.0001);
    }

    @Test
    void boundingBoxContainsTheOriginPoint() {
        var box = GeoUtils.boundingBoxForRadius(18.52, 73.85, 10.0);
        assertTrue(18.52 >= box.minLat() && 18.52 <= box.maxLat());
        assertTrue(73.85 >= box.minLng() && 73.85 <= box.maxLng());
    }

    @Test
    void boundingBoxClampsToValidLatLngRangeNearThePoles() {
        var box = GeoUtils.boundingBoxForRadius(89.9, 0.0, 500.0);
        assertTrue(box.maxLat() <= 90);
        assertTrue(box.minLat() >= -90);
    }
}
