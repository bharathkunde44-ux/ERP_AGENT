# 🎓 Autonomous College ERP Assignment Agent

An intelligent, production-ready local autonomous AI Agent built in **Node.js (CommonJS)** that monitors a university ERP portal for upcoming assignment deadlines, recursively inspects local folders for completed assignment documents (reading inside `.pdf` and `.docx` files to verify subject and topic matches), sends multi-channel **Email** and **WhatsApp** alerts, and safely auto-submits verified files before deadlines expire.

---

## 🌟 Key Capabilities

- **🧠 AI Brain with Strict LLM Tool Calling:** Uses **Groq SDK** (`llama-3.3-70b-versatile`) with multi-turn function calling (`get_pending_deadlines`, `scan_assignments_folder`, `send_student_notification`, `submit_assignment_file`, `record_audit_log`).
- **🛡️ Intelligent Heuristic Fallback:** If `GROQ_API_KEY` is not set or network is restricted, seamlessly activates an autonomous keyword/token semantic analysis engine so the agent works 100% out of the box.
- **🌐 Persistent Browser Automation:** Leverages **Playwright** with a persistent browser context (`browser_session/`). Cookies, sessions, and CAPTCHA states are saved locally across restarts.
- **📄 Deep Document Parsing:**
  - Extracts text from `.pdf` documents using `pdf-parse`.
  - Extracts raw text and structure from `.docx` documents using `mammoth`.
  - Computes SHA-256 hashes to avoid redundant re-processing and track file modifications.
- **🗄️ Robust SQLite Database & Audit Trail:** Local SQLite database (`agent_data.db`) managed via `sqlite` and `sqlite3`, tracking `deadlines`, `local_files`, `alerts_sent`, `submissions`, and system `audit_logs`.
- **📬 Dual-Channel Notifications:**
  - **Email:** Rich, responsive HTML & plaintext emails with status badges, deadline countdowns, and attached submission proof screenshots via **Nodemailer** (Gmail / SMTP).
  - **WhatsApp:** Direct alerts via the **Meta WhatsApp Cloud API** with actionable summaries and emojis.
  - **Anti-Spam Safeguards:** Enforces cooldown windows (12 hours) to avoid notification fatigue.
- **📸 Cryptographic & Visual Audit Proof:** Every submission captures a high-resolution, full-page screenshot stored in `screenshots/` and logs the timestamp, file path, and AI confidence score in SQLite.
- **🏫 Realistic Mock ERP Portal:** Bundled with an Express-based mock college portal (`mock_erp/mockServer.js`) supporting session cookies, multi-course deadline boards, file upload forms, and confirmation screens for local end-to-end testing.

---

## 📁 Project Architecture

```text
erp-assignment-agent/
├── college_assignments/        # Watched folder where student places finished PDFs/DOCXs
├── browser_session/            # Git-ignored folder for Playwright persistent cookies/session
├── screenshots/                # Stores proof-of-submission screenshots
├── src/
│   ├── config/
│   │   └── env.js              # Loads and validates .env variables & default thresholds
│   ├── db/
│   │   └── database.js         # SQLite setup & queries (deadlines, alerts, submissions)
│   ├── browser/
│   │   └── erpAutomation.js    # Playwright login helper, deadline scraper & file uploader
│   ├── scanner/
│   │   └── folderScanner.js    # Scans college_assignments/ & extracts text from PDF/DOCX
│   ├── notifications/
│   │   └── notifier.js         # Sends formatted Email & WhatsApp alerts with cooldowns
│   ├── agent/
│   │   └── orchestrator.js     # Groq LLM tool-calling loop & autonomous decision engine
│   └── index.js                # CLI entry point with flags (--login, --run-once, --mock, --dry-run)
├── mock_erp/
│   ├── mockServer.js           # Local Express app simulating a university ERP portal
│   └── uploads/                # Directory storing simulated uploaded assignment files
├── .env.example                # Template of all environment variables
├── .gitignore                  # Git exclusions for sessions, databases, and logs
└── README.md                   # Comprehensive documentation and setup guide
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js** >= 18.0.0
- **npm** >= 9.0.0

### 2. Installation
Navigate into `erp-assignment-agent` and install dependencies:
```bash
cd erp-assignment-agent
npm install
npx playwright install chromium
```

### 3. Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Configure your credentials in `.env`:
```env
# Groq LLM Brain (Get a free key at https://console.groq.com/keys)
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile

# ERP Portal URL & Credentials
ERP_PORTAL_URL=http://localhost:3000
ERP_USERNAME=student_2026
ERP_PASSWORD=student_pass_secure

