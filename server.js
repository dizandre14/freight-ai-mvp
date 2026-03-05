require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const app = express();
const port = 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

app.post('/api/audit', upload.array('documents', 3), async (req, res) => {
    console.log("\n--- 📥 New Audit Request Received ---");

    try {
        if (!req.files || req.files.length === 0 || req.files.length > 3) {
            return res.status(400).json({ error: "Please upload between 1 and 3 freight documents." });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const imageParts = req.files.map(file => {
            let mimeType = 'text/plain';
            if (file.mimetype === 'application/pdf') mimeType = 'application/pdf';
            else if (file.mimetype === 'image/jpeg') mimeType = 'image/jpeg';
            else if (file.mimetype === 'image/png') mimeType = 'image/png';
            else if (file.mimetype === 'text/csv') mimeType = 'text/csv';
            return fileToGenerativePart(file.path, mimeType);
        });

        // UPDATED PROMPT: Now asks for TL;DR bullets AND a detailed paragraph
const prompt = `
        You are a Senior Freight Auditor. Analyze the provided PDF, CSV, or TXT files.
        Compare them across these 4 specific Audit Categories.

        🎯 TARGET KEYWORDS FOR DENSE TEXT:
        If the documents contain dense legal text, prioritize searching for these exact terms to find the data:
        - RATE CON (Rate Confirmation): Scan for "Linehaul", "Total Rate", "Carrier Pay", "Agreed Amount", "Flat Rate".
        - BOL (Bill of Lading): Scan for "Weight", "lbs", "Pieces", "Pallets". Look specifically near sections labeled "Received by", "Shipper", or "Sign here" to confirm if it is signed. ALSO scan for "Declared Value" or "COD Amount".
        - INVOICE: Scan for "Amount Due", "Total Billed", "Detention", "Lumper", "Fuel Surcharge".

        1. RATE MATCH: Contract Linehaul vs Invoice Linehaul.
        2. WEIGHT VERIFICATION: BOL weight vs Invoice weight.
        3. ACCESSORIAL CHECK: Are there fees on the invoice (Detention, Fuel, Lumper) not in the contract?
        4. DOCUMENT INTEGRITY: Is the BOL/POD signed?
        5. UPLOAD INTEGRITY: Did the user upload duplicate document types (e.g., two invoices) or are they missing a required document? If so, set match_status to false and explicitly state which document is missing or duplicated in the TLDR and Details.

        CRITICAL INSTRUCTION: You must respond with ONLY valid JSON. Do NOT include any conversational text.

        Output JSON Schema:
        {
          "audit_summary": {
            "load_id": "string",
            "match_status": boolean,
            "discrepancy_found": boolean
          },
          "extracted_values": {
            "rate_con": {"total": 0.00, "weight": 0, "accessorials": []},
            "bol": {"weight": 0, "is_signed": boolean, "declared_value": 0.00},
            "invoice": {"total": 0.00, "weight": 0, "fees_found": []}
          },
          "discrepancy_tldr": ["Short bullet point 1", "Short bullet point 2"],
          "discrepancy_details": "A highly detailed, professional paragraph explaining exactly what is wrong, comparing specific document values, meant to be read during a dispute. If all match perfectly, state 'Audit passed, all documents reconcile.'"
        }
        `;

        console.log("🤖 Calling Gemini API...");
        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();
        
        const startIndex = responseText.indexOf('{');
        const endIndex = responseText.lastIndexOf('}');
        
        if (startIndex === -1 || endIndex === -1) throw new Error("AI did not return valid JSON.");
        
        const cleanJson = responseText.substring(startIndex, endIndex + 1);
        const auditData = JSON.parse(cleanJson);

        console.log("✅ Audit Data Parsed Successfully. Match Status:", auditData.audit_summary.match_status);

        req.files.forEach(file => fs.unlinkSync(file.path));
        res.json(auditData);

    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.message);
        if (req.files) req.files.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
        res.status(500).json({ error: "Server failed to process audit." });
    }
});

app.listen(port, () => { console.log(`Freight Audit MVP running at http://localhost:${port}`); });