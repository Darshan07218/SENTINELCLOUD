package com.sentinelcloud.bloodbank.service;

/**
 * Pure geo math — no Spring, no DB — mirroring the identical
 * Haversine-distance + bounding-box approach used in hospital-service
 * (services/capacity.js) and ambulance-service (services/routing.js).
 * See those files' comments for the full rationale on why this
 * project computes distance in application code rather than requiring
 * a geospatial database extension at this scale.
 */
public final class GeoUtils {

    private static final double EARTH_RADIUS_KM = 6371.0;

    private GeoUtils() {}

    public static double haversineDistanceKm(double lat1, double lng1, double lat2, double lng2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
            * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        double h = Math.min(1, Math.max(0, a)); // float error can push a past 1 for antipodal points
        double c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        return EARTH_RADIUS_KM * c;
    }

    public record BoundingBox(double minLat, double maxLat, double minLng, double maxLng) {}

    public static BoundingBox boundingBoxForRadius(double lat, double lng, double radiusKm) {
        double latDelta = radiusKm / 111.0;
        double minLat = Math.max(lat - latDelta, -90);
        double maxLat = Math.min(lat + latDelta, 90);
        // Near a pole, or across the ±180° meridian, one [minLng, maxLng]
        // range can't describe the box: search every longitude (a correct
        // superset — the exact Haversine check filters afterwards).
        double lngDivisor = Math.cos(Math.toRadians(lat));
        double lngDelta = lngDivisor > 0.01 ? radiusKm / (111.0 * lngDivisor) : 360;
        if (minLat == -90 || maxLat == 90 || lng - lngDelta < -180 || lng + lngDelta > 180) {
            return new BoundingBox(minLat, maxLat, -180, 180);
        }
        return new BoundingBox(minLat, maxLat, lng - lngDelta, lng + lngDelta);
    }
}
