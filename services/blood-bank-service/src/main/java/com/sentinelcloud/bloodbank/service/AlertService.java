package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.dto.MiscDtos.AlertSeverity;
import com.sentinelcloud.bloodbank.dto.MiscDtos.ShortageAlert;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.repository.BloodBankRepository;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Feature 9 — aggregates the low-stock detection (feature 6) and
 * near-expiry detection (feature 7) into one prioritized alert feed,
 * the same "compute alerts, don't just expose raw thresholds
 * separately" pattern hospital-service uses for its capacity alerts.
 */
@Service
public class AlertService {

    private final InventoryService inventoryService;
    private final BloodBankRepository bloodBankRepository;

    public AlertService(InventoryService inventoryService, BloodBankRepository bloodBankRepository) {
        this.inventoryService = inventoryService;
        this.bloodBankRepository = bloodBankRepository;
    }

    public List<ShortageAlert> generateAlerts() {
        Map<UUID, String> bankNames = bloodBankRepository.findAll().stream()
            .collect(Collectors.toMap(BloodBank::getId, BloodBank::getName));

        Stream<ShortageAlert> lowStockAlerts = inventoryService.detectLowStock(bankNames.keySet()).stream()
            .map(entry -> {
                AlertSeverity severity = entry.isCritical() ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
                String bankName = bankNames.getOrDefault(entry.bloodBankId(), "Unknown blood bank");
                String message = entry.isCritical()
                    ? String.format("%s has critically low %s stock: only %d units available.", bankName, entry.bloodType(), entry.unitsAvailable())
                    : String.format("%s is running low on %s: %d units available.", bankName, entry.bloodType(), entry.unitsAvailable());
                return new ShortageAlert(severity, "LOW_STOCK", entry.bloodBankId(), bankName, entry.bloodType(), message, entry.unitsAvailable(), null);
            });

        Stream<ShortageAlert> expiryAlerts = inventoryService.detectExpiringSoon(InventoryService.EXPIRY_WARNING_DAYS).stream()
            .map(batch -> {
                String bankName = bankNames.getOrDefault(batch.getBloodBankId(), "Unknown blood bank");
                String type = new BloodType(batch.getBloodGroup(), batch.getRhFactor()).display();
                // ChronoUnit, not Period.getDays(): a Period of "1 month 3 days"
                // has getDays() == 3, which under-reported anything >= 1 month.
                long daysLeft = java.time.temporal.ChronoUnit.DAYS.between(LocalDate.now(), batch.getExpiryDate());
                AlertSeverity severity = daysLeft <= 2 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
                String message = String.format("%s has %d units of %s expiring in %d day(s) (on %s).",
                    bankName, batch.getUnitsAvailable(), type, daysLeft, batch.getExpiryDate());
                return new ShortageAlert(severity, "EXPIRING_SOON", batch.getBloodBankId(), bankName, type, message,
                    batch.getUnitsAvailable(), batch.getExpiryDate());
            });

        return Stream.concat(lowStockAlerts, expiryAlerts)
            .sorted(Comparator.comparing((ShortageAlert a) -> a.severity() == AlertSeverity.CRITICAL ? 0 : 1))
            .collect(Collectors.toList());
    }
}
