package com.sentinelcloud.bloodbank.domain;

/**
 * Combines {@link BloodGroup} and {@link RhFactor} into the familiar
 * display form (A+, A-, B+, B-, AB+, AB-, O+, O-) — the 8 types this
 * service is required to support. Stored as two normalized columns
 * (see migration V1) but always presented to API consumers as this
 * single, recognizable string.
 */
public record BloodType(BloodGroup group, RhFactor rh) {

    public String display() {
        return group.name() + (rh == RhFactor.POSITIVE ? "+" : "-");
    }

    public static BloodType parse(String display) {
        if (display == null || display.isBlank()) {
            throw new IllegalArgumentException("Blood type must not be blank");
        }
        String trimmed = display.trim();
        RhFactor rh;
        if (trimmed.endsWith("+")) {
            rh = RhFactor.POSITIVE;
        } else if (trimmed.endsWith("-")) {
            rh = RhFactor.NEGATIVE;
        } else {
            throw new IllegalArgumentException("Blood type must end with + or -: " + display);
        }
        String groupPart = trimmed.substring(0, trimmed.length() - 1).toUpperCase();
        BloodGroup group;
        try {
            group = BloodGroup.valueOf(groupPart);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Unknown blood group '" + groupPart + "' in blood type: " + display);
        }
        return new BloodType(group, rh);
    }
}
