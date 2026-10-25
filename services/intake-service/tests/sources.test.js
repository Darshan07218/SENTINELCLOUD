import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseUsgsFeed, earthquakeSeverity, feltRadiusKm } from "../src/sources/usgs.js";
import { parseOpenMeteo, openMeteoUrl, summarise } from "../src/sources/openMeteo.js";
import { haversineKm } from "../src/sources/geo.js";
import { PUNE, quake, forecast } from "./fakes.js";

describe("USGS earthquakes", () => {
  test("severity by magnitude, one step lower beyond 250 km", () => {
    assert.equal(earthquakeSeverity(6.7, 50), "CRITICAL");
    assert.equal(earthquakeSeverity(5.8, 50), "HIGH");
    assert.equal(earthquakeSeverity(4.6, 50), "MEDIUM");
    assert.equal(earthquakeSeverity(3.2, 50), "LOW");
    assert.equal(earthquakeSeverity(6.7, 300), "HIGH");
    assert.equal(earthquakeSeverity(3.2, 300), "LOW");
  });

  test("felt radius doubles per magnitude, within 5–500 km", () => {
    assert.equal(feltRadiusKm(3), 15);
    assert.equal(feltRadiusKm(5), 60);
    assert.equal(feltRadiusKm(7), 240);
    assert.equal(feltRadiusKm(9.5), 500);
  });

  test("a quake near the city becomes an EARTHQUAKE detection at its epicentre", () => {
    const [d] = parseUsgsFeed({ features: [quake({ id: "us7000abc", mag: 4.8, lat: 17.4, lng: 73.75 })] }, PUNE);
    assert.equal(d.source, "USGS");
    assert.equal(d.externalId, "us7000abc");
    assert.equal(d.type, "EARTHQUAKE");
    assert.equal(d.severity, "MEDIUM");
    assert.equal(d.latitude, 17.4);
    assert.equal(d.radiusKm, feltRadiusKm(4.8));
    assert.match(d.title, /^M4\.8 earthquake/);
    assert.ok(d.description.length >= 5 && d.description.includes("us7000abc"));
    assert.equal(d.details.distanceKm, Math.round(haversineKm(PUNE.latitude, PUNE.longitude, 17.4, 73.75)));
  });

  test("quakes outside the radius, below the magnitude, or not earthquakes are ignored", () => {
    const feed = {
      features: [
        quake({ id: "far", lat: 35.7, lng: 139.7 }), // Tokyo
        quake({ id: "small", mag: 2.4 }),
        quake({ id: "blast", type: "quarry blast" }),
        { id: "broken", properties: {}, geometry: null },
      ],
    };
    assert.deepEqual(parseUsgsFeed(feed, PUNE), []);
    assert.deepEqual(parseUsgsFeed(null, PUNE), []);
  });
});

describe("Open-Meteo rain and wind", () => {
  test("the request asks for 24 hours of rain and gusts at the watch point", () => {
    const url = new URL(openMeteoUrl("https://api.open-meteo.com/v1/forecast", PUNE));
    assert.equal(url.searchParams.get("latitude"), "18.5204");
    assert.equal(url.searchParams.get("forecast_hours"), "24");
    assert.match(url.searchParams.get("hourly"), /precipitation/);
  });

  test("summary: 24 h rain total and the strongest gust", () => {
    const s = summarise(forecast({ rainPerHour: 2.5, gust: 40 }));
    assert.equal(s.rain24hMm, 60);
    assert.equal(s.maxGustKmh, 40);
  });

  test("quiet weather: a summary but no detection", () => {
    const { summary, detections } = parseOpenMeteo(forecast({ rainPerHour: 0.5, gust: 30 }), PUNE);
    assert.equal(summary.rain24hMm, 12);
    assert.deepEqual(detections, []);
  });

  test("IMD rain bands: heavy MEDIUM, very heavy HIGH, extremely heavy CRITICAL", () => {
    const sev = (mmPerHour) => parseOpenMeteo(forecast({ rainPerHour: mmPerHour }), PUNE).detections[0]?.severity;
    assert.equal(sev(64.5 / 24), "MEDIUM");
    assert.equal(sev(5), "HIGH"); // 120 mm
    assert.equal(sev(9), "CRITICAL"); // 216 mm
    assert.equal(sev(2), undefined); // 48 mm: below heavy
  });

  test("gust bands make a CYCLONE detection; rain and wind can both fire", () => {
    const { detections } = parseOpenMeteo(forecast({ rainPerHour: 5, gust: 95 }), PUNE);
    const byType = Object.fromEntries(detections.map((d) => [d.type, d]));
    assert.equal(byType.FLOOD.severity, "HIGH");
    assert.equal(byType.CYCLONE.severity, "HIGH");
    assert.equal(byType.CYCLONE.latitude, PUNE.latitude);
  });

  test("the external id carries kind, day and severity: same forecast = same id, worse forecast = new id", () => {
    const a = parseOpenMeteo(forecast({ rainPerHour: 5 }), PUNE).detections[0].externalId;
    const b = parseOpenMeteo(forecast({ rainPerHour: 5.2 }), PUNE).detections[0].externalId;
    const c = parseOpenMeteo(forecast({ rainPerHour: 9 }), PUNE).detections[0].externalId;
    assert.equal(a, "flood:2026-10-25:HIGH");
    assert.equal(a, b);
    assert.equal(c, "flood:2026-10-25:CRITICAL");
  });
});
