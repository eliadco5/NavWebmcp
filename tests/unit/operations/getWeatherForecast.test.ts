// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getWeatherForecast: any

function mockForecastResponse(overrides: Partial<{
  tempMax: number; tempMin: number; precipitation: number; weathercode: number;
}> = {}) {
  const { tempMax = 24, tempMin = 18, precipitation = 10, weathercode = 1 } = overrides
  return {
    ok: true,
    status: 200,
    json: async () => ({
      daily: {
        time: ['2026-08-10'],
        temperature_2m_max: [tempMax],
        temperature_2m_min: [tempMin],
        precipitation_probability_max: [precipitation],
        weathercode: [weathercode],
      },
    }),
  }
}

beforeEach(async () => {
  await import('@/lib/operations/index')
  getWeatherForecast = (await import('@/lib/operations/getWeatherForecast')).getWeatherForecast
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getWeatherForecast', () => {
  it('returns forecast and recommends outdoor seating in good weather', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockForecastResponse()))

    const result = await getWeatherForecast.handler(
      { date: '2026-08-10', location: 'Chicago' },
      customerCtx
    )

    expect(result.success).toBe(true)
    expect(result.data.outdoorSeatingRecommended).toBe(true)
    expect(result.data.condition).toBe('partly cloudy')
  })

  it('recommends indoor seating when rain chance is high', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockForecastResponse({ precipitation: 80, weathercode: 63 })))

    const result = await getWeatherForecast.handler(
      { date: '2026-08-10', location: 'miami' },
      customerCtx
    )

    expect(result.success).toBe(true)
    expect(result.data.outdoorSeatingRecommended).toBe(false)
    expect(result.data.condition).toBe('rain')
  })

  it('fails with UNKNOWN_LOCATION for an unsupported city', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const result = await getWeatherForecast.handler(
      { date: '2026-08-10', location: 'Atlantis' },
      customerCtx
    )

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('UNKNOWN_LOCATION')
  })

  it('fails with WEATHER_API_UNREACHABLE when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const result = await getWeatherForecast.handler(
      { date: '2026-08-10', location: 'Austin' },
      customerCtx
    )

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('WEATHER_API_UNREACHABLE')
  })

  it('fails with WEATHER_API_ERROR on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const result = await getWeatherForecast.handler(
      { date: '2026-08-10', location: 'new york' },
      customerCtx
    )

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('WEATHER_API_ERROR')
  })
})
