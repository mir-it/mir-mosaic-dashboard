# Mir Mosaic Operations Dashboard

Local company dashboard for FedFish orders, Payclock attendance and AI Email Processor activity. Existing application data and clock records are read-only. Four individual PIN sessions lock after 15 minutes of inactivity.

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

In the day editor, toggling Include proposes new roles for enabled punches without changing their times. Add missing punch identifies a missing shift role and inserts a blank time field in the correct role position. It never estimates a missing timestamp: enter the actual time before saving. These actions change only the unsaved draft.

Sessions lock after 15 minutes of inactivity. Trusted clicks, typing, touch and scrolling renew the session through a throttled server activity endpoint. Background report polling does not renew sessions. Expiry updates are shared across tabs for the same browser origin; manual Lock signs the session out immediately.


## Manager attendance alerts

Expand Manager attendance alerts in Payclock. Bayel can manage recipients, enable/pause delivery, adjust thresholds, exclude employee IDs and enter approved-leave date ranges. Initial recipients are Emin and Fatima; Tatyana can be added later. Settings and email delivery history live under ignored `data/alerts/`.

From the server computer, open `http://localhost:4320/payclock`, sign in as Bayel and select Connect it@ Gmail. Authorize **it@mir-mosaic.com**. A dedicated OAuth token is saved locally; existing AI Email Processor credentials/tokens are not modified. Only the Gmail send and email identity scopes are requested, and sender identity is verified. `attendanceAlerts.gmailClientFile` points to a Google Desktop OAuth client JSON. The server must have outbound internet access to Google.

While enabled and connected, the running server scans fresh clock data every five minutes from 6 AM to 9 PM Pacific, using saved corrections. Possible lunch delays are flagged four elapsed hours after arrival if no earlier lunch-out is recorded. Lateness means a first punch strictly after 8:30 AM on a weekday, with three such days in 30 days by default. Missing-work alerts require three consecutive completed expected weekdays without punches; weekends are optional. Never-fetched or partial closed dates cannot substantiate missing work. Approved leave and exclusions suppress matching cases. The eligibility window uses employees observed in the previous 30 days; roster/employment status and nonstandard shifts must be verified by a manager.

Emails describe clock-record observations for human review, not confirmed absences or misconduct. Recipients get a digest of new items, deduplicated by employee and event (late patterns once per calendar month; missing runs once per run; lunch once per day). A durable in-flight marker prevents blind re-sending after an ambiguous Gmail/network failure. Check Gmail Sent before using the explicit retry control. No live email has been sent until the requested sender is connected.

Windows Start-Mira starts a detached hidden dashboard process and records its PID and logs in `data/runtime/`. Closing the chat does not control that process. Stop-Mira verifies the server command line before stopping the LAN listener. The current deployment is in email testing mode with it@mir-mosaic.com as the sole recipient; restore manager recipients through alert settings after testing.

Attendance alerts use a branded HTML layout with category counts, employee cards, evidence tables and a Payclock link, plus a plain-text alternative. Preview email design shows sample data without sending any email.
