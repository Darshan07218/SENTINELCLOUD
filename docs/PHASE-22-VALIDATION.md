# Phase 22 — Validating the models

> **Status: done.** Each model is tested against real data it was not built
> on. Where it fell short, the fix or the reason for not fixing is stated.

| Model | Tested on | Finding | Action |
|---|---|---|---|
| Casualty estimate (response-service) | 11 historical Indian disasters | Under-estimates severe sudden events: all 7 with complete figures too low, median **×69** | Not re-tuned (biased sample, no gain on unseen events); every plan now **quotes the record** and calls its estimate a lower bound |
| Bed-occupancy forecast (hospital-service) | 3 years of real daily occupancy, 6 US states | Phase 18 settings **3× worse** than "no change"; "80 %" band held 94 % | **Re-tuned** on 2021–22, tested on 2023: now level with / slightly better than "no change", band holds 79 % |
| Transformer projection (power-service) | 2 years of real hourly transformer temperature (ETT) | About as accurate as "no change" in normal operation (−2 % at 1 h, −10 % at 24 h) | Kept: its purpose, warning of heating towards 85 °C, is not exercised by data peaking at 46 °C |

Everything here is reproducible: `tools/validation/` holds the inputs, the
scripts and their outputs, and `tests/data/validation.test.js` fails if the
committed results, or the record the live system quotes, no longer match a
fresh run.

## 1. Casualty model against historical disasters

**Events** (`tools/validation/events.json`): Koyna 1967, Uttarkashi 1991,
Latur 1993 and Bhuj 2001 earthquakes; Bhopal 1984 and Visakhapatnam 2020 gas
leaks; Kamala Mills fire 2017; Malin landslide 2014; Mumbai floods 2005;
Odisha super cyclone 1999 and Cyclone Fani 2019. Observed = reported deaths +
injuries (public figures, approximate, sources linked). Where injuries were
never reported (landslide, flood, cyclones) the figure is only a lower bound
and is not used for the headline metrics.

**Inputs follow fixed rules, never the outcome.** Earthquakes use the very
functions intake-service applies to live USGS events (severity from magnitude,
felt radius); other events a severity and radius written down from the hazard
(gas-cloud area, rain in mm, cyclone category). Population: WorldPop 2020
inside the circle (`event-populations.mjs`, the same `populationWithin` the
live system uses, so the 100 km cap applies too), scaled to the event year by
India's population (World Bank).

**Result** (`node tools/validation/validate-casualty-model.mjs`):

| Event | Estimate | Reported | Actual ÷ estimate |
|---|---|---|---|
| Koyna 1967 (M6.6) | 2,257 | 2,452 | 1.1 |
| Uttarkashi 1991 (M6.8) | 1,938 | 5,834 | 3.0 |
| Latur 1993 (M6.2) | 1,415 | 39,748 | 28 |
| Bhuj 2001 (M7.7) | 1,587 | 187,000 | 118 |
| Bhopal 1984 | 158 | 561,912 | 3,556 |
| Visakhapatnam 2020 | 7 | 597 | 85 |
| Kamala Mills 2017 | 1 | 69 | 69 |
| Malin 2014 | 0 | ≥ 151 | (lower bound) |
| Mumbai floods 2005 | 3,439 | ≥ 419 | (lower bound, estimate above it) |
| Odisha 1999 | 3,758 | ≥ 9,887 | (lower bound) |
| Fani 2019 | 3,985 | ≥ 64 | (lower bound; ~1 M people evacuated beforehand) |

All seven events with complete figures are under-estimated; the median is
**69× too low**; one is within ×3, two within ×10.

**Why.** Local events (gas leaks, a fire, a landslide) concentrate casualties
far more than "a small share of the zone at a modest rate" allows; four
severity levels can't tell M6.6 from M7.7; time of day, building stock and
damage beyond 100 km (Bhuj) aren't in the model; warnings and evacuation
(Fani) aren't either.

**Could a correction factor fix it?** `tools/validation/calibrate.mjs` fits
one factor per type and scores it **leave-one-out** (each event predicted from
the others only):

| Type | Error now (mean \|log10\|) | Leave-one-out with a factor | Verdict |
|---|---|---|---|
| Earthquake (4) | 1.01 (~×10) | 1.00 | no meaningful gain: fixes Latur and Bhuj, breaks Koyna (×20) |
| Industrial (2) | 2.74 (~×550) | 1.62 (~×42) | better, but resting on Bhopal: ×550 would predict ~100,000 casualties for an ordinary leak |
| Fire (1) | — | — | one event can only fit itself |

And the sample is biased: well-documented disasters are the catastrophic
ones. Calibrating on them would inflate estimates for the moderate events
that make up most of real life. **So the rates are not changed.** Instead the
live system says what the validation showed: every response plan's estimate
notice now ends, for example,

