import type { ToolResult } from "./index";

/**
 * Weather via Open-Meteo: no API key, no signup. A plain place name is
 * geocoded first; the forecast call returns current conditions and a
 * three-day outlook. WMO weather codes are translated to short phrases
 * here — raw numbers are never handed to the model.
 */

const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "violent rain showers",
  85: "light snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm with light hail",
  99: "thunderstorm with heavy hail",
};

function condition(code: unknown): string {
  return typeof code === "number" && code in WMO ? WMO[code] : "unknown conditions";
}

interface GeoResult {
  name?: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
}

// Open-Meteo's geocoder does not know common city abbreviations ("SF"
// finds nothing), and "what is the weather in SF" is one of the first
// things anyone types at a chatbot.
const CITY_ALIASES: Record<string, string> = {
  sf: "San Francisco",
  nyc: "New York",
  ny: "New York",
  la: "Los Angeles",
  dc: "Washington",
  ldn: "London",
  ist: "Istanbul",
};

export async function getWeather(location: string): Promise<ToolResult> {
  try {
    const raw = location.trim();
    if (!raw) {
      return {
        ok: false,
        reason: "No location was given. Ask the user which place they mean instead of guessing a city.",
      };
    }
    const place = CITY_ALIASES[raw.toLowerCase()] ?? raw;

    const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geoUrl.searchParams.set("name", place);
    geoUrl.searchParams.set("count", "1");
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(10000) });
    if (!geoRes.ok) {
      return { ok: false, reason: `The geocoding service returned ${geoRes.status}.` };
    }
    const geo = (await geoRes.json()) as { results?: GeoResult[] };
    const hit = geo.results?.[0];
    if (!hit || hit.latitude == null || hit.longitude == null) {
      return { ok: false, reason: `Could not find a place called "${place}".` };
    }
    const resolvedName = [hit.name, hit.admin1, hit.country]
      .filter(Boolean)
      .join(", ");

    const wxUrl = new URL("https://api.open-meteo.com/v1/forecast");
    wxUrl.searchParams.set("latitude", String(hit.latitude));
    wxUrl.searchParams.set("longitude", String(hit.longitude));
    wxUrl.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    );
    wxUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    wxUrl.searchParams.set("timezone", "auto");
    wxUrl.searchParams.set("forecast_days", "3");
    const wxRes = await fetch(wxUrl, { signal: AbortSignal.timeout(10000) });
    if (!wxRes.ok) {
      return { ok: false, reason: `The weather service returned ${wxRes.status}.` };
    }
    const wx = (await wxRes.json()) as {
      timezone?: string;
      current?: {
        time?: string;
        temperature_2m?: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        wind_speed_10m?: number;
        weather_code?: number;
      };
      current_units?: Record<string, string>;
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
      };
      daily_units?: Record<string, string>;
    };
    const cur = wx.current;
    if (!cur) {
      return { ok: false, reason: "The weather service returned no current conditions." };
    }

    const tempUnit = wx.current_units?.temperature_2m ?? "°C";
    const windUnit = wx.current_units?.wind_speed_10m ?? "km/h";
    const outlook = (wx.daily?.time ?? []).map((date, i) => ({
      date,
      condition: condition(wx.daily?.weather_code?.[i]),
      high: wx.daily?.temperature_2m_max?.[i] ?? null,
      low: wx.daily?.temperature_2m_min?.[i] ?? null,
    }));

    return {
      ok: true,
      data: {
        // Always says which place was used — geocoding takes the first
        // match, and names like "Springfield" are ambiguous.
        resolvedLocation: resolvedName,
        note: `Geocoding used the first match for "${place}" — state which resolved place the reading is for.`,
        localTime: cur.time ?? null,
        timezone: wx.timezone ?? null,
        current: {
          temperature: cur.temperature_2m ?? null,
          feelsLike: cur.apparent_temperature ?? null,
          condition: condition(cur.weather_code),
          humidityPercent: cur.relative_humidity_2m ?? null,
          wind: cur.wind_speed_10m ?? null,
          temperatureUnit: tempUnit,
          windUnit,
        },
        threeDayOutlook: outlook,
        outlookTemperatureUnit: wx.daily_units?.temperature_2m_max ?? tempUnit,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `Weather lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
