-- V3__create_demand_records.sql
--
-- Historical demand data feeding the PROTOTYPE forecasting module
-- (service/ForecastingService.java). This is demo/synthetic data
-- seeded by seed/DemoDataSeeder.java on first startup, standing in for
-- what would, in a real deployment, be actual historical hospital
-- request volume per blood type. See the forecasting service and
-- docs/PHASE-5-BLOOD-BANK.md for the explicit, repeated disclaimer:
-- this model is NOT medically validated and must not be used for real
-- clinical or operational decisions.

CREATE TABLE blood_demand_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blood_group     VARCHAR(4) NOT NULL,
    rh_factor       VARCHAR(8) NOT NULL,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    units_requested INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_demand_blood_group CHECK (blood_group IN ('A','B','AB','O')),
    CONSTRAINT chk_demand_rh_factor CHECK (rh_factor IN ('POSITIVE','NEGATIVE')),
    CONSTRAINT chk_demand_units_nonneg CHECK (units_requested >= 0),
    CONSTRAINT chk_demand_period_order CHECK (period_end > period_start)
);

CREATE INDEX idx_demand_group_rh_period ON blood_demand_records(blood_group, rh_factor, period_start);
