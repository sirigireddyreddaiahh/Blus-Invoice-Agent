# AP Sentinel — Enterprise Accounts Payable Fraud & Duplicate Detection

A full-stack enterprise React 19 + Express application designed to detect, review, and prevent invoice fraud, duplicates, and tax non-compliance before posting to the general ledger.

## Core Features Ported & Enhanced

1. **14-Rule Fraud & Duplicate Catalogue (AP-01 to AP-14)**:
   - **AP-01**: e-Invoice QR code JWS RS256 signature verification and IRN cross-invoice binding.
   - **AP-02**: Exact duplicate detection (Supplier GSTIN/ID + Financial Year + Normalized Invoice Number) & Blacklist matching.
   - **AP-03**: GSTIN weighted base-36 check character format validation and active portal status.
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

2. **Invoice Upload & Interactive Inspection (Screen 1)**:
   - PDF file upload with automated field extraction.
   - 5 Instant test scenario presets:
     - Clean invoice (`PASS`)
     - Math & GST tax mismatch (`AP-08 HOLD`)
     - Exact duplicate (`AP-02 REJECT`)
     - BEC bank details change (`AP-05 HOLD`)
     - Threshold split (`AP-11 HOLD`)
   - Post to general ledger (payment blocked automatically if status is `HOLD`; blocked permanently if `REJECT`).

3. **S/4HANA Extract & Batch Processing (Screen 2)**:
   - Import S/4HANA export as CSV or JSON.
   - Load built-in 10-invoice sample extract.
   - Batch check execution with inter-invoice cross-comparisons.
   - Status filters, reason chips, and slide-over inspection drawer.

4. **Review Queue (Fiori Elements Equivalent)**:
   - Centralized queue of all flagged items (`REJECT`, `HOLD`, `FLAG`).
   - Decision workflow: **CLEAR**, **CONFIRM**, or **ESCALATE** with mandatory reviewer audit comment.
   - Policy enforcement: `REJECT` tier is fatal and cannot be cleared.

5. **Posted Invoices Ledger**:
   - Accounts payable ledger view with active vs. payment-blocked status indicators.

6. **Tamper-Evident SHA-256 Audit Trail**:
   - Cryptographically chained hash log.
   - Real-time "Verify Cryptographic Chain" check guaranteeing ledger integrity.

7. **Sentinel AI Copilot (Integrated Chatbot)**:
   - Powered by Google GenAI SDK (`gemini-3.8-flash`) via server-side `/api/chat`.
   - Explains any of the 14 rules and why specific invoices were held or rejected.
   - Guides reviewers on appropriate decisions and drafts audit justifications.
   - Auto-drafts formal vendor discrepancy inquiry emails for bank changes, PO omissions, or GST credit errors.

## Tech Stack
- **Frontend:** React 19, Vite, Tailwind CSS v4, Lucide Icons
- **Backend:** Node.js, Express, `@google/genai`
- **Data & Masters:** In-memory store initialized with Bluspring vendor masters and posted invoice history.

## Development & Build
```bash
npm run dev    # Starts full-stack Express + Vite on http://0.0.0.0:3000
npm run build  # Builds optimized Vite production bundle
npm run lint   # Verifies TypeScript typing with tsc --noEmit
```
