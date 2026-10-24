package com.sentinelcloud.power.service;

import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.exception.ForbiddenException;
import com.sentinelcloud.power.repository.SubstationRepository;
import com.sentinelcloud.power.security.AuthenticatedUser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class SubstationServiceTest {

    private SubstationRepository substationRepository;
    private SubstationService substationService;

    @BeforeEach
    void setUp() {
        substationRepository = mock(SubstationRepository.class);
        substationService = new SubstationService(substationRepository);
    }

    @Test
    void systemAdminMayManageAnySubstation() {
        UUID ownerId = UUID.randomUUID();
        Substation substation = new Substation("Test", "Addr", 18.5, 73.8, "Zone", ownerId);
        AuthenticatedUser systemAdmin = new AuthenticatedUser(UUID.randomUUID(), "admin@x.com", "SYSTEM_ADMIN");

        assertDoesNotThrow(() -> substationService.assertManages(substation, systemAdmin));
    }

    @Test
    void infrastructureAdminMayManageTheirOwnSubstation() {
        UUID ownerId = UUID.randomUUID();
        Substation substation = new Substation("Test", "Addr", 18.5, 73.8, "Zone", ownerId);
        AuthenticatedUser owner = new AuthenticatedUser(ownerId, "owner@x.com", "INFRASTRUCTURE_ADMIN");

        assertDoesNotThrow(() -> substationService.assertManages(substation, owner));
    }

    @Test
    void infrastructureAdminMayNotManageSomeoneElsesSubstation() {
        Substation substation = new Substation("Test", "Addr", 18.5, 73.8, "Zone", UUID.randomUUID());
        AuthenticatedUser otherAdmin = new AuthenticatedUser(UUID.randomUUID(), "other@x.com", "INFRASTRUCTURE_ADMIN");

        assertThrows(ForbiddenException.class, () -> substationService.assertManages(substation, otherAdmin));
    }

    @Test
    void unrelatedRoleMayNotManageAnySubstation() {
        Substation substation = new Substation("Test", "Addr", 18.5, 73.8, "Zone", UUID.randomUUID());
        AuthenticatedUser citizen = new AuthenticatedUser(UUID.randomUUID(), "citizen@x.com", "CITIZEN");

        assertThrows(ForbiddenException.class, () -> substationService.assertManages(substation, citizen));
    }
}
