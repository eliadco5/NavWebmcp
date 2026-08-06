import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

const KNOWN_LOCATIONS: Record<string, { latitude: number; longitude: number }> = {
  "new york": { latitude: 40.7128, longitude: -74.006 },
  chicago: { latitude: 41.8781, longitude: -87.6298 },
  miami: { latitude: 25.7617, longitude: -80.1918 },
  "san francisco": { latitude: 37.7749, longitude: -122.4194 },
  austin: { latitude: 30.2672, longitude: -97.7431 },
};

// WMO weather codes used by Open-Meteo, collapsed to the categories we care about.
function describeWeatherCode(code: number): string {
  if (code === 0) return "clear sky";
  if ([1, 2, 3].includes(code)) return "partly cloudy";
  if ([45, 48].includes(code)) return "fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "thunderstorm";
  return "unknown";
}

export const getWeatherForecast = defineOperation({
  name: "getWeatherForecast",
  title: "Get Weather Forecast",
  description:
    "Get the weather forecast for a supported city on a given date, to help decide between indoor and outdoor seating.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "reservation.availability",
  tags: ["booking", "weather"],
  inputSchema: {
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
      .describe("Date to forecast, in YYYY-MM-DD format"),
    location: z
      .string()
      .describe(`City to forecast for. Supported: ${Object.keys(KNOWN_LOCATIONS).join(", ")}`),
  },
  async handler({ date, location }, _ctx) {
    const coords = KNOWN_LOCATIONS[location.trim().toLowerCase()];
    if (!coords) {
      return fail(
        "UNKNOWN_LOCATION",
        `Unsupported location "${location}". Supported: ${Object.keys(KNOWN_LOCATIONS).join(", ")}`
      );
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
      `&timezone=auto&start_date=${date}&end_date=${date}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return fail("WEATHER_API_UNREACHABLE", "Could not reach the weather service.");
    }
    if (!res.ok) {
      return fail("WEATHER_API_ERROR", `Weather service returned ${res.status}.`);
    }

    const data = await res.json();
    const daily = data?.daily;
    if (!daily?.time?.length) {
      return fail("NO_FORECAST", `No forecast available for ${location} on ${date}.`);
    }

    const tempMaxC = daily.temperature_2m_max[0];
    const tempMinC = daily.temperature_2m_min[0];
    const precipitationChancePercent = daily.precipitation_probability_max[0];
    const condition = describeWeatherCode(daily.weathercode[0]);
    const outdoorSeatingRecommended = precipitationChancePercent < 30 && tempMinC >= 15 && tempMaxC <= 32;

    return ok({
      date,
      location,
      condition,
      tempMaxC,
      tempMinC,
      precipitationChancePercent,
      outdoorSeatingRecommended,
      message: outdoorSeatingRecommended
        ? `${condition}, ${tempMinC}-${tempMaxC}°C — good conditions for outdoor seating.`
        : `${condition}, ${tempMinC}-${tempMaxC}°C, ${precipitationChancePercent}% chance of rain — indoor seating recommended.`,
    });
  },
});
