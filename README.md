# Solar Production Dashboard

Live website that shows current and historical solar production by polling Home Assistant.

## What it does

- Polls a Home Assistant sensor (`HA_SENSOR_ENTITY_ID`) every `POLL_SECONDS`.
- Optionally polls EcoFlow AC output (`HA_AC_OUTPUT_ENTITY_ID`) and charts it.
- Stores readings in `data/history.json` for historical charting.
- Serves a live dashboard with:
  - current output in watts
  - historical line chart
  - real-time updates via Server-Sent Events

## Requirements

- Node.js 18+
- Home Assistant reachable from this machine
- A Home Assistant long-lived access token

## Setup

1. Copy env file:

   ```bash
   cp .env.example .env
   ```

2. Export variables from `.env` in your shell (or set them another way):

   ```bash
   set -a
   source .env
   set +a
   ```

3. Start server:

   ```bash
   npm start
   ```

4. Open:

   [http://localhost:3000](http://localhost:3000)

## Home Assistant sensor notes

Point `HA_SENSOR_ENTITY_ID` at your solar power sensor state in watts, for example:

- `sensor.pv_power`
- `sensor.solar_input_power`
- `sensor.inverter_power`

If your sensor reports non-numeric states (like `unknown`), the dashboard will show a warning until valid numeric data returns.

Set `HA_AC_OUTPUT_ENTITY_ID` if you also want to track the EcoFlow AC output power sensor.

## Daily kWh and value estimate

- The dashboard computes today's generated energy (`kWh`) from sampled watt readings.
- It also estimates value with `COST_RATE_USD_PER_KWH` (default `0.33`).

## Troubleshooting 401 from Home Assistant

1. Enable verbose HA debug logs in `.env`:

   ```bash
   DEBUG_HA=true
   ```

2. Restart the server and watch logs. You will see:
   - request endpoint
   - token preview (redacted)
   - status code and response body preview for failures

3. Inspect the latest HA request metadata from your browser:
   - [http://localhost:3000/api/debug/ha](http://localhost:3000/api/debug/ha)

4. Test the same API call manually:

   ```bash
   set -a
   source .env
   set +a
   curl -i \
     -H "Authorization: Bearer $HA_TOKEN" \
     "$HA_BASE_URL/api/states/$HA_SENSOR_ENTITY_ID"
   ```

If this `curl` returns 401 too, the issue is token/base URL/proxy-side and not the dashboard code.
