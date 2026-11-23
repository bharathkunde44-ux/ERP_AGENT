/**
 * Mock College ERP Server
 * Simulates a realistic university LMS / ERP portal with session authentication,
 * assignment deadlines table, submission file upload forms, and confirmation pages.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${req.params.id}-${uniqueSuffix}-${file.originalname}`);
  },
});
const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Helper to calculate dynamic upcoming dates
const now = new Date();
const inHours = (h) => new Date(now.getTime() + h * 60 * 60 * 1000).toISOString();
const agoHours = (h) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

// In-memory assignment store for mock portal
let assignmentsState = [
  {
    id: 'cs101_asgt3',
    title: 'Assignment 3: Binary Search Trees & Balanced AVL Trees',
    subject: 'CS101: Data Structures and Algorithms',
    description:
      'Implement recursive AVL rotation methods, insertion balancing, and range query traversals in C++ or Python. Include thorough complexity proofs.',
    dueDate: inHours(14), // 14 hours away -> should trigger auto-submit!
    status: 'PENDING',
    submittedFile: null,
    submittedAt: null,
  },
  {
    id: 'math202_hw4',
    title: 'Homework 4: Eigenvalues, Eigenvectors, and Diagonalization Proofs',
    subject: 'MATH202: Linear Algebra',
    description:
      'Solve Problem Set 4: Compute characteristic polynomials, verify algebraic vs geometric multiplicity, and orthogonal diagonalizations.',
    dueDate: inHours(32), // 32 hours away -> within 48h buffer
    status: 'PENDING',
    submittedFile: null,
    submittedAt: null,
  },
  {
    id: 'phy105_lab2',
    title: 'Lab Report 2: Photoelectric Effect & Plancks Constant',
    subject: 'PHY105: Quantum Physics Lab',
    description:
      'Compile experimental data for stopping potential vs wavelength, calculate work function of zinc cathode, and compute experimental error margins.',
    dueDate: inHours(96), // 4 days away
    status: 'PENDING',
    submittedFile: null,
    submittedAt: null,
  },
  {
    id: 'eng102_essay',
    title: 'Essay 1: Ethical Implications of Generative AI in Higher Education',
    subject: 'ENG102: Academic Writing & Ethics',
    description: 'Submit an 8-page argumentative essay formatted according to APA 7th Edition.',
    dueDate: agoHours(24),
    status: 'SUBMITTED',
    submittedFile: 'ENG102_Essay_Ethics_AI.pdf',
    submittedAt: agoHours(26),
  },
];

// Simple auth check middleware
function requireAuth(req, res, next) {
  const sessionToken = req.cookies.mock_erp_session;
  if (!sessionToken || sessionToken !== 'valid_student_session') {
    return res.redirect('/login');
  }
  next();
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// Login Page
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>University ERP - Student Portal Login</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #eef2f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); width: 100%; max-width: 400px; }
        h2 { margin-top: 0; color: #1e293b; text-align: center; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 6px; font-weight: 600; color: #475569; font-size: 14px; }
        input[type="text"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #1d4ed8; }
        .hint { font-size: 12px; color: #64748b; margin-top: 15px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Student ERP Login</h2>
        <form method="POST" action="/login">
          <div class="form-group">
            <label for="username">Student ID / Username</label>
            <input type="text" id="username" name="username" value="student_2026" required />
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" value="student_pass_secure" required />
          </div>
          <button type="submit" id="login-button">Sign In to ERP Portal</button>
        </form>
        <p class="hint">Default credentials: student_2026 / student_pass_secure</p>
      </div>
    </body>
    </html>
  `);
});

// Login Handler
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'student_2026' && password === 'student_pass_secure') {
    res.cookie('mock_erp_session', 'valid_student_session', {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
    });
    return res.redirect('/dashboard');
  }
  return res.status(401).send(`
    <h3>Invalid login credentials</h3>
    <a href="/login">Try again</a>
  `);
});

// Logout Handler
app.get('/logout', (req, res) => {
  res.clearCookie('mock_erp_session');
  res.redirect('/login');
});

// Assignments Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  const rows = assignmentsState
    .map(
      (asgt) => `
      <tr class="assignment-row" data-id="${asgt.id}">
        <td><strong>${asgt.subject}</strong></td>
        <td>
          <a href="/assignment/${asgt.id}" class="assignment-link">${asgt.title}</a>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px;">${asgt.description.substring(0, 75)}...</div>
        </td>
        <td class="deadline-col" data-date="${asgt.dueDate}">
          ${new Date(asgt.dueDate).toLocaleString()}
        </td>
        <td>
          <span class="status-badge status-${asgt.status.toLowerCase()}">${asgt.status}</span>
        </td>
        <td>
          ${
            asgt.status === 'PENDING'
              ? `<a href="/assignment/${asgt.id}" class="action-btn submit-btn" id="btn-submit-${asgt.id}">Submit File</a>`
              : `<span class="submitted-label">✓ Done</span>`
          }
        </td>
      </tr>
    `
    )
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>University ERP - Assignment Portal</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: #f8fafc; margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 30px; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px; }
        h1 { margin: 0; font-size: 22px; color: #0f172a; }
        .user-tag { font-size: 14px; color: #475569; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid #e2e8f0; }
        th { background: #f1f5f9; color: #334155; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
        .status-badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
        .status-pending { background: #fef3c7; color: #b45309; }
        .status-submitted { background: #dcfce7; color: #15803d; }
        .action-btn { background: #2563eb; color: white; text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; }
        .action-btn:hover { background: #1d4ed8; }
        .submitted-label { color: #16a34a; font-weight: bold; font-size: 13px; }
        .assignment-link { color: #0f172a; font-weight: 600; text-decoration: none; }
        .assignment-link:hover { color: #2563eb; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>Student Assignment Submissions Portal</h1>
            <div class="user-tag">Welcome, Student (ID: student_2026) | Semester 5</div>
          </div>
          <div>
            <a href="/logout" style="color: #64748b; font-size: 13px;">Sign Out</a>
          </div>
        </div>
        <table id="assignments-table">
          <thead>
            <tr>
              <th style="width: 25%;">Subject</th>
              <th style="width: 35%;">Assignment</th>
              <th style="width: 20%;">Deadline</th>
              <th style="width: 10%;">Status</th>
              <th style="width: 10%;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `);
});

// Alias /assignments to /dashboard
app.get('/assignments', (req, res) => res.redirect('/dashboard'));

// Assignment Detail & Submission Form
app.get('/assignment/:id', requireAuth, (req, res) => {
  const asgt = assignmentsState.find((a) => a.id === req.params.id);
  if (!asgt) {
    return res.status(404).send('Assignment not found');
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>${asgt.title} - Submission</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; padding: 30px; }
        .card { max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); padding: 32px; }
        .back-link { display: inline-block; margin-bottom: 20px; color: #2563eb; text-decoration: none; font-size: 14px; }
        h1 { margin-top: 0; font-size: 22px; color: #1e293b; }
        .meta-row { display: flex; gap: 24px; margin: 16px 0 24px; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
        .meta-item strong { display: block; color: #64748b; font-size: 12px; text-transform: uppercase; }
        .desc-box { background: #f1f5f9; padding: 16px; border-radius: 8px; font-size: 14px; line-height: 1.5; color: #334155; margin-bottom: 24px; }
        .upload-area { border: 2px dashed #cbd5e1; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 20px; }
        input[type="file"] { font-size: 14px; margin-top: 8px; }
        .submit-btn { background: #16a34a; color: white; border: none; padding: 12px 28px; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; }
        .submit-btn:hover { background: #15803d; }
        .submitted-box { background: #dcfce7; border: 1px solid #86efac; border-radius: 8px; padding: 16px; color: #166534; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <a href="/dashboard" class="back-link">← Back to Assignments</a>
        <h1 id="assignment-title">${asgt.title}</h1>
        <div class="meta-row">
          <div class="meta-item">
            <strong>Subject</strong>
            <span id="assignment-subject">${asgt.subject}</span>
          </div>
          <div class="meta-item">
            <strong>Deadline</strong>
            <span id="assignment-deadline">${new Date(asgt.dueDate).toLocaleString()}</span>
          </div>
          <div class="meta-item">
            <strong>Status</strong>
            <span id="assignment-status">${asgt.status}</span>
          </div>
        </div>

        <div class="desc-box">
          <strong>Instructions:</strong>
          <p id="assignment-description" style="margin: 6px 0 0;">${asgt.description}</p>
        </div>

        ${
          asgt.status === 'PENDING'
            ? `
          <form id="submission-form" action="/assignment/${asgt.id}/submit" method="POST" enctype="multipart/form-data">
            <div class="upload-area">
              <label for="assignment-file" style="display:block; font-weight: 600; margin-bottom: 8px;">Select assignment file (.pdf or .docx):</label>
              <input type="file" id="assignment-file" name="assignmentFile" accept=".pdf,.docx" required />
            </div>
            <div style="text-align: right;">
              <button type="submit" id="submit-assignment-btn" class="submit-btn">Upload & Submit Assignment</button>
            </div>
          </form>
        `
            : `
          <div class="submitted-box" id="submission-confirmation">
            <strong>✓ Assignment Already Submitted</strong>
            <p style="margin: 6px 0 0;">File: <em>${asgt.submittedFile}</em><br>Submitted at: ${new Date(asgt.submittedAt).toLocaleString()}</p>
          </div>
        `
        }
      </div>
    </body>
    </html>
  `);
});

// Submission Upload Endpoint
app.post(
  '/assignment/:id/submit',
  requireAuth,
  upload.single('assignmentFile'),
  (req, res) => {
    const asgt = assignmentsState.find((a) => a.id === req.params.id);
    if (!asgt) {
      return res.status(404).send('Assignment not found');
    }

    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    // Mark as submitted
    asgt.status = 'SUBMITTED';
    asgt.submittedFile = req.file.originalname;
    asgt.submittedAt = new Date().toISOString();

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Submission Confirmed</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; padding: 40px; }
        .card { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); padding: 36px; text-align: center; }
        .icon { font-size: 48px; color: #16a34a; margin-bottom: 12px; }
        h1 { margin-top: 0; color: #1e293b; font-size: 24px; }
        .details { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin: 20px 0; text-align: left; font-size: 14px; }
        .btn { display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">✓</div>
        <h1 id="success-header">Submission Successful!</h1>
        <div class="details" id="submission-proof-box">
          <p><strong>Assignment:</strong> ${asgt.title}</p>
          <p><strong>Subject:</strong> ${asgt.subject}</p>
          <p><strong>Uploaded File:</strong> <span id="uploaded-filename">${req.file.originalname}</span></p>
          <p><strong>Timestamp:</strong> ${asgt.submittedAt}</p>
          <p><strong>Confirmation Token:</strong> SUB-${Date.now().toString(36).toUpperCase()}</p>
        </div>
        <a href="/dashboard" class="btn">Return to Dashboard</a>
      </div>
    </body>
    </html>
  `);
  }
);

// REST API for external verification / agent direct checks
app.get('/api/assignments', (req, res) => {
  res.json({
    success: true,
    count: assignmentsState.length,
    assignments: assignmentsState,
  });
});

// Reset endpoint to revert all assignments to pending for testing
app.post('/api/reset', (req, res) => {
  const currentNow = new Date();
  assignmentsState = [
    {
      id: 'cs101_asgt3',
      title: 'Assignment 3: Binary Search Trees & Balanced AVL Trees',
      subject: 'CS101: Data Structures and Algorithms',
      description:
        'Implement recursive AVL rotation methods, insertion balancing, and range query traversals in C++ or Python. Include thorough complexity proofs.',
      dueDate: new Date(currentNow.getTime() + 14 * 60 * 60 * 1000).toISOString(),
      status: 'PENDING',
      submittedFile: null,
      submittedAt: null,
    },
    {
      id: 'math202_hw4',
      title: 'Homework 4: Eigenvalues, Eigenvectors, and Diagonalization Proofs',
      subject: 'MATH202: Linear Algebra',
      description:
        'Solve Problem Set 4: Compute characteristic polynomials, verify algebraic vs geometric multiplicity, and orthogonal diagonalizations.',
      dueDate: new Date(currentNow.getTime() + 32 * 60 * 60 * 1000).toISOString(),
      status: 'PENDING',
      submittedFile: null,
      submittedAt: null,
    },
    {
      id: 'phy105_lab2',
      title: 'Lab Report 2: Photoelectric Effect & Plancks Constant',
      subject: 'PHY105: Quantum Physics Lab',
      description:
        'Compile experimental data for stopping potential vs wavelength, calculate work function of zinc cathode, and compute experimental error margins.',
      dueDate: new Date(currentNow.getTime() + 96 * 60 * 60 * 1000).toISOString(),
      status: 'PENDING',
      submittedFile: null,
      submittedAt: null,
    },
    {
      id: 'eng102_essay',
      title: 'Essay 1: Ethical Implications of Generative AI in Higher Education',
      subject: 'ENG102: Academic Writing & Ethics',
      description: 'Submit an 8-page argumentative essay formatted according to APA 7th Edition.',
      dueDate: new Date(currentNow.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      status: 'SUBMITTED',
      submittedFile: 'ENG102_Essay_Ethics_AI.pdf',
      submittedAt: new Date(currentNow.getTime() - 26 * 60 * 60 * 1000).toISOString(),
    },
  ];

  res.json({ success: true, message: 'Reset mock assignments to initial state.' });
});

let serverInstance = null;

function startMockServer(port = 3000) {
  return new Promise((resolve) => {
    serverInstance = app.listen(port, () => {
      console.log(`[Mock ERP] Server running on http://localhost:${port}`);
      resolve(serverInstance);
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        console.log('[Mock ERP] Server stopped.');
        serverInstance = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// Standalone execution
if (require.main === module) {
  const port = process.env.MOCK_SERVER_PORT || 3000;
  startMockServer(port);
}

module.exports = {
  app,
  startMockServer,
  stopMockServer,
};

