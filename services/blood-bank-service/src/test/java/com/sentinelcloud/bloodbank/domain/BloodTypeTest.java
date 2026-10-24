package com.sentinelcloud.bloodbank.domain;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

class BloodTypeTest {

    @ParameterizedTest
    @ValueSource(strings = {"A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"})
    void parsesAndRoundTripsEveryRequiredBloodType(String display) {
        BloodType type = BloodType.parse(display);
        assertEquals(display, type.display());
    }

    @Test
    void parsesLowercaseInput() {
        BloodType type = BloodType.parse("ab+");
        assertEquals(BloodGroup.AB, type.group());
        assertEquals(RhFactor.POSITIVE, type.rh());
    }

    @Test
    void negativeRhParsesCorrectly() {
        BloodType type = BloodType.parse("O-");
        assertEquals(RhFactor.NEGATIVE, type.rh());
    }

    @Test
    void rejectsMissingSign() {
        assertThrows(IllegalArgumentException.class, () -> BloodType.parse("A"));
    }

    @Test
    void rejectsUnknownGroup() {
        assertThrows(IllegalArgumentException.class, () -> BloodType.parse("X+"));
    }

    @Test
    void rejectsBlank() {
        assertThrows(IllegalArgumentException.class, () -> BloodType.parse(""));
        assertThrows(IllegalArgumentException.class, () -> BloodType.parse(null));
    }
}
