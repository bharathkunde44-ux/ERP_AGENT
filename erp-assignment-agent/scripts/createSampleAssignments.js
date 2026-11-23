/**
 * Generator script to create sample completed assignment files
 * (CS101_Assignment_3.pdf and MATH202_Homework_4.docx) in college_assignments/
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function createSamplePdf() {
  const targetDir = path.resolve(__dirname, '../college_assignments');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const pdfPath = path.join(targetDir, 'CS101_Assignment_3.pdf');
  console.log(`[Sample Generator] Generating PDF at: ${pdfPath}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Helvetica Neue', Arial, sans-serif; padding: 40px; line-height: 1.6; color: #1a202c; }
          .header { border-bottom: 2px solid #2d3748; padding-bottom: 15px; margin-bottom: 25px; }
          h1 { font-size: 20px; margin: 0 0 6px 0; color: #2b6cb0; }
          h2 { font-size: 16px; margin: 0 0 10px 0; color: #4a5568; }
          .meta { font-size: 13px; color: #718096; }
          h3 { font-size: 14px; margin: 20px 0 8px 0; color: #1a202c; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
          p, li { font-size: 13px; color: #2d3748; }
          pre { background: #edf2f7; padding: 12px; border-radius: 6px; font-size: 12px; font-family: 'Courier New', monospace; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Subject: CS101 Data Structures and Algorithms</h1>
          <h2>Assignment 3: Binary Search Trees & Balanced AVL Trees</h2>
          <div class="meta">
            <strong>Student Name:</strong> Alex Carter &nbsp;|&nbsp;
            <strong>Student ID:</strong> student_2026 &nbsp;|&nbsp;
            <strong>Date:</strong> November 2026
          </div>
        </div>

        <h3>Section 1: AVL Tree Self-Balancing Implementation</h3>
        <p>In this assignment, we implement a fully self-balancing AVL Tree supporting dynamic key insertions, recursive height recalculation, and rotations:</p>
        <ul>
          <li><strong>Left Rotation (LL Case):</strong> Performed when the right-subtree balance factor exceeds +1.</li>
          <li><strong>Right Rotation (RR Case):</strong> Performed when the left-subtree balance factor exceeds -1.</li>
          <li><strong>Double Rotations (LR & RL Cases):</strong> Applied to maintain the strict AVL invariant height difference |h_L - h_R| &le; 1.</li>
        </ul>

        <pre>
AVLNode* rotateLeft(AVLNode* x) {
    AVLNode* y = x->right;
    AVLNode* T2 = y->left;
    y->left = x;
    x->right = T2;
    x->height = 1 + max(getHeight(x->left), getHeight(x->right));
    y->height = 1 + max(getHeight(y->left), getHeight(y->right));
    return y;
}
        </pre>

        <h3>Section 2: Range Query Traversal</h3>
        <p>The range query algorithm searches between keys [low, high] with optimal time complexity O(k + log n), visiting only nodes within the bounded subtree interval.</p>

        <h3>Section 3: Mathematical Proof of Height Bound</h3>
        <p>By defining the recurrence for the minimal number of nodes in an AVL tree of height h as N(h) = N(h-1) + N(h-2) + 1, we prove that the maximum height is strictly upper-bounded by 1.4404 * log2(n). Therefore, search, insertion, and deletion operations strictly achieve worst-case O(log n) performance.</p>
      </body>
    </html>
  `;

  await page.setContent(htmlContent, { waitUntil: 'load' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
  });

  await browser.close();
  console.log('[Sample Generator] PDF successfully generated.');
}

createSamplePdf().catch((err) => {
  console.error('[Sample Generator] Error:', err);
  process.exit(1);
});

