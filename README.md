# Mir Mosaic Operations Dashboard

I built this dashboard to bring our order processing and attendance tools into one place. It runs on a company computer and is available to the team over the local network.

The main goal was to make daily work easier without replacing the systems we already use. The dashboard reads their data, keeps a local attendance cache, and gives the team a shared place to review records.

## What it does

- **FedFish:** view sent orders, response messages, and payloads by source, with paginated history.
- **Payclock:** browse punches by date or employee, review hours, correct missing or extra punches, and download Excel reports.
- **AI Email Processor:** see activity from the existing order-processing application.
- **Attendance alerts:** send separate Warehouse and Office emails, with additional CC recipients for Warehouse.
- **Employee texts:** send private lunch notifications to employees who have a saved phone number.

This is a company-specific application. It connects to existing local projects and services; cloning this repository alone will not provide those systems or their data.

## Running it

You need Node.js 24 or later, Python with `openpyxl`, and the existing Payclock exporter and clock reader.

1. Copy `config.example.json` to `config.json`.
2. Set the paths to the source applications, Python executable, and clock address.
3. Run `npm start`, then open `http://localhost:4320`.

On Windows, `Start-Mira.bat` starts the server in the background. `Stop-Mira.bat` stops it. Logs are saved in `data/runtime/`. The server computer must stay awake for the dashboard and scheduled checks to work.

Initial login PINs are generated in `data/access/initial-pins.txt`. Sessions lock after 15 minutes without user activity. Clicking, typing, and scrolling keep an active session open; background updates do not.

For access from other computers, enable LAN access in the configuration and allow port 4320 through the server's firewall. Check the `safePeer` network restriction in `server.mjs` when changing networks. The current login runs over HTTP and is intended for the company network, not the public internet.

## How attendance data works

The dashboard keeps raw punches in a local SQLite database. It reuses completed days and pulls missing or partial days for all employees together. Overlapping pulls add missing timestamps without duplicating existing punches. Today's records stay partial until a later-day pull closes that day.

The calendar lets you select dates, fetch missing days, or view saved data. Shortcuts cover yesterday and the last one, two, or four completed weeks. A nightly pull runs at 11 PM Pacific, with catch-up after a restart. The page also shows the latest successful clock pull, including background alert checks.

### Corrections

Corrections are stored separately from the clock records. You can add a missing time, change a time or assignment, exclude an extra punch, undo a change, or restore the original records. Each saved change records who made it and when.

All users see the same saved corrections. Reports, employee statistics, and Excel downloads include them. Corrected days stay visible in Needs Review with a blue label so they are easy to find again.

The editor suggests punch assignments from employee history, but it does not invent missing times. Adding a missing punch creates a blank field for someone to fill in. Nothing changes until the draft is saved. If another user changes the same day, or new clock punches arrive, an outdated draft must be reloaded before saving.

## Notifications

The server checks attendance every five minutes between 6 AM and 9 PM Pacific while automatic alerts are enabled.

Manager emails cover:

- No lunch-out punch by five hours after the first punch, or a lunch-out recorded after that point.
- Three or more weekday arrivals after 8:30 AM in the trailing 30-day period.
- Three consecutive completed weekdays with no punches. Missing or partial clock coverage does not count as an absence.

Warehouse and Office records go into separate emails. Both use the main recipient list; only Warehouse emails include the Warehouse CC list. Lunch alerts are sent once per employee per day, lateness alerts once per calendar month, and missing-work alerts once per consecutive streak. Approved leave, employee exclusions, and temporary lunch exemptions affect which alerts are generated.

### Gmail

Set `attendanceAlerts.gmailClientFile` to the Google OAuth client file. From the server computer, sign in with the administrator PIN and use **Connect it@ Gmail** in the alerts section. The integration verifies the configured company mailbox and stores its token separately from the email-processing application's credentials.

Emails include the relevant dates and punches. A design preview uses sample records and sends nothing. If Gmail does not confirm a send, automatic email delivery pauses until someone checks Sent and uses the retry control.

### Twilio SMS

Under **Employee lunch notifications**, select an employee and save their 10-digit US phone number. The application adds `+1` automatically. Clearing the field removes that employee from text notifications. Phone edits record the signed-in user and reject conflicting updates.

Texts go only to employees with saved numbers and only when a lunch-out is still missing after five hours. They contain that employee's notification, not the manager digest. Each employee gets at most one lunch text per day. Old pending messages are cancelled when the day changes, the lunch alert clears, or the phone number changes.

Twilio credentials belong in `data/alerts/twilio.json`. Sending requires a paid account and an approved SMS sender. Trial accounts may reject custom messages. An accepted API request is recorded separately from confirmed delivery; delivery problems can be checked in Twilio's logs.

## Local files and backups

These files stay outside Git:

- `config.json` and Twilio/Gmail credentials
- Login PINs and employee phone numbers
- Punch databases, corrections, and notification history
- Exports, screenshots, and runtime logs

The raw punch cache is `data/payclock/punches.sqlite3`. Corrections are in `data/payclock/adjustments.sqlite3`. Back up both with SQLite's backup facility, along with the local settings you need to restore the installation. A Git clone restores the code, not the working data.

## Tests

Run the JavaScript tests with:

```sh
npm test
```

Run the Python report and punch-review tests with:

```sh
python -B -m unittest discover -s tests -p "test_*.py"
```

Some integration tests need the existing Payclock installation and local export fixtures. Those fixtures are not included in this repository. Tests cover report calculations, Excel output, cache behavior, corrections, sessions, email routing, and lunch-only SMS delivery rules.