> In 4 past earthquakes checked, actual casualties were 1.1–118× this model's
> estimate: treat it as a lower bound.

The record comes from `services/response-service/src/data/casualty-validation.json`,
written by the validation script and checked by the data tests.

## 2. What a better casualty model would need

A continuous magnitude term (not four buckets), building-vulnerability and
time-of-day factors, intensity decay with distance instead of a flat circle,
and a separate model for point-source events. And, above all, unbiased
calibration data: complete casualty records for moderate events too.

## 3. Bed-occupancy forecast on real hospital data

**Data:** US HHS "COVID-19 Reported Patient Impact and Hospital Capacity by
State Timeseries" (healthdata.gov `g62h-syeh`, public domain): daily inpatient
beds and beds used for MA, CA, TX, NY, FL and IL, 2021–2023. No comparable
open series exists for Indian hospitals. The backtest runs the live code
(`holt`, `projectHolt`, the same settings and band) on daily occupancy: one
step = one day here, one hour in the live system.

**Phase 18 settings** (α 0.5, β 0.3, φ 0.98, band z 1.28), every 7th day,
1–14 steps ahead, against persistence ("tomorrow = today"):

| Steps ahead | Forecast error | "No change" error |
|---|---|---|
| 1 | 0.76 pp | 0.60 pp |
| 7 | 2.68 | 1.04 |
| 14 | 4.94 | 1.23 |

The forecast read week-to-week swings as trends and extended them. Its "80 %"
band held 94–97 % of outcomes: far too wide.

**Re-tuned without peeking** (`backtest-occupancy.mjs --tune`): α, β, φ and
the band's z chosen on **2021–2022 only**, two forms compared (plain Holt, and
anchored at the latest reading), then scored on **2023**:

| On 2023 (unseen) | Error | Skill vs "no change" | Band coverage |
|---|---|---|---|
| Phase 18 settings | 2.82 pp | −2.10 | 94 % |
| **Tuned** (α 0.7, β 0.05, φ 0.5, z 0.38) | **0.89** | **+0.02** | **79 %** |
| Anchored form, best settings | 0.91 | 0.00 | — |
| "No change" | 0.91 | 0 | — |

Adopted in `forecast.js` (the data test pins the live settings to the tuning
file). Plain and anchored are a near-tie (0.02 pp); plain was kept by the rule
set before the run (better on the unseen year). Honest reading: **real
occupancy has little trend worth extending**; the tuned forecast mostly
smooths, which is why it now matches the naive forecast instead of losing to
it. Side effects, stated: a steady rise is forecast to start slightly below
the latest reading (the smoothed level lags), the band is narrower one step
ahead than further out (66 % at 1 step, 85–88 % at 7–14), and a hospital is
no longer flagged hours before 90 % on a trend alone. Its current level and
the alerts still flag it. Parameters were tuned on daily steps and run on
hourly ones; damping the trend hard is the cautious choice at either scale.

## 4. Transformer projection on real transformer data

**Data:** ETDataset ETTh1 (Zhou et al., AAAI 2021): 17,420 hourly readings of
a real transformer's oil temperature. Not committed; the backtest is a JUnit
test (`RiskForecasterBacktest`) that runs the actual
`TransformerRiskForecaster` only when `ETT_CSV` is set. Every 24 h it gets the
last 168 hourly readings, as in the live service, and projects ahead:

| Ahead | Projection error | "No change" error | Skill |
|---|---|---|---|
| 1 h | 0.52 °C | 0.51 °C | −0.02 |
| 6 h | 1.26 | 1.22 | −0.03 |
| 12 h | 1.79 | 1.72 | −0.04 |
| 24 h | 2.19 | 1.99 | −0.10 |

In normal operation the 7-day trend adds a little noise. It was **not**
removed: its job is to warn of sustained heating towards the 85 °C critical
line, and this transformer peaked at 46 °C, so that case is untested here.
Validated: accuracy in normal operation. Not validated: early warning of
overheating.

## 5. Reproduce

```bash
node tools/validation/validate-casualty-model.mjs --write   # casualty model (+ the record the live system quotes)
node tools/validation/calibrate.mjs                         # correction factors, leave-one-out
node tools/validation/backtest-occupancy.mjs --write        # bed forecast on HHS data (downloads it)
node tools/validation/backtest-occupancy.mjs --tune --write # tune on 2021–22, test on 2023
# event populations need the WorldPop India grid and Docker (GDAL):
node tools/validation/event-populations.mjs ind_ppp_2020_1km_Aggregated.tif
# transformer projection (ETT data, not committed):
ETT_CSV=ETTh1.csv mvn -Dtest=RiskForecasterBacktest test     # in services/power-service
```