# Email Notifications (Gmail SMTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_gmail_app_password
ALERT_RECIPIENT_EMAIL=student_alerts@example.com

# WhatsApp Notifications (Meta Cloud API)
WHATSAPP_API_TOKEN=your_meta_system_user_access_token
WHATSAPP_PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WHATSAPP_RECIPIENT_PHONE=+919876543210

# Autonomous Thresholds
AUTO_SUBMIT_CONFIDENCE_THRESHOLD=85
HOURS_BEFORE_DEADLINE_TO_SUBMIT=48
CRON_SCHEDULE=*/30 * * * *
HEADLESS_BROWSER=false
```

---

## 💻 CLI Usage

The agent supports flexible CLI flags to accommodate various operational modes:

| Command | Description |
|---|---|
| `npm run mock:dry-run` | Spawns the local mock ERP server, scans documents, evaluates matches, and simulates submission with proof screenshots without modifying live data. |
| `npm run mock:run-once` | Starts mock ERP server, performs one live scraping, document matching, and auto-submission cycle, then exits cleanly. |
| `npm run mock` | Starts mock ERP server and runs the agent in continuous daemon mode on a cron schedule. |
| `npm run login` | Opens a headed Playwright browser window pointing to your ERP portal so you can manually log in, solve CAPTCHA, or handle 2FA. The session is saved to `browser_session/`. |
| `npm run run-once` | Runs a single autonomous cycle against the real ERP portal configured in `.env`. |
| `npm start` | Runs the agent in continuous daemon mode according to `CRON_SCHEDULE` (default: every 30 minutes). |
| `npm run mock-server` | Launches only the standalone Mock ERP portal on `http://localhost:3000`. |

---

## 🧪 Testing with Mock ERP

To test the entire workflow locally without external dependencies:

1. **Verify Sample Assignments:**
   The `college_assignments/` directory contains sample documents (e.g., `CS101_Assignment_3.pdf` and `MATH202_Homework_4.docx`).
2. **Execute a Dry Run:**
   ```bash
   npm run mock:dry-run
   ```
   - Spawns the Mock ERP at `http://localhost:3000`.
   - Scrapes upcoming assignments:
     - `CS101`: Due in ~14h (PENDING)
     - `MATH202`: Due in ~32h (PENDING)
     - `PHY105`: Due in 4 days (PENDING)
   - Reads inside local files and computes semantic match confidence.
   - For `CS101`, matches `CS101_Assignment_3.pdf` with >90% confidence and triggers auto-submission (dry-run mode).
   - Captures screenshot proof in `screenshots/`.
   - Sends simulated email and WhatsApp alerts to console.

3. **Execute Live Auto-Submission:**
   ```bash
   npm run mock:run-once
   ```
   - Automatically navigates to the portal, selects the file, clicks submit, records the confirmation token, and captures proof in `screenshots/submission_cs101_asgt3_<timestamp>.png`.

---

## 🛡️ Safety & Safeguards

- **Confidence Threshold (`AUTO_SUBMIT_CONFIDENCE_THRESHOLD`):**
  Auto-submission will **never** trigger unless the AI match score meets or exceeds the threshold (default: **85%**).
- **Subject Matching Guarantee:**
  The agent checks both the subject course code and topic terminology inside the document body to prevent uploading the wrong homework to a course.
- **Time Buffer (`HOURS_BEFORE_DEADLINE_TO_SUBMIT`):**
  Files are only auto-submitted if the deadline is within the designated submission window (e.g., 48 hours). If a file is matched earlier, the agent sends an "Upcoming Deadline: File Ready" alert instead of submitting prematurely.
- **Missing File Urgent Warning:**
  If an assignment is due in less than 48 hours and no matching document is found, the agent triggers an urgent warning to notify the student to complete their work.
- **Persistent Sessions:**
  Playwright stores all authentication cookies in `browser_session/`, so human login, 2FA, or CAPTCHA solving only needs to be completed once.
- **Dry-Run Mode (`--dry-run`):**
  Allows full verification of form population and screenshot capture without clicking the final submit button.

---

## 📊 Database Schema (`agent_data.db`)

The SQLite database contains five primary tables:
- `deadlines`: Scraped ERP assignments, due dates, statuses, and links.
- `local_files`: Scanned documents, computed SHA-256 hashes, extracted text, and detected subjects.
- `alerts_sent`: Record of Email and WhatsApp notifications with timestamps to enforce cooldown limits.
- `submissions`: Complete audit log of every auto-submission, including status (`SUCCESS`, `DRY_RUN`, `FAILED`), confidence score, LLM reasoning, and screenshot path.
- `audit_logs`: Detailed action timeline for system debugging and traceability.

---

## 📄 License
MIT

