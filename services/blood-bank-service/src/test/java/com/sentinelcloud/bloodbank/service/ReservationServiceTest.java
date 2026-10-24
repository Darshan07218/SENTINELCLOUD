package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.ReservationStatus;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import com.sentinelcloud.bloodbank.dto.ReservationDtos.CreateReservationRequest;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.entity.BloodReservation;
import com.sentinelcloud.bloodbank.exception.ConflictException;
import com.sentinelcloud.bloodbank.repository.BloodInventoryBatchRepository;
import com.sentinelcloud.bloodbank.repository.BloodReservationRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class ReservationServiceTest {

    private BloodInventoryBatchRepository batchRepository;
    private BloodReservationRepository reservationRepository;
    private ReservationService reservationService;

    private final UUID bloodBankId = UUID.randomUUID();
    private final UUID hospitalId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        batchRepository = mock(BloodInventoryBatchRepository.class);
        reservationRepository = mock(BloodReservationRepository.class);
        reservationService = new ReservationService(batchRepository, reservationRepository);

        when(reservationRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(batchRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    /** BloodInventoryBatch's id is JPA-generated with no public setter — reflection gives a test entity a stable id without a real persistence context. */
    private static BloodInventoryBatch withId(BloodInventoryBatch batch, UUID id) {
        try {
            Field field = BloodInventoryBatch.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(batch, id);
            return batch;
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    private static BloodReservation withReservationId(BloodReservation reservation, UUID id) {
        try {
            Field field = BloodReservation.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(reservation, id);
            return reservation;
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void reservesFromTheFirstFefoBatchWhenItHasEnoughUnits() {
        LocalDate today = LocalDate.now();
        BloodInventoryBatch earlyExpiry = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.O, RhFactor.POSITIVE, 3, today.minusDays(10), today.plusDays(5)),
            UUID.randomUUID());
        BloodInventoryBatch laterExpiry = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.O, RhFactor.POSITIVE, 10, today.minusDays(5), today.plusDays(30)),
            UUID.randomUUID());

        when(batchRepository.findAvailableFefo(eq(bloodBankId), eq(BloodGroup.O), eq(RhFactor.POSITIVE), any()))
            .thenReturn(List.of(earlyExpiry, laterExpiry));
        when(batchRepository.findByIdForUpdate(earlyExpiry.getId())).thenReturn(Optional.of(earlyExpiry));

        CreateReservationRequest req = new CreateReservationRequest("O+", 3, hospitalId, "test reservation");
        BloodReservation reservation = reservationService.reserveBlood(bloodBankId, req, userId);

        assertEquals(earlyExpiry.getId(), reservation.getBatchId());
        assertEquals(3, reservation.getUnitsReserved());
        assertEquals(0, earlyExpiry.getUnitsAvailable(), "earliest-expiry batch should be drawn down first");
        assertEquals(3, earlyExpiry.getReservedUnits());
        verify(batchRepository, never()).findByIdForUpdate(laterExpiry.getId());
    }

    @Test
    void skipsAnInsufficientBatchAndReservesFromTheNextOne() {
        LocalDate today = LocalDate.now();
        BloodInventoryBatch tooSmall = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.A, RhFactor.NEGATIVE, 2, today.minusDays(10), today.plusDays(5)),
            UUID.randomUUID());
        BloodInventoryBatch bigEnough = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.A, RhFactor.NEGATIVE, 10, today.minusDays(5), today.plusDays(30)),
            UUID.randomUUID());

        when(batchRepository.findAvailableFefo(eq(bloodBankId), eq(BloodGroup.A), eq(RhFactor.NEGATIVE), any()))
            .thenReturn(List.of(tooSmall, bigEnough));
        when(batchRepository.findByIdForUpdate(tooSmall.getId())).thenReturn(Optional.of(tooSmall));
        when(batchRepository.findByIdForUpdate(bigEnough.getId())).thenReturn(Optional.of(bigEnough));

        CreateReservationRequest req = new CreateReservationRequest("A-", 5, hospitalId, null);
        BloodReservation reservation = reservationService.reserveBlood(bloodBankId, req, userId);

        assertEquals(bigEnough.getId(), reservation.getBatchId());
        assertEquals(2, tooSmall.getUnitsAvailable(), "the too-small batch should be left untouched");
        assertEquals(5, bigEnough.getUnitsAvailable());
        assertEquals(5, bigEnough.getReservedUnits());
    }

    @Test
    void throwsInsufficientInventoryWhenNoSingleBatchCoversTheRequest() {
        LocalDate today = LocalDate.now();
        BloodInventoryBatch batch1 = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.B, RhFactor.POSITIVE, 2, today.minusDays(10), today.plusDays(5)),
            UUID.randomUUID());
        BloodInventoryBatch batch2 = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.B, RhFactor.POSITIVE, 3, today.minusDays(5), today.plusDays(30)),
            UUID.randomUUID());

        when(batchRepository.findAvailableFefo(eq(bloodBankId), eq(BloodGroup.B), eq(RhFactor.POSITIVE), any()))
            .thenReturn(List.of(batch1, batch2));
        when(batchRepository.findByIdForUpdate(batch1.getId())).thenReturn(Optional.of(batch1));
        when(batchRepository.findByIdForUpdate(batch2.getId())).thenReturn(Optional.of(batch2));

        CreateReservationRequest req = new CreateReservationRequest("B+", 10, hospitalId, null);

        ConflictException ex = assertThrows(ConflictException.class,
            () -> reservationService.reserveBlood(bloodBankId, req, userId));
        assertEquals("INSUFFICIENT_INVENTORY", ex.getCode());
    }

    @Test
    void releaseRestoresUnitsToAnUnexpiredBatchAndMarksReservationReleased() {
        LocalDate today = LocalDate.now();
        BloodInventoryBatch batch = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.O, RhFactor.NEGATIVE, 1, today.minusDays(20), today.plusDays(20)),
            UUID.randomUUID());
        batch.setReservedUnits(4);

        BloodReservation reservation = withReservationId(
            new BloodReservation(batch.getId(), hospitalId, 4, "notes", userId), UUID.randomUUID());

        when(reservationRepository.findByIdForUpdate(reservation.getId())).thenReturn(Optional.of(reservation));
        when(batchRepository.findByIdForUpdate(batch.getId())).thenReturn(Optional.of(batch));

        BloodReservation released = reservationService.releaseReservation(reservation.getId());

        assertEquals(ReservationStatus.RELEASED, released.getStatus());
        assertNotNull(released.getReleasedAt());
        assertEquals(5, batch.getUnitsAvailable(), "1 + 4 released units");
        assertEquals(0, batch.getReservedUnits());
    }

    @Test
    void releaseDoesNotRestoreUnitsToAnExpiredBatchButStillClearsReservedCount() {
        LocalDate today = LocalDate.now();
        BloodInventoryBatch expiredBatch = withId(
            new BloodInventoryBatch(bloodBankId, BloodGroup.AB, RhFactor.POSITIVE, 0, today.minusDays(60), today.minusDays(1)),
            UUID.randomUUID());
        expiredBatch.setReservedUnits(2);

        BloodReservation reservation = withReservationId(
            new BloodReservation(expiredBatch.getId(), hospitalId, 2, null, userId), UUID.randomUUID());

        when(reservationRepository.findByIdForUpdate(reservation.getId())).thenReturn(Optional.of(reservation));
        when(batchRepository.findByIdForUpdate(expiredBatch.getId())).thenReturn(Optional.of(expiredBatch));

        reservationService.releaseReservation(reservation.getId());

        assertEquals(0, expiredBatch.getUnitsAvailable(), "expired units are not usable, even after release");
        assertEquals(0, expiredBatch.getReservedUnits());
    }

    @Test
    void releasingAnAlreadyReleasedReservationThrowsConflict() {
        BloodReservation reservation = withReservationId(
            new BloodReservation(UUID.randomUUID(), hospitalId, 1, null, userId), UUID.randomUUID());
        reservation.release();

        when(reservationRepository.findByIdForUpdate(reservation.getId())).thenReturn(Optional.of(reservation));

        ConflictException ex = assertThrows(ConflictException.class,
            () -> reservationService.releaseReservation(reservation.getId()));
        assertEquals("RESERVATION_NOT_ACTIVE", ex.getCode());
    }
}
