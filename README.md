# Mir Mosaic Operations Dashboard

Local company dashboard for FedFish orders, Payclock attendance and AI Email Processor activity. Existing application data and clock records are read-only. Four individual PIN sessions lock after 15 minutes.

## Run locally

Requires Node.js 24 or later and Python with openpyxl, plus the existing Payclock exporter and clock reader.

1. Copy `config.example.json` to `config.json` and configure your application paths, Python executable and device address.
2. Run `npm start`, or use `Start-Mira.bat` on Windows.
3. Open `http://127.0.0.1:4320`. Initial PINs for Bayel, Tatyana, Emin and Fatima are generated into `data/access/initial-pins.txt` on first run.

Local configuration, PINs, employee data, databases, exports and screenshots are excluded from Git. This repository backs up application code only. Back up both Payclock databases separately using SQLite's backup facility.

## Attendance review

Raw punches live in `data/payclock/punches.sqlite3`. Added times, disabled extras, assignments and undo revisions live separately in `data/payclock/adjustments.sqlite3`. Reports and Excel combine both layers. Every correction records the signed-in person and a timestamp; reasons are optional. Conflicting drafts are rejected. Corrected days remain blue in Needs Review.

Suggested punch roles use employee history where available and explicitly disclosed fallback shift times. Suggestions require human review and saving; they never alter the clock. Click review patterns to open lists of matching days.

Completed days use local cache; missing and partial days fetch all employees. Today remains partial until a later-day read. The running service checks for an 11 PM Pacific pull and catches up after restart. Period shortcuts show yesterday and completed calendar weeks.

## Local network

LAN access is opt-in in `config.json` and needs an inbound firewall rule for port 4320. Current source restricts LAN peers to the configured office deployment's 192.168.8.0/22 subnet; adapt `safePeer` before using a different subnet. HTTP PIN access is not encrypted. No public hosting is configured.

## Verification

`npm test` runs JavaScript tests. `python -B -m unittest discover -s tests -p "test_*.py"` checks calculations and Excel output. Payclock integration tests require a local configured Payclock installation and approved fixture exports; no employee exports are distributed in this repository.

In the day editor, toggling Include proposes new roles for enabled punches without changing their times. Add missing punch identifies a missing shift role and inserts an editable estimate constrained between neighboring punches, using employee history when available. These actions change only the unsaved draft; verify estimated times before saving.
