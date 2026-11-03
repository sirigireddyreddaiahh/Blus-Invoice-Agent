# Blus Invoice Agent — Enterprise Accounts Payable Fraud & Duplicate Detection

A full-stack enterprise application designed to catch duplicate and split invoices before they get paid, and prevent invoice fraud and tax non-compliance before posting to the general ledger.

## Core Features

1. **14-Rule Fraud & Duplicate Catalogue (AP-01 to AP-14)** (with **AP-02, AP-03, AP-09, AP-11** active by default):
   - **AP-01**: e-Invoice QR code JWS RS256 signature verification and IRN cross-invoice binding.
   - **AP-02**: Exact duplicate detection (Supplier GSTIN/ID + Financial Year + Normalized Invoice Number) & Blacklist matching.
   - **AP-03**: GSTIN weighted base-36 check character format validation and vendor master uniqueness check.
   - **AP-04**: Addressee (buyer) validation against approved corporate entities (Bluspring entities).
   - **AP-05**: Bank details changed vs. vendor master (BEC — Business Email Compromise detection on IFSC and account number).
   - **AP-06**: Bank account collision detection across customer, employee, and supplier records.
   - **AP-07**: Purchase Order & Receipt 3-way match control (PO required, 48-hour tolerance, GR for goods, SES for services).
   - **AP-08**: Arithmetic consistency and Indian GST tax rules (intra-state equal CGST/SGST with zero IGST, inter-state IGST, HSN tax rate schedule validation).
   - **AP-09**: Recurring look-alike invoice detection (same supplier, same amount, similar description within 90 days unless contract PO).
   - **AP-10**: Lookalike resubmission detection (similar invoice number within 10 days, amount within ±₹1.5).
   - **AP-11**: Delegation of Authority (DOA) threshold splitting (multiple invoices from same supplier within 14 days just below approval limits like ₹100,000 or ₹500,000).
   - **AP-12**: Hidden / adversarial text detection in PDF invoices (prompt injection / instruction overrides).
   - **AP-13**: PDF metadata signals (identifies invoices generated in design tools like Canva, Photoshop, Illustrator).
   - **AP-14**: Calendar anomalies (invoices dated on Sundays or gazetted holidays).

2. **Upload Invoice & AI Chat Inspection (Step 1)**:
   - Upload PDF, PNG, or JPG invoices (up to 10 MB) directly in the chat composer.
   - Automated field extraction (PDF text layer, Tesseract OCR, and QR e-Invoice JWT decoding).
   - Instant verdict badge (**Passed checks**, **Needs review**, or **Blocked**), extracted invoice fields, and active rule results (`AP-02`, `AP-03`, `AP-09`, `AP-11`).
   - Post clean or held invoices to the general ledger (payment blocked automatically if status is `HOLD`; blocked permanently if `REJECT`).

3. **S/4HANA Extract & Batch Processing (Step 2)**:
   - Import S/4HANA export as CSV or JSON, or load the built-in sample extract.
   - Batch check execution with inter-invoice cross-comparisons.

4. **Review Queue (Step 3)**:
   - Centralized queue of all flagged items (`REJECT`, `HOLD`, `FLAG`).
   - Decision workflow: **CLEAR**, **CONFIRM**, or **ESCALATE** with mandatory reviewer audit comment.
   - Policy enforcement: `REJECT` tier is final and cannot be cleared.

5. **Check History & Export (Step 4)**:
   - Filterable history of all checked invoices with CSV and Excel export.

6. **Tamper-Evident SHA-256 Activity Log (Step 5)**:
   - Cryptographically chained hash log with real-time integrity verification.

7. **Blus Invoice Agent AI Assistant**:
   - Powered by Google GenAI SDK (`@google/genai`) via server-side `/fraud/askInvoice`.
   - Answers follow-up questions about the checked invoice, extracted fields, bank details, and active or disabled rules.

## Tech Stack
- **Frontend:** HTML5, Plus Jakarta Sans & JetBrains Mono Typography, Classic Enterprise CSS, Vanilla ES6+ JavaScript
- **Backend:** Node.js, Express, `@sap/cds`, SQLite, `@google/genai`, `pdfjs-dist`, `tesseract.js`
- **Data & Masters:** SQLite persistence seeded with Bluspring vendor masters and posted invoice history.

## Development & Build
```bash
npm run dev    # Starts Blus Invoice Agent server on http://0.0.0.0:3000
npm run build  # Verifies application build
npm test       # Runs the 17 acceptance and regression tests
```
