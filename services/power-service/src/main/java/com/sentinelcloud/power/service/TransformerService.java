package com.sentinelcloud.power.service;

import com.sentinelcloud.power.dto.TransformerDtos.*;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.exception.ConflictException;
import com.sentinelcloud.power.exception.NotFoundException;
import com.sentinelcloud.power.repository.TransformerRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/** Feature 1 (add infrastructure — transformer half) plus per-substation listing/update. */
@Service
public class TransformerService {

    private final TransformerRepository transformerRepository;

    public TransformerService(TransformerRepository transformerRepository) {
        this.transformerRepository = transformerRepository;
    }

    @Transactional
    public Transformer addTransformer(Substation substation, CreateTransformerRequest req) {
        if (transformerRepository.existsBySubstationIdAndCode(substation.getId(), req.code())) {
            throw new ConflictException("DUPLICATE_TRANSFORMER_CODE",
                "A transformer with code '" + req.code() + "' already exists at this substation.");
        }
        Transformer transformer = new Transformer(substation.getId(), req.code(), req.name(),
            req.ratedVoltageKv(), req.ratedCurrentAmps(), req.lastInspectionDate());
        return transformerRepository.save(transformer);
    }

    public Transformer getOrThrow(UUID transformerId) {
        return transformerRepository.findById(transformerId).orElseThrow(() -> new NotFoundException("Transformer not found."));
    }

    public List<Transformer> listForSubstation(UUID substationId) {
        return transformerRepository.findBySubstationId(substationId);
    }

    public List<Transformer> listAll() {
        return transformerRepository.findAll();
    }

    /** Indexed query instead of loading the whole fleet and filtering in memory. */
    public List<Transformer> listOverloaded(double floorPct) {
        return transformerRepository.findOverloaded(floorPct);
    }

    public List<Transformer> listHighTemperature(double floorC) {
        return transformerRepository.findHighTemperature(floorC);
    }

    @Transactional
    public Transformer update(UUID transformerId, UpdateTransformerRequest req) {
        Transformer transformer = getOrThrow(transformerId);
        if (req.name() != null) transformer.setName(req.name());
        if (req.ratedVoltageKv() != null) transformer.setRatedVoltageKv(req.ratedVoltageKv());
        if (req.ratedCurrentAmps() != null) transformer.setRatedCurrentAmps(req.ratedCurrentAmps());
        if (req.lastInspectionDate() != null) transformer.setLastInspectionDate(req.lastInspectionDate());
        return transformerRepository.save(transformer);
    }
}
