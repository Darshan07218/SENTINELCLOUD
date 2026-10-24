package com.sentinelcloud.bloodbank.controller;

import jakarta.validation.constraints.*;
import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.dto.InventoryDtos.InventoryBatchResponse;
import com.sentinelcloud.bloodbank.dto.MiscDtos.ForecastResponse;
import com.sentinelcloud.bloodbank.dto.MiscDtos.ShortageAlert;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.service.AlertService;
import com.sentinelcloud.bloodbank.service.BloodBankService;
import com.sentinelcloud.bloodbank.service.ForecastingService;
import com.sentinelcloud.bloodbank.service.InventoryService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.TreeMap;
import java.util.stream.Collectors;

@RestController
public class AnalyticsController {

    private final InventoryService inventoryService;
    private final AlertService alertService;
    private final ForecastingService forecastingService;
    private final BloodBankService bloodBankService;

    public AnalyticsController(InventoryService inventoryService, AlertService alertService,
                                ForecastingService forecastingService, BloodBankService bloodBankService) {
        this.inventoryService = inventoryService;
        this.alertService = alertService;
        this.forecastingService = forecastingService;
        this.bloodBankService = bloodBankService;
    }

    /** Feature 6 — detect low inventory, across every blood bank and type. */
    @GetMapping("/low-stock")
    public Map<String, Object> lowStock() {
        List<UUID> bankIds = bloodBankService.list().stream().map(BloodBank::getId).collect(Collectors.toList());
        List<InventoryService.LowStockEntry> entries = inventoryService.detectLowStock(bankIds);
        return Map.of("lowStock", entries, "count", entries.size());
    }

    /** Feature 7 — detect units approaching expiry. */
    @GetMapping("/expiring-soon")
    public Map<String, Object> expiringSoon(@RequestParam(defaultValue = "7") @Min(0) @Max(365) int withinDays) {
        List<InventoryBatchResponse> batches = inventoryService.detectExpiringSoon(withinDays).stream()
            .map(InventoryBatchResponse::of).collect(Collectors.toList());
        return Map.of("expiringSoon", batches, "withinDays", withinDays, "count", batches.size());
    }

    /** Feature 9 — generate shortage alerts (combines low-stock + expiring, most severe first). */
    @GetMapping("/alerts")
    public Map<String, Object> alerts() {
        List<ShortageAlert> alerts = alertService.generateAlerts();
        return Map.of("alerts", alerts, "count", alerts.size());
    }

    /**
     * PROTOTYPE demand forecast for one blood type. See
     * service/ForecastingService.java — every response repeats the
     * "not medically validated, prototype only" disclaimer explicitly.
     */
    @GetMapping("/forecast")
    public ForecastResponse forecast(@RequestParam @Pattern(regexp = "^(A|B|AB|O)[+-]$") String bloodType) {
        return forecastingService.forecast(bloodType);
    }

    /**
     * Dashboard summary — total blood banks, total units by type
     * across the whole network, low-stock count, expiring count. One
     * call for everything the frontend's summary cards need, same
     * pattern as hospital-service's GET /hospitals/stats/summary and
     * ambulance-service's GET /ambulances/stats/summary.
     */
    @GetMapping("/stats/summary")
    public Map<String, Object> summary() {
        List<BloodBank> banks = bloodBankService.list();
        List<InventoryService.LowStockEntry> lowStock = inventoryService.detectLowStock(
            banks.stream().map(BloodBank::getId).collect(Collectors.toList()));
        List<BloodInventoryBatch> expiringSoon = inventoryService.detectExpiringSoon(InventoryService.EXPIRY_WARNING_DAYS);

        Map<String, Integer> unitsByType = new TreeMap<>();
        for (BloodInventoryBatch batch : inventoryService.listAllNonExpired()) {
            String type = new BloodType(batch.getBloodGroup(), batch.getRhFactor()).display();
            unitsByType.merge(type, batch.getUnitsAvailable(), Integer::sum);
        }

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalBloodBanks", banks.size());
        summary.put("unitsByType", unitsByType);
        summary.put("totalUnitsAvailable", unitsByType.values().stream().mapToInt(Integer::intValue).sum());
        summary.put("lowStockCount", lowStock.size());
        summary.put("expiringSoonCount", expiringSoon.size());
        summary.put("expiringSoonUnits", expiringSoon.stream().mapToInt(BloodInventoryBatch::getUnitsAvailable).sum());

        return Map.of("summary", summary);
    }
}
